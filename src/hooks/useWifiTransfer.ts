import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BatchFileItem,
  IncomingOffer,
  PeerInfo,
  RemoteFilePreview,
  TransferHistoryItem,
  TransferProgressState,
} from '../types/transfer';
import { detectDetailedDeviceInfo, detectDeviceInfo } from '../utils/format';
import {
  EzFileSaver,
  EzWifiServer,
  isNativeAndroid,
  uint8ToBase64,
  type NativeServerInfo,
} from '../native/androidPlugins';

const NATIVE_FLUSH_BYTES = 512 * 1024; // Flush every 512 KB to Android MediaStore

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for safe, fast SCTP transfer
const MAX_BUFFERED_AMOUNT = 1536 * 1024; // 1.5 MB backpressure cap
const LOW_BUFFERED_THRESHOLD = 512 * 1024; // 512 KB low-water mark

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const INITIAL_PROGRESS: TransferProgressState = {
  phase: 'idle',
  direction: null,
  transferId: null,
  remotePeer: null,
  activeFileIndex: 0,
  totalFiles: 0,
  totalBytes: 0,
  transferredBytes: 0,
  speedBytesPerSec: 0,
  peakSpeedBytesPerSec: 0,
  etaSeconds: null,
  usingDirectDiskWrite: false,
};

interface FileSystemWritableLike {
  write: (data: BufferSource | Blob | string) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable: () => Promise<FileSystemWritableLike>;
}

interface FileSystemDirectoryHandleLike {
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandleLike>;
}

declare global {
  interface Window {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
    }) => Promise<FileSystemFileHandleLike>;
    showDirectoryPicker?: (options?: {
      mode?: 'read' | 'readwrite';
    }) => Promise<FileSystemDirectoryHandleLike>;
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'file_diterima';
}

function triggerBrowserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1500);
}

export function useWifiTransfer() {
  const [wsConnected, setWsConnected] = useState(false);
  const [selfPeer, setSelfPeer] = useState<PeerInfo | null>(null);
  const [nearbyPeers, setNearbyPeers] = useState<PeerInfo[]>([]);
  const [pairedPeer, setPairedPeer] = useState<PeerInfo | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [queue, setQueue] = useState<BatchFileItem[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [incomingFilesProgress, setIncomingFilesProgress] = useState<
    Array<RemoteFilePreview & { bytesReceived: number; progress: number; done: boolean }>
  >([]);
  const [progress, setProgress] = useState<TransferProgressState>(INITIAL_PROGRESS);
  const [history, setHistory] = useState<TransferHistoryItem[]>(() => {
    try {
      const saved = localStorage.getItem('eztransfer_history');
      return saved ? (JSON.parse(saved) as TransferHistoryItem[]) : [];
    } catch {
      return [];
    }
  });
  const [nativeServerInfo, setNativeServerInfo] = useState<NativeServerInfo | null>(null);
  const [customServerHost, setCustomServerHostState] = useState<string>(() => {
    try {
      return localStorage.getItem('eztransfer_custom_host') || '';
    } catch {
      return '';
    }
  });

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const queueRef = useRef<BatchFileItem[]>([]);
  const selfPeerRef = useRef<PeerInfo | null>(null);
  const initialDevice = detectDeviceInfo();
  const deviceNameRef = useRef<string>(initialDevice.defaultName);
  const deviceTypeRef = useRef(initialDevice.deviceType);

  // Active transfer session refs
  const cancelFlagRef = useRef(false);
  const activeRemotePeerRef = useRef<PeerInfo | null>(null);
  const activeTransferIdRef = useRef<string | null>(null);
  const acceptResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const fileAckResolverRef = useRef<((fileId: string) => void) | null>(null);

  // Speed sliding window refs
  const speedSamplesRef = useRef<Array<{ time: number; bytes: number }>>([]);
  const transferredBytesRef = useRef(0);
  const totalBytesRef = useRef(0);
  const peakSpeedRef = useRef(0);
  const transferStartTimeRef = useRef(0);
  const speedIntervalRef = useRef<number | null>(null);

  // Receiver state refs
  const offerBufferRef = useRef<{
    transferId: string;
    fromPeer: PeerInfo;
    files: RemoteFilePreview[];
  } | null>(null);
  const activeIncomingOfferRef = useRef<IncomingOffer | null>(null);
  const dirHandleRef = useRef<FileSystemDirectoryHandleLike | null>(null);
  const singleFileHandleRef = useRef<FileSystemFileHandleLike | null>(null);
  const currentWritableRef = useRef<FileSystemWritableLike | null>(null);
  const currentBlobChunksRef = useRef<Uint8Array[]>([]);
  const nativeChunkQueueRef = useRef<Uint8Array[]>([]);
  const nativeChunkBytesRef = useRef(0);
  const nativeSavingFileIdRef = useRef<string | null>(null);
  const currentReceiveFileRef = useRef<{
    index: number;
    file: RemoteFilePreview;
    receivedBytes: number;
    usingDisk: boolean;
    usingNativeSaver: boolean;
  } | null>(null);
  const receiveWriteChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    selfPeerRef.current = selfPeer;
  }, [selfPeer]);

  const appendHistory = useCallback((item: TransferHistoryItem) => {
    setHistory((prev) => {
      const next = [item, ...prev].slice(0, 30);
      try {
        localStorage.setItem('eztransfer_history', JSON.stringify(next));
      } catch {
        // ignore storage quota errors
      }
      return next;
    });
  }, []);

  const stopSpeedTicker = useCallback(() => {
    if (speedIntervalRef.current !== null) {
      window.clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    }
  }, []);

  const startSpeedTicker = useCallback(() => {
    stopSpeedTicker();
    speedSamplesRef.current = [];
    peakSpeedRef.current = 0;
    transferStartTimeRef.current = Date.now();

    speedIntervalRef.current = window.setInterval(() => {
      const now = Date.now();
      const samples = speedSamplesRef.current;
      // Keep samples from last 1500ms
      while (samples.length > 0 && now - samples[0].time > 1500) {
        samples.shift();
      }
      const bytesInWindow = samples.reduce((sum, s) => sum + s.bytes, 0);
      const windowSpanSec =
        samples.length > 1 ? Math.max((now - samples[0].time) / 1000, 0.25) : 1;
      const speed = bytesInWindow / windowSpanSec;
      if (speed > peakSpeedRef.current) {
        peakSpeedRef.current = speed;
      }

      const remaining = Math.max(0, totalBytesRef.current - transferredBytesRef.current);
      const eta = speed > 1024 ? remaining / speed : null;

      setProgress((prev) => ({
        ...prev,
        transferredBytes: transferredBytesRef.current,
        speedBytesPerSec: speed,
        peakSpeedBytesPerSec: peakSpeedRef.current,
        etaSeconds: eta,
      }));
    }, 250);
  }, [stopSpeedTicker]);

  const sendWs = useCallback((payload: unknown) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const closePeerConnection = useCallback(async () => {
    stopSpeedTicker();
    if (currentWritableRef.current) {
      try {
        await currentWritableRef.current.abort();
      } catch {
        // ignore abort error
      }
      currentWritableRef.current = null;
    }
    if (nativeSavingFileIdRef.current) {
      try {
        await EzFileSaver.closeFile({ transferId: nativeSavingFileIdRef.current, abort: true });
      } catch {
        // ignore native abort error
      }
      nativeSavingFileIdRef.current = null;
    }
    nativeChunkQueueRef.current = [];
    nativeChunkBytesRef.current = 0;
    currentBlobChunksRef.current = [];
    currentReceiveFileRef.current = null;
    dirHandleRef.current = null;
    singleFileHandleRef.current = null;

    if (dcRef.current) {
      try {
        dcRef.current.onopen = null;
        dcRef.current.onmessage = null;
        dcRef.current.onclose = null;
        dcRef.current.onerror = null;
        dcRef.current.close();
      } catch {
        // ignore
      }
      dcRef.current = null;
    }

    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ondatachannel = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    pendingIceRef.current = [];
    acceptResolverRef.current = null;
    fileAckResolverRef.current = null;
    sendWs({ type: 'peer:update', status: 'idle' });
  }, [sendWs, stopSpeedTicker]);

  const sendDcJson = useCallback((obj: unknown) => {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      dc.send(JSON.stringify(obj));
    }
  }, []);

  const handleDataChannelMessage = useCallback(
    (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const type = msg.type;

        if (type === 'batch-offer-start') {
          const fromPeer = activeRemotePeerRef.current || {
            id: 'unknown',
            pairCode: '------',
            name: String(msg.senderName || 'Perangkat Pengirim'),
            deviceType: 'other' as const,
            status: 'transferring' as const,
          };
          offerBufferRef.current = {
            transferId: String(msg.transferId || ''),
            fromPeer,
            files: [],
          };
          return;
        }

        if (type === 'batch-offer-file' && offerBufferRef.current) {
          const f = msg.file as RemoteFilePreview;
          if (f) {
            offerBufferRef.current.files.push(f);
          }
          return;
        }

        if (type === 'batch-offer-end' && offerBufferRef.current) {
          const buf = offerBufferRef.current;
          offerBufferRef.current = null;
          const totalBytes = buf.files.reduce((acc, f) => acc + f.size, 0);
          const offer: IncomingOffer = {
            transferId: buf.transferId,
            fromPeer: buf.fromPeer,
            files: buf.files,
            totalBytes,
          };
          activeIncomingOfferRef.current = offer;
          setIncomingOffer(offer);
          return;
        }

        if (type === 'batch-accept') {
          if (acceptResolverRef.current) {
            acceptResolverRef.current(true);
            acceptResolverRef.current = null;
          }
          return;
        }

        if (type === 'batch-reject') {
          if (acceptResolverRef.current) {
            acceptResolverRef.current(false);
            acceptResolverRef.current = null;
          }
          return;
        }

        if (type === 'file-ack') {
          const fileId = String(msg.fileId || '');
          if (fileAckResolverRef.current) {
            fileAckResolverRef.current(fileId);
            fileAckResolverRef.current = null;
          }
          return;
        }

        if (type === 'file-start') {
          const fileId = String(msg.fileId || '');
          const fileIndex = Number(msg.index || 0);
          const offer = activeIncomingOfferRef.current;
          const fileMeta = offer?.files.find((f) => f.id === fileId);
          if (!fileMeta) return;

          receiveWriteChainRef.current = receiveWriteChainRef.current.then(async () => {
            let usingDisk = false;
            let usingNativeSaver = false;
            currentBlobChunksRef.current = [];
            currentWritableRef.current = null;
            nativeChunkQueueRef.current = [];
            nativeChunkBytesRef.current = 0;
            nativeSavingFileIdRef.current = null;

            const safeName = sanitizeFileName(fileMeta.name);
            if (isNativeAndroid()) {
              try {
                await EzFileSaver.openFile({
                  transferId: fileId,
                  fileName: safeName,
                  mimeType: fileMeta.mimeType || 'application/octet-stream',
                });
                nativeSavingFileIdRef.current = fileId;
                usingNativeSaver = true;
                usingDisk = true;
              } catch {
                usingNativeSaver = false;
                nativeSavingFileIdRef.current = null;
              }
            }

            if (!usingNativeSaver) {
              try {
                if (singleFileHandleRef.current && offer && offer.files.length === 1) {
                  currentWritableRef.current = await singleFileHandleRef.current.createWritable();
                  usingDisk = true;
                } else if (dirHandleRef.current) {
                  const fh = await dirHandleRef.current.getFileHandle(safeName, { create: true });
                  currentWritableRef.current = await fh.createWritable();
                  usingDisk = true;
                }
              } catch {
                currentWritableRef.current = null;
                usingDisk = false;
              }
            }

            currentReceiveFileRef.current = {
              index: fileIndex,
              file: fileMeta,
              receivedBytes: 0,
              usingDisk,
              usingNativeSaver,
            };

            setProgress((prev) => ({
              ...prev,
              activeFileIndex: fileIndex,
              usingDirectDiskWrite: usingDisk,
            }));
          });
          return;
        }

        if (type === 'file-end') {
          const fileId = String(msg.fileId || '');
          receiveWriteChainRef.current = receiveWriteChainRef.current.then(async () => {
            const current = currentReceiveFileRef.current;
            if (!current || current.file.id !== fileId) return;

            if (current.usingNativeSaver) {
              if (nativeChunkBytesRef.current > 0) {
                const merged = new Uint8Array(nativeChunkBytesRef.current);
                let offset = 0;
                for (const part of nativeChunkQueueRef.current) {
                  merged.set(part, offset);
                  offset += part.byteLength;
                }
                nativeChunkQueueRef.current = [];
                nativeChunkBytesRef.current = 0;
                await EzFileSaver.appendChunk({
                  transferId: fileId,
                  base64: uint8ToBase64(merged),
                });
              }
              await EzFileSaver.closeFile({ transferId: fileId, abort: false });
              nativeSavingFileIdRef.current = null;
            } else if (current.usingDisk && currentWritableRef.current) {
              await currentWritableRef.current.close();
              currentWritableRef.current = null;
            } else {
              const blob = new Blob(currentBlobChunksRef.current as BlobPart[], {
                type: current.file.mimeType || 'application/octet-stream',
              });
              triggerBrowserDownload(blob, sanitizeFileName(current.file.name));
              currentBlobChunksRef.current = [];
            }

            setIncomingFilesProgress((prev) =>
              prev.map((item) =>
                item.id === fileId ? { ...item, progress: 100, done: true } : item
              )
            );
            currentReceiveFileRef.current = null;
            sendDcJson({ type: 'file-ack', fileId });
          });
          return;
        }

        if (type === 'batch-complete') {
          receiveWriteChainRef.current = receiveWriteChainRef.current.then(async () => {
            stopSpeedTicker();
            const offer = activeIncomingOfferRef.current;
            const elapsedSec = Math.max((Date.now() - transferStartTimeRef.current) / 1000, 0.2);
            const avgSpeed = offer ? offer.totalBytes / elapsedSec : 0;

            if (offer) {
              appendHistory({
                id: offer.transferId,
                direction: 'receive',
                peerName: offer.fromPeer.name,
                fileCount: offer.files.length,
                totalBytes: offer.totalBytes,
                firstFileName: offer.files[0]?.name || 'File',
                avgSpeedBytesPerSec: avgSpeed,
                status: 'completed',
                timestamp: Date.now(),
              });
            }

            setProgress((prev) => ({
              ...prev,
              phase: 'completed',
              transferredBytes: totalBytesRef.current,
              speedBytesPerSec: 0,
              etaSeconds: 0,
            }));
            activeIncomingOfferRef.current = null;
            await closePeerConnection();
          });
          return;
        }

        if (type === 'transfer-cancel') {
          cancelFlagRef.current = true;
          if (acceptResolverRef.current) {
            acceptResolverRef.current(false);
            acceptResolverRef.current = null;
          }
          if (fileAckResolverRef.current) {
            fileAckResolverRef.current('__cancelled__');
            fileAckResolverRef.current = null;
          }
          setIncomingOffer(null);
          const offer = activeIncomingOfferRef.current;
          if (offer) {
            appendHistory({
              id: offer.transferId,
              direction: 'receive',
              peerName: offer.fromPeer.name,
              fileCount: offer.files.length,
              totalBytes: offer.totalBytes,
              firstFileName: offer.files[0]?.name || 'File',
              avgSpeedBytesPerSec: 0,
              status: 'cancelled',
              timestamp: Date.now(),
            });
            activeIncomingOfferRef.current = null;
          }
          setProgress((prev) => ({
            ...prev,
            phase: 'cancelled',
            speedBytesPerSec: 0,
            etaSeconds: null,
          }));
          void closePeerConnection();
          return;
        }
        return;
      }

      // Binary ArrayBuffer chunk received
      const chunkBuffer = event.data as ArrayBuffer;
      const chunkBytes = chunkBuffer.byteLength;
      const uint8 = new Uint8Array(chunkBuffer);

      receiveWriteChainRef.current = receiveWriteChainRef.current.then(async () => {
        const current = currentReceiveFileRef.current;
        if (!current) return;

        if (current.usingNativeSaver) {
          nativeChunkQueueRef.current.push(uint8);
          nativeChunkBytesRef.current += uint8.byteLength;
          if (nativeChunkBytesRef.current >= NATIVE_FLUSH_BYTES) {
            const merged = new Uint8Array(nativeChunkBytesRef.current);
            let offset = 0;
            for (const part of nativeChunkQueueRef.current) {
              merged.set(part, offset);
              offset += part.byteLength;
            }
            nativeChunkQueueRef.current = [];
            nativeChunkBytesRef.current = 0;
            await EzFileSaver.appendChunk({
              transferId: current.file.id,
              base64: uint8ToBase64(merged),
            });
          }
        } else if (current.usingDisk && currentWritableRef.current) {
          await currentWritableRef.current.write(uint8);
        } else {
          currentBlobChunksRef.current.push(uint8);
        }

        current.receivedBytes += chunkBytes;
        transferredBytesRef.current += chunkBytes;
        speedSamplesRef.current.push({ time: Date.now(), bytes: chunkBytes });

        const filePct =
          current.file.size > 0
            ? Math.min(100, Math.round((current.receivedBytes / current.file.size) * 100))
            : 100;
        const fileId = current.file.id;
        const receivedForFile = current.receivedBytes;

        setIncomingFilesProgress((prev) =>
          prev.map((item) =>
            item.id === fileId
              ? { ...item, bytesReceived: receivedForFile, progress: filePct }
              : item
          )
        );
      });
    },
    [appendHistory, closePeerConnection, sendDcJson, stopSpeedTicker]
  );

  const attachDataChannel = useCallback(
    (dc: RTCDataChannel) => {
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_BUFFERED_THRESHOLD;
      dcRef.current = dc;
      dc.onmessage = handleDataChannelMessage;
      dc.onclose = () => {
        stopSpeedTicker();
      };
    },
    [handleDataChannelMessage, stopSpeedTicker]
  );

  const createPeerConnection = useCallback(
    (targetPeer: PeerInfo) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      pcRef.current = pc;
      activeRemotePeerRef.current = targetPeer;

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendWs({
            type: 'webrtc:ice',
            targetPeerId: targetPeer.id,
            candidate: e.candidate.toJSON(),
          });
        }
      };

      pc.ondatachannel = (e) => {
        attachDataChannel(e.channel);
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          setProgress((prev) => {
            if (prev.phase === 'connecting' || prev.phase === 'waiting-accept' || prev.phase === 'transferring') {
              return {
                ...prev,
                phase: 'error',
                errorMessage: 'Koneksi WiFi peer-to-peer terputus. Coba sambungkan ulang.',
              };
            }
            return prev;
          });
          void closePeerConnection();
        }
      };

      return pc;
    },
    [attachDataChannel, closePeerConnection, sendWs]
  );

  // WebSocket signaling lifecycle
  useEffect(() => {
    let closedByUnmount = false;
    let reconnectTimer: number | null = null;
    let attempt = 0;

    const resolveWsTarget = async (): Promise<string> => {
      if (isNativeAndroid()) {
        let info: NativeServerInfo | null = null;
        try {
          info = await EzWifiServer.startServer();
          if (!closedByUnmount) {
            setNativeServerInfo(info);
          }
        } catch {
          info = null;
        }

        const custom = customServerHost.trim();
        if (custom) {
          if (custom.startsWith('ws://') || custom.startsWith('wss://')) {
            return custom.endsWith('/ws') ? custom : `${custom.replace(/\/+$/, '')}/ws`;
          }
          if (custom.startsWith('http://') || custom.startsWith('https://')) {
            const wsProto = custom.startsWith('https://') ? 'wss://' : 'ws://';
            const rest = custom.replace(/^https?:\/\//, '').replace(/\/+$/, '');
            return `${wsProto}${rest}/ws`;
          }
          const cleanHost = custom.replace(/\/+$/, '');
          const withPort = cleanHost.includes(':') ? cleanHost : `${cleanHost}:3000`;
          return `ws://${withPort}/ws`;
        }

        if (info?.wsUrl) {
          return info.wsUrl;
        }
        return 'ws://127.0.0.1:3000/ws';
      }

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${protocol}//${window.location.host}/ws`;
    };

    const connectWs = async () => {
      if (closedByUnmount) return;
      const wsUrl = await resolveWsTarget();
      if (closedByUnmount) return;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        setWsConnected(true);
        ws.send(
          JSON.stringify({
            type: 'peer:update',
            name: deviceNameRef.current,
            deviceType: deviceTypeRef.current,
            status: 'idle',
          })
        );

        void detectDetailedDeviceInfo().then((detailed) => {
          deviceNameRef.current = detailed.name;
          deviceTypeRef.current = detailed.deviceType;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'peer:update',
                name: detailed.name,
                deviceType: detailed.deviceType,
              })
            );
          }
        });

        const params = new URLSearchParams(window.location.search);
        const pairParam = params.get('pair');
        if (pairParam && /^\d{6}$/.test(pairParam)) {
          ws.send(JSON.stringify({ type: 'pair:lookup', code: pairParam }));
        }
      };

      ws.onmessage = async (event) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'welcome' || msg.type === 'self:updated') {
          setSelfPeer(msg.self as PeerInfo);
          return;
        }

        if (msg.type === 'peers:update') {
          setNearbyPeers((msg.peers as PeerInfo[]) || []);
          return;
        }

        if (msg.type === 'pair:result') {
          if (msg.ok && msg.peer) {
            setPairedPeer(msg.peer as PeerInfo);
            setPairError(null);
          } else {
            setPairError(String(msg.error || 'Kode ruang tidak ditemukan.'));
          }
          return;
        }

        if (msg.type === 'signal:error') {
          setProgress((prev) => ({
            ...prev,
            phase: 'error',
            errorMessage: String(msg.error || 'Perangkat tujuan tidak dapat dijangkau.'),
          }));
          void closePeerConnection();
          return;
        }

        if (msg.type === 'webrtc:offer') {
          const fromPeer = msg.fromPeer as PeerInfo;
          const sdp = msg.sdp as RTCSessionDescriptionInit;
          if (!fromPeer || !sdp) return;

          await closePeerConnection();
          const pc = createPeerConnection(fromPeer);
          await pc.setRemoteDescription(new RTCSessionDescription(sdp));
          for (const ice of pendingIceRef.current) {
            await pc.addIceCandidate(new RTCIceCandidate(ice));
          }
          pendingIceRef.current = [];
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendWs({
            type: 'webrtc:answer',
            targetPeerId: fromPeer.id,
            sdp: pc.localDescription?.toJSON(),
          });
          return;
        }

        if (msg.type === 'webrtc:answer') {
          const sdp = msg.sdp as RTCSessionDescriptionInit;
          const pc = pcRef.current;
          if (pc && sdp) {
            await pc.setRemoteDescription(new RTCSessionDescription(sdp));
            for (const ice of pendingIceRef.current) {
              await pc.addIceCandidate(new RTCIceCandidate(ice));
            }
            pendingIceRef.current = [];
          }
          return;
        }

        if (msg.type === 'webrtc:ice') {
          const candidate = msg.candidate as RTCIceCandidateInit;
          const pc = pcRef.current;
          if (pc && candidate) {
            if (pc.remoteDescription) {
              await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } else {
              pendingIceRef.current.push(candidate);
            }
          }
          return;
        }

        if (msg.type === 'webrtc:cancel') {
          setIncomingOffer(null);
          activeIncomingOfferRef.current = null;
          setProgress((prev) => ({
            ...prev,
            phase: 'cancelled',
            speedBytesPerSec: 0,
            etaSeconds: null,
          }));
          void closePeerConnection();
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (!closedByUnmount) {
          const delay = Math.min(1000 * Math.pow(1.6, attempt), 8000);
          attempt += 1;
          reconnectTimer = window.setTimeout(connectWs, delay);
        }
      };
    };

    void connectWs();

    return () => {
      closedByUnmount = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      wsRef.current?.close();
      void closePeerConnection();
    };
  }, [closePeerConnection, createPeerConnection, customServerHost, sendWs]);



  const lookupPairCode = useCallback(
    (code: string) => {
      setPairError(null);
      const cleaned = code.replace(/\D/g, '').slice(0, 6);
      if (cleaned.length !== 6) {
        setPairError('Masukkan 6 digit kode perangkat tujuan.');
        return;
      }
      if (selfPeerRef.current && cleaned === selfPeerRef.current.pairCode) {
        setPairError('Itu kode perangkat ini sendiri.');
        return;
      }
      sendWs({ type: 'pair:lookup', code: cleaned });
    },
    [sendWs]
  );

  const addFilesToQueue = useCallback((items: BatchFileItem[]) => {
    setQueue((prev) => [...prev, ...items]);
  }, []);

  const removeQueueItem = useCallback((id: string) => {
    setQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  const sendBatchToPeer = useCallback(
    async (targetPeer: PeerInfo) => {
      const filesToSend = queueRef.current;
      if (filesToSend.length === 0) return;

      cancelFlagRef.current = false;
      const transferId = `tx-${Date.now()}`;
      activeTransferIdRef.current = transferId;
      const totalBytes = filesToSend.reduce((sum, f) => sum + f.size, 0);
      totalBytesRef.current = totalBytes;
      transferredBytesRef.current = 0;

      setQueue((prev) =>
        prev.map((item) => ({ ...item, bytesTransferred: 0, progress: 0, status: 'waiting-accept' }))
      );

      setProgress({
        phase: 'connecting',
        direction: 'send',
        transferId,
        remotePeer: targetPeer,
        activeFileIndex: 0,
        totalFiles: filesToSend.length,
        totalBytes,
        transferredBytes: 0,
        speedBytesPerSec: 0,
        peakSpeedBytesPerSec: 0,
        etaSeconds: null,
        usingDirectDiskWrite: false,
      });

      sendWs({ type: 'peer:update', status: 'transferring' });

      try {
        await closePeerConnection();
        sendWs({ type: 'peer:update', status: 'transferring' });

        const pc = createPeerConnection(targetPeer);
        const dc = pc.createDataChannel('eztransfer', { ordered: true });
        attachDataChannel(dc);

        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(
            () => reject(new Error('Waktu tunggu koneksi P2P habis. Pastikan kedua perangkat aktif.')),
            15000
          );
          dc.onopen = () => {
            window.clearTimeout(timeout);
            resolve();
          };
          dc.onerror = () => {
            window.clearTimeout(timeout);
            reject(new Error('Gagal membuka saluran data WiFi P2P.'));
          };

          pc.createOffer()
            .then((offer) => pc.setLocalDescription(offer))
            .then(() => {
              sendWs({
                type: 'webrtc:offer',
                targetPeerId: targetPeer.id,
                sdp: pc.localDescription?.toJSON(),
              });
            })
            .catch(reject);
        });

        if (cancelFlagRef.current) return;

        // Send batch offer metadata
        setProgress((prev) => ({ ...prev, phase: 'waiting-accept' }));
        sendDcJson({
          type: 'batch-offer-start',
          transferId,
          senderName: selfPeerRef.current?.name || deviceNameRef.current,
        });

        for (const item of filesToSend) {
          sendDcJson({
            type: 'batch-offer-file',
            file: {
              id: item.id,
              name: item.name,
              size: item.size,
              mimeType: item.mimeType,
              category: item.category,
              previewDataUrl: item.previewDataUrl,
              duration: item.duration,
              width: item.width,
              height: item.height,
            } satisfies RemoteFilePreview,
          });
        }
        sendDcJson({ type: 'batch-offer-end' });

        const accepted = await new Promise<boolean>((resolve) => {
          acceptResolverRef.current = resolve;
        });

        if (!accepted || cancelFlagRef.current) {
          const wasCancelled = cancelFlagRef.current;
          setProgress((prev) => ({
            ...prev,
            phase: wasCancelled ? 'cancelled' : 'rejected',
            speedBytesPerSec: 0,
            etaSeconds: null,
          }));
          setQueue((prev) =>
            prev.map((item) => ({ ...item, status: wasCancelled ? 'cancelled' : 'queued' }))
          );
          appendHistory({
            id: transferId,
            direction: 'send',
            peerName: targetPeer.name,
            fileCount: filesToSend.length,
            totalBytes,
            firstFileName: filesToSend[0].name,
            avgSpeedBytesPerSec: 0,
            status: wasCancelled ? 'cancelled' : 'rejected',
            timestamp: Date.now(),
          });
          await closePeerConnection();
          return;
        }

        // Start streaming chunks
        setProgress((prev) => ({ ...prev, phase: 'transferring' }));
        startSpeedTicker();

        for (let i = 0; i < filesToSend.length; i++) {
          if (cancelFlagRef.current) break;
          const item = filesToSend[i];

          setProgress((prev) => ({ ...prev, activeFileIndex: i }));
          setQueue((prev) =>
            prev.map((q) => (q.id === item.id ? { ...q, status: 'transferring' } : q))
          );

          sendDcJson({ type: 'file-start', fileId: item.id, index: i });

          let offset = 0;
          while (offset < item.file.size) {
            if (cancelFlagRef.current) break;
            if (dc.readyState !== 'open') {
              throw new Error('Saluran transfer terputus di tengah pengiriman.');
            }

            if (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
              await new Promise<void>((resolve) => {
                let done = false;
                const finish = () => {
                  if (done) return;
                  done = true;
                  dc.removeEventListener('bufferedamountlow', onLow);
                  window.clearTimeout(fallbackTimer);
                  resolve();
                };
                const onLow = () => finish();
                const fallbackTimer = window.setTimeout(finish, 40);
                dc.addEventListener('bufferedamountlow', onLow);
              });
            }

            const end = Math.min(offset + CHUNK_SIZE, item.file.size);
            const sliceBuffer = await item.file.slice(offset, end).arrayBuffer();
            dc.send(sliceBuffer);

            const sentLen = sliceBuffer.byteLength;
            offset = end;
            transferredBytesRef.current += sentLen;
            speedSamplesRef.current.push({ time: Date.now(), bytes: sentLen });

            const pct = item.size > 0 ? Math.min(100, Math.round((offset / item.size) * 100)) : 100;
            // Throttle per-file state updates slightly for smooth 60fps UI
            if (pct === 100 || offset % (CHUNK_SIZE * 8) === 0) {
              setQueue((prev) =>
                prev.map((q) =>
                  q.id === item.id ? { ...q, bytesTransferred: offset, progress: pct } : q
                )
              );
            }
          }

          if (cancelFlagRef.current) break;

          sendDcJson({ type: 'file-end', fileId: item.id });

          // Wait for receiver acknowledgment before advancing
          const ackId = await new Promise<string>((resolve) => {
            fileAckResolverRef.current = resolve;
          });
          if (ackId === '__cancelled__' || cancelFlagRef.current) break;

          setQueue((prev) =>
            prev.map((q) =>
              q.id === item.id ? { ...q, bytesTransferred: q.size, progress: 100, status: 'completed' } : q
            )
          );
        }

        if (cancelFlagRef.current) {
          setProgress((prev) => ({ ...prev, phase: 'cancelled', speedBytesPerSec: 0, etaSeconds: null }));
          await closePeerConnection();
          return;
        }

        sendDcJson({ type: 'batch-complete' });
        stopSpeedTicker();
        const elapsedSec = Math.max((Date.now() - transferStartTimeRef.current) / 1000, 0.2);
        const avgSpeed = totalBytes / elapsedSec;

        appendHistory({
          id: transferId,
          direction: 'send',
          peerName: targetPeer.name,
          fileCount: filesToSend.length,
          totalBytes,
          firstFileName: filesToSend[0].name,
          avgSpeedBytesPerSec: avgSpeed,
          status: 'completed',
          timestamp: Date.now(),
        });

        setProgress((prev) => ({
          ...prev,
          phase: 'completed',
          transferredBytes: totalBytes,
          speedBytesPerSec: 0,
          etaSeconds: 0,
        }));
        await closePeerConnection();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Terjadi kesalahan saat transfer.';
        setProgress((prev) => ({
          ...prev,
          phase: 'error',
          errorMessage: msg,
          speedBytesPerSec: 0,
          etaSeconds: null,
        }));
        appendHistory({
          id: transferId,
          direction: 'send',
          peerName: targetPeer.name,
          fileCount: filesToSend.length,
          totalBytes,
          firstFileName: filesToSend[0].name,
          avgSpeedBytesPerSec: 0,
          status: 'error',
          timestamp: Date.now(),
        });
        await closePeerConnection();
      }
    },
    [
      appendHistory,
      attachDataChannel,
      closePeerConnection,
      createPeerConnection,
      sendDcJson,
      sendWs,
      startSpeedTicker,
      stopSpeedTicker,
    ]
  );

  const acceptIncomingOffer = useCallback(async () => {
    const offer = incomingOffer;
    if (!offer) return;

    cancelFlagRef.current = false;
    dirHandleRef.current = null;
    singleFileHandleRef.current = null;
    let usingDisk = false;

    // Attempt direct disk write via File System Access API (works in standalone Windows Edge/Chrome)
    // Inside Android APK, EzFileSaver automatically writes directly to Download/EzTransfer.
    try {
      if (isNativeAndroid()) {
        usingDisk = true;
      } else if (offer.files.length === 1 && typeof window.showSaveFilePicker === 'function') {
        singleFileHandleRef.current = await window.showSaveFilePicker({
          suggestedName: sanitizeFileName(offer.files[0].name),
        });
        usingDisk = true;
      } else if (offer.files.length > 1 && typeof window.showDirectoryPicker === 'function') {
        dirHandleRef.current = await window.showDirectoryPicker({ mode: 'readwrite' });
        usingDisk = true;
      }
    } catch (err) {
      // User cancelled native picker or iframe blocked picker -> fallback cleanly or abort only if not AbortError?
      // If SecurityError (e.g. iframe), fall back to browser download seamlessly.
      const errName = err instanceof Error ? err.name : '';
      if (errName === 'AbortError') {
        return; // Keep confirmation dialog open so user can pick folder or decline
      }
      dirHandleRef.current = null;
      singleFileHandleRef.current = null;
      usingDisk = false;
    }

    setIncomingOffer(null);
    totalBytesRef.current = offer.totalBytes;
    transferredBytesRef.current = 0;

    setIncomingFilesProgress(
      offer.files.map((f) => ({
        ...f,
        bytesReceived: 0,
        progress: 0,
        done: false,
      }))
    );

    setProgress({
      phase: 'transferring',
      direction: 'receive',
      transferId: offer.transferId,
      remotePeer: offer.fromPeer,
      activeFileIndex: 0,
      totalFiles: offer.files.length,
      totalBytes: offer.totalBytes,
      transferredBytes: 0,
      speedBytesPerSec: 0,
      peakSpeedBytesPerSec: 0,
      etaSeconds: null,
      usingDirectDiskWrite: usingDisk,
    });

    sendWs({ type: 'peer:update', status: 'transferring' });
    startSpeedTicker();
    sendDcJson({ type: 'batch-accept', transferId: offer.transferId });
  }, [incomingOffer, sendDcJson, sendWs, startSpeedTicker]);

  const rejectIncomingOffer = useCallback(async () => {
    const offer = incomingOffer;
    if (!offer) return;
    setIncomingOffer(null);
    activeIncomingOfferRef.current = null;
    sendDcJson({ type: 'batch-reject', transferId: offer.transferId });
    appendHistory({
      id: offer.transferId,
      direction: 'receive',
      peerName: offer.fromPeer.name,
      fileCount: offer.files.length,
      totalBytes: offer.totalBytes,
      firstFileName: offer.files[0]?.name || 'File',
      avgSpeedBytesPerSec: 0,
      status: 'rejected',
      timestamp: Date.now(),
    });
    await closePeerConnection();
  }, [appendHistory, closePeerConnection, incomingOffer, sendDcJson]);

  const cancelTransfer = useCallback(async () => {
    cancelFlagRef.current = true;
    sendDcJson({ type: 'transfer-cancel', transferId: activeTransferIdRef.current });
    if (activeRemotePeerRef.current) {
      sendWs({ type: 'webrtc:cancel', targetPeerId: activeRemotePeerRef.current.id });
    }
    if (acceptResolverRef.current) {
      acceptResolverRef.current(false);
      acceptResolverRef.current = null;
    }
    if (fileAckResolverRef.current) {
      fileAckResolverRef.current('__cancelled__');
      fileAckResolverRef.current = null;
    }
    setProgress((prev) => ({
      ...prev,
      phase: 'cancelled',
      speedBytesPerSec: 0,
      etaSeconds: null,
    }));
    await closePeerConnection();
  }, [closePeerConnection, sendDcJson, sendWs]);

  const resetProgress = useCallback(() => {
    setProgress(INITIAL_PROGRESS);
    setIncomingFilesProgress([]);
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    try {
      localStorage.removeItem('eztransfer_history');
    } catch {
      // ignore
    }
  }, []);

  const setCustomServerHost = useCallback((host: string) => {
    const cleaned = host.trim();
    setCustomServerHostState(cleaned);
    try {
      if (cleaned) {
        localStorage.setItem('eztransfer_custom_host', cleaned);
      } else {
        localStorage.removeItem('eztransfer_custom_host');
      }
    } catch {
      // ignore storage restrictions
    }
  }, []);

  return {
    wsConnected,
    selfPeer,
    nearbyPeers,
    pairedPeer,
    pairError,
    queue,
    incomingOffer,
    incomingFilesProgress,
    progress,
    history,
    nativeServerInfo,
    customServerHost,
    setCustomServerHost,
    lookupPairCode,
    setPairedPeer,
    addFilesToQueue,
    removeQueueItem,
    clearQueue,
    sendBatchToPeer,
    acceptIncomingOffer,
    rejectIncomingOffer,
    cancelTransfer,
    resetProgress,
    clearHistory,
  };
}

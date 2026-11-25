import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  BatchFileItem,
  IncomingFileProgress,
  IncomingOffer,
  PeerInfo,
  ReceivedFileRecord,
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

const NATIVE_FLUSH_BYTES = 2 * 1024 * 1024; // Flush every 2 MB to Android MediaStore (WebRTC fallback)
const READ_BLOCK_SIZE = 2 * 1024 * 1024; // Read 2 MB blocks at a time to avoid per-64KB disk IPC overhead

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for safe, fast SCTP transfer
const MAX_BUFFERED_AMOUNT = 6 * 1024 * 1024; // 6 MB backpressure cap
const LOW_BUFFERED_THRESHOLD = 2 * 1024 * 1024; // 2 MB low-water mark

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

async function probeLanReachable(lanUrl?: string): Promise<boolean> {
  if (!lanUrl || window.location.protocol !== 'http:' || !lanUrl.startsWith('http://')) {
    return false;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 1600);
  try {
    const res = await fetch(`${lanUrl.replace(/\/+$/, '')}/api/health`, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

export function useWifiTransfer() {
  const [wsConnected, setWsConnected] = useState(false);
  const [selfPeer, setSelfPeer] = useState<PeerInfo | null>(null);
  const [nearbyPeers, setNearbyPeers] = useState<PeerInfo[]>([]);
  const [pairedPeer, setPairedPeer] = useState<PeerInfo | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [queue, setQueue] = useState<BatchFileItem[]>([]);
  const [incomingOffer, setIncomingOffer] = useState<IncomingOffer | null>(null);
  const [incomingFilesProgress, setIncomingFilesProgress] = useState<IncomingFileProgress[]>([]);
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
  const nearbyPeersRef = useRef<PeerInfo[]>([]);
  const lanUrlRef = useRef<string>('');
  const initialDevice = detectDeviceInfo();
  const deviceNameRef = useRef<string>(initialDevice.defaultName);
  const deviceTypeRef = useRef(initialDevice.deviceType);

  // Active transfer session refs
  const cancelFlagRef = useRef(false);
  const activeRemotePeerRef = useRef<PeerInfo | null>(null);
  const activeTransferIdRef = useRef<string | null>(null);
  const acceptResolverRef = useRef<((accepted: boolean) => void) | null>(null);
  const fileAckResolverRef = useRef<((fileId: string) => void) | null>(null);

  // Direct LAN TCP mode refs
  const directTransferRef = useRef<{
    isDirect: boolean;
    targetPeerId: string;
    transferId: string;
  } | null>(null);
  const directOfferRef = useRef<IncomingOffer | null>(null);
  const activeXhrRef = useRef<XMLHttpRequest | null>(null);
  const directBytesByFileRef = useRef<Map<string, number>>(new Map());

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
  const nativeSavedMetaRef = useRef<{ savedPath?: string; contentUri?: string }>({});
  const receivedBatchFilesRef = useRef<ReceivedFileRecord[]>([]);
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
    if (activeXhrRef.current) {
      try {
        activeXhrRef.current.abort();
      } catch {
        // ignore abort error
      }
      activeXhrRef.current = null;
    }
    directTransferRef.current = null;
    directOfferRef.current = null;
    directBytesByFileRef.current.clear();

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
    nativeSavedMetaRef.current = {};
    receivedBatchFilesRef.current = [];
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
            nativeSavedMetaRef.current = {};

            const safeName = sanitizeFileName(fileMeta.name);
            if (isNativeAndroid()) {
              try {
                const opened = await EzFileSaver.openFile({
                  transferId: fileId,
                  fileName: safeName,
                  mimeType: fileMeta.mimeType || 'application/octet-stream',
                });
                nativeSavingFileIdRef.current = fileId;
                nativeSavedMetaRef.current = {
                  savedPath: opened.savedPath,
                  contentUri: opened.contentUri,
                };
                usingNativeSaver = true;
                usingDisk = true;
              } catch (err) {
                const reason =
                  err instanceof Error && err.message
                    ? err.message
                    : 'Izin penyimpanan HP ditolak atau folder Download penuh.';
                cancelFlagRef.current = true;
                sendDcJson({ type: 'transfer-cancel', transferId: offer?.transferId });
                setProgress((prev) => ({
                  ...prev,
                  phase: 'error',
                  errorMessage: `Gagal menyimpan ${safeName}: ${reason}`,
                  speedBytesPerSec: 0,
                  etaSeconds: null,
                }));
                void closePeerConnection();
                return;
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

            let savedPath: string | undefined;
            let contentUri: string | undefined;
            let previewUrl: string | undefined;

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
              const closed = await EzFileSaver.closeFile({ transferId: fileId, abort: false });
              savedPath = closed.savedPath || nativeSavedMetaRef.current.savedPath;
              contentUri = closed.contentUri || nativeSavedMetaRef.current.contentUri;
              nativeSavingFileIdRef.current = null;
              nativeSavedMetaRef.current = {};
            } else if (current.usingDisk && currentWritableRef.current) {
              await currentWritableRef.current.close();
              currentWritableRef.current = null;
              savedPath = sanitizeFileName(current.file.name);
            } else {
              const blob = new Blob(currentBlobChunksRef.current as BlobPart[], {
                type: current.file.mimeType || 'application/octet-stream',
              });
              previewUrl = URL.createObjectURL(blob);
              triggerBrowserDownload(blob, sanitizeFileName(current.file.name));
              currentBlobChunksRef.current = [];
            }

            const offer = activeIncomingOfferRef.current;
            receivedBatchFilesRef.current.push({
              id: current.file.id,
              name: current.file.name,
              size: current.file.size,
              mimeType: current.file.mimeType,
              category: current.file.category,
              savedPath,
              contentUri,
              previewUrl,
              peerName: offer?.fromPeer.name || 'Pengirim',
              timestamp: Date.now(),
            });

            setIncomingFilesProgress((prev) =>
              prev.map((item) =>
                item.id === fileId
                  ? { ...item, progress: 100, done: true, savedPath, contentUri, previewUrl }
                  : item
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
              const persistedFiles: ReceivedFileRecord[] = receivedBatchFilesRef.current.map(
                ({ previewUrl: _omit, ...rest }) => rest
              );
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
                files: persistedFiles,
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

  // Direct LAN TCP native event listeners (receiver side progress & completion)
  useEffect(() => {
    if (!isNativeAndroid()) return;
    let cancelled = false;
    const handles: Array<{ remove: () => Promise<void> }> = [];

    const setupListeners = async () => {
      try {
        const progHandle = await EzWifiServer.addListener('directFileProgress', (ev) => {
          const offer = activeIncomingOfferRef.current;
          if (!offer || offer.transferId !== ev.transferId) return;

          const prevBytes = directBytesByFileRef.current.get(ev.fileId) || 0;
          const nextBytes = Math.max(prevBytes, ev.bytesReceived);
          const delta = nextBytes - prevBytes;
          directBytesByFileRef.current.set(ev.fileId, nextBytes);

          if (delta > 0) {
            transferredBytesRef.current += delta;
            speedSamplesRef.current.push({ time: Date.now(), bytes: delta });
          }

          const fileIndex = offer.files.findIndex((f) => f.id === ev.fileId);
          const fileMeta = fileIndex >= 0 ? offer.files[fileIndex] : undefined;
          const denom = fileMeta?.size || ev.totalBytes || 1;
          const pct = denom > 0 ? Math.min(100, Math.round((nextBytes / denom) * 100)) : 100;

          if (fileIndex >= 0) {
            setProgress((prev) => ({
              ...prev,
              activeFileIndex: fileIndex,
            }));
          }

          setIncomingFilesProgress((prev) =>
            prev.map((item) =>
              item.id === ev.fileId ? { ...item, bytesReceived: nextBytes, progress: pct } : item
            )
          );
        });
        if (!cancelled) {
          handles.push(progHandle);
        } else {
          void progHandle.remove();
        }

        const doneHandle = await EzWifiServer.addListener('directFileComplete', (ev) => {
          const offer = activeIncomingOfferRef.current;
          if (!offer || offer.transferId !== ev.transferId) return;

          const fileMeta = offer.files.find((f) => f.id === ev.fileId);
          if (fileMeta) {
            const prevBytes = directBytesByFileRef.current.get(ev.fileId) || 0;
            const delta = Math.max(0, fileMeta.size - prevBytes);
            directBytesByFileRef.current.set(ev.fileId, fileMeta.size);
            if (delta > 0) {
              transferredBytesRef.current += delta;
              speedSamplesRef.current.push({ time: Date.now(), bytes: delta });
            }

            const alreadySaved = receivedBatchFilesRef.current.some((f) => f.id === fileMeta.id);
            if (!alreadySaved) {
              receivedBatchFilesRef.current.push({
                id: fileMeta.id,
                name: fileMeta.name,
                size: fileMeta.size,
                mimeType: fileMeta.mimeType,
                category: fileMeta.category,
                savedPath: ev.savedPath,
                contentUri: ev.contentUri,
                peerName: offer.fromPeer.name || 'Pengirim',
                timestamp: Date.now(),
              });
            }
          }

          setIncomingFilesProgress((prev) =>
            prev.map((item) =>
              item.id === ev.fileId
                ? {
                    ...item,
                    bytesReceived: item.size,
                    progress: 100,
                    done: true,
                    savedPath: ev.savedPath,
                    contentUri: ev.contentUri,
                  }
                : item
            )
          );
        });
        if (!cancelled) {
          handles.push(doneHandle);
        } else {
          void doneHandle.remove();
        }
      } catch {
        // ignore listener setup issues on non-native environments
      }
    };

    void setupListeners();

    return () => {
      cancelled = true;
      for (const h of handles) {
        void h.remove();
      }
    };
  }, []);

  // WebSocket signaling lifecycle
  useEffect(() => {
    let closedByUnmount = false;
    let reconnectTimer: number | null = null;
    let discoveryTimer: number | null = null;
    let activeWsUrl = '';
    let attempt = 0;

    const resolveWsTarget = async (): Promise<string> => {
      if (isNativeAndroid()) {
        let info: NativeServerInfo | null = null;
        try {
          info = await EzWifiServer.startServer();
          if (!closedByUnmount) {
            setNativeServerInfo(info);
            if (info.url) {
              lanUrlRef.current = info.url;
            }
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

        if (info?.recommendedWsUrl) {
          return info.recommendedWsUrl;
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
      activeWsUrl = wsUrl;
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
            ...(lanUrlRef.current ? { lanUrl: lanUrlRef.current } : {}),
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
                ...(lanUrlRef.current ? { lanUrl: lanUrlRef.current } : {}),
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
          const list = (msg.peers as PeerInfo[]) || [];
          nearbyPeersRef.current = list;
          setNearbyPeers(list);
          setPairedPeer((prev) => (prev ? list.find((p) => p.id === prev.id) || prev : null));
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
          if (acceptResolverRef.current) {
            acceptResolverRef.current(false);
            acceptResolverRef.current = null;
          }
          setProgress((prev) => ({
            ...prev,
            phase: 'error',
            errorMessage: String(msg.error || 'Perangkat tujuan tidak dapat dijangkau.'),
          }));
          void closePeerConnection();
          return;
        }

        if (msg.type === 'direct:offer') {
          const fromPeer = msg.fromPeer as PeerInfo;
          const transferId = String(msg.transferId || '');
          const files = (msg.files as RemoteFilePreview[]) || [];
          const totalBytes = Number(msg.totalBytes || files.reduce((sum, f) => sum + f.size, 0));
          if (!fromPeer || !transferId || files.length === 0) return;

          await closePeerConnection();
          const offer: IncomingOffer = {
            transferId,
            fromPeer,
            files,
            totalBytes,
          };
          directOfferRef.current = offer;
          directTransferRef.current = {
            isDirect: true,
            targetPeerId: fromPeer.id,
            transferId,
          };
          activeIncomingOfferRef.current = offer;
          activeRemotePeerRef.current = fromPeer;
          activeTransferIdRef.current = transferId;
          setIncomingOffer(offer);
          return;
        }

        if (msg.type === 'direct:accept') {
          const accepted = Boolean(msg.accepted);
          if (acceptResolverRef.current) {
            acceptResolverRef.current(accepted);
            acceptResolverRef.current = null;
          }
          return;
        }

        if (msg.type === 'direct:complete') {
          stopSpeedTicker();
          const offer = activeIncomingOfferRef.current;
          const elapsedSec = Math.max((Date.now() - transferStartTimeRef.current) / 1000, 0.2);
          const avgSpeed = offer ? offer.totalBytes / elapsedSec : 0;

          if (offer) {
            const persistedFiles: ReceivedFileRecord[] = receivedBatchFilesRef.current.map(
              ({ previewUrl: _omit, ...rest }) => rest
            );
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
              files: persistedFiles,
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
          return;
        }

        if (msg.type === 'direct:cancel') {
          cancelFlagRef.current = true;
          if (acceptResolverRef.current) {
            acceptResolverRef.current(false);
            acceptResolverRef.current = null;
          }
          if (activeXhrRef.current) {
            try {
              activeXhrRef.current.abort();
            } catch {
              // ignore
            }
            activeXhrRef.current = null;
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

    if (isNativeAndroid()) {
      discoveryTimer = window.setInterval(() => {
        if (closedByUnmount || pcRef.current || directTransferRef.current) return;
        void EzWifiServer.getServerInfo()
          .then((info) => {
            if (closedByUnmount) return;
            setNativeServerInfo(info);
            if (info.url && info.url !== lanUrlRef.current) {
              lanUrlRef.current = info.url;
              if (wsRef.current?.readyState === WebSocket.OPEN) {
                wsRef.current.send(JSON.stringify({ type: 'peer:update', lanUrl: info.url }));
              }
            }
            if (!customServerHost.trim()) {
              const nextUrl = info.recommendedWsUrl || info.wsUrl;
              if (nextUrl && activeWsUrl && nextUrl !== activeWsUrl) {
                attempt = 0;
                wsRef.current?.close();
              }
            }
          })
          .catch(() => {
            // ignore discovery poll error
          });
      }, 3500);
    }

    return () => {
      closedByUnmount = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (discoveryTimer !== null) window.clearInterval(discoveryTimer);
      wsRef.current?.close();
      void closePeerConnection();
    };
  }, [appendHistory, closePeerConnection, createPeerConnection, customServerHost, sendWs, stopSpeedTicker]);



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
    async (targetPeerArg: PeerInfo) => {
      const filesToSend = queueRef.current;
      if (filesToSend.length === 0) return;

      const freshPeer = nearbyPeersRef.current.find((p) => p.id === targetPeerArg.id);
      const targetPeer = freshPeer ? { ...targetPeerArg, ...freshPeer } : targetPeerArg;

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
        activeRemotePeerRef.current = targetPeer;
        sendWs({ type: 'peer:update', status: 'transferring' });

        // Prefer Direct LAN HTTP/TCP Streaming when receiver's LAN endpoint is directly reachable (full WiFi speed!)
        const targetLanUrl = targetPeer.lanUrl?.trim() || '';
        const canUseDirectLan = targetLanUrl ? await probeLanReachable(targetLanUrl) : false;

        if (canUseDirectLan && !cancelFlagRef.current) {
          directTransferRef.current = {
            isDirect: true,
            targetPeerId: targetPeer.id,
            transferId,
          };

          setProgress((prev) => ({
            ...prev,
            phase: 'waiting-accept',
            usingDirectDiskWrite: true,
          }));

          sendWs({
            type: 'direct:offer',
            targetPeerId: targetPeer.id,
            transferId,
            files: filesToSend.map((item) => ({
              id: item.id,
              name: item.name,
              size: item.size,
              mimeType: item.mimeType,
              category: item.category,
              previewDataUrl: item.previewDataUrl,
              duration: item.duration,
              width: item.width,
              height: item.height,
            } satisfies RemoteFilePreview)),
            totalBytes,
          });

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

          setProgress((prev) => ({ ...prev, phase: 'transferring', usingDirectDiskWrite: true }));
          startSpeedTicker();

          for (let i = 0; i < filesToSend.length; i++) {
            if (cancelFlagRef.current) break;
            const item = filesToSend[i];

            setProgress((prev) => ({ ...prev, activeFileIndex: i }));
            setQueue((prev) =>
              prev.map((q) => (q.id === item.id ? { ...q, status: 'transferring' } : q))
            );

            await new Promise<void>((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              activeXhrRef.current = xhr;
              const qs = new URLSearchParams({
                transferId,
                fileId: item.id,
                fileName: item.name,
                mimeType: item.mimeType || 'application/octet-stream',
                fileSize: String(item.size),
              });
              const uploadUrl = `${targetLanUrl.replace(/\/+$/, '')}/api/direct-upload?${qs.toString()}`;
              let lastLoaded = 0;
              let lastUiUpdate = 0;

              xhr.open('POST', uploadUrl, true);
              xhr.setRequestHeader('Content-Type', 'application/octet-stream');

              xhr.upload.onprogress = (ev) => {
                const loaded = Math.min(ev.loaded, item.size > 0 ? item.size : ev.loaded);
                const delta = Math.max(0, loaded - lastLoaded);
                lastLoaded = loaded;
                if (delta > 0) {
                  transferredBytesRef.current += delta;
                  speedSamplesRef.current.push({ time: Date.now(), bytes: delta });
                }
                const now = Date.now();
                if (now - lastUiUpdate >= 120 || loaded >= item.size) {
                  lastUiUpdate = now;
                  const pct =
                    item.size > 0 ? Math.min(100, Math.round((loaded / item.size) * 100)) : 100;
                  setQueue((prev) =>
                    prev.map((q) =>
                      q.id === item.id ? { ...q, bytesTransferred: loaded, progress: pct } : q
                    )
                  );
                }
              };

              xhr.onload = () => {
                activeXhrRef.current = null;
                if (xhr.status >= 200 && xhr.status < 300) {
                  const remaining = Math.max(0, item.size - lastLoaded);
                  if (remaining > 0) {
                    transferredBytesRef.current += remaining;
                    speedSamplesRef.current.push({ time: Date.now(), bytes: remaining });
                  }
                  resolve();
                } else {
                  let errMsg = `Gagal mengirim file (HTTP ${xhr.status}).`;
                  try {
                    const parsed = JSON.parse(xhr.responseText);
                    if (parsed?.error) errMsg = String(parsed.error);
                  } catch {
                    // ignore JSON parse failure
                  }
                  reject(new Error(errMsg));
                }
              };

              xhr.onerror = () => {
                activeXhrRef.current = null;
                reject(new Error('Koneksi Direct WiFi TCP terputus di tengah pengiriman.'));
              };

              xhr.onabort = () => {
                activeXhrRef.current = null;
                reject(new Error('__CANCELLED__'));
              };

              xhr.send(item.file);
            });

            if (cancelFlagRef.current) break;

            setQueue((prev) =>
              prev.map((q) =>
                q.id === item.id
                  ? { ...q, bytesTransferred: q.size, progress: 100, status: 'completed' }
                  : q
              )
            );
          }

          if (cancelFlagRef.current) {
            setProgress((prev) => ({
              ...prev,
              phase: 'cancelled',
              speedBytesPerSec: 0,
              etaSeconds: null,
            }));
            await closePeerConnection();
            return;
          }

          sendWs({
            type: 'direct:complete',
            targetPeerId: targetPeer.id,
            transferId,
          });
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
          return;
        }

        // WebRTC fallback (browser peers or non-direct networks) with 2 MB read-ahead buffer
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

        // Start streaming chunks with 2 MB block reads
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
          let lastUiTick = 0;
          while (offset < item.file.size) {
            if (cancelFlagRef.current) break;

            const blockEnd = Math.min(offset + READ_BLOCK_SIZE, item.file.size);
            const blockBuffer = await item.file.slice(offset, blockEnd).arrayBuffer();
            const blockView = new Uint8Array(blockBuffer);

            let innerOffset = 0;
            while (innerOffset < blockView.byteLength) {
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
                  const fallbackTimer = window.setTimeout(finish, 80);
                  dc.addEventListener('bufferedamountlow', onLow);
                });
              }

              const chunkEnd = Math.min(innerOffset + CHUNK_SIZE, blockView.byteLength);
              const chunkSlice = blockView.subarray(innerOffset, chunkEnd);
              dc.send(chunkSlice as Uint8Array<ArrayBuffer>);

              const sentLen = chunkSlice.byteLength;
              innerOffset = chunkEnd;
              offset += sentLen;
              transferredBytesRef.current += sentLen;
              speedSamplesRef.current.push({ time: Date.now(), bytes: sentLen });

              const now = Date.now();
              if (now - lastUiTick >= 120 || offset >= item.size) {
                lastUiTick = now;
                const pct =
                  item.size > 0 ? Math.min(100, Math.round((offset / item.size) * 100)) : 100;
                setQueue((prev) =>
                  prev.map((q) =>
                    q.id === item.id ? { ...q, bytesTransferred: offset, progress: pct } : q
                  )
                );
              }
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
        if (cancelFlagRef.current || (err instanceof Error && err.message === '__CANCELLED__')) {
          setProgress((prev) => ({
            ...prev,
            phase: 'cancelled',
            speedBytesPerSec: 0,
            etaSeconds: null,
          }));
          await closePeerConnection();
          return;
        }
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
    const isDirect = Boolean(directOfferRef.current && directOfferRef.current.transferId === offer.transferId);

    // Attempt direct disk write via File System Access API (works in standalone Windows Edge/Chrome)
    // Inside Android APK, EzFileSaver/EzStorageHelper automatically writes directly to Download/EzTransfer.
    try {
      if (isNativeAndroid()) {
        const perm = await EzFileSaver.ensureStoragePermission();
        if (!perm.granted) {
          setProgress((prev) => ({
            ...prev,
            phase: 'error',
            errorMessage: 'Izin penyimpanan diperlukan untuk menyimpan file ke folder Download.',
          }));
          if (isDirect) {
            sendWs({
              type: 'direct:accept',
              targetPeerId: offer.fromPeer.id,
              transferId: offer.transferId,
              accepted: false,
            });
          } else {
            sendDcJson({ type: 'batch-reject', transferId: offer.transferId });
          }
          setIncomingOffer(null);
          activeIncomingOfferRef.current = null;
          await closePeerConnection();
          return;
        }
        usingDisk = true;
      } else if (!isDirect && offer.files.length === 1 && typeof window.showSaveFilePicker === 'function') {
        singleFileHandleRef.current = await window.showSaveFilePicker({
          suggestedName: sanitizeFileName(offer.files[0].name),
        });
        usingDisk = true;
      } else if (!isDirect && offer.files.length > 1 && typeof window.showDirectoryPicker === 'function') {
        dirHandleRef.current = await window.showDirectoryPicker({ mode: 'readwrite' });
        usingDisk = true;
      }
    } catch (err) {
      const errName = err instanceof Error ? err.name : '';
      if (errName === 'AbortError') {
        return; // Keep confirmation dialog open so user can pick folder or decline
      }
      dirHandleRef.current = null;
      singleFileHandleRef.current = null;
      usingDisk = false;
    }

    setIncomingOffer(null);
    activeTransferIdRef.current = offer.transferId;
    totalBytesRef.current = offer.totalBytes;
    transferredBytesRef.current = 0;
    receivedBatchFilesRef.current = [];
    directBytesByFileRef.current.clear();

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
    if (isDirect) {
      sendWs({
        type: 'direct:accept',
        targetPeerId: offer.fromPeer.id,
        transferId: offer.transferId,
        accepted: true,
      });
    } else {
      sendDcJson({ type: 'batch-accept', transferId: offer.transferId });
    }
  }, [closePeerConnection, incomingOffer, sendDcJson, sendWs, startSpeedTicker]);

  const rejectIncomingOffer = useCallback(async () => {
    const offer = incomingOffer;
    if (!offer) return;
    const isDirect = Boolean(directOfferRef.current && directOfferRef.current.transferId === offer.transferId);
    setIncomingOffer(null);
    activeIncomingOfferRef.current = null;
    if (isDirect) {
      sendWs({
        type: 'direct:accept',
        targetPeerId: offer.fromPeer.id,
        transferId: offer.transferId,
        accepted: false,
      });
    } else {
      sendDcJson({ type: 'batch-reject', transferId: offer.transferId });
    }
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
  }, [appendHistory, closePeerConnection, incomingOffer, sendDcJson, sendWs]);

  const cancelTransfer = useCallback(async () => {
    cancelFlagRef.current = true;
    const activeDirect = directTransferRef.current;
    if (activeXhrRef.current) {
      try {
        activeXhrRef.current.abort();
      } catch {
        // ignore
      }
      activeXhrRef.current = null;
    }
    if (activeDirect?.isDirect) {
      sendWs({
        type: 'direct:cancel',
        targetPeerId: activeDirect.targetPeerId,
        transferId: activeDirect.transferId,
      });
    } else {
      sendDcJson({ type: 'transfer-cancel', transferId: activeTransferIdRef.current });
      if (activeRemotePeerRef.current) {
        sendWs({ type: 'webrtc:cancel', targetPeerId: activeRemotePeerRef.current.id });
      }
    }
    if (acceptResolverRef.current) {
      acceptResolverRef.current(false);
      acceptResolverRef.current = null;
    }
    if (fileAckResolverRef.current) {
      fileAckResolverRef.current('__cancelled__');
      fileAckResolverRef.current = null;
    }
    setIncomingOffer(null);
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

export type DeviceType = 'windows' | 'mac' | 'android' | 'ios' | 'linux' | 'other';

export interface PeerInfo {
  id: string;
  pairCode: string;
  name: string;
  deviceType: DeviceType;
  status: 'idle' | 'transferring';
}

export type FileTransferStatus =
  | 'queued'
  | 'waiting-accept'
  | 'transferring'
  | 'completed'
  | 'cancelled'
  | 'error';

export interface BatchFileItem {
  id: string;
  file: File;
  name: string;
  size: number;
  mimeType: string;
  category: 'video' | 'image' | 'audio' | 'document' | 'archive' | 'other';
  previewDataUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
  bytesTransferred: number;
  progress: number;
  status: FileTransferStatus;
  error?: string;
}

export interface RemoteFilePreview {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  category: 'video' | 'image' | 'audio' | 'document' | 'archive' | 'other';
  previewDataUrl?: string;
  duration?: number;
  width?: number;
  height?: number;
}

export interface IncomingFileProgress extends RemoteFilePreview {
  bytesReceived: number;
  progress: number;
  done: boolean;
  savedPath?: string;
  contentUri?: string;
  previewUrl?: string;
}

export interface ReceivedFileRecord {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  category: RemoteFilePreview['category'];
  savedPath?: string;
  contentUri?: string;
  previewUrl?: string;
  peerName: string;
  timestamp: number;
}

export interface IncomingOffer {
  transferId: string;
  fromPeer: PeerInfo;
  files: RemoteFilePreview[];
  totalBytes: number;
}

export interface TransferProgressState {
  phase:
    | 'idle'
    | 'connecting'
    | 'waiting-accept'
    | 'transferring'
    | 'completed'
    | 'rejected'
    | 'cancelled'
    | 'error';
  direction: 'send' | 'receive' | null;
  transferId: string | null;
  remotePeer: PeerInfo | null;
  activeFileIndex: number;
  totalFiles: number;
  totalBytes: number;
  transferredBytes: number;
  speedBytesPerSec: number;
  peakSpeedBytesPerSec: number;
  etaSeconds: number | null;
  usingDirectDiskWrite: boolean;
  errorMessage?: string;
}

export interface TransferHistoryItem {
  id: string;
  direction: 'send' | 'receive';
  peerName: string;
  fileCount: number;
  totalBytes: number;
  firstFileName: string;
  avgSpeedBytesPerSec: number;
  status: 'completed' | 'cancelled' | 'rejected' | 'error';
  timestamp: number;
  files?: ReceivedFileRecord[];
}

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface NativeServerInfo {
  running: boolean;
  port: number;
  ip: string;
  url: string;
  wsUrl: string;
  recommendedWsUrl?: string;
  leaderIp?: string;
}

export interface DirectFileProgressEvent {
  transferId: string;
  fileId: string;
  bytesReceived: number;
  totalBytes: number;
}

export interface DirectFileCompleteEvent {
  transferId: string;
  fileId: string;
  savedPath: string;
  contentUri?: string;
}

export interface EzWifiServerPluginInterface {
  startServer(): Promise<NativeServerInfo>;
  getServerInfo(): Promise<NativeServerInfo>;
  addListener(
    eventName: 'directFileProgress',
    listenerFunc: (event: DirectFileProgressEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'directFileComplete',
    listenerFunc: (event: DirectFileCompleteEvent) => void
  ): Promise<PluginListenerHandle>;
}

export interface EzFileSaverPluginInterface {
  ensureStoragePermission(): Promise<{ granted: boolean }>;
  openFile(options: {
    transferId: string;
    fileName: string;
    mimeType: string;
  }): Promise<{ savedPath: string; contentUri?: string }>;
  appendChunk(options: {
    transferId: string;
    base64: string;
  }): Promise<void>;
  closeFile(options: {
    transferId: string;
    abort?: boolean;
  }): Promise<{ savedPath?: string; contentUri?: string }>;
  openSavedFile(options: {
    contentUri?: string;
    savedPath?: string;
    mimeType?: string;
  }): Promise<void>;
}

export const EzWifiServer = registerPlugin<EzWifiServerPluginInterface>('EzWifiServer');
export const EzFileSaver = registerPlugin<EzFileSaverPluginInterface>('EzFileSaver');

export function isNativeAndroid(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
}

export function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(sub));
  }
  return btoa(binary);
}

import type { DeviceType } from '../types/transfer';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, idx);
  return `${value >= 100 || idx === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[idx]}`;
}

export function formatSpeed(bytesPerSec: number): { mbPerSec: string; mbps: string } {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return { mbPerSec: '0.0 MB/s', mbps: '0.0 Mbps' };
  }
  const mb = bytesPerSec / (1024 * 1024);
  const mbps = (bytesPerSec * 8) / 1_000_000;
  return {
    mbPerSec: `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`,
    mbps: `${mbps >= 100 ? mbps.toFixed(0) : mbps.toFixed(1)} Mbps`,
  };
}

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)} dtk`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds % 60);
  if (m < 60) return `${m} mnt ${s} dtk`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h} jam ${remM} mnt`;
}

interface NavigatorUAData {
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    model?: string;
    platform?: string;
    platformVersion?: string;
  }>;
}

function extractAndroidModelFromUA(rawUa: string): string | null {
  const match = rawUa.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|;|\))/i);
  if (!match) return null;
  const candidate = match[1].trim();
  // Chrome UA reduction uses "K" as a placeholder
  if (!candidate || candidate === 'K' || /^wv$/i.test(candidate)) return null;
  return candidate.slice(0, 32);
}

function getBrowserShortName(rawUa: string): string {
  if (/Edg\//i.test(rawUa)) return 'Edge';
  if (/OPR\/|Opera/i.test(rawUa)) return 'Opera';
  if (/SamsungBrowser/i.test(rawUa)) return 'Samsung';
  if (/Firefox\//i.test(rawUa)) return 'Firefox';
  if (/Chrome\//i.test(rawUa)) return 'Chrome';
  if (/Safari\//i.test(rawUa)) return 'Safari';
  return '';
}

export function detectDeviceInfo(): { defaultName: string; deviceType: DeviceType } {
  if (typeof navigator === 'undefined') {
    return { defaultName: 'Perangkat Web', deviceType: 'other' };
  }
  const rawUa = navigator.userAgent || '';
  const ua = rawUa.toLowerCase();
  const browser = getBrowserShortName(rawUa);
  const browserSuffix = browser ? ` (${browser})` : '';

  if (/iphone|ipad|ipod/.test(ua)) {
    const label = /ipad/.test(ua) ? 'iPad' : 'iPhone';
    return { defaultName: `${label}${browserSuffix}`, deviceType: 'ios' };
  }
  if (/android/.test(ua)) {
    const model = extractAndroidModelFromUA(rawUa);
    const isTablet = !/mobile/.test(ua) || (typeof window !== 'undefined' && Math.min(window.screen.width, window.screen.height) >= 600);
    if (model) {
      return { defaultName: model, deviceType: 'android' };
    }
    return {
      defaultName: `${isTablet ? 'Tablet Android' : 'HP Android'}${browserSuffix}`,
      deviceType: 'android',
    };
  }
  if (/windows/.test(ua)) {
    return { defaultName: `PC Windows${browserSuffix}`, deviceType: 'windows' };
  }
  if (/macintosh|mac os x/.test(ua)) {
    return { defaultName: `MacBook / Mac${browserSuffix}`, deviceType: 'mac' };
  }
  if (/linux/.test(ua)) {
    return { defaultName: `PC Linux${browserSuffix}`, deviceType: 'linux' };
  }
  return { defaultName: `Perangkat${browserSuffix}`, deviceType: 'other' };
}

export async function detectDetailedDeviceInfo(): Promise<{
  name: string;
  deviceType: DeviceType;
}> {
  const base = detectDeviceInfo();
  if (typeof navigator === 'undefined') {
    return { name: base.defaultName, deviceType: base.deviceType };
  }

  const uaData = (navigator as unknown as { userAgentData?: NavigatorUAData }).userAgentData;
  if (!uaData?.getHighEntropyValues) {
    return { name: base.defaultName, deviceType: base.deviceType };
  }

  try {
    const hints = await uaData.getHighEntropyValues(['model', 'platform', 'platformVersion']);
    const model = (hints.model || '').trim();
    const platform = (hints.platform || '').toLowerCase();
    const majorVer = parseInt((hints.platformVersion || '').split('.')[0] || '0', 10);
    const browser = getBrowserShortName(navigator.userAgent || '');
    const browserSuffix = browser ? ` (${browser})` : '';

    if (platform === 'android' || base.deviceType === 'android') {
      if (model) {
        return { name: model.slice(0, 36), deviceType: 'android' };
      }
      const label = uaData.mobile === false ? 'Tablet Android' : 'HP Android';
      return { name: `${label}${browserSuffix}`, deviceType: 'android' };
    }

    if (platform === 'windows' || base.deviceType === 'windows') {
      const winVer = majorVer >= 13 ? 'Windows 11' : majorVer >= 1 ? 'Windows 10' : 'Windows';
      return { name: `PC ${winVer}${browserSuffix}`, deviceType: 'windows' };
    }

    if (platform === 'macos' || base.deviceType === 'mac') {
      return { name: `Mac${browserSuffix}`, deviceType: 'mac' };
    }
  } catch {
    // Fallback to synchronous detection
  }

  return { name: base.defaultName, deviceType: base.deviceType };
}

export function getDeviceLabel(type: DeviceType): string {
  switch (type) {
    case 'windows':
      return 'Windows PC';
    case 'mac':
      return 'macOS';
    case 'android':
      return 'Android';
    case 'ios':
      return 'iPhone / iPad';
    case 'linux':
      return 'Linux PC';
    default:
      return 'Perangkat';
  }
}

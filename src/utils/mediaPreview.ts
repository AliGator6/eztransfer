import type { BatchFileItem } from '../types/transfer';

export function classifyFile(
  file: File
): 'video' | 'image' | 'audio' | 'document' | 'archive' | 'other' {
  const mime = file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase() || '';

  if (mime.startsWith('video/') || ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'].includes(ext)) {
    return 'video';
  }
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext)) {
    return 'image';
  }
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext)) {
    return 'audio';
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(ext)) {
    return 'archive';
  }
  if (
    mime.includes('pdf') ||
    mime.includes('document') ||
    mime.includes('spreadsheet') ||
    mime.includes('presentation') ||
    ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv'].includes(ext)
  ) {
    return 'document';
  }
  return 'other';
}

function drawThumbnailToDataUrl(
  source: HTMLImageElement | HTMLVideoElement,
  srcWidth: number,
  srcHeight: number
): string | undefined {
  if (!srcWidth || !srcHeight) return undefined;
  const maxW = 140;
  const maxH = 96;
  const ratio = Math.min(maxW / srcWidth, maxH / srcHeight, 1);
  const targetW = Math.max(1, Math.round(srcWidth * ratio));
  const targetH = Math.max(1, Math.round(srcHeight * ratio));

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.drawImage(source, 0, 0, targetW, targetH);
  try {
    return canvas.toDataURL('image/jpeg', 0.58);
  } catch {
    return undefined;
  }
}

async function extractVideoPreview(
  file: File
): Promise<{ previewDataUrl?: string; duration?: number; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
    };

    const timeout = window.setTimeout(() => {
      cleanup();
      resolve({});
    }, 3500);

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : undefined;
      const width = video.videoWidth || undefined;
      const height = video.videoHeight || undefined;
      const targetTime = duration && duration > 1 ? Math.min(1, duration * 0.1) : 0.1;
      try {
        video.currentTime = targetTime;
      } catch {
        window.clearTimeout(timeout);
        cleanup();
        resolve({ duration, width, height });
      }
    };

    video.onseeked = () => {
      window.clearTimeout(timeout);
      const previewDataUrl = drawThumbnailToDataUrl(video, video.videoWidth, video.videoHeight);
      const result = {
        previewDataUrl,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      };
      cleanup();
      resolve(result);
    };

    video.onerror = () => {
      window.clearTimeout(timeout);
      cleanup();
      resolve({});
    };

    video.src = url;
  });
}

async function extractImagePreview(
  file: File
): Promise<{ previewDataUrl?: string; width?: number; height?: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();

    const timeout = window.setTimeout(() => {
      URL.revokeObjectURL(url);
      resolve({});
    }, 2500);

    img.onload = () => {
      window.clearTimeout(timeout);
      const previewDataUrl = drawThumbnailToDataUrl(img, img.naturalWidth, img.naturalHeight);
      const result = {
        previewDataUrl,
        width: img.naturalWidth || undefined,
        height: img.naturalHeight || undefined,
      };
      URL.revokeObjectURL(url);
      resolve(result);
    };

    img.onerror = () => {
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      resolve({});
    };

    img.src = url;
  });
}

export async function createBatchItem(file: File): Promise<BatchFileItem> {
  const category = classifyFile(file);
  const base: BatchFileItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    file,
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    category,
    bytesTransferred: 0,
    progress: 0,
    status: 'queued',
  };

  if (category === 'video') {
    const meta = await extractVideoPreview(file);
    return { ...base, ...meta };
  }
  if (category === 'image') {
    const meta = await extractImagePreview(file);
    return { ...base, ...meta };
  }
  return base;
}

import React, { useMemo, useState } from 'react';
import { ExternalLink, FileText, FolderOpen, X } from 'lucide-react';
import type { ReceivedFileRecord } from '../types/transfer';
import { EzFileSaver, isNativeAndroid, type NativeServerInfo } from '../native/androidPlugins';
import { formatBytes } from '../utils/format';

interface FileViewerModalProps {
  file: ReceivedFileRecord | null;
  nativeServerInfo: NativeServerInfo | null;
  onClose: () => void;
}

export const FileViewerModal: React.FC<FileViewerModalProps> = ({
  file,
  nativeServerInfo,
  onClose,
}) => {
  const [openError, setOpenError] = useState<string | null>(null);
  const [openingExternal, setOpeningExternal] = useState(false);

  const mediaUrl = useMemo(() => {
    if (!file) return null;
    if (file.previewUrl) return file.previewUrl;
    if (isNativeAndroid() && file.contentUri && nativeServerInfo?.port) {
      return `http://127.0.0.1:${nativeServerInfo.port}/native-file?uri=${encodeURIComponent(
        file.contentUri
      )}&mime=${encodeURIComponent(file.mimeType || 'application/octet-stream')}`;
    }
    return null;
  }, [file, nativeServerInfo]);

  if (!file) return null;

  const isInlineViewable =
    Boolean(mediaUrl) &&
    (file.category === 'image' || file.category === 'video' || file.category === 'audio');

  const handleOpenExternal = async () => {
    setOpenError(null);
    setOpeningExternal(true);
    try {
      if (isNativeAndroid()) {
        await EzFileSaver.openSavedFile({
          contentUri: file.contentUri,
          savedPath: file.savedPath,
          mimeType: file.mimeType || '*/*',
        });
      } else if (file.previewUrl) {
        const a = document.createElement('a');
        a.href = file.previewUrl;
        a.download = file.name;
        a.click();
      } else {
        setOpenError('File tersimpan di folder Download perangkat Anda.');
      }
    } catch (err) {
      setOpenError(
        err instanceof Error
          ? err.message
          : 'Tidak ada aplikasi di HP yang mendukung format file ini.'
      );
    } finally {
      setOpeningExternal(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 backdrop-blur-xs p-3 sm:p-5"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-viewer-title"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-white border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-4 sm:px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="file-viewer-title" className="text-sm sm:text-base font-bold text-slate-900 truncate">
              {file.name}
            </h2>
            <p className="text-xs text-slate-500 font-mono tabular-nums truncate mt-0.5">
              {formatBytes(file.size)}
              {file.savedPath ? ` · ${file.savedPath}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0 cursor-pointer"
            aria-label="Tutup penampil file"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-5 overflow-y-auto flex-1 bg-slate-50 flex flex-col items-center justify-center min-h-[220px]">
          {isInlineViewable && file.category === 'image' && mediaUrl && (
            <img
              src={mediaUrl}
              alt={file.name}
              className="max-h-[58vh] w-auto max-w-full rounded-lg object-contain bg-white border border-slate-200"
            />
          )}

          {isInlineViewable && file.category === 'video' && mediaUrl && (
            <video
              src={mediaUrl}
              controls
              autoPlay
              playsInline
              className="w-full max-h-[58vh] rounded-lg bg-black"
            />
          )}

          {isInlineViewable && file.category === 'audio' && mediaUrl && (
            <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-5 space-y-3 text-center">
              <p className="text-sm font-semibold text-slate-900 truncate">{file.name}</p>
              <audio src={mediaUrl} controls autoPlay className="w-full" />
            </div>
          )}

          {!isInlineViewable && (
            <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 text-center space-y-3">
              <div className="mx-auto w-12 h-12 rounded-xl bg-blue-50 text-[#2563EB] flex items-center justify-center">
                <FileText className="w-6 h-6" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-900 break-all">{file.name}</p>
                <p className="text-xs text-slate-500">
                  File tersimpan di{' '}
                  <span className="font-mono font-medium text-slate-700">
                    {file.savedPath || 'Download/EzTransfer'}
                  </span>
                </p>
              </div>
            </div>
          )}

          {openError && (
            <div className="mt-3 w-full rounded-lg bg-red-50 border border-red-200 px-3.5 py-2 text-xs text-red-700">
              {openError}
            </div>
          )}
        </div>

        <div className="px-4 sm:px-5 py-3.5 border-t border-slate-200 bg-white flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex items-center gap-1.5 text-xs text-slate-500 min-w-0">
            <FolderOpen className="w-4 h-4 shrink-0 text-slate-400" aria-hidden="true" />
            <span className="truncate">{file.savedPath || 'Folder Download'}</span>
          </div>

          <div className="flex items-center gap-2 ml-auto">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            >
              Tutup
            </button>
            <button
              type="button"
              disabled={openingExternal}
              onClick={() => void handleOpenExternal()}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>
                {openingExternal
                  ? 'Membuka...'
                  : isNativeAndroid()
                    ? 'Buka dengan Aplikasi HP'
                    : 'Simpan / Buka File'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

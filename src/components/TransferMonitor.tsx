import React from 'react';
import { AlertCircle, CheckCircle2, HardDrive, XCircle } from 'lucide-react';
import type { BatchFileItem, RemoteFilePreview, TransferProgressState } from '../types/transfer';
import { formatBytes, formatEta, formatSpeed } from '../utils/format';

interface TransferMonitorProps {
  progress: TransferProgressState;
  outgoingQueue: BatchFileItem[];
  incomingFiles: Array<RemoteFilePreview & { bytesReceived: number; progress: number; done: boolean }>;
  onCancel: () => void;
  onDismiss: () => void;
}

export const TransferMonitor: React.FC<TransferMonitorProps> = ({
  progress,
  outgoingQueue,
  incomingFiles,
  onCancel,
  onDismiss,
}) => {
  if (progress.phase === 'idle') return null;

  const overallPct =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.transferredBytes / progress.totalBytes) * 100))
      : 0;
  const speed = formatSpeed(progress.speedBytesPerSec);
  const peak = formatSpeed(progress.peakSpeedBytesPerSec);

  const isActive =
    progress.phase === 'connecting' ||
    progress.phase === 'waiting-accept' ||
    progress.phase === 'transferring';

  const statusTextMap: Record<TransferProgressState['phase'], string> = {
    idle: '',
    connecting: 'Menghubungkan jalur WiFi langsung...',
    'waiting-accept': `Menunggu konfirmasi dari ${progress.remotePeer?.name || 'penerima'}...`,
    transferring:
      progress.direction === 'send'
        ? `Mengirim ke ${progress.remotePeer?.name || 'penerima'}`
        : `Menerima dari ${progress.remotePeer?.name || 'pengirim'}`,
    completed: 'Transfer selesai',
    rejected: `${progress.remotePeer?.name || 'Penerima'} menolak permintaan file`,
    cancelled: 'Transfer dibatalkan',
    error: progress.errorMessage || 'Transfer gagal',
  };

  return (
    <section
      aria-label="Monitor Transfer Aktif"
      className="rounded-xl bg-white border border-slate-200 p-5 space-y-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {progress.phase === 'completed' && (
              <CheckCircle2 className="w-5 h-5 text-[#16A34A] shrink-0" aria-hidden="true" />
            )}
            {(progress.phase === 'error' ||
              progress.phase === 'rejected' ||
              progress.phase === 'cancelled') && (
              <AlertCircle className="w-5 h-5 text-[#DC2626] shrink-0" aria-hidden="true" />
            )}
            <h2 className="text-base font-bold text-slate-900 truncate">
              {statusTextMap[progress.phase]}
            </h2>
          </div>

          <p className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
            {formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)} ·{' '}
            {progress.totalFiles} file
            {progress.direction === 'receive' && progress.phase === 'transferring' && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-1 text-slate-700 font-sans">
                  <HardDrive className="w-3.5 h-3.5 inline" aria-hidden="true" />
                  {progress.usingDirectDiskWrite
                    ? 'Menulis langsung ke disk'
                    : 'Unduhan browser standar'}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="shrink-0">
          {isActive ? (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3.5 py-2 text-xs font-medium text-[#DC2626] bg-red-50 hover:bg-red-100 rounded-lg transition-colors cursor-pointer"
            >
              <XCircle className="w-4 h-4" aria-hidden="true" />
              <span>Batalkan</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onDismiss}
              className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
            >
              Tutup
            </button>
          )}
        </div>
      </div>

      {/* Real-Time Speed & Progress Metrics */}
      {(progress.phase === 'transferring' || progress.phase === 'completed') && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs text-slate-500">Kecepatan</div>
              <div className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-0.5">
                {progress.phase === 'completed' ? peak.mbPerSec : speed.mbPerSec}
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                {progress.phase === 'completed' ? `Puncak ${peak.mbps}` : speed.mbps}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs text-slate-500">Progres Total</div>
              <div className="text-lg font-semibold text-[#2563EB] font-mono tabular-nums mt-0.5">
                {overallPct}%
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                File {Math.min(progress.activeFileIndex + 1, progress.totalFiles)}/{progress.totalFiles}
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs text-slate-500">Sisa Waktu (ETA)</div>
              <div className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-0.5">
                {progress.phase === 'completed' ? 'Selesai' : formatEta(progress.etaSeconds)}
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">
                {formatBytes(Math.max(0, progress.totalBytes - progress.transferredBytes))} tersisa
              </div>
            </div>

            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
              <div className="text-xs text-slate-500">Kecepatan Puncak</div>
              <div className="text-lg font-semibold text-slate-900 font-mono tabular-nums mt-0.5">
                {peak.mbPerSec}
              </div>
              <div className="text-xs text-slate-500 font-mono tabular-nums">{peak.mbps}</div>
            </div>
          </div>

          <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-150 ${
                progress.phase === 'completed' ? 'bg-[#16A34A]' : 'bg-[#2563EB]'
              }`}
              style={{ width: `${overallPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Per-file receive progress list */}
      {progress.direction === 'receive' && incomingFiles.length > 0 && (
        <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2 max-h-52 overflow-y-auto">
          {incomingFiles.map((file) => (
            <div key={file.id} className="py-2 flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-slate-700 font-medium">{file.name}</span>
              <div className="flex items-center gap-3 shrink-0 font-mono tabular-nums text-xs text-slate-600">
                <span>{formatBytes(file.size)}</span>
                <span className={file.done ? 'text-[#16A34A] font-semibold' : 'text-[#2563EB]'}>
                  {file.done ? '100%' : `${file.progress}%`}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-file outgoing progress summary when sending */}
      {progress.direction === 'send' && outgoingQueue.length > 0 && progress.phase === 'transferring' && (
        <div className="divide-y divide-slate-100 border-t border-slate-100 pt-2 max-h-40 overflow-y-auto">
          {outgoingQueue.map((file) => (
            <div key={file.id} className="py-2 flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-slate-700">{file.name}</span>
              <span className="font-mono tabular-nums text-xs text-slate-600 shrink-0">
                {file.status === 'completed' ? 'Selesai' : `${file.progress}%`}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

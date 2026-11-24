import React from 'react';
import { Check, X } from 'lucide-react';
import type { IncomingOffer } from '../types/transfer';
import { formatBytes, formatDuration, getDeviceLabel } from '../utils/format';
import { DeviceIcon } from './DeviceIcon';
import { FilePreviewThumb } from './FilePreviewThumb';

interface IncomingOfferModalProps {
  offer: IncomingOffer;
  onAccept: () => void;
  onReject: () => void;
}

export const IncomingOfferModal: React.FC<IncomingOfferModalProps> = ({
  offer,
  onAccept,
  onReject,
}) => {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="incoming-offer-title"
    >
      <div className="w-full max-w-lg rounded-t-2xl sm:rounded-xl bg-white border border-slate-200 shadow-xl overflow-hidden max-h-[88vh] flex flex-col">
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center gap-3 shrink-0">
          <div className="w-10 h-10 rounded-lg bg-blue-50 text-[#2563EB] flex items-center justify-center shrink-0">
            <DeviceIcon type={offer.fromPeer.deviceType} className="w-5 h-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="incoming-offer-title" className="text-base font-bold text-slate-900 truncate">
              Permintaan Kirim File Masuk
            </h2>
            <p className="text-sm text-slate-600 truncate">
              {offer.fromPeer.name} · {getDeviceLabel(offer.fromPeer.deviceType)} ·{' '}
              <span className="font-mono tabular-nums">
                {offer.files.length} file ({formatBytes(offer.totalBytes)})
              </span>
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 px-4 sm:px-5">
          {offer.files.map((file) => (
            <div key={file.id} className="py-3 flex items-center gap-3">
              <FilePreviewThumb
                category={file.category}
                previewDataUrl={file.previewDataUrl}
                name={file.name}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-900 truncate">{file.name}</p>
                <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                  {formatBytes(file.size)}
                  {file.duration ? ` · ${formatDuration(file.duration)}` : ''}
                  {file.width && file.height ? ` · ${file.width}×${file.height}` : ''}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="p-4 sm:p-5 bg-slate-50 border-t border-slate-200 flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2.5 sm:gap-3 shrink-0">
          <button
            type="button"
            onClick={onReject}
            className="inline-flex items-center justify-center gap-2 min-h-[48px] sm:min-h-[44px] px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-100 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" aria-hidden="true" />
            <span>Tolak</span>
          </button>
          <button
            type="button"
            onClick={onAccept}
            className="inline-flex items-center justify-center gap-2 min-h-[48px] sm:min-h-[44px] px-5 py-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors cursor-pointer"
          >
            <Check className="w-4 h-4" aria-hidden="true" />
            <span>Terima & Simpan</span>
          </button>
        </div>
      </div>
    </div>
  );
};

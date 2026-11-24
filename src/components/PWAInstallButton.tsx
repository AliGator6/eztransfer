import React, { useState } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import { usePWAInstall } from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, isWindows, isInIframe, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);

  if (isInstalled) {
    return null;
  }

  const handleInstallClick = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome !== 'unavailable') return;
    }
    setShowGuideModal(true);
  };

  const buttonLabel = isWindows ? 'Pasang di Windows' : isIOS ? 'Pasang di iOS' : 'Pasang Aplikasi';

  return (
    <>
      <button
        type="button"
        onClick={handleInstallClick}
        className="inline-flex items-center gap-1.5 sm:gap-2 min-h-[40px] px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
        <span className="sm:hidden">{isWindows ? 'Pasang' : buttonLabel}</span>
        <span className="hidden sm:inline">{buttonLabel}</span>
      </button>

      {showGuideModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="install-guide-title"
        >
          <div className="w-full max-w-md rounded-xl bg-white border border-slate-200 p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <h2 id="install-guide-title" className="text-lg font-bold text-slate-900">
                Pasang Aplikasi di Perangkat
              </h2>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
                aria-label="Tutup panduan"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isIOS ? (
              <div className="mt-4 space-y-3 text-sm text-slate-600 leading-relaxed">
                <p>Untuk memasang di iPhone atau iPad melalui Safari:</p>
                <ol className="list-decimal pl-5 space-y-2 text-slate-700">
                  <li>
                    Tekan tombol <strong>Bagikan (Share)</strong> di bilah bawah Safari.
                  </li>
                  <li>
                    Gulir ke bawah dan pilih <strong>Add to Home Screen</strong>.
                  </li>
                  <li>
                    Tekan <strong>Add</strong> untuk membuka aplikasi layar penuh.
                  </li>
                </ol>
              </div>
            ) : (
              <div className="mt-4 space-y-3 text-sm text-slate-600 leading-relaxed">
                {isInIframe && (
                  <p className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-slate-700">
                    Saat ini halaman berada di jendela pratinjau. Buka alamat aplikasi di tab baru
                    Microsoft Edge atau Google Chrome agar tombol instalasi Windows aktif.
                  </p>
                )}
                <ol className="list-decimal pl-5 space-y-2 text-slate-700">
                  <li>
                    Buka aplikasi di <strong>Microsoft Edge</strong> atau{' '}
                    <strong>Google Chrome</strong> pada Windows 10/11.
                  </li>
                  <li>
                    Klik ikon <strong>Install App</strong> di sisi kanan bilah alamat browser (atau
                    menu titik tiga → <em>Apps</em> → <em>Install this site as an app</em>).
                  </li>
                  <li>
                    Setelah terpasang di Start Menu, video besar dapat disimpan langsung ke folder
                    Windows tanpa membebani RAM.
                  </li>
                </ol>
              </div>
            )}

            <div className="mt-6 flex items-center justify-end gap-3">
              {isInIframe && (
                <a
                  href={window.location.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg transition-colors"
                >
                  <ExternalLink className="w-4 h-4" aria-hidden="true" />
                  <span>Buka di Tab Baru</span>
                </a>
              )}
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

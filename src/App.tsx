import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Copy,
  Download,
  Eye,
  FolderUp,
  History,
  Info,
  QrCode,
  Send,
  Terminal,
  Trash2,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { DeviceIcon } from './components/DeviceIcon';
import { FilePreviewThumb } from './components/FilePreviewThumb';
import { FileViewerModal } from './components/FileViewerModal';
import { IncomingOfferModal } from './components/IncomingOfferModal';
import { TransferMonitor } from './components/TransferMonitor';
import { useOnlineStatus } from './hooks/useOnlineStatus';
import { useWifiTransfer } from './hooks/useWifiTransfer';
import { isNativeAndroid } from './native/androidPlugins';
import type { PeerInfo, ReceivedFileRecord } from './types/transfer';
import { formatBytes, formatDuration, formatSpeed, getDeviceLabel } from './utils/format';
import { createBatchItem } from './utils/mediaPreview';

type ActiveTab = 'transfer' | 'riwayat' | 'panduan';

export default function App() {
  const nativeAndroid = isNativeAndroid();
  const isOnline = useOnlineStatus();
  const {
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
  } = useWifiTransfer();

  const [activeTab, setActiveTab] = useState<ActiveTab>('transfer');
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [showQrPanel, setShowQrPanel] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedServerUrl, setCopiedServerUrl] = useState(false);
  const [showHostSwitch, setShowHostSwitch] = useState(Boolean(customServerHost));
  const [hostInput, setHostInput] = useState(customServerHost);
  const [copiedTermuxCmd, setCopiedTermuxCmd] = useState(false);
  const [downloadingTxt, setDownloadingTxt] = useState(false);
  const [copyingTxt, setCopyingTxt] = useState(false);
  const [txtFeedback, setTxtFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  const [isDragging, setIsDragging] = useState(false);
  const [extractingFiles, setExtractingFiles] = useState(false);
  const [viewingFile, setViewingFile] = useState<ReceivedFileRecord | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Merge nearby WiFi peers + explicitly paired peer without duplicates
  const availablePeers = useMemo(() => {
    const map = new Map<string, PeerInfo>();
    for (const p of nearbyPeers) map.set(p.id, p);
    if (pairedPeer && !map.has(pairedPeer.id)) {
      map.set(pairedPeer.id, pairedPeer);
    }
    return Array.from(map.values());
  }, [nearbyPeers, pairedPeer]);

  const selectedPeer = useMemo(() => {
    if (selectedPeerId) {
      const found = availablePeers.find((p) => p.id === selectedPeerId);
      if (found) return found;
    }
    if (pairedPeer) return pairedPeer;
    return availablePeers.length === 1 ? availablePeers[0] : null;
  }, [availablePeers, pairedPeer, selectedPeerId]);

  const totalQueueBytes = useMemo(
    () => queue.reduce((sum, item) => sum + item.size, 0),
    [queue]
  );

  const isTransferring =
    progress.phase === 'connecting' ||
    progress.phase === 'waiting-accept' ||
    progress.phase === 'transferring';

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setExtractingFiles(true);
    try {
      const files = Array.from(fileList);
      const items = await Promise.all(files.map((f) => createBatchItem(f)));
      addFilesToQueue(items);
    } finally {
      setExtractingFiles(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    void handleFilesSelected(e.dataTransfer.files);
  };

  const copyPlainText = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      return copied;
    } catch {
      return false;
    }
  };

  const handleCopyCode = async () => {
    if (!selfPeer) return;
    const ok = await copyPlainText(selfPeer.pairCode);
    if (ok) {
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1800);
    }
  };

  const handleCopyServerUrl = async () => {
    if (!nativeServerInfo?.url) return;
    const ok = await copyPlainText(nativeServerInfo.url);
    if (ok) {
      setCopiedServerUrl(true);
      window.setTimeout(() => setCopiedServerUrl(false), 1800);
    }
  };

  const handlePairSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    lookupPairCode(codeInput);
  };

  const qrBaseUrl =
    nativeAndroid && nativeServerInfo?.url ? nativeServerInfo.url : window.location.origin;

  const pairShareUrl = selfPeer ? `${qrBaseUrl}/?pair=${selfPeer.pairCode}` : qrBaseUrl;

  const fetchSetupScriptText = async (): Promise<string> => {
    const res = await fetch(`/api/download-txt?t=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      throw new Error(`Server mengembalikan status ${res.status}`);
    }
    const text = await res.text();
    if (!text.startsWith('#!/usr/bin/env bash')) {
      throw new Error('Respons server bukan script setup yang valid.');
    }
    return text;
  };

  const handleDownloadTxt = async () => {
    setDownloadingTxt(true);
    setTxtFeedback(null);
    try {
      const scriptText = await fetchSetupScriptText();
      const blob = new Blob([scriptText], { type: 'text/plain;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = 'eztransfer-setup.txt';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 8000);
      setTxtFeedback({
        type: 'success',
        text: 'File eztransfer-setup.txt berhasil disiapkan. Cek folder Download di perangkat Anda.',
      });
    } catch (err) {
      setTxtFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? `Gagal mengunduh: ${err.message}. Gunakan tombol "Salin Isi File (.txt)" di samping.`
            : 'Gagal mengunduh file. Gunakan tombol "Salin Isi File (.txt)" di samping.',
      });
    } finally {
      setDownloadingTxt(false);
    }
  };

  const handleCopyTxtContent = async () => {
    setCopyingTxt(true);
    setTxtFeedback(null);
    try {
      const scriptText = await fetchSetupScriptText();
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(scriptText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = scriptText;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        if (!copied) {
          throw new Error('Browser memblokir akses clipboard.');
        }
      }
      setTxtFeedback({
        type: 'success',
        text: 'Isi script (.txt) tersalin! Di Termux ketik: cat > ~/eztransfer-setup.txt lalu Tempel, Enter, tekan Ctrl+D, lalu jalankan: bash ~/eztransfer-setup.txt',
      });
    } catch (err) {
      setTxtFeedback({
        type: 'error',
        text:
          err instanceof Error
            ? `Gagal menyalin: ${err.message}`
            : 'Gagal menyalin isi file setup.',
      });
    } finally {
      setCopyingTxt(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F8FAFC] text-[#0F172A]">
      {/* Top Bar: 3-zone on tablet/laptop, compact brand + install CTA on mobile */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 h-14 md:h-16 flex items-center justify-between gap-4 md:gap-8">
          <button
            type="button"
            onClick={() => setActiveTab('transfer')}
            className="flex items-center gap-2.5 text-base sm:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span className="w-8 h-8 rounded-lg bg-[#2563EB] text-white flex items-center justify-center shrink-0">
              <Wifi className="w-4 h-4" aria-hidden="true" />
            </span>
            <span>EzTransfer</span>
          </button>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
            <button
              type="button"
              onClick={() => setActiveTab('transfer')}
              className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'transfer'
                  ? 'border-[#2563EB] text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Transfer
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('riwayat')}
              className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'riwayat'
                  ? 'border-[#2563EB] text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Riwayat{history.length > 0 ? ` (${history.length})` : ''}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('panduan')}
              className={`py-1.5 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === 'panduan'
                  ? 'border-[#2563EB] text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-900'
              }`}
            >
              Panduan
            </button>
          </nav>

          <div className="w-8 shrink-0" aria-hidden="true" />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-3.5 sm:px-6 lg:px-8 pt-4 pb-20 md:py-6">
        {activeTab === 'transfer' && (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 sm:gap-5 lg:gap-6 items-start">
            {/* Left Column: Device Identity, WiFi Auto-Discovery & QR/6-Digit Pairing */}
            <div className="md:col-span-5 space-y-4 sm:space-y-5">
              {/* Self Device Card */}
              <section className="rounded-xl bg-white border border-slate-200 p-4 sm:p-5 space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-500">Perangkat Ini (Terdeteksi Otomatis)</div>
                    <h1 className="mt-1 text-lg font-bold text-slate-900 truncate">
                      {selfPeer?.name || 'Mendeteksi perangkat...'}
                    </h1>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {selfPeer ? getDeviceLabel(selfPeer.deviceType) : 'Memuat'} ·{' '}
                      <span className={wsConnected ? 'text-[#16A34A] font-medium' : 'text-[#D97706]'}>
                        {wsConnected ? 'Siap di jaringan WiFi' : 'Menghubungkan ulang...'}
                      </span>
                    </p>
                  </div>
                </div>

                {/* 6-Digit Pairing Code & QR Toggle */}
                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs text-slate-500">Kode Perangkat Anda</div>
                    <div className="text-xl font-bold tracking-widest text-slate-900 font-mono tabular-nums mt-0.5">
                      {selfPeer?.pairCode || '------'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handleCopyCode}
                      disabled={!selfPeer}
                      className="inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer disabled:opacity-50"
                    >
                      {copiedCode ? (
                        <Check className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>{copiedCode ? 'Tersalin' : 'Salin'}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowQrPanel((v) => !v)}
                      className={`inline-flex items-center gap-1.5 min-h-[40px] px-3 py-2 text-xs font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                        showQrPanel
                          ? 'bg-[#2563EB] text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      <QrCode className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>QR Code</span>
                    </button>
                  </div>
                </div>

                {showQrPanel && selfPeer && (
                  <div className="pt-3 border-t border-slate-100 flex flex-col items-center text-center space-y-2.5">
                    <div className="p-3 bg-white border border-slate-200 rounded-xl">
                      <QRCodeSVG value={pairShareUrl} size={156} level="M" />
                    </div>
                    <p className="text-xs text-slate-500 max-w-xs">
                      Pindai QR ini dari kamera ponsel atau buka linknya di browser PC untuk langsung
                      terhubung ke <span className="font-medium text-slate-700">{selfPeer.name}</span>.
                    </p>
                  </div>
                )}

                {nativeAndroid && (
                  <div className="pt-3 border-t border-slate-100 space-y-2.5">
                    {nativeServerInfo?.url ? (
                      <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium text-slate-600">
                            Alamat WiFi Server HP Ini
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleCopyServerUrl()}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 rounded-md cursor-pointer"
                          >
                            {copiedServerUrl ? (
                              <Check className="w-3.5 h-3.5 text-[#16A34A]" aria-hidden="true" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                            )}
                            <span>{copiedServerUrl ? 'Tersalin' : 'Salin Link'}</span>
                          </button>
                        </div>
                        <div className="text-sm font-mono font-semibold text-slate-900 break-all">
                          {nativeServerInfo.url}
                        </div>
                        <p className="text-[11px] text-slate-500 leading-relaxed">
                          Buka alamat di atas lewat browser PC Windows atau HP lain pada WiFi yang
                          sama, atau pindai QR Code.
                        </p>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-500">
                        Aktifkan WiFi atau Hotspot agar alamat IP lokal muncul.
                      </p>
                    )}

                    <button
                      type="button"
                      onClick={() => setShowHostSwitch((v) => !v)}
                      className="text-xs font-medium text-[#2563EB] hover:underline cursor-pointer"
                    >
                      {showHostSwitch
                        ? 'Tutup pengaturan server tujuan'
                        : 'Pakai 2 APK? Hubungkan ke IP HP lain'}
                    </button>

                    {showHostSwitch && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          setCustomServerHost(hostInput);
                        }}
                        className="space-y-2 pt-1"
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={hostInput}
                            onChange={(e) => setHostInput(e.target.value)}
                            placeholder="Contoh: 192.168.1.5:3000"
                            className="min-w-0 flex-1 min-h-[40px] px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                          />
                          <button
                            type="submit"
                            className="min-h-[40px] px-3 py-1.5 text-xs font-medium text-white bg-[#2563EB] hover:bg-blue-700 rounded-lg whitespace-nowrap cursor-pointer"
                          >
                            Sambungkan
                          </button>
                        </div>
                        {customServerHost && (
                          <div className="flex items-center justify-between text-[11px] text-slate-600">
                            <span>Tersambung ke host: {customServerHost}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setHostInput('');
                                setCustomServerHost('');
                              }}
                              className="text-[#DC2626] hover:underline cursor-pointer"
                            >
                              Kembali ke HP ini
                            </button>
                          </div>
                        )}
                      </form>
                    )}
                  </div>
                )}
              </section>

              {/* Discovered WiFi Peers + Manual 6-Digit Connect */}
              <section className="rounded-xl bg-white border border-slate-200 p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-bold text-slate-900">
                    Perangkat di WiFi yang Sama
                  </h2>
                  <span className="text-xs text-slate-500 font-mono tabular-nums">
                    {availablePeers.length} terdeteksi
                  </span>
                </div>

                {availablePeers.length === 0 ? (
                  <div className="py-6 px-4 rounded-lg bg-slate-50 border border-dashed border-slate-200 text-center space-y-1.5">
                    <p className="text-sm font-medium text-slate-700">
                      Belum ada perangkat lain terlihat
                    </p>
                    <p className="text-xs text-slate-500 leading-relaxed">
                      Buka aplikasi ini di PC Windows atau ponsel lain pada WiFi yang sama, atau
                      masukkan kode 6 digit di bawah.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {availablePeers.map((peer) => {
                      const isSelected = selectedPeer?.id === peer.id;
                      return (
                        <button
                          key={peer.id}
                          type="button"
                          onClick={() => setSelectedPeerId(peer.id)}
                          className={`w-full min-h-[56px] p-3 rounded-lg border text-left flex items-center justify-between gap-3 transition-colors cursor-pointer ${
                            isSelected
                              ? 'border-[#2563EB] bg-blue-50/60'
                              : 'border-slate-200 bg-white hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div
                              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                                isSelected
                                  ? 'bg-[#2563EB] text-white'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                            >
                              <DeviceIcon type={peer.deviceType} className="w-4 h-4" />
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-900 truncate">
                                {peer.name}
                              </div>
                              <div className="text-xs text-slate-500 font-mono tabular-nums">
                                {getDeviceLabel(peer.deviceType)} · Kode {peer.pairCode}
                              </div>
                            </div>
                          </div>

                          <span
                            className={`text-xs font-medium shrink-0 ${
                              isSelected ? 'text-[#2563EB]' : 'text-slate-500'
                            }`}
                          >
                            {isSelected ? 'Dipilih' : 'Pilih'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Manual 6-Digit Code Lookup */}
                <form onSubmit={handlePairSubmit} className="pt-3 border-t border-slate-100 space-y-2">
                  <label htmlFor="pair-code-input" className="block text-xs font-medium text-slate-600">
                    Atau hubungkan dengan Kode 6 Digit
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      id="pair-code-input"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="Contoh: 482910"
                      className="min-w-0 flex-1 min-h-[44px] px-3 py-2 text-sm font-mono tabular-nums tracking-wider bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#2563EB]"
                    />
                    <button
                      type="submit"
                      className="min-h-[44px] px-4 py-2 text-sm font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Hubungkan
                    </button>
                  </div>
                  {pairError && <p className="text-xs text-[#DC2626]">{pairError}</p>}
                  {pairedPeer && (
                    <div className="flex items-center justify-between text-xs text-[#16A34A]">
                      <span>Terhubung dengan {pairedPeer.name}</span>
                      <button
                        type="button"
                        onClick={() => setPairedPeer(null)}
                        className="text-slate-500 hover:text-slate-800 underline cursor-pointer"
                      >
                        Lepas
                      </button>
                    </div>
                  )}
                </form>
              </section>
            </div>

            {/* Right Column: Active Transfer Monitor, Dropzone & Batch Media Preview Queue */}
            <div className="md:col-span-7 space-y-4 sm:space-y-5">
              <TransferMonitor
                progress={progress}
                outgoingQueue={queue}
                incomingFiles={incomingFilesProgress}
                onCancel={() => void cancelTransfer()}
                onDismiss={resetProgress}
                onOpenFile={(file) => setViewingFile(file)}
              />

              {/* File Dropzone & Picker */}
              <section className="rounded-xl bg-white border border-slate-200 p-4 sm:p-5 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      Antrean File & Video
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Pilih atau tarik banyak file sekaligus termasuk video berukuran besar
                    </p>
                  </div>
                  {queue.length > 0 && !isTransferring && (
                    <button
                      type="button"
                      onClick={clearQueue}
                      className="min-h-[36px] px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-[#DC2626] hover:bg-red-50 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
                    >
                      Kosongkan
                    </button>
                  )}
                </div>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => void handleFilesSelected(e.target.files)}
                />

                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDragging(true);
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  className={`rounded-xl border-2 border-dashed p-6 sm:p-8 text-center transition-colors cursor-pointer ${
                    isDragging
                      ? 'border-[#2563EB] bg-blue-50/70'
                      : 'border-slate-300 bg-slate-50/70 hover:border-slate-400 hover:bg-slate-50'
                  }`}
                >
                  <div className="mx-auto w-11 h-11 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-[#2563EB]">
                    <FolderUp className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <p className="mt-3 text-sm font-semibold text-slate-900">
                    {extractingFiles
                      ? 'Menyiapkan pratinjau media...'
                      : 'Tarik file ke sini atau klik untuk memilih'}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Mendukung video 4K/MKV/MP4 bergiga-giga, foto, arsip ZIP, dan semua jenis file
                  </p>
                </div>

                {/* Batch Queue List with Media Previews */}
                {queue.length > 0 && (
                  <div className="space-y-3 pt-1">
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden bg-white max-h-80 overflow-y-auto">
                      {queue.map((item) => (
                        <div
                          key={item.id}
                          className="p-3 flex items-center gap-3 hover:bg-slate-50/60"
                        >
                          <FilePreviewThumb
                            category={item.category}
                            previewDataUrl={item.previewDataUrl}
                            name={item.name}
                          />

                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-900 truncate">
                              {item.name}
                            </p>
                            <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                              {formatBytes(item.size)}
                              {item.duration ? ` · ${formatDuration(item.duration)}` : ''}
                              {item.width && item.height ? ` · ${item.width}×${item.height}` : ''}
                              {item.status === 'transferring' && ` · ${item.progress}%`}
                              {item.status === 'completed' && ' · Terkirim'}
                            </p>
                          </div>

                          {!isTransferring && (
                            <button
                              type="button"
                              onClick={() => removeQueueItem(item.id)}
                              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-[#DC2626] hover:bg-red-50 transition-colors shrink-0 cursor-pointer"
                              aria-label={`Hapus ${item.name}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* Primary Send Action Bar */}
                    <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div className="text-xs text-slate-600 font-mono tabular-nums">
                        Total {queue.length} file · {formatBytes(totalQueueBytes)}
                        {selectedPeer && (
                          <span className="font-sans text-slate-700">
                            {' '}
                            → Tujuan: <strong>{selectedPeer.name}</strong>
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        disabled={!selectedPeer || isTransferring || queue.length === 0}
                        onClick={() => selectedPeer && void sendBatchToPeer(selectedPeer)}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 min-h-[48px] sm:min-h-[44px] px-5 py-2.5 text-sm font-semibold text-white bg-[#2563EB] hover:bg-blue-700 disabled:bg-slate-300 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                      >
                        <Send className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span className="truncate max-w-[220px] sm:max-w-none">
                          {selectedPeer
                            ? `Kirim ke ${selectedPeer.name}`
                            : 'Pilih Perangkat Tujuan'}
                        </span>
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

        {activeTab === 'riwayat' && (
          <section className="rounded-xl bg-white border border-slate-200 p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <History className="w-5 h-5 text-slate-700" aria-hidden="true" />
                <h1 className="text-lg font-bold text-slate-900">Riwayat Transfer</h1>
              </div>
              {history.length > 0 && (
                <button
                  type="button"
                  onClick={clearHistory}
                  className="min-h-[40px] px-3.5 py-2 text-xs font-medium text-slate-600 hover:text-[#DC2626] hover:bg-red-50 rounded-lg transition-colors cursor-pointer"
                >
                  Bersihkan Riwayat
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-500">
                Belum ada riwayat transfer pada perangkat ini.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {history.map((item) => {
                  const speed = formatSpeed(item.avgSpeedBytesPerSec);
                  const dateLabel = new Date(item.timestamp).toLocaleTimeString('id-ID', {
                    hour: '2-digit',
                    minute: '2-digit',
                  });
                  const statusLabel =
                    item.status === 'completed'
                      ? 'Selesai'
                      : item.status === 'rejected'
                        ? 'Ditolak'
                        : item.status === 'cancelled'
                          ? 'Dibatalkan'
                          : 'Gagal';
                  const statusColor =
                    item.status === 'completed' ? 'text-[#16A34A]' : 'text-[#DC2626]';

                  return (
                    <div key={item.id} className="py-3.5 space-y-2.5">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                            {item.direction === 'send' ? (
                              <ArrowUpRight className="w-4 h-4 text-[#2563EB]" aria-hidden="true" />
                            ) : (
                              <ArrowDownLeft className="w-4 h-4 text-[#16A34A]" aria-hidden="true" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate">
                              {item.firstFileName}
                              {item.fileCount > 1 ? ` (+${item.fileCount - 1} lainnya)` : ''}
                            </p>
                            <p className="text-xs text-slate-500">
                              {item.direction === 'send' ? 'Dikirim ke' : 'Diterima dari'}{' '}
                              <span className="font-medium text-slate-700">{item.peerName}</span> ·{' '}
                              <span className="font-mono tabular-nums">{dateLabel}</span>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-4 text-xs font-mono tabular-nums pl-12 sm:pl-0 shrink-0">
                          <span className="text-slate-600">{formatBytes(item.totalBytes)}</span>
                          {item.status === 'completed' && (
                            <span className="text-slate-600">{speed.mbPerSec}</span>
                          )}
                          <span className={`font-sans font-semibold ${statusColor}`}>
                            {statusLabel}
                          </span>
                        </div>
                      </div>

                      {item.direction === 'receive' &&
                        item.status === 'completed' &&
                        item.files &&
                        item.files.length > 0 && (
                          <div className="pl-12 space-y-1.5">
                            {item.files.map((f) => (
                              <div
                                key={`${item.id}-${f.id}`}
                                className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <p className="text-xs font-medium text-slate-800 truncate">
                                    {f.name}
                                  </p>
                                  <p className="text-[11px] text-slate-500 font-mono truncate">
                                    {formatBytes(f.size)}
                                    {f.savedPath ? ` · ${f.savedPath}` : ''}
                                  </p>
                                </div>
                                {(f.contentUri || f.savedPath || f.previewUrl) && (
                                  <button
                                    type="button"
                                    onClick={() => setViewingFile(f)}
                                    className="inline-flex items-center gap-1 min-h-[34px] px-3 py-1 text-xs font-semibold text-white bg-[#2563EB] hover:bg-blue-700 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                  >
                                    <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                                    <span>Buka</span>
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {activeTab === 'panduan' && (
          <section className="rounded-xl bg-white border border-slate-200 p-5 sm:p-6 space-y-6">
            <div className="flex items-center gap-2.5">
              <Info className="w-5 h-5 text-[#2563EB]" aria-hidden="true" />
              <h1 className="text-lg font-bold text-slate-900">
                Cara Kerja & Tips Video Ukuran Besar
              </h1>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div className="text-xs font-semibold text-[#2563EB]">01. Koneksi Langsung WiFi</div>
                <h2 className="text-sm font-bold text-slate-900">Tanpa Upload ke Server</h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Server hanya mempertemukan perangkat. File dan video mengalir langsung antarperangkat
                  melalui WebRTC DataChannel di jaringan WiFi Anda.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div className="text-xs font-semibold text-[#2563EB]">02. Aman untuk Video 4K</div>
                <h2 className="text-sm font-bold text-slate-900">Streaming Potongan 64 KB</h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  File dipecah per potongan kecil dengan kontrol buffer otomatis sehingga browser
                  tidak mengalami kehabisan RAM saat mengirim video bergiga-giga.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-1.5">
                <div className="text-xs font-semibold text-[#2563EB]">03. APK Android Mandiri</div>
                <h2 className="text-sm font-bold text-slate-900">Simpan ke Download/EzTransfer</h2>
                <p className="text-xs text-slate-600 leading-relaxed">
                  APK EzTransfer menemukan perangkat lain di WiFi yang sama secara otomatis dan
                  menyimpan file langsung ke folder Download/EzTransfer tanpa butuh browser Chrome.
                </p>
              </div>
            </div>

            {!nativeAndroid && (
              <div className="pt-4 border-t border-slate-200 space-y-4">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <Terminal className="w-5 h-5 text-slate-700 shrink-0" aria-hidden="true" />
                    <div>
                      <h2 className="text-base font-bold text-slate-900">
                        Unduh File Setup (.txt) untuk Build APK di GitHub
                      </h2>
                      <p className="text-xs text-slate-500">
                        Hanya mengekstrak kode ke ~/eztransfer untuk di-push ke GitHub Actions (tanpa
                        menjalankan server web di Termux).
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={downloadingTxt}
                      onClick={() => void handleDownloadTxt()}
                      className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-sm font-medium text-white bg-[#2563EB] hover:bg-blue-700 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Download className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{downloadingTxt ? 'Mengunduh...' : 'Unduh Setup (.txt)'}</span>
                    </button>

                    <button
                      type="button"
                      disabled={copyingTxt}
                      onClick={() => void handleCopyTxtContent()}
                      className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2 text-sm font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Copy className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>{copyingTxt ? 'Menyalin...' : 'Salin Isi File (.txt)'}</span>
                    </button>
                  </div>
                </div>

                {txtFeedback && (
                  <div
                    className={`rounded-lg px-3.5 py-2.5 text-xs leading-relaxed border ${
                      txtFeedback.type === 'success'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                        : 'bg-red-50 border-red-200 text-red-700'
                    }`}
                  >
                    {txtFeedback.text}
                  </div>
                )}

                <div className="rounded-xl bg-slate-900 text-slate-100 p-4 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-slate-300">
                      Jalankan di Termux untuk ekstrak kode lalu langsung push ke GitHub:
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        const cmd =
                          'bash ~/storage/downloads/eztransfer-setup.txt && cd ~/eztransfer && git add . && git commit -m "Build APK" && git push';
                        const ok = await copyPlainText(cmd);
                        if (ok) {
                          setCopiedTermuxCmd(true);
                          window.setTimeout(() => setCopiedTermuxCmd(false), 2000);
                        }
                      }}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 rounded-md cursor-pointer shrink-0"
                    >
                      {copiedTermuxCmd ? (
                        <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                      )}
                      <span>{copiedTermuxCmd ? 'Tersalin' : 'Salin'}</span>
                    </button>
                  </div>
                  <pre className="text-xs font-mono text-slate-200 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
{`bash ~/storage/downloads/eztransfer-setup.txt
cd ~/eztransfer && git add . && git commit -m "Build APK" && git push`}
                  </pre>
                  <p className="text-[11px] text-slate-400 leading-relaxed">
                    Setelah push selesai, buka tab <strong className="text-slate-200">Releases</strong> atau{' '}
                    <strong className="text-slate-200">Actions</strong> di GitHub untuk mengunduh{' '}
                    <code className="text-slate-200">EzTransfer.apk</code>.
                  </p>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      {/* Mobile Bottom Tab Bar (Thumb Zone) */}
      <nav
        aria-label="Navigasi Utama Seluler"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur border-t border-slate-200 grid grid-cols-3 h-14"
      >
        <button
          type="button"
          onClick={() => setActiveTab('transfer')}
          className={`flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors cursor-pointer ${
            activeTab === 'transfer' ? 'text-[#2563EB]' : 'text-slate-500'
          }`}
        >
          <Send className="w-5 h-5 mb-0.5" aria-hidden="true" />
          <span>Transfer</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('riwayat')}
          className={`flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors cursor-pointer ${
            activeTab === 'riwayat' ? 'text-[#2563EB]' : 'text-slate-500'
          }`}
        >
          <History className="w-5 h-5 mb-0.5" aria-hidden="true" />
          <span>Riwayat{history.length > 0 ? ` (${history.length})` : ''}</span>
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('panduan')}
          className={`flex flex-col items-center justify-center min-h-[44px] text-[11px] font-medium transition-colors cursor-pointer ${
            activeTab === 'panduan' ? 'text-[#2563EB]' : 'text-slate-500'
          }`}
        >
          <Info className="w-5 h-5 mb-0.5" aria-hidden="true" />
          <span>Panduan</span>
        </button>
      </nav>

      {/* 1-to-1 Receiver Confirmation Modal */}
      {incomingOffer && (
        <IncomingOfferModal
          offer={incomingOffer}
          onAccept={() => void acceptIncomingOffer()}
          onReject={() => void rejectIncomingOffer()}
        />
      )}

      {/* In-App File Viewer Modal */}
      <FileViewerModal
        file={viewingFile}
        nativeServerInfo={nativeServerInfo}
        onClose={() => setViewingFile(null)}
      />

      {/* Offline Status Banner */}
      {!isOnline && (
        <div className="fixed bottom-16 md:bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-[#D97706] px-3.5 py-2 text-xs font-medium text-white shadow-lg">
          <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>Koneksi WiFi / jaringan terputus</span>
        </div>
      )}
    </div>
  );
}

# EzTransfer

Aplikasi Android APK kirim-terima file dan video berukuran besar via WiFi berbasis WebRTC Peer-to-Peer.

- **100% Gratis & Mandiri (Offline WiFi):** Tidak membutuhkan Chrome PWA, Termux server, atau server cloud berbayar.
- **Auto-Discovery WiFi:** Dua HP dengan aplikasi **EzTransfer.apk** pada WiFi yang sama otomatis saling menemukan, atau perangkat lain dapat membuka alamat lokal yang tampil di aplikasi.
- **Simpan Langsung:** File dan video yang diterima di APK otomatis tersimpan ke folder **`Download/EzTransfer`**.

## Build APK Android Otomatis di GitHub (100% Gratis)

Repository ini dilengkapi workflow GitHub Actions (`.github/workflows/build-apk.yml`) berbasis Capacitor. Setiap kali kode di-push ke branch `main`:

1. GitHub otomatis mem-build **`EzTransfer.apk`**.
2. Buka halaman repository GitHub Anda → klik menu **Releases** (atau tab **Actions → Artifacts → EzTransfer-APK**) → unduh **`EzTransfer.apk`** dan pasang di HP Android Anda.

## Mengunggah / Memperbarui Kode ke GitHub dari Termux

1. Unduh file **`eztransfer-setup.txt`** (simpan di folder Download HP Anda).
2. Ekstrak dan push ke GitHub:
   ```bash
   bash ~/storage/downloads/eztransfer-setup.txt
   cd ~/eztransfer && git add . && git commit -m "Build APK" && git push
   ```

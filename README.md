# EzTransfer

Aplikasi kirim-terima file dan video berukuran besar via WiFi berbasis WebRTC Peer-to-Peer, responsif untuk HP, Tablet, dan Laptop/PC Windows, serta dapat dipasang sebagai aplikasi desktop Windows (PWA).

**100% Gratis (Free & Open-Source)**: Tidak membutuhkan server berbayar, akun cloud, atau API key berbayar.

## Menjalankan di Termux dari File Download (.txt)

1. Unduh file **`eztransfer-setup.txt`** lewat aplikasi (tersimpan otomatis di folder **Download** HP Anda).
2. Buka **Termux**, beri izin akses folder Download (cukup sekali):
   ```bash
   termux-setup-storage
   ```
3. Panggil file `.txt` tersebut:
   ```bash
   bash ~/storage/downloads/eztransfer-setup.txt
   ```
   Perintah ini otomatis mengekstrak seluruh kode ke `~/eztransfer`, memasang Node.js/Git & dependensi gratis, lalu menjalankan server di port `3000`.
4. Cek IP WiFi HP Anda (`ip -4 addr show wlan0 | grep inet`), lalu buka `http://<IP_WIFI>:3000` di Laptop/Windows/HP lain yang satu WiFi.

Untuk menjalankan ulang di lain waktu:
```bash
cd ~/eztransfer && npm run dev
```

## Mengunggah ke GitHub (100% Gratis)

Di dalam folder `~/eztransfer`:

```bash
git init
git add .
git commit -m "Initial commit: EzTransfer"
git branch -M main
git remote add origin https://github.com/USERNAME/eztransfer.git
git push -u origin main
```

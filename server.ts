import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import zlib from 'zlib';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type DeviceType = 'windows' | 'mac' | 'android' | 'ios' | 'linux' | 'other';

interface PeerRecord {
  id: string;
  pairCode: string;
  name: string;
  deviceType: DeviceType;
  networkKey: string;
  status: 'idle' | 'transferring';
  ws: WebSocket;
  isAlive: boolean;
}

interface PublicPeer {
  id: string;
  pairCode: string;
  name: string;
  deviceType: DeviceType;
  status: 'idle' | 'transferring';
}

function normalizeNetworkKey(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  let ip = '';
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    ip = forwarded.split(',')[0].trim();
  } else if (Array.isArray(forwarded) && forwarded.length > 0) {
    ip = forwarded[0].trim();
  } else {
    ip = req.socket.remoteAddress || 'unknown';
  }

  if (ip.startsWith('::ffff:')) {
    ip = ip.slice(7);
  }
  if (ip === '::1' || ip === '127.0.0.1' || ip === 'localhost') {
    return 'local-loopback';
  }

  // Group IPv4 private LAN /24 or public NAT IP into a consistent WiFi bucket
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const parts = ip.split('.');
    if (parts[0] === '192' && parts[1] === '168') {
      return `lan-${parts[0]}.${parts[1]}.${parts[2]}`;
    }
    if (parts[0] === '10') {
      return `lan-10.${parts[1]}.${parts[2]}`;
    }
    return `net-${ip}`;
  }

  return `net-${ip}`;
}

function toPublicPeer(peer: PeerRecord): PublicPeer {
  return {
    id: peer.id,
    pairCode: peer.pairCode,
    name: peer.name,
    deviceType: peer.deviceType,
    status: peer.status,
  };
}

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const peers = new Map<string, PeerRecord>();
  const codeToPeerId = new Map<string, string>();

  function generatePairCode(): string {
    for (let i = 0; i < 20; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!codeToPeerId.has(code)) return code;
    }
    return String(Date.now()).slice(-6);
  }

  function sendJson(ws: WebSocket, payload: unknown) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function broadcastNetworkPeers(networkKey: string) {
    const sameNetworkPeers: PeerRecord[] = [];
    for (const peer of peers.values()) {
      if (peer.networkKey === networkKey) {
        sameNetworkPeers.push(peer);
      }
    }

    for (const target of sameNetworkPeers) {
      const others = sameNetworkPeers
        .filter((p) => p.id !== target.id)
        .map(toPublicPeer);
      sendJson(target.ws, {
        type: 'peers:update',
        peers: others,
      });
    }
  }

  wss.on('connection', (ws, req) => {
    const peerId = randomUUID();
    const pairCode = generatePairCode();
    const networkKey = normalizeNetworkKey(req);

    const record: PeerRecord = {
      id: peerId,
      pairCode,
      name: `Perangkat-${pairCode.slice(-3)}`,
      deviceType: 'other',
      networkKey,
      status: 'idle',
      ws,
      isAlive: true,
    };

    peers.set(peerId, record);
    codeToPeerId.set(pairCode, peerId);

    sendJson(ws, {
      type: 'welcome',
      self: toPublicPeer(record),
    });

    broadcastNetworkPeers(networkKey);

    ws.on('pong', () => {
      record.isAlive = true;
    });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.type;
      if (typeof type !== 'string') return;

      if (type === 'peer:update') {
        if (typeof msg.name === 'string' && msg.name.trim()) {
          record.name = msg.name.trim().slice(0, 40);
        }
        if (
          msg.deviceType === 'windows' ||
          msg.deviceType === 'mac' ||
          msg.deviceType === 'android' ||
          msg.deviceType === 'ios' ||
          msg.deviceType === 'linux' ||
          msg.deviceType === 'other'
        ) {
          record.deviceType = msg.deviceType;
        }
        if (msg.status === 'idle' || msg.status === 'transferring') {
          record.status = msg.status;
        }
        sendJson(ws, { type: 'self:updated', self: toPublicPeer(record) });
        broadcastNetworkPeers(record.networkKey);
        return;
      }

      if (type === 'pair:lookup') {
        const code = typeof msg.code === 'string' ? msg.code.trim() : '';
        const targetId = codeToPeerId.get(code);
        const target = targetId ? peers.get(targetId) : undefined;
        if (!target || target.id === record.id) {
          sendJson(ws, {
            type: 'pair:result',
            ok: false,
            code,
            error: 'Kode tidak ditemukan atau perangkat sedang offline.',
          });
          return;
        }
        sendJson(ws, {
          type: 'pair:result',
          ok: true,
          code,
          peer: toPublicPeer(target),
        });
        return;
      }

      if (
        type === 'webrtc:offer' ||
        type === 'webrtc:answer' ||
        type === 'webrtc:ice' ||
        type === 'webrtc:cancel'
      ) {
        const targetPeerId = typeof msg.targetPeerId === 'string' ? msg.targetPeerId : '';
        const target = peers.get(targetPeerId);
        if (!target) {
          sendJson(ws, {
            type: 'signal:error',
            targetPeerId,
            error: 'Perangkat tujuan tidak terhubung.',
          });
          return;
        }

        sendJson(target.ws, {
          ...msg,
          fromPeerId: record.id,
          fromPeer: toPublicPeer(record),
        });
      }
    });

    ws.on('close', () => {
      peers.delete(peerId);
      codeToPeerId.delete(pairCode);
      broadcastNetworkPeers(networkKey);
    });
  });

  // Heartbeat cleanup every 25s
  const heartbeatInterval = setInterval(() => {
    for (const [id, peer] of peers.entries()) {
      if (!peer.isAlive) {
        peer.ws.terminate();
        peers.delete(id);
        codeToPeerId.delete(peer.pairCode);
        broadcastNetworkPeers(peer.networkKey);
        continue;
      }
      peer.isAlive = false;
      peer.ws.ping();
    }
  }, 25000);

  wss.on('close', () => clearInterval(heartbeatInterval));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, connectedPeers: peers.size });
  });

  app.get(['/api/download-txt', '/eztransfer-setup.txt', '/kinetik-wifi-setup.txt'], (_req, res) => {
    try {
      const rootDir = __dirname;
      const allowFiles = [
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'server.ts',
        'index.html',
        'metadata.json',
        '.env.example',
        '.gitignore',
        'README.md',
      ];
      const allowDirs = ['src', 'public'];
      const collected: Array<{ relPath: string; b64: string }> = [];

      for (const file of allowFiles) {
        const full = path.join(rootDir, file);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          collected.push({
            relPath: file,
            b64: fs.readFileSync(full).toString('base64'),
          });
        }
      }

      const walkDir = (dirRel: string) => {
        const dirFull = path.join(rootDir, dirRel);
        if (!fs.existsSync(dirFull)) return;
        for (const entry of fs.readdirSync(dirFull, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const nextRel = `${dirRel}/${entry.name}`;
          const nextFull = path.join(rootDir, nextRel);
          if (entry.isDirectory()) {
            walkDir(nextRel);
          } else if (entry.isFile()) {
            collected.push({
              relPath: nextRel,
              b64: fs.readFileSync(nextFull).toString('base64'),
            });
          }
        }
      };

      for (const d of allowDirs) {
        walkDir(d);
      }

      const lines: string[] = [
        '#!/usr/bin/env bash',
        'set -e',
        '',
        'TARGET_DIR="$HOME/eztransfer"',
        'echo "============================================"',
        'echo "  EzTransfer - Setup Termux 100% Free"',
        'echo "============================================"',
        'echo "[1/4] Menyiapkan folder proyek di $TARGET_DIR..."',
        'mkdir -p "$TARGET_DIR"',
        '',
        'B64_DEC="base64 -d"',
        'if ! printf "SGk=" | base64 -d >/dev/null 2>&1; then',
        '  B64_DEC="base64 -D"',
        'fi',
        '',
        'write_b64_file() {',
        '  mkdir -p "$(dirname "$1")"',
        '  $B64_DEC > "$1"',
        '}',
        '',
        'echo "[2/4] Mengekstrak seluruh kode sumber..."',
      ];

      for (const item of collected) {
        const wrapped = item.b64.replace(/(.{76})/g, '$1\n');
        lines.push(`write_b64_file "$TARGET_DIR/${item.relPath}" << 'EOF_KINETIK_B64'`);
        lines.push(wrapped);
        lines.push('EOF_KINETIK_B64');
      }

      lines.push(
        '',
        'echo "[3/4] Memeriksa Node.js & Git..."',
        'if ! command -v node >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then',
        '  if [ -n "$PREFIX" ] && command -v pkg >/dev/null 2>&1; then',
        '    pkg update -y && pkg install -y nodejs git',
        '  else',
        '    echo "Silakan pasang Node.js dan Git terlebih dahulu."',
        '    exit 1',
        '  fi',
        'fi',
        '',
        'echo "[4/4] Memasang dependensi npm (100% open-source/gratis)..."',
        'cd "$TARGET_DIR"',
        'npm install',
        '',
        'WIFI_IP="$(ip -4 addr show wlan0 2>/dev/null | awk \'/inet /{print $2}\' | cut -d/ -f1 | head -n1)"',
        'echo ""',
        'echo "Selesai! Aplikasi siap dijalankan."',
        'if [ -n "$WIFI_IP" ]; then',
        '  echo "Buka di browser HP/Laptop/Windows se-WiFi: http://$WIFI_IP:3000"',
        'fi',
        'echo "Untuk push ke GitHub gratis, lihat panduan di README.md."',
        'echo "Menjalankan server di port 3000..."',
        'npm run dev',
        ''
      );

      const scriptText = lines.join('\n');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="eztransfer-setup.txt"');
      res.setHeader('Content-Length', String(Buffer.byteLength(scriptText, 'utf8')));
      res.send(scriptText);
    } catch {
      res.status(500).send('Gagal membuat file eztransfer-setup.txt');
    }
  });

  app.get('/api/download-source', (_req, res) => {
    try {
      const rootDir = __dirname;
      const allowFiles = [
        'package.json',
        'tsconfig.json',
        'vite.config.ts',
        'server.ts',
        'index.html',
        'metadata.json',
        '.env.example',
        '.gitignore',
        'README.md',
      ];
      const allowDirs = ['src', 'public'];

      const collected: Array<{ relPath: string; content: Buffer; mtime: number }> = [];

      for (const file of allowFiles) {
        const full = path.join(rootDir, file);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          const stat = fs.statSync(full);
          collected.push({
            relPath: file,
            content: fs.readFileSync(full),
            mtime: Math.floor(stat.mtimeMs / 1000),
          });
        }
      }

      const walkDir = (dirRel: string) => {
        const dirFull = path.join(rootDir, dirRel);
        if (!fs.existsSync(dirFull)) return;
        for (const entry of fs.readdirSync(dirFull, { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const nextRel = `${dirRel}/${entry.name}`;
          const nextFull = path.join(rootDir, nextRel);
          if (entry.isDirectory()) {
            walkDir(nextRel);
          } else if (entry.isFile()) {
            const stat = fs.statSync(nextFull);
            collected.push({
              relPath: nextRel,
              content: fs.readFileSync(nextFull),
              mtime: Math.floor(stat.mtimeMs / 1000),
            });
          }
        }
      };

      for (const d of allowDirs) {
        walkDir(d);
      }

      const tarChunks: Buffer[] = [];
      for (const item of collected) {
        const header = Buffer.alloc(512, 0);
        const fullName = item.relPath;
        let name = fullName;
        let prefix = '';
        if (Buffer.byteLength(fullName) > 100) {
          const slashIdx = fullName.lastIndexOf('/');
          if (slashIdx > 0) {
            prefix = fullName.slice(0, slashIdx);
            name = fullName.slice(slashIdx + 1);
          }
        }
        header.write(name.slice(0, 100), 0, 'utf8');
        header.write('0000644\0', 100, 'ascii');
        header.write('0000000\0', 108, 'ascii');
        header.write('0000000\0', 116, 'ascii');
        header.write(`${item.content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
        header.write(`${item.mtime.toString(8).padStart(11, '0')}\0`, 136, 'ascii');
        header.fill(0x20, 148, 156); // checksum placeholder spaces
        header.write('0', 156, 'ascii'); // normal file
        header.write('ustar\0', 257, 'ascii');
        header.write('00', 263, 'ascii');
        if (prefix) {
          header.write(prefix.slice(0, 155), 345, 'utf8');
        }

        let sum = 0;
        for (let i = 0; i < 512; i++) sum += header[i];
        header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

        tarChunks.push(header);
        tarChunks.push(item.content);
        const rem = item.content.length % 512;
        if (rem !== 0) {
          tarChunks.push(Buffer.alloc(512 - rem, 0));
        }
      }
      tarChunks.push(Buffer.alloc(1024, 0)); // EOF 2x 512-byte zero blocks

      const gzipped = zlib.gzipSync(Buffer.concat(tarChunks));
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', 'attachment; filename="eztransfer.tar.gz"');
      res.setHeader('Content-Length', String(gzipped.length));
      res.send(gzipped);
    } catch {
      res.status(500).json({ error: 'Gagal membuat arsip kode sumber.' });
    }
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => {
    console.log(`EzTransfer berjalan di http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Gagal menjalankan server:', err);
  process.exit(1);
});

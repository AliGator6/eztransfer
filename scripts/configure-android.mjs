import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const androidDir = path.join(rootDir, 'android');

if (!fs.existsSync(androidDir)) {
  console.error('Folder android/ tidak ditemukan. Jalankan "npx cap add android" terlebih dahulu.');
  process.exit(1);
}

const appDir = path.join(androidDir, 'app');
const mainDir = path.join(appDir, 'src', 'main');
const javaPkgDir = path.join(mainDir, 'java', 'com', 'eztransfer', 'app');
fs.mkdirSync(javaPkgDir, { recursive: true });

// 1. Update strings.xml
const stringsXmlPath = path.join(mainDir, 'res', 'values', 'strings.xml');
const stringsXml = `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">EzTransfer</string>
    <string name="title_activity_main">EzTransfer</string>
    <string name="package_name">com.eztransfer.app</string>
    <string name="custom_url_scheme">com.eztransfer.app</string>
</resources>
`;
fs.writeFileSync(stringsXmlPath, stringsXml, 'utf8');

// 2. Update AndroidManifest.xml with cleartext LAN + Media/Storage permissions
const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:usesCleartextTraffic="true">

        <activity
            android:configChanges="orientation|keyboardHidden|keyboard|screenSize|locale|smallestScreenSize|screenLayout|uiMode|navigation|density"
            android:name=".MainActivity"
            android:label="@string/title_activity_main"
            android:theme="@style/AppTheme.NoActionBarLaunch"
            android:launchMode="singleTask"
            android:exported="true">

            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>

        </activity>

        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths"></meta-data>
        </provider>
    </application>

    <!-- WiFi & Media Permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
    <uses-permission android:name="android.permission.READ_MEDIA_AUDIO" />
</manifest>
`;
fs.writeFileSync(manifestPath, manifestXml, 'utf8');

// 3. Copy EzTransfer PNG launcher icons
const icon512 = path.join(rootDir, 'public', 'pwa-512x512.png');
const icon192 = path.join(rootDir, 'public', 'pwa-192x192.png');
const iconSource = fs.existsSync(icon512) ? icon512 : icon192;
if (fs.existsSync(iconSource)) {
  const mipmapDirs = [
    'mipmap-mdpi',
    'mipmap-hdpi',
    'mipmap-xhdpi',
    'mipmap-xxhdpi',
    'mipmap-xxxhdpi',
  ];
  for (const dirName of mipmapDirs) {
    const destDir = path.join(mainDir, 'res', dirName);
    if (fs.existsSync(destDir)) {
      const targetIcon = dirName === 'mipmap-mdpi' || dirName === 'mipmap-hdpi' ? (fs.existsSync(icon192) ? icon192 : iconSource) : iconSource;
      fs.copyFileSync(targetIcon, path.join(destDir, 'ic_launcher.png'));
      fs.copyFileSync(targetIcon, path.join(destDir, 'ic_launcher_round.png'));
      fs.copyFileSync(targetIcon, path.join(destDir, 'ic_launcher_foreground.png'));
    }
  }
  const anyDpiDir = path.join(mainDir, 'res', 'mipmap-anydpi-v26');
  if (fs.existsSync(anyDpiDir)) {
    fs.rmSync(anyDpiDir, { recursive: true, force: true });
  }
}

// 4. Write MainActivity.java
const mainActivityJava = `package com.eztransfer.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EzWifiServerPlugin.class);
        registerPlugin(EzFileSaverPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
fs.writeFileSync(path.join(javaPkgDir, 'MainActivity.java'), mainActivityJava, 'utf8');

// 5. Write EzFileSaverPlugin.java (direct MediaStore.Downloads streaming + in-app / native opener)
const ezFileSaverJava = `package com.eztransfer.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@CapacitorPlugin(
    name = "EzFileSaver",
    permissions = {
        @Permission(
            alias = "storage",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE
            }
        )
    }
)
public class EzFileSaverPlugin extends Plugin {

    private static class SaveSession {
        OutputStream outputStream;
        Uri mediaUri;
        File legacyFile;
        String fileName;
        String mimeType;
    }

    private final Map<String, SaveSession> sessions = new ConcurrentHashMap<>();

    private String sanitizeFileName(String name) {
        if (name == null || name.trim().isEmpty()) {
            return "file_diterima";
        }
        String cleaned = name.replaceAll("[<>:\\"/\\\\\\\\|?*\\\\x00-\\\\x1F]", "_").trim();
        return cleaned.isEmpty() ? "file_diterima" : cleaned;
    }

    @PluginMethod
    public void openFile(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("storage") != PermissionState.GRANTED) {
            requestPermissionForAlias("storage", call, "storagePermCallback");
            return;
        }
        openFileInternal(call);
    }

    @PermissionCallback
    private void storagePermCallback(PluginCall call) {
        if (getPermissionState("storage") == PermissionState.GRANTED) {
            openFileInternal(call);
        } else {
            call.reject("Izin penyimpanan diperlukan untuk menyimpan file ke folder Download.");
        }
    }

    private Uri insertIntoDownloadsMediaStore(ContentResolver resolver, String fileName, String mimeType) {
        String relPath = Environment.DIRECTORY_DOWNLOADS + "/EzTransfer";
        String[] candidateMimes = (mimeType != null && !mimeType.trim().isEmpty() && !"application/octet-stream".equals(mimeType))
            ? new String[] { mimeType.trim(), "application/octet-stream", null }
            : new String[] { "application/octet-stream", null };

        for (String candidateMime : candidateMimes) {
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                if (candidateMime != null) {
                    values.put(MediaStore.Downloads.MIME_TYPE, candidateMime);
                }
                values.put(MediaStore.Downloads.RELATIVE_PATH, relPath);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri != null) {
                    return uri;
                }
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    private void openFileInternal(PluginCall call) {
        String transferId = call.getString("transferId");
        String fileName = sanitizeFileName(call.getString("fileName"));
        String mimeType = call.getString("mimeType", "application/octet-stream");
        if (transferId == null || transferId.isEmpty()) {
            call.reject("transferId wajib diisi");
            return;
        }

        try {
            SaveSession session = new SaveSession();
            session.fileName = fileName;
            session.mimeType = (mimeType != null && !mimeType.trim().isEmpty()) ? mimeType : "application/octet-stream";

            Uri resolvedUri = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                Uri uri = insertIntoDownloadsMediaStore(resolver, fileName, session.mimeType);
                if (uri == null) {
                    call.reject("Gagal membuat file di folder Download/EzTransfer");
                    return;
                }
                OutputStream os = resolver.openOutputStream(uri);
                if (os == null) {
                    resolver.delete(uri, null, null);
                    call.reject("Gagal membuka stream penulisan file");
                    return;
                }
                session.mediaUri = uri;
                session.outputStream = os;
                resolvedUri = uri;
            } else {
                File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File targetDir = new File(downloadsDir, "EzTransfer");
                if (!targetDir.exists()) {
                    targetDir.mkdirs();
                }
                File outFile = new File(targetDir, fileName);
                int counter = 1;
                while (outFile.exists()) {
                    int dot = fileName.lastIndexOf('.');
                    String candidate = dot > 0
                        ? fileName.substring(0, dot) + " (" + counter + ")" + fileName.substring(dot)
                        : fileName + " (" + counter + ")";
                    outFile = new File(targetDir, candidate);
                    counter++;
                }
                session.fileName = outFile.getName();
                session.legacyFile = outFile;
                session.outputStream = new FileOutputStream(outFile);
                resolvedUri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    outFile
                );
            }

            sessions.put(transferId, session);
            JSObject result = new JSObject();
            result.put("savedPath", "Download/EzTransfer/" + session.fileName);
            if (resolvedUri != null) {
                result.put("contentUri", resolvedUri.toString());
            }
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Gagal menyiapkan file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void appendChunk(PluginCall call) {
        String transferId = call.getString("transferId");
        String base64 = call.getString("base64");
        if (transferId == null || base64 == null) {
            call.reject("Parameter tidak lengkap");
            return;
        }
        SaveSession session = sessions.get(transferId);
        if (session == null || session.outputStream == null) {
            call.reject("Sesi file tidak ditemukan");
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            session.outputStream.write(bytes);
            call.resolve();
        } catch (Exception e) {
            call.reject("Gagal menulis potongan file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void closeFile(PluginCall call) {
        String transferId = call.getString("transferId");
        boolean abort = Boolean.TRUE.equals(call.getBoolean("abort", false));
        if (transferId == null) {
            call.resolve();
            return;
        }
        SaveSession session = sessions.remove(transferId);
        if (session == null) {
            call.resolve();
            return;
        }

        try {
            if (session.outputStream != null) {
                try {
                    session.outputStream.flush();
                } catch (Exception ignored) {
                }
                try {
                    session.outputStream.close();
                } catch (Exception ignored) {
                }
            }

            String contentUriStr = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && session.mediaUri != null) {
                ContentResolver resolver = getContext().getContentResolver();
                if (abort) {
                    resolver.delete(session.mediaUri, null, null);
                } else {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.IS_PENDING, 0);
                    resolver.update(session.mediaUri, values, null, null);
                    contentUriStr = session.mediaUri.toString();
                }
            } else if (session.legacyFile != null) {
                if (abort && session.legacyFile.exists()) {
                    session.legacyFile.delete();
                } else if (session.legacyFile.exists()) {
                    MediaScannerConnection.scanFile(
                        getContext(),
                        new String[] { session.legacyFile.getAbsolutePath() },
                        new String[] { session.mimeType },
                        null
                    );
                    contentUriStr = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        session.legacyFile
                    ).toString();
                }
            }

            JSObject result = new JSObject();
            result.put("savedPath", "Download/EzTransfer/" + session.fileName);
            if (contentUriStr != null) {
                result.put("contentUri", contentUriStr);
            }
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Gagal menutup file: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void openSavedFile(PluginCall call) {
        String contentUriStr = call.getString("contentUri", "");
        String savedPath = call.getString("savedPath", "");
        String mimeType = call.getString("mimeType", "*/*");
        if (mimeType == null || mimeType.trim().isEmpty()) {
            mimeType = "*/*";
        }

        try {
            Uri targetUri = null;
            if (contentUriStr != null && !contentUriStr.trim().isEmpty()) {
                targetUri = Uri.parse(contentUriStr.trim());
            } else if (savedPath != null && !savedPath.trim().isEmpty()) {
                String fileName = savedPath.replace("Download/EzTransfer/", "");
                File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File file = new File(new File(downloadsDir, "EzTransfer"), fileName);
                if (file.exists()) {
                    targetUri = FileProvider.getUriForFile(
                        getContext(),
                        getContext().getPackageName() + ".fileprovider",
                        file
                    );
                }
            }

            if (targetUri == null) {
                call.reject("File tidak ditemukan di penyimpanan perangkat.");
                return;
            }

            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(targetUri, mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

            try {
                Intent chooser = Intent.createChooser(intent, "Buka file dengan");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(chooser);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                Intent fallback = new Intent(Intent.ACTION_VIEW);
                fallback.setDataAndType(targetUri, "*/*");
                fallback.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                Intent chooser = Intent.createChooser(fallback, "Buka file dengan");
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(chooser);
                call.resolve();
            }
        } catch (Exception e) {
            call.reject("Tidak ada aplikasi di HP yang mendukung format file ini.", e);
        }
    }
}
`;
fs.writeFileSync(path.join(javaPkgDir, 'EzFileSaverPlugin.java'), ezFileSaverJava, 'utf8');

// 6. Write EzWifiServerPlugin.java (Embedded Pure-Java HTTP Static Server + WebSocket Signaling)
const ezWifiServerJava = `package com.eztransfer.app;

import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "EzWifiServer")
public class EzWifiServerPlugin extends Plugin {

    private static class PeerClient {
        String id;
        String pairCode;
        String name;
        String deviceType = "other";
        String status = "idle";
        Socket socket;
        OutputStream out;
        final Object writeLock = new Object();
        volatile boolean open = true;

        JSONObject toPublicJson() {
            JSONObject obj = new JSONObject();
            try {
                obj.put("id", id);
                obj.put("pairCode", pairCode);
                obj.put("name", name);
                obj.put("deviceType", deviceType);
                obj.put("status", status);
            } catch (Exception ignored) {
            }
            return obj;
        }
    }

    private static final int DISCOVERY_PORT = 45678;
    private ServerSocket serverSocket;
    private DatagramSocket udpListenSocket;
    private int activePort = 0;
    private volatile boolean running = false;
    private ExecutorService executor;
    private final Map<String, PeerClient> peers = new ConcurrentHashMap<>();
    private final Map<String, String> codeToPeerId = new ConcurrentHashMap<>();
    private final Map<String, long[]> discoveredApks = new ConcurrentHashMap<>();
    private final Random random = new Random();

    @Override
    public void load() {
        super.load();
        ensureServerStarted();
    }

    @Override
    protected void handleOnDestroy() {
        stopServerInternal();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void startServer(PluginCall call) {
        ensureServerStarted();
        call.resolve(buildServerInfo());
    }

    @PluginMethod
    public void getServerInfo(PluginCall call) {
        call.resolve(buildServerInfo());
    }

    private synchronized void ensureServerStarted() {
        if (running && serverSocket != null && !serverSocket.isClosed()) {
            return;
        }
        int[] candidatePorts = new int[] { 3000, 3001, 3002, 3003, 3004, 3005 };
        for (int port : candidatePorts) {
            try {
                ServerSocket ss = new ServerSocket(port);
                ss.setReuseAddress(true);
                serverSocket = ss;
                activePort = port;
                running = true;
                executor = Executors.newCachedThreadPool();
                executor.submit(this::acceptLoop);
                executor.submit(this::udpListenLoop);
                executor.submit(this::udpAnnounceLoop);
                return;
            } catch (IOException ignored) {
            }
        }
    }

    private synchronized void stopServerInternal() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (udpListenSocket != null) {
            try {
                udpListenSocket.close();
            } catch (Exception ignored) {
            }
            udpListenSocket = null;
        }
        discoveredApks.clear();
        for (PeerClient p : peers.values()) {
            closePeer(p);
        }
        peers.clear();
        codeToPeerId.clear();
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
    }

    private long ipv4ToLong(String ip) {
        if (ip == null || ip.isEmpty()) return Long.MAX_VALUE;
        String[] parts = ip.split("\\\\.");
        if (parts.length != 4) return Long.MAX_VALUE;
        try {
            long val = 0;
            for (String p : parts) {
                val = (val << 8) | (Integer.parseInt(p) & 0xFFL);
            }
            return val;
        } catch (Exception e) {
            return Long.MAX_VALUE;
        }
    }

    private void udpListenLoop() {
        try {
            DatagramSocket sock = new DatagramSocket(null);
            sock.setReuseAddress(true);
            sock.setBroadcast(true);
            sock.bind(new InetSocketAddress(DISCOVERY_PORT));
            udpListenSocket = sock;
            byte[] buf = new byte[256];
            while (running && !sock.isClosed()) {
                DatagramPacket packet = new DatagramPacket(buf, buf.length);
                sock.receive(packet);
                String msg = new String(packet.getData(), 0, packet.getLength(), StandardCharsets.UTF_8).trim();
                if (!msg.startsWith("EZTRANSFER|")) continue;
                String[] parts = msg.split("\\\\|");
                if (parts.length < 2) continue;
                int remotePort;
                try {
                    remotePort = Integer.parseInt(parts[1].trim());
                } catch (Exception e) {
                    continue;
                }
                String senderIp = packet.getAddress() != null ? packet.getAddress().getHostAddress() : "";
                String myIp = detectWifiIpv4();
                if (senderIp != null && !senderIp.isEmpty() && !senderIp.equals(myIp) && !senderIp.startsWith("127.")) {
                    discoveredApks.put(senderIp, new long[] { remotePort, System.currentTimeMillis() });
                }
            }
        } catch (Exception ignored) {
        }
    }

    private void udpAnnounceLoop() {
        try (DatagramSocket sock = new DatagramSocket()) {
            sock.setBroadcast(true);
            while (running) {
                String myIp = detectWifiIpv4();
                if (!myIp.isEmpty() && activePort > 0) {
                    byte[] payload = ("EZTRANSFER|" + activePort).getBytes(StandardCharsets.UTF_8);
                    try {
                        sock.send(new DatagramPacket(payload, payload.length, InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT));
                    } catch (Exception ignored) {
                    }
                    try {
                        Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
                        while (ifaces != null && ifaces.hasMoreElements()) {
                            NetworkInterface iface = ifaces.nextElement();
                            if (!iface.isUp() || iface.isLoopback()) continue;
                            for (InterfaceAddress ia : iface.getInterfaceAddresses()) {
                                InetAddress bcast = ia.getBroadcast();
                                if (bcast != null) {
                                    try {
                                        sock.send(new DatagramPacket(payload, payload.length, bcast, DISCOVERY_PORT));
                                    } catch (Exception ignored) {
                                    }
                                }
                            }
                        }
                    } catch (Exception ignored) {
                    }
                }
                Thread.sleep(2000);
            }
        } catch (Exception ignored) {
        }
    }

    private JSObject buildServerInfo() {
        String ip = detectWifiIpv4();
        String url = (running && activePort > 0 && !ip.isEmpty())
            ? "http://" + ip + ":" + activePort
            : "";
        String wsUrl = (running && activePort > 0)
            ? "ws://127.0.0.1:" + activePort + "/ws"
            : "";

        long now = System.currentTimeMillis();
        String leaderIp = ip;
        int leaderPort = activePort;
        long leaderNum = ipv4ToLong(ip);

        for (Map.Entry<String, long[]> entry : discoveredApks.entrySet()) {
            long[] meta = entry.getValue();
            if (now - meta[1] > 7000) {
                discoveredApks.remove(entry.getKey());
                continue;
            }
            long candidateNum = ipv4ToLong(entry.getKey());
            if (candidateNum < leaderNum) {
                leaderNum = candidateNum;
                leaderIp = entry.getKey();
                leaderPort = (int) meta[0];
            }
        }

        String recommendedWsUrl = wsUrl;
        if (running && !leaderIp.isEmpty() && !leaderIp.equals(ip) && leaderPort > 0) {
            recommendedWsUrl = "ws://" + leaderIp + ":" + leaderPort + "/ws";
        }

        JSObject obj = new JSObject();
        obj.put("running", running);
        obj.put("port", activePort);
        obj.put("ip", ip);
        obj.put("url", url);
        obj.put("wsUrl", wsUrl);
        obj.put("recommendedWsUrl", recommendedWsUrl);
        obj.put("leaderIp", leaderIp);
        return obj;
    }

    private String detectWifiIpv4() {
        String fallback = "";
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                String ifaceName = iface.getName().toLowerCase(Locale.US);
                Enumeration<InetAddress> addrs = iface.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                        String host = addr.getHostAddress();
                        if (host == null) continue;
                        if (ifaceName.startsWith("wlan") || ifaceName.startsWith("ap") || ifaceName.startsWith("swlan")) {
                            return host;
                        }
                        if (addr.isSiteLocalAddress() && fallback.isEmpty()) {
                            fallback = host;
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return fallback;
    }

    private void acceptLoop() {
        while (running && serverSocket != null && !serverSocket.isClosed()) {
            try {
                Socket client = serverSocket.accept();
                if (executor != null) {
                    executor.submit(() -> handleConnection(client));
                }
            } catch (IOException e) {
                if (!running) break;
            }
        }
    }

    private void handleConnection(Socket socket) {
        try {
            socket.setTcpNoDelay(true);
            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();

            String rawHeader = readHttpHeader(in);
            if (rawHeader == null || rawHeader.isEmpty()) {
                socket.close();
                return;
            }

            String[] lines = rawHeader.split("\\r\\n");
            if (lines.length == 0) {
                socket.close();
                return;
            }
            String[] reqParts = lines[0].split(" ");
            if (reqParts.length < 2) {
                socket.close();
                return;
            }
            String method = reqParts[0].toUpperCase(Locale.US);
            String fullPath = reqParts[1];
            int qIdx = fullPath.indexOf('?');
            String pathOnly = qIdx >= 0 ? fullPath.substring(0, qIdx) : fullPath;

            Map<String, String> headers = new HashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) {
                    headers.put(
                        lines[i].substring(0, colon).trim().toLowerCase(Locale.US),
                        lines[i].substring(colon + 1).trim()
                    );
                }
            }

            String upgrade = headers.get("upgrade");
            if ("/ws".equals(pathOnly) && upgrade != null && "websocket".equalsIgnoreCase(upgrade)) {
                String wsKey = headers.get("sec-websocket-key");
                if (wsKey == null) {
                    socket.close();
                    return;
                }
                handleWebSocket(socket, in, out, wsKey);
                return;
            }

            if ("/api/health".equals(pathOnly)) {
                byte[] body = ("{\\"ok\\":true,\\"connectedPeers\\":" + peers.size() + "}")
                    .getBytes(StandardCharsets.UTF_8);
                writeHttpResponse(out, 200, "OK", "application/json; charset=utf-8", body);
                socket.close();
                return;
            }

            if ("/native-file".equals(pathOnly)) {
                if (!socket.getInetAddress().isLoopbackAddress()) {
                    writeHttpResponse(out, 403, "Forbidden", "text/plain; charset=utf-8", "Forbidden".getBytes(StandardCharsets.UTF_8));
                    socket.close();
                    return;
                }
                String query = qIdx >= 0 ? fullPath.substring(qIdx + 1) : "";
                serveNativeContentFile(out, query, headers, "HEAD".equals(method));
                socket.close();
                return;
            }

            if (!"GET".equals(method) && !"HEAD".equals(method)) {
                writeHttpResponse(out, 405, "Method Not Allowed", "text/plain; charset=utf-8", "Method Not Allowed".getBytes(StandardCharsets.UTF_8));
                socket.close();
                return;
            }

            serveStaticAsset(out, pathOnly, "HEAD".equals(method));
            socket.close();
        } catch (Exception e) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void serveNativeContentFile(OutputStream out, String query, Map<String, String> headers, boolean headOnly) throws IOException {
        String uriParam = null;
        String mimeParam = null;
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;
            String k = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
            String v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
            if ("uri".equals(k)) uriParam = v;
            else if ("mime".equals(k)) mimeParam = v;
        }
        if (uriParam == null || uriParam.isEmpty()) {
            writeHttpResponse(out, 400, "Bad Request", "text/plain; charset=utf-8", "Missing uri".getBytes(StandardCharsets.UTF_8));
            return;
        }

        Uri contentUri = Uri.parse(uriParam);
        String resolvedMime = getContext().getContentResolver().getType(contentUri);
        if (resolvedMime == null || resolvedMime.isEmpty()) {
            resolvedMime = (mimeParam != null && !mimeParam.isEmpty()) ? mimeParam : "application/octet-stream";
        }

        AssetFileDescriptor afd = null;
        try {
            afd = getContext().getContentResolver().openAssetFileDescriptor(contentUri, "r");
        } catch (Exception ignored) {
        }

        long totalLen = afd != null ? afd.getLength() : -1;
        InputStream stream = null;
        try {
            stream = afd != null ? afd.createInputStream() : getContext().getContentResolver().openInputStream(contentUri);
            if (stream == null) {
                writeHttpResponse(out, 404, "Not Found", "text/plain; charset=utf-8", "File not found".getBytes(StandardCharsets.UTF_8));
                return;
            }

            long start = 0;
            long end = totalLen > 0 ? totalLen - 1 : -1;
            boolean isRange = false;
            String rangeHeader = headers.get("range");
            if (rangeHeader != null && rangeHeader.startsWith("bytes=") && totalLen > 0) {
                String spec = rangeHeader.substring(6).split(",")[0].trim();
                int dash = spec.indexOf('-');
                if (dash >= 0) {
                    String sPart = spec.substring(0, dash).trim();
                    String ePart = spec.substring(dash + 1).trim();
                    try {
                        if (!sPart.isEmpty()) {
                            start = Long.parseLong(sPart);
                            end = !ePart.isEmpty() ? Math.min(Long.parseLong(ePart), totalLen - 1) : totalLen - 1;
                            isRange = start >= 0 && start <= end;
                        } else if (!ePart.isEmpty()) {
                            long suffix = Long.parseLong(ePart);
                            start = Math.max(0, totalLen - suffix);
                            end = totalLen - 1;
                            isRange = start <= end;
                        }
                    } catch (NumberFormatException ignored) {
                    }
                }
            }

            StringBuilder resp = new StringBuilder();
            if (isRange && totalLen > 0) {
                long chunkLen = (end - start) + 1;
                resp.append("HTTP/1.1 206 Partial Content\\r\\n");
                resp.append("Content-Type: ").append(resolvedMime).append("\\r\\n");
                resp.append("Accept-Ranges: bytes\\r\\n");
                resp.append("Content-Range: bytes ").append(start).append("-").append(end).append("/").append(totalLen).append("\\r\\n");
                resp.append("Content-Length: ").append(chunkLen).append("\\r\\n");
                resp.append("Access-Control-Allow-Origin: *\\r\\n");
                resp.append("Connection: close\\r\\n\\r\\n");
                out.write(resp.toString().getBytes(StandardCharsets.ISO_8859_1));
                if (!headOnly) {
                    skipFully(stream, start);
                    copyBounded(stream, out, chunkLen);
                }
            } else {
                resp.append("HTTP/1.1 200 OK\\r\\n");
                resp.append("Content-Type: ").append(resolvedMime).append("\\r\\n");
                if (totalLen > 0) {
                    resp.append("Accept-Ranges: bytes\\r\\n");
                    resp.append("Content-Length: ").append(totalLen).append("\\r\\n");
                }
                resp.append("Access-Control-Allow-Origin: *\\r\\n");
                resp.append("Connection: close\\r\\n\\r\\n");
                out.write(resp.toString().getBytes(StandardCharsets.ISO_8859_1));
                if (!headOnly) {
                    copyBounded(stream, out, totalLen > 0 ? totalLen : Long.MAX_VALUE);
                }
            }
            out.flush();
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                }
            }
            if (afd != null) {
                try {
                    afd.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private void skipFully(InputStream in, long bytesToSkip) throws IOException {
        long remaining = bytesToSkip;
        byte[] skipBuf = new byte[8192];
        while (remaining > 0) {
            long skipped = in.skip(remaining);
            if (skipped > 0) {
                remaining -= skipped;
            } else {
                int r = in.read(skipBuf, 0, (int) Math.min(skipBuf.length, remaining));
                if (r == -1) break;
                remaining -= r;
            }
        }
    }

    private void copyBounded(InputStream in, OutputStream out, long maxBytes) throws IOException {
        byte[] buf = new byte[16384];
        long remaining = maxBytes;
        while (remaining > 0) {
            int toRead = (int) Math.min(buf.length, remaining);
            int n = in.read(buf, 0, toRead);
            if (n == -1) break;
            out.write(buf, 0, n);
            remaining -= n;
        }
    }

    private String readHttpHeader(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int prev1 = 0, prev2 = 0, prev3 = 0;
        int b;
        while ((b = in.read()) != -1) {
            buf.write(b);
            if (prev3 == '\\r' && prev2 == '\\n' && prev1 == '\\r' && b == '\\n') {
                return buf.toString(StandardCharsets.ISO_8859_1.name());
            }
            if (buf.size() > 16384) {
                return null;
            }
            prev3 = prev2;
            prev2 = prev1;
            prev1 = b;
        }
        return null;
    }

    private void serveStaticAsset(OutputStream out, String pathOnly, boolean headOnly) throws IOException {
        String clean = pathOnly;
        if (clean == null || clean.isEmpty() || "/".equals(clean)) {
            clean = "/index.html";
        }
        if (clean.contains("..")) {
            clean = "/index.html";
        }
        String assetPath = "public" + clean;
        AssetManager assets = getContext().getAssets();
        byte[] data = readAssetBytes(assets, assetPath);
        if (data == null) {
            assetPath = "public/index.html";
            data = readAssetBytes(assets, assetPath);
        }
        if (data == null) {
            byte[] notFound = "Not Found".getBytes(StandardCharsets.UTF_8);
            writeHttpResponse(out, 404, "Not Found", "text/plain; charset=utf-8", notFound);
            return;
        }
        String mime = guessMimeType(assetPath);
        if (headOnly) {
            String header = "HTTP/1.1 200 OK\\r\\nContent-Type: " + mime + "\\r\\nContent-Length: " + data.length + "\\r\\nConnection: close\\r\\n\\r\\n";
            out.write(header.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
            return;
        }
        writeHttpResponse(out, 200, "OK", mime, data);
    }

    private byte[] readAssetBytes(AssetManager assets, String path) {
        try (InputStream is = assets.open(path)) {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) {
                baos.write(buf, 0, n);
            }
            return baos.toByteArray();
        } catch (IOException e) {
            return null;
        }
    }

    private String guessMimeType(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (lower.endsWith(".css")) return "text/css; charset=utf-8";
        if (lower.endsWith(".json")) return "application/json; charset=utf-8";
        if (lower.endsWith(".webmanifest")) return "application/manifest+json; charset=utf-8";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        return "application/octet-stream";
    }

    private void writeHttpResponse(OutputStream out, int code, String status, String contentType, byte[] body) throws IOException {
        String header =
            "HTTP/1.1 " + code + " " + status + "\\r\\n" +
            "Content-Type: " + contentType + "\\r\\n" +
            "Content-Length: " + body.length + "\\r\\n" +
            "Cache-Control: no-cache\\r\\n" +
            "Connection: close\\r\\n\\r\\n";
        out.write(header.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private void handleWebSocket(Socket socket, InputStream in, OutputStream out, String wsKey) throws Exception {
        MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
        String magic = wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        byte[] hash = sha1.digest(magic.getBytes(StandardCharsets.UTF_8));
        String accept = Base64.encodeToString(hash, Base64.NO_WRAP);

        String response =
            "HTTP/1.1 101 Switching Protocols\\r\\n" +
            "Upgrade: websocket\\r\\n" +
            "Connection: Upgrade\\r\\n" +
            "Sec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n";
        out.write(response.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();

        PeerClient peer = new PeerClient();
        peer.id = UUID.randomUUID().toString();
        peer.pairCode = generatePairCode();
        peer.name = "Perangkat-" + peer.pairCode.substring(Math.max(0, peer.pairCode.length() - 3));
        peer.socket = socket;
        peer.out = out;

        peers.put(peer.id, peer);
        codeToPeerId.put(peer.pairCode, peer.id);

        JSONObject welcome = new JSONObject();
        welcome.put("type", "welcome");
        welcome.put("self", peer.toPublicJson());
        sendWsJson(peer, welcome);
        broadcastPeers();

        ByteArrayOutputStream fragmentBuf = new ByteArrayOutputStream();
        try {
            while (peer.open && running) {
                int b0 = in.read();
                if (b0 == -1) break;
                int b1 = in.read();
                if (b1 == -1) break;

                boolean fin = (b0 & 0x80) != 0;
                int opcode = b0 & 0x0F;
                boolean masked = (b1 & 0x80) != 0;
                long len = b1 & 0x7F;
                if (len == 126) {
                    byte[] ext = readExact(in, 2);
                    len = ((ext[0] & 0xFF) << 8) | (ext[1] & 0xFF);
                } else if (len == 127) {
                    byte[] ext = readExact(in, 8);
                    len = 0;
                    for (int i = 0; i < 8; i++) {
                        len = (len << 8) | (ext[i] & 0xFFL);
                    }
                }
                if (len > 4 * 1024 * 1024) break;

                byte[] maskKey = masked ? readExact(in, 4) : null;
                byte[] payload = readExact(in, (int) len);
                if (masked && maskKey != null) {
                    for (int i = 0; i < payload.length; i++) {
                        payload[i] = (byte) (payload[i] ^ maskKey[i % 4]);
                    }
                }

                if (opcode == 0x8) {
                    sendWsFrame(peer, 0x8, new byte[0]);
                    break;
                } else if (opcode == 0x9) {
                    sendWsFrame(peer, 0xA, payload);
                    continue;
                } else if (opcode == 0xA) {
                    continue;
                }

                if (opcode == 0x1 || opcode == 0x0) {
                    fragmentBuf.write(payload);
                    if (fin) {
                        String text = fragmentBuf.toString(StandardCharsets.UTF_8.name());
                        fragmentBuf.reset();
                        onWsMessage(peer, text);
                    }
                }
            }
        } catch (IOException ignored) {
        } finally {
            peers.remove(peer.id);
            codeToPeerId.remove(peer.pairCode);
            closePeer(peer);
            broadcastPeers();
        }
    }

    private byte[] readExact(InputStream in, int length) throws IOException {
        byte[] buf = new byte[length];
        int offset = 0;
        while (offset < length) {
            int n = in.read(buf, offset, length - offset);
            if (n == -1) throw new EOFException("EOF");
            offset += n;
        }
        return buf;
    }

    private void sendWsJson(PeerClient peer, JSONObject obj) {
        byte[] payload = obj.toString().getBytes(StandardCharsets.UTF_8);
        sendWsFrame(peer, 0x1, payload);
    }

    private void sendWsFrame(PeerClient peer, int opcode, byte[] payload) {
        if (!peer.open) return;
        synchronized (peer.writeLock) {
            try {
                ByteArrayOutputStream frame = new ByteArrayOutputStream();
                frame.write(0x80 | (opcode & 0x0F));
                int len = payload.length;
                if (len < 126) {
                    frame.write(len);
                } else if (len <= 65535) {
                    frame.write(126);
                    frame.write((len >> 8) & 0xFF);
                    frame.write(len & 0xFF);
                } else {
                    frame.write(127);
                    long l = len;
                    for (int i = 7; i >= 0; i--) {
                        frame.write((int) ((l >> (8 * i)) & 0xFF));
                    }
                }
                frame.write(payload);
                peer.out.write(frame.toByteArray());
                peer.out.flush();
            } catch (IOException e) {
                peer.open = false;
            }
        }
    }

    private synchronized String generatePairCode() {
        for (int i = 0; i < 30; i++) {
            String code = String.valueOf(100000 + random.nextInt(900000));
            if (!codeToPeerId.containsKey(code)) {
                return code;
            }
        }
        String fallback = String.valueOf(System.currentTimeMillis());
        return fallback.substring(Math.max(0, fallback.length() - 6));
    }

    private void broadcastPeers() {
        List<PeerClient> snapshot = new ArrayList<>(peers.values());
        for (PeerClient target : snapshot) {
            JSONArray others = new JSONArray();
            for (PeerClient other : snapshot) {
                if (!other.id.equals(target.id)) {
                    others.put(other.toPublicJson());
                }
            }
            JSONObject msg = new JSONObject();
            try {
                msg.put("type", "peers:update");
                msg.put("peers", others);
                sendWsJson(target, msg);
            } catch (Exception ignored) {
            }
        }
    }

    private void onWsMessage(PeerClient record, String raw) {
        try {
            JSONObject msg = new JSONObject(raw);
            String type = msg.optString("type", "");
            if (type.isEmpty()) return;

            if ("peer:update".equals(type)) {
                String name = msg.optString("name", "").trim();
                if (!name.isEmpty()) {
                    record.name = name.length() > 40 ? name.substring(0, 40) : name;
                }
                String dt = msg.optString("deviceType", "");
                if ("windows".equals(dt) || "mac".equals(dt) || "android".equals(dt) || "ios".equals(dt) || "linux".equals(dt) || "other".equals(dt)) {
                    record.deviceType = dt;
                }
                String st = msg.optString("status", "");
                if ("idle".equals(st) || "transferring".equals(st)) {
                    record.status = st;
                }
                JSONObject updated = new JSONObject();
                updated.put("type", "self:updated");
                updated.put("self", record.toPublicJson());
                sendWsJson(record, updated);
                broadcastPeers();
                return;
            }

            if ("pair:lookup".equals(type)) {
                String code = msg.optString("code", "").trim();
                String targetId = codeToPeerId.get(code);
                PeerClient target = targetId != null ? peers.get(targetId) : null;
                JSONObject res = new JSONObject();
                res.put("type", "pair:result");
                res.put("code", code);
                if (target == null || target.id.equals(record.id)) {
                    res.put("ok", false);
                    res.put("error", "Kode tidak ditemukan atau perangkat sedang offline.");
                } else {
                    res.put("ok", true);
                    res.put("peer", target.toPublicJson());
                }
                sendWsJson(record, res);
                return;
            }

            if ("webrtc:offer".equals(type) || "webrtc:answer".equals(type) || "webrtc:ice".equals(type) || "webrtc:cancel".equals(type)) {
                String targetPeerId = msg.optString("targetPeerId", "");
                PeerClient target = peers.get(targetPeerId);
                if (target == null) {
                    JSONObject err = new JSONObject();
                    err.put("type", "signal:error");
                    err.put("targetPeerId", targetPeerId);
                    err.put("error", "Perangkat tujuan tidak terhubung.");
                    sendWsJson(record, err);
                    return;
                }
                msg.put("fromPeerId", record.id);
                msg.put("fromPeer", record.toPublicJson());
                sendWsJson(target, msg);
            }
        } catch (Exception ignored) {
        }
    }

    private void closePeer(PeerClient peer) {
        peer.open = false;
        try {
            if (peer.socket != null) {
                peer.socket.close();
            }
        } catch (IOException ignored) {
        }
    }
}
`;
fs.writeFileSync(path.join(javaPkgDir, 'EzWifiServerPlugin.java'), ezWifiServerJava, 'utf8');

console.log('Konfigurasi Android Capacitor untuk EzTransfer berhasil disiapkan.');

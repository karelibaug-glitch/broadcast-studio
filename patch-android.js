const fs = require('fs');
const path = require('path');

console.log('--- Starting Android WebRTC & Permissions Patch ---');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 1. res/xml/device_filter.xml
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const resXmlDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'res', 'xml');
if (!fs.existsSync(resXmlDir)) {
    fs.mkdirSync(resXmlDir, { recursive: true });
}

const deviceFilterXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- USB Video Class (UVC) Capture Cards & Webcams (class 14 / 0x0E) -->
    <usb-device class="14" />
    <!-- Misc / composite USB devices (e.g. some HDMI sticks) -->
    <usb-device class="239" subclass="2" />
    <!-- Match any USB device (broadest fallback) -->
    <usb-device />
</resources>
`;
fs.writeFileSync(path.join(resXmlDir, 'device_filter.xml'), deviceFilterXml, 'utf8');
console.log('âœ“ Created res/xml/device_filter.xml');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 2. Patch AndroidManifest.xml
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const manifestPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (fs.existsSync(manifestPath)) {
    let content = fs.readFileSync(manifestPath, 'utf8');

    const permissions = `
    <!-- Camera, Audio, Network & USB-Host permissions -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <!-- USB host â€” required for OTG capture cards -->
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <!-- Camera features â€” optional so app installs on devices without a camera -->
    <uses-feature android:name="android.hardware.camera"         android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-feature android:name="android.hardware.camera.any"     android:required="false" />
`;

    if (!content.includes('android.permission.RECORD_AUDIO')) {
        content = content.replace('<application', `${permissions}\n    <application`);
    }

    if (!content.includes('android:usesCleartextTraffic="true"')) {
        content = content.replace(
            '<application',
            '<application android:hardwareAccelerated="true" android:usesCleartextTraffic="true"'
        );
    }

    const usbIntentFilter = `
            <intent-filter>
                <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
            </intent-filter>
            <meta-data
                android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
                android:resource="@xml/device_filter" />
    `;
    if (!content.includes('android.hardware.usb.action.USB_DEVICE_ATTACHED')) {
        content = content.replace('</activity>', `${usbIntentFilter}\n        </activity>`);
    }

    fs.writeFileSync(manifestPath, content, 'utf8');
    console.log('âœ“ Patched AndroidManifest.xml');
} else {
    console.warn('AndroidManifest.xml not found at:', manifestPath);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 3. Patch android/app/build.gradle â€” add NanoHTTPD dependency
//    NanoHTTPD is on Maven Central â€” no JitPack, no NDK needed.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const appBuildGradlePath = path.join(__dirname, 'android', 'app', 'build.gradle');
if (fs.existsSync(appBuildGradlePath)) {
    let gradle = fs.readFileSync(appBuildGradlePath, 'utf8');
    if (!gradle.includes('nanohttpd')) {
        gradle = gradle.replace(
            /dependencies\s*\{/,
            `dependencies {\n    // NanoHTTPD: tiny embedded HTTP server for local USB MJPEG stream\n    implementation 'org.nanohttpd:nanohttpd:2.3.1'`
        );
        fs.writeFileSync(appBuildGradlePath, gradle, 'utf8');
        console.log('âœ“ Patched android/app/build.gradle with NanoHTTPD dependency');
    }
} else {
    console.warn('android/app/build.gradle not found (will be present during CI build)');
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 4. Java source files
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const javaDir = path.join(
    __dirname, 'android', 'app', 'src', 'main', 'java', 'com', 'broadcast', 'studio'
);
if (!fs.existsSync(javaDir)) {
    fs.mkdirSync(javaDir, { recursive: true });
}

// â”€â”€â”€ 4a. UsbMjpegServer.java â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const mjpegServerCode = `package com.broadcast.studio;

import android.util.Log;
import fi.iki.elonen.NanoHTTPD;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Tiny embedded HTTP server serving a live MJPEG stream to the WebView.
 * Runs on 127.0.0.1:8088 â€” accessible only inside the app, never on the network.
 *
 * The WebView loads: <img src="http://127.0.0.1:8088/stream">
 */
public class UsbMjpegServer extends NanoHTTPD {
    private static final String TAG = "UsbMjpegServer";
    private static final String BOUNDARY = "mjpegboundary";

    private volatile byte[] latestFrame = null;
    private final List<BlockingQueue<byte[]>> activeStreams = new CopyOnWriteArrayList<>();

    public UsbMjpegServer() {
        super("127.0.0.1", 8088);
    }

    /** Called by UsbCameraPlugin for every clean MJPEG frame from the capture card. */
    public void pushFrame(byte[] jpegData) {
        if (jpegData == null || jpegData.length < 512) return;
        latestFrame = jpegData;
        for (BlockingQueue<byte[]> q : activeStreams) {
            while (q.remainingCapacity() == 0) q.poll();
            q.offer(jpegData);
        }
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        if ("/stream".equals(uri)) {
            final BlockingQueue<byte[]> clientQueue = new ArrayBlockingQueue<>(2);
            byte[] init = latestFrame;
            if (init != null) clientQueue.offer(init);
            activeStreams.add(clientQueue);

            Response r = newChunkedResponse(
                Response.Status.OK,
                "multipart/x-mixed-replace; boundary=" + BOUNDARY,
                new MjpegInputStream(clientQueue, BOUNDARY, () -> activeStreams.remove(clientQueue))
            );
            r.addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
            r.addHeader("Pragma", "no-cache");
            r.addHeader("Access-Control-Allow-Origin", "*");
            return r;
        } else if ("/snapshot".equals(uri) || "/frame.jpg".equals(uri)) {
            byte[] frame = latestFrame;
            if (frame != null) {
                Response r = newFixedLengthResponse(Response.Status.OK, "image/jpeg", new ByteArrayInputStream(frame), frame.length);
                r.addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
                r.addHeader("Access-Control-Allow-Origin", "*");
                return r;
            }
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "No frame available yet");
        }
        return newFixedLengthResponse(Response.Status.OK, "text/plain",
            "Broadcast Studio USB Camera Server running");
    }

    private static class MjpegInputStream extends InputStream {
        private final BlockingQueue<byte[]> queue;
        private final String boundary;
        private final Runnable onClose;
        private final AtomicBoolean isOpen = new AtomicBoolean(true);
        private byte[] chunk;
        private int pos;

        MjpegInputStream(BlockingQueue<byte[]> q, String b, Runnable onClose) {
            this.queue = q;
            this.boundary = b;
            this.onClose = onClose;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (chunk == null || pos >= chunk.length) loadNextChunk();
            if (chunk == null) return -1;
            int n = Math.min(len, chunk.length - pos);
            System.arraycopy(chunk, pos, buf, off, n);
            pos += n;
            return n;
        }

        @Override
        public int read() throws IOException {
            if (chunk == null || pos >= chunk.length) loadNextChunk();
            return (chunk == null) ? -1 : (chunk[pos++] & 0xFF);
        }

        @Override
        public void close() throws IOException {
            isOpen.set(false);
            if (onClose != null) onClose.run();
            super.close();
        }

        private void loadNextChunk() throws IOException {
            try {
                byte[] frame = null;
                while (isOpen.get() && frame == null) {
                    frame = queue.poll(500, TimeUnit.MILLISECONDS);
                }
                if (frame == null) { chunk = null; return; }
                String header = "--" + boundary + "\r\nContent-Type: image/jpeg\r\n"
                    + "Content-Length: " + frame.length + "\r\n\r\n";
                byte[] hb = header.getBytes(StandardCharsets.US_ASCII);
                byte[] tail = "\r\n".getBytes(StandardCharsets.US_ASCII);
                chunk = new byte[hb.length + frame.length + tail.length];
                System.arraycopy(hb,    0, chunk, 0,                        hb.length);
                System.arraycopy(frame, 0, chunk, hb.length,                frame.length);
                System.arraycopy(tail,  0, chunk, hb.length + frame.length, tail.length);
                pos = 0;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException("Interrupted");
            }
        }
    }
}
`;
fs.writeFileSync(path.join(javaDir, 'UsbMjpegServer.java'), mjpegServerCode, 'utf8');
console.log('âœ“ Wrote UsbMjpegServer.java');

// â”€â”€â”€ 4b. UsbCameraPlugin.java â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const usbCameraPluginCode = `package com.broadcast.studio;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.hardware.usb.UsbRequest;
import android.os.Build;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * UsbCameraPlugin â€” Capacitor native plugin implementing CameraFi-style USB capture card streaming.
 *
 * Uses Android USB Host API (android.hardware.usb) â€” works on ALL phones
 * regardless of whether the manufacturer enabled Camera2 External HAL.
 *
 * Flow:
 *   USB card plugged in
 *   â†’ Android permission dialog shown automatically
 *   â†’ User taps OK
 *   â†’ Plugin opens USB device, negotiates MJPEG 1920x1080 @ 60fps (falls back to 30fps)
 *   â†’ Reads video frames via bulk or isochronous USB transfer
 *   â†’ Feeds frames to UsbMjpegServer (NanoHTTPD on 127.0.0.1:8088)
 *   â†’ Fires "usbCameraReady" event to JavaScript with the stream URL
 *   â†’ JavaScript shows <img src="http://127.0.0.1:8088/stream"> in the preview
 *
 * JS events:
 *   "usbCameraAttached"  { deviceName }
 *   "usbCameraReady"     { url, width, height }
 *   "usbCameraDetached"  {}
 *   "usbCameraError"     { message }
 */
@CapacitorPlugin(name = "UsbCamera")
public class UsbCameraPlugin extends Plugin {
    private static final String TAG = "UsbCameraPlugin";
    private static final String ACTION_USB_PERMISSION = "com.broadcast.studio.USB_PERMISSION";

    // Request 1920x1080 @ 60fps; card auto-negotiates to its maximum capability
    private static final int TARGET_W   = 1920;
    private static final int TARGET_H   = 1080;
    private static final int INTERVAL_60 = 166667; // 60fps in 100ns units
    private static final int INTERVAL_30 = 333333; // 30fps fallback

    private UsbManager usbManager;
    private UsbDevice currentDevice;
    private UsbDeviceConnection connection;
    private UsbInterface videoInterface;
    private Thread readerThread;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private UsbMjpegServer mjpegServer;
    private BroadcastReceiver usbReceiver;

    // â”€â”€ Plugin Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        mjpegServer = new UsbMjpegServer();
        registerUsbReceiver();
        // Check if a UVC device is already plugged in when the app launches
        getActivity().runOnUiThread(this::scanForExistingDevices);
    }

    // â”€â”€ USB BroadcastReceiver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private void registerUsbReceiver() {
        usbReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                switch (action) {
                    case UsbManager.ACTION_USB_DEVICE_ATTACHED:
                        if (device != null && isUvcDevice(device)) handleDeviceAttached(device);
                        break;
                    case UsbManager.ACTION_USB_DEVICE_DETACHED:
                        if (device != null && device.equals(currentDevice)) handleDeviceDetached();
                        break;
                    case ACTION_USB_PERMISSION:
                        if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                                && device != null) {
                            openAndStream(device);
                        } else {
                            JSObject e = new JSObject();
                            e.put("message", "USB permission denied by user.");
                            notifyListeners("usbCameraError", e);
                        }
                        break;
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        filter.addAction(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(usbReceiver, filter);
        }
    }

    private void scanForExistingDevices() {
        if (usbManager == null) return;
        HashMap<String, UsbDevice> list = usbManager.getDeviceList();
        for (UsbDevice dev : list.values()) {
            if (isUvcDevice(dev)) { handleDeviceAttached(dev); break; }
        }
    }

    // â”€â”€ Device Identification â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private boolean isUvcDevice(UsbDevice device) {
        if (device.getDeviceClass() == 14) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            if (device.getInterface(i).getInterfaceClass() == 14) return true;
        }
        return false;
    }

    // â”€â”€ Device Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private void handleDeviceAttached(UsbDevice device) {
        currentDevice = device;
        String name = device.getProductName();
        if (name == null || name.isEmpty()) name = "USB Capture Card";
        JSObject data = new JSObject();
        data.put("deviceName", name);
        notifyListeners("usbCameraAttached", data);
        Log.d(TAG, "UVC device attached: " + name);

        if (usbManager.hasPermission(device)) {
            openAndStream(device);
        } else {
            int flags = Build.VERSI    // ── Bulk Frame Reader ──────────────────────────────────────────────────

    private void startBulkReader(final UsbEndpoint endpoint) {
        running.set(true);
        startMjpegServer();
        readerThread = new Thread(() -> {
            byte[] buf = new byte[65536];
            ByteArrayOutputStream frame = new ByteArrayOutputStream(256 * 1024);
            boolean inFrame = false;
            int lastFid = -1;

            while (running.get()) {
                int n = connection.bulkTransfer(endpoint, buf, buf.length, 1000);
                if (n <= 0) continue;

                int headerLen = buf[0] & 0xFF;
                int payloadStart = 0;
                boolean isEof = false;
                boolean isErr = false;

                // UVC payload header: byte 0 = bHeaderLength, byte 1 = bmHeaderInfo
                if (headerLen >= 2 && headerLen <= n) {
                    int headerInfo = buf[1] & 0xFF;
                    isErr = (headerInfo & 0x40) != 0;
                    isEof = (headerInfo & 0x02) != 0;
                    int fid = headerInfo & 0x01;
                    payloadStart = headerLen;

                    // If Frame ID toggled, any previous open frame has finished
                    if (lastFid != -1 && fid != lastFid && inFrame) {
                        pushCleanJpeg(frame.toByteArray());
                        frame.reset();
                        inFrame = false;
                    }
                    lastFid = fid;
                }

                if (isErr) {
                    frame.reset();
                    inFrame = false;
                    continue;
                }

                int payloadLen = n - payloadStart;
                if (payloadLen <= 0) {
                    if (isEof && inFrame) {
                        pushCleanJpeg(frame.toByteArray());
                        frame.reset();
                        inFrame = false;
                    }
                    continue;
                }

                int p = payloadStart;
                if (!inFrame) {
                    // Synchronize on Start-Of-Image marker (0xFF 0xD8)
                    while (p < n - 1) {
                        if ((buf[p] & 0xFF) == 0xFF && (buf[p + 1] & 0xFF) == 0xD8) {
                            inFrame = true;
                            frame.reset();
                            break;
                        }
                        p++;
                    }
                }

                if (inFrame) {
                    frame.write(buf, p, n - p);

                    boolean hasEoi = (n >= payloadStart + 2
                        && (buf[n - 2] & 0xFF) == 0xFF
                        && (buf[n - 1] & 0xFF) == 0xD9);

                    if (isEof || hasEoi) {
                        pushCleanJpeg(frame.toByteArray());
                        frame.reset();
                        inFrame = false;
                    }
                }
            }
        }, "usb-bulk-reader");
        readerThread.setDaemon(true);
        readerThread.start();
        Log.d(TAG, "Bulk reader started with clean UVC header stripping");
    }

    // ── Isochronous Frame Reader ───────────────────────────────────────────

    private void startIsoReader(final UsbEndpoint endpoint) {
        running.set(true);
        startMjpegServer();
        readerThread = new Thread(() -> {
            int pktSize = endpoint.getMaxPacketSize();
            int numReq = 8;
            UsbRequest[] requests = new UsbRequest[numReq];
            ByteBuffer[] buffers  = new ByteBuffer[numReq];
            for (int i = 0; i < numReq; i++) {
                buffers[i]  = ByteBuffer.allocate(pktSize * 8);
                requests[i] = new UsbRequest();
                requests[i].initialize(connection, endpoint);
                requests[i].queue(buffers[i]);
            }
            ByteArrayOutputStream frame = new ByteArrayOutputStream(256 * 1024);
            boolean inFrame = false;
            int lastFid = -1;

            while (running.get()) {
                try {
                    UsbRequest done = connection.requestWait(500);
                    if (done == null) continue;
                    ByteBuffer buf = null;
                    for (int i = 0; i < numReq; i++) {
                        if (requests[i] == done) { buf = buffers[i]; break; }
                    }
                    if (buf == null) continue;
                    buf.rewind();
                    int limit = buf.limit();
                    if (limit < 2) { done.queue(buf); continue; }

                    int headerLen = buf.get() & 0xFF;
                    int headerInfo = buf.get() & 0xFF;
                    boolean isErr = (headerInfo & 0x40) != 0;
                    boolean isEof = (headerInfo & 0x02) != 0;
                    int fid = headerInfo & 0x01;

                    if (headerLen > limit || isErr) {
                        if (isErr) { frame.reset(); inFrame = false; }
                        done.queue(buf);
                        continue;
                    }

                    if (lastFid != -1 && fid != lastFid && inFrame) {
                        pushCleanJpeg(frame.toByteArray());
                        frame.reset();
                        inFrame = false;
                    }
                    lastFid = fid;

                    // Skip remaining UVC header bytes
                    for (int i = 2; i < headerLen && i < limit; i++) buf.get();
                    int payloadLen = limit - headerLen;
                    if (payloadLen <= 0) {
                        if (isEof && inFrame) {
                            pushCleanJpeg(frame.toByteArray());
                            frame.reset();
                            inFrame = false;
                        }
                        done.queue(buf);
                        continue;
                    }

                    byte[] payload = new byte[payloadLen];
                    buf.get(payload, 0, payloadLen);

                    int p = 0;
                    if (!inFrame) {
                        while (p < payloadLen - 1) {
                            if ((payload[p] & 0xFF) == 0xFF && (payload[p + 1] & 0xFF) == 0xD8) {
                                inFrame = true;
                                frame.reset();
                                break;
                            }
                            p++;
                        }
                    }

                    if (inFrame) {
                        frame.write(payload, p, payloadLen - p);
                        boolean hasEoi = (payloadLen >= 2
                            && (payload[payloadLen - 2] & 0xFF) == 0xFF
                            && (payload[payloadLen - 1] & 0xFF) == 0xD9);

                        if (isEof || hasEoi) {
                            pushCleanJpeg(frame.toByteArray());
                            frame.reset();
                            inFrame = false;
                        }
                    }

                    buf.clear();
                    done.queue(buf);
                } catch (Exception e) {
                    if (running.get()) Log.e(TAG, "Iso error", e);
                }
            }
            for (UsbRequest r : requests) {
                try { r.cancel(); r.close(); } catch (Exception ignored) {}
            }
        }, "usb-iso-reader");
        readerThread.setDaemon(true);
        readerThread.start();
        Log.d(TAG, "Isochronous reader started with clean UVC header stripping");
    }

    private void pushCleanJpeg(byte[] data) {
        if (data == null || data.length < 1024) return;
        // Verify Start-Of-Image marker
        if ((data[0] & 0xFF) != 0xFF || (data[1] & 0xFF) != 0xD8) return;

        // Ensure End-Of-Image marker (0xFF 0xD9) is present at end
        boolean endsWithEoi = (data.length >= 2
            && (data[data.length - 2] & 0xFF) == 0xFF
            && (data[data.length - 1] & 0xFF) == 0xD9);

        if (!endsWithEoi) {
            byte[] patched = new byte[data.length + 2];
            System.arraycopy(data, 0, patched, 0, data.length);
            patched[data.length] = (byte) 0xFF;
            patched[data.length + 1] = (byte) 0xD9;
            mjpegServer.pushFrame(patched);
        } else {
            mjpegServer.pushFrame(data);
        }
    }��€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private void startBulkReader(final UsbEndpoint endpoint) {
        running.set(true);
        startMjpegServer();
        readerThread = new Thread(() -> {
            byte[] buf = new byte[65536];
            ByteArrayOutputStream frame = new ByteArrayOutputStream(1 << 19);
            boolean inFrame = false;
            while (running.get()) {
                int n = connection.bulkTransfer(endpoint, buf, buf.length, 1000);
                if (n <= 0) continue;
                for (int i = 0; i < n; i++) {
                    int b = buf[i] & 0xFF;
                    if (!inFrame && b == 0xFF && i+1 < n && (buf[i+1]&0xFF) == 0xD8) {
                        frame.reset(); inFrame = true;
                    }
                    if (inFrame) {
                        frame.write(b);
                        if (b == 0xFF && i+1 < n && (buf[i+1]&0xFF) == 0xD9) {
                            frame.write(buf[++i] & 0xFF);
                            mjpegServer.pushFrame(frame.toByteArray());
                            frame.reset(); inFrame = false;
                        }
                    }
                }
            }
        }, "usb-bulk-reader");
        readerThread.setDaemon(true);
        readerThread.start();
        Log.d(TAG, "Bulk reader started");
    }

    // â”€â”€ Isochronous Frame Reader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private void startIsoReader(final UsbEndpoint endpoint) {
        running.set(true);
        startMjpegServer();
        readerThread = new Thread(() -> {
            int pktSize = endpoint.getMaxPacketSize();
            int numReq = 8;
            UsbRequest[] requests = new UsbRequest[numReq];
            ByteBuffer[] buffers  = new ByteBuffer[numReq];
            for (int i = 0; i < numReq; i++) {
                buffers[i]  = ByteBuffer.allocate(pktSize * 8);
                requests[i] = new UsbRequest();
                requests[i].initialize(connection, endpoint);
                requests[i].queue(buffers[i]);
            }
            ByteArrayOutputStream frame = new ByteArrayOutputStream(1 << 19);
            boolean inFrame = false;
            while (running.get()) {
                try {
                    UsbRequest done = connection.requestWait(500);
                    if (done == null) continue;
                    ByteBuffer buf = null;
                    for (int i = 0; i < numReq; i++) {
                        if (requests[i] == done) { buf = buffers[i]; break; }
                    }
                    if (buf == null) continue;
                    buf.rewind();
                    int limit = buf.limit();
                    if (limit < 2) { done.queue(buf); continue; }
                    int headerLen = buf.get() & 0xFF;
                    buf.get(); // flags byte
                    if (headerLen > limit) { done.queue(buf); continue; }
                    for (int i = 2; i < headerLen && i < limit; i++) buf.get();
                    int payloadLen = limit - headerLen;
                    if (payloadLen <= 0) { done.queue(buf); continue; }
                    byte[] payload = new byte[payloadLen];
                    buf.get(payload, 0, payloadLen);
                    for (int i = 0; i < payload.length; i++) {
                        int b = payload[i] & 0xFF;
                        if (!inFrame && b == 0xFF && i+1 < payload.length && (payload[i+1]&0xFF)==0xD8) {
                            frame.reset(); inFrame = true;
                        }
                        if (inFrame) {
                            frame.write(b);
                            if (b == 0xFF && i+1 < payload.length && (payload[i+1]&0xFF)==0xD9) {
                                frame.write(payload[++i] & 0xFF);
                                mjpegServer.pushFrame(frame.toByteArray());
                                frame.reset(); inFrame = false;
                            }
                        }
                    }
                    buf.clear();
                    done.queue(buf);
                } catch (Exception e) {
                    if (running.get()) Log.e(TAG, "Iso error", e);
                }
            }
            for (UsbRequest r : requests) {
                try { r.cancel(); r.close(); } catch (Exception ignored) {}
            }
        }, "usb-iso-reader");
        readerThread.setDaemon(true);
        readerThread.start();
        Log.d(TAG, "Isochronous reader started");
    }

    // â”€â”€ MJPEG Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private void startMjpegServer() {
        try {
            if (!mjpegServer.isAlive()) mjpegServer.start();
            Log.d(TAG, "MJPEG server: http://127.0.0.1:8088/stream");
            JSObject result = new JSObject();
            result.put("url",    "http://127.0.0.1:8088/stream");
            result.put("width",  TARGET_W);
            result.put("height", TARGET_H);
            notifyListeners("usbCameraReady", result);
        } catch (java.io.IOException e) {
            Log.e(TAG, "Failed to start MJPEG server", e);
        }
    }

    // â”€â”€ Capacitor JS-callable Methods â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    @PluginMethod
    public void isConnected(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("connected", running.get());
        call.resolve(ret);
    }

    @PluginMethod
    public void stopStream(PluginCall call) {
        stopStreaming();
        call.resolve();
    }

    // â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    private void stopStreaming() {
        running.set(false);
        if (readerThread != null) { readerThread.interrupt(); readerThread = null; }
        if (videoInterface != null && connection != null) {
            try { connection.releaseInterface(videoInterface); } catch (Exception ignored) {}
            videoInterface = null;
        }
        if (connection != null) { connection.close(); connection = null; }
        if (mjpegServer != null && mjpegServer.isAlive()) mjpegServer.stop();
    }

    @Override
    protected void handleOnDestroy() {
        stopStreaming();
        if (usbReceiver != null) {
            try { getContext().unregisterReceiver(usbReceiver); } catch (Exception ignored) {}
            usbReceiver = null;
        }
        super.handleOnDestroy();
    }
}
`;
fs.writeFileSync(path.join(javaDir, 'UsbCameraPlugin.java'), usbCameraPluginCode, 'utf8');
console.log('âœ“ Wrote UsbCameraPlugin.java');

// â”€â”€â”€ 4c. MainActivity.java â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const mainActivityCode = `package com.broadcast.studio;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "MainActivity";
    private static final int PERM_REQ = 101;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register native Capacitor plugins BEFORE super.onCreate()
        registerPlugin(UsbCameraPlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            }
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                }
            });
        }

        new Handler(Looper.getMainLooper())
                .postDelayed(this::checkAndRequestPermissions, 600);
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERM_REQ) {
            boolean allGranted = true;
            for (int r : grantResults) {
                if (r != PackageManager.PERMISSION_GRANTED) { allGranted = false; break; }
            }
            Log.d(TAG, "Runtime permissions granted: " + allGranted);
        }
    }

    public void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        List<String> needed = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(
                this, needed.toArray(new String[0]), PERM_REQ);
        }
    }
}
`;
fs.writeFileSync(path.join(javaDir, 'MainActivity.java'), mainActivityCode, 'utf8');
console.log('âœ“ Wrote MainActivity.java (UsbCameraPlugin registered)');

console.log('--- Android Patch Complete ---');

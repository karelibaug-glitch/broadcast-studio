/**
 * patch-android.js
 *
 * Configures the Capacitor Android project for Broadcast Studio:
 *  1. Writes res/xml/device_filter.xml (matches UVC video capture cards).
 *  2. Patches AndroidManifest.xml (adds permissions, hardware acceleration, cleartext traffic).
 *  3. Patches android/app/build.gradle (adds NanoHTTPD for local MJPEG stream).
 *  4. Writes UsbMjpegServer.java, UsbCameraPlugin.java, MainActivity.java.
 *
 * NOTE: All strings in this file are pure 7-bit ASCII to prevent javac encoding errors.
 */

const fs   = require('fs');
const path = require('path');

console.log('--- Starting Broadcast Studio Android Patch ---');

// ---------------------------------------------------------------------------
// 1. device_filter.xml
// ---------------------------------------------------------------------------
const xmlDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'res', 'xml');
if (!fs.existsSync(xmlDir)) {
    fs.mkdirSync(xmlDir, { recursive: true });
}
const deviceFilterXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- Match any USB Video Class (UVC) device (class 14 = 0x0E) -->
    <usb-device class="14" />
    <usb-device class="239" subclass="2" />
</resources>
`;
fs.writeFileSync(path.join(xmlDir, 'device_filter.xml'), deviceFilterXml, 'utf8');
console.log('[OK] Wrote device_filter.xml');

// ---------------------------------------------------------------------------
// 2. Patch AndroidManifest.xml
// ---------------------------------------------------------------------------
const manifestPath = path.join(
    __dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'
);

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
    <!-- USB host - required for OTG capture cards -->
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <!-- Camera features - optional so app installs on devices without a camera -->
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
    console.log('[OK] Patched AndroidManifest.xml');
} else {
    console.warn('AndroidManifest.xml not found at:', manifestPath);
}

// ---------------------------------------------------------------------------
// 3. Patch android/app/build.gradle - add NanoHTTPD dependency
// ---------------------------------------------------------------------------
const appBuildGradlePath = path.join(__dirname, 'android', 'app', 'build.gradle');
if (fs.existsSync(appBuildGradlePath)) {
    let gradle = fs.readFileSync(appBuildGradlePath, 'utf8');
    if (!gradle.includes('nanohttpd')) {
        gradle = gradle.replace(
            /dependencies\s*\{/,
            `dependencies {\n    // NanoHTTPD: tiny embedded HTTP server for local USB MJPEG stream\n    implementation 'org.nanohttpd:nanohttpd:2.3.1'`
        );
        fs.writeFileSync(appBuildGradlePath, gradle, 'utf8');
        console.log('[OK] Patched android/app/build.gradle with NanoHTTPD dependency');
    }
} else {
    console.warn('android/app/build.gradle not found (will be present during CI build)');
}

// ---------------------------------------------------------------------------
// 4. Java source files
// ---------------------------------------------------------------------------
const javaDir = path.join(
    __dirname, 'android', 'app', 'src', 'main', 'java', 'com', 'broadcast', 'studio'
);
if (!fs.existsSync(javaDir)) {
    fs.mkdirSync(javaDir, { recursive: true });
}

// --- 4a. UsbMjpegServer.java -----------------------------------------------
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
 * Runs on 127.0.0.1:8088 - accessible only inside the app, never on the network.
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
console.log('[OK] Wrote UsbMjpegServer.java');

// --- 4b. UsbCameraPlugin.java ----------------------------------------------
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
 * UsbCameraPlugin - Capacitor native plugin implementing USB capture card streaming.
 *
 * Uses Android USB Host API (android.hardware.usb).
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

    // -- Plugin Lifecycle -------------------------------------------------------

    @Override
    public void load() {
        usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        mjpegServer = new UsbMjpegServer();
        registerUsbReceiver();
        // Check if a UVC device is already plugged in when the app launches
        getActivity().runOnUiThread(this::scanForExistingDevices);
    }

    // -- USB BroadcastReceiver --------------------------------------------------

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

    // -- Device Identification --------------------------------------------------

    private boolean isUvcDevice(UsbDevice device) {
        if (device.getDeviceClass() == 14) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            if (device.getInterface(i).getInterfaceClass() == 14) return true;
        }
        return false;
    }

    // -- Device Lifecycle -------------------------------------------------------

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
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? PendingIntent.FLAG_MUTABLE : 0;
            PendingIntent pi = PendingIntent.getBroadcast(
                getContext(), 0, new Intent(ACTION_USB_PERMISSION), flags);
            usbManager.requestPermission(device, pi);
        }
    }

    private void handleDeviceDetached() {
        stopStreaming();
        currentDevice = null;
        notifyListeners("usbCameraDetached", new JSObject());
    }

    // -- USB Streaming Setup ----------------------------------------------------

    private void openAndStream(UsbDevice device) {
        // Find UVC VideoStreaming interface (class=14, subclass=2)
        UsbInterface bulkIface = null;
        UsbEndpoint bulkEp = null;
        UsbInterface isoIface = null;
        UsbEndpoint isoEp = null;

        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface iface = device.getInterface(i);
            if (iface.getInterfaceClass() != 14 || iface.getInterfaceSubclass() != 2) continue;
            for (int j = 0; j < iface.getEndpointCount(); j++) {
                UsbEndpoint ep = iface.getEndpoint(j);
                if (ep.getDirection() != UsbConstants.USB_DIR_IN) continue;
                if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && bulkEp == null) {
                    bulkIface = iface; bulkEp = ep;
                }
                if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_ISOC
                        && ep.getMaxPacketSize() > 0 && isoEp == null) {
                    isoIface = iface; isoEp = ep;
                }
            }
        }

        connection = usbManager.openDevice(device);
        if (connection == null) { Log.e(TAG, "Cannot open USB device"); return; }

        if (bulkEp != null) {
            if (!connection.claimInterface(bulkIface, true)) {
                Log.e(TAG, "Cannot claim bulk interface"); connection.close(); return;
            }
            videoInterface = bulkIface;
            negotiateFormat(connection, bulkIface.getId());
            startBulkReader(bulkEp);
        } else if (isoEp != null) {
            if (!connection.claimInterface(isoIface, true)) {
                Log.e(TAG, "Cannot claim iso interface"); connection.close(); return;
            }
            videoInterface = isoIface;
            negotiateFormat(connection, isoIface.getId());
            startIsoReader(isoEp);
        } else {
            Log.e(TAG, "No video endpoint found on capture card");
            JSObject err = new JSObject();
            err.put("message", "Capture card has no compatible video endpoint.");
            notifyListeners("usbCameraError", err);
            connection.close();
        }
    }

    /**
     * UVC Probe/Commit handshake - tells the card we want MJPEG 1920x1080 @ 60fps.
     * The card writes back what it can actually deliver (may be 30fps on USB 2.0 OTG).
     */
    private void negotiateFormat(UsbDeviceConnection conn, int ifaceId) {
        byte[] probe = new byte[26];
        probe[0] = 0x01; probe[1] = 0x00;  // bmHint: fix frame interval
        probe[2] = 0x01;                     // bFormatIndex = 1 (MJPEG)
        probe[3] = 0x01;                     // bFrameIndex  = 1 (1920x1080)
        probe[4] = (byte)(INTERVAL_60 & 0xFF);
        probe[5] = (byte)((INTERVAL_60 >> 8)  & 0xFF);
        probe[6] = (byte)((INTERVAL_60 >> 16) & 0xFF);
        probe[7] = (byte)((INTERVAL_60 >> 24) & 0xFF);

        conn.controlTransfer(0x21, 0x01, 0x0100, ifaceId, probe, probe.length, 1000); // SET Probe
        conn.controlTransfer(0xA1, 0x81, 0x0100, ifaceId, probe, probe.length, 1000); // GET Probe
        conn.controlTransfer(0x21, 0x01, 0x0200, ifaceId, probe, probe.length, 1000); // SET Commit

        int interval = ((probe[7]&0xFF)<<24)|((probe[6]&0xFF)<<16)|((probe[5]&0xFF)<<8)|(probe[4]&0xFF);
        if (interval > 0) {
            int fps = (int) Math.round(10000000.0 / interval);
            Log.d(TAG, "Negotiated MJPEG " + TARGET_W + "x" + TARGET_H + " @ " + fps + "fps");
        }
    }

    // -- Bulk Frame Reader ----------------------------------------------------

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

    // -- Isochronous Frame Reader ---------------------------------------------

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
    }

    // -- MJPEG Server -----------------------------------------------------------

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

    // -- Capacitor JS-callable Methods ------------------------------------------

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

    // -- Cleanup ----------------------------------------------------------------

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
console.log('[OK] Wrote UsbCameraPlugin.java');

// --- 4c. MainActivity.java -------------------------------------------------
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
console.log('[OK] Wrote MainActivity.java (UsbCameraPlugin registered)');

console.log('--- Android Patch Complete ---');

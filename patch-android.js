/**
 * patch-android.js
 *
 * Configures the Capacitor Android project for Broadcast Studio:
 *  1. Writes res/xml/device_filter.xml (matches UVC video capture cards).
 *  2. Patches AndroidManifest.xml (adds permissions, hardware acceleration, cleartext traffic, launchMode).
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

    // Ensure singleTask launch mode so incoming USB attach intents don't recreate the activity
    if (content.includes('<activity') && !content.includes('android:launchMode=')) {
        content = content.replace('<activity', '<activity android:launchMode="singleTask"');
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
// 3. Patch android/app/build.gradle - add UVCAndroid & NanoHTTPD dependencies
// ---------------------------------------------------------------------------
const appBuildGradlePath = path.join(__dirname, 'android', 'app', 'build.gradle');
if (fs.existsSync(appBuildGradlePath)) {
    let gradle = fs.readFileSync(appBuildGradlePath, 'utf8');
    if (!gradle.includes('com.herohan:UVCAndroid')) {
        gradle = gradle.replace(
            /dependencies\s*\{/,
            `dependencies {\n    // Native UVC Video Engine (libuvc + libusb NDK)\n    implementation 'com.herohan:UVCAndroid:1.0.13'\n    // NanoHTTPD: tiny embedded HTTP server for local stream fallback\n    implementation 'org.nanohttpd:nanohttpd:2.3.1'`
        );
        fs.writeFileSync(appBuildGradlePath, gradle, 'utf8');
        console.log('[OK] Patched android/app/build.gradle with UVCAndroid and NanoHTTPD dependencies');
    }
} else {
    console.warn('android/app/build.gradle not found (will be present during CI build)');
}

// ---------------------------------------------------------------------------
// 3b. Patch proguard-rules.pro for UVCAndroid native callbacks
// ---------------------------------------------------------------------------
const proguardPath = path.join(__dirname, 'android', 'app', 'proguard-rules.pro');
if (fs.existsSync(proguardPath)) {
    let proguard = fs.readFileSync(proguardPath, 'utf8');
    const uvcRules = `
# UVCAndroid & UVCCamera native JNI keeps
-keep class com.herohan.uvcapp.** { *; }
-keep class com.serenegiant.usb.** { *; }
-keepclassmembers class * implements com.serenegiant.usb.IButtonCallback { *; }
-keepclassmembers class * implements com.serenegiant.usb.IFrameCallback { *; }
-keepclassmembers class * implements com.serenegiant.usb.IStatusCallback { *; }
`;
    if (!proguard.includes('com.herohan.uvcapp')) {
        proguard += uvcRules;
        fs.writeFileSync(proguardPath, proguard, 'utf8');
        console.log('[OK] Patched proguard-rules.pro for UVCAndroid');
    }
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

    /** Called by UsbCameraPlugin for every clean, verified MJPEG frame from the capture card. */
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
            final BlockingQueue<byte[]> clientQueue = new ArrayBlockingQueue<>(4);
            byte[] init = latestFrame;
            if (init != null) clientQueue.offer(init);
            activeStreams.add(clientQueue);

            Response r = newChunkedResponse(
                Response.Status.OK,
                "multipart/x-mixed-replace; boundary=" + BOUNDARY,
                new MjpegInputStream(clientQueue, BOUNDARY, () -> activeStreams.remove(clientQueue))
            );
            r.addHeader("Connection", "close");
            r.addHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
            r.addHeader("Pragma", "no-cache");
            r.addHeader("Access-Control-Allow-Origin", "*");
            return r;
        } else if ("/snapshot".equals(uri) || "/frame.jpg".equals(uri)) {
            byte[] frame = latestFrame;
            if (frame != null) {
                Response r = newFixedLengthResponse(Response.Status.OK, "image/jpeg", new ByteArrayInputStream(frame), frame.length);
                r.addHeader("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
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
                String header = "\\r\\n--" + boundary + "\\r\\nContent-Type: image/jpeg\\r\\n"
                    + "Content-Length: " + frame.length + "\\r\\n\\r\\n";
                byte[] hb = header.getBytes(StandardCharsets.US_ASCII);
                byte[] tail = "\\r\\n".getBytes(StandardCharsets.US_ASCII);
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
import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.YuvImage;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.util.Log;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.herohan.uvcapp.CameraHelper;
import com.herohan.uvcapp.ICameraHelper;
import com.serenegiant.usb.IFrameCallback;
import com.serenegiant.usb.Size;
import com.serenegiant.usb.UVCCamera;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * UsbCameraPlugin - Capacitor native plugin implementing rock-solid USB capture card streaming.
 *
 * Dual-Engine Architecture:
 * 1. Native UVC Engine (UVCAndroid / libuvc + libusb NDK) for hardware-accelerated 30/60fps video.
 * 2. Hardened Bulk Reader Fallback (Android USB Host API with FID tracking) for maximum compatibility.
 */
@CapacitorPlugin(name = "UsbCamera")
public class UsbCameraPlugin extends Plugin {
    private static final String TAG = "UsbCameraPlugin";
    private static final String ACTION_USB_PERMISSION = "com.broadcast.studio.USB_PERMISSION";

    private static final int TARGET_W   = 1920;
    private static final int TARGET_H   = 1080;
    private static final int INTERVAL_60 = 166666; // 60fps (100ns units: 10,000,000 / 60)
    private static final int INTERVAL_30 = 333333; // 30fps fallback (100ns units: 10,000,000 / 30)
    private static final int MAX_FRAME_SIZE = 3 * 1024 * 1024; // 3MB max per JPEG frame

    private UsbManager usbManager;
    private UsbDevice currentDevice;
    private UsbDeviceConnection connection;
    private UsbInterface videoInterface;
    private Thread readerThread;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private UsbMjpegServer mjpegServer;
    private BroadcastReceiver usbReceiver;
    private final ExecutorService workerExecutor = Executors.newSingleThreadExecutor();

    // Native UVC Engine
    private CameraHelper mCameraHelper;
    private int currentWidth = TARGET_W;
    private int currentHeight = TARGET_H;
    private int currentFps = 60;

    // -- Plugin Lifecycle -------------------------------------------------------

    @Override
    public void load() {
        try {
            usbManager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
            registerUsbReceiver();
            workerExecutor.execute(this::scanForExistingDevices);
        } catch (Throwable t) {
            Log.e(TAG, "Error in UsbCameraPlugin load", t);
        }
    }

    // -- USB BroadcastReceiver --------------------------------------------------

    private void registerUsbReceiver() {
        usbReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                try {
                    String action = intent.getAction();
                    if (action == null) return;
                    Log.d(TAG, "USB Broadcast received: " + action);

                    UsbDevice device = null;
                    if (Build.VERSION.SDK_INT >= 33) {
                        try {
                            device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class);
                        } catch (Throwable ignored) {
                            device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                        }
                    } else {
                        device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    }

                    if (device == null) {
                        device = currentDevice;
                    }

                    switch (action) {
                        case UsbManager.ACTION_USB_DEVICE_ATTACHED:
                            if (device != null && isUvcDevice(device)) {
                                handleDeviceAttached(device);
                            } else {
                                scanForExistingDevices();
                            }
                            break;
                        case UsbManager.ACTION_USB_DEVICE_DETACHED:
                            if (device != null && (currentDevice == null || device.getDeviceId() == currentDevice.getDeviceId())) {
                                handleDeviceDetached();
                            }
                            break;
                        case ACTION_USB_PERMISSION:
                            boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                            if (granted) {
                                if (device != null) {
                                    final UsbDevice devToOpen = device;
                                    workerExecutor.execute(() -> startCapture(devToOpen));
                                } else {
                                    scanForExistingDevices();
                                }
                            } else {
                                Log.w(TAG, "USB Permission denied by user");
                                JSObject e = new JSObject();
                                e.put("message", "USB permission denied by user.");
                                notifyListeners("usbCameraError", e);
                            }
                            break;
                    }
                } catch (Throwable t) {
                    Log.e(TAG, "Exception in USB onReceive", t);
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        filter.addAction(ACTION_USB_PERMISSION);

        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(usbReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            getContext().registerReceiver(usbReceiver, filter);
        }
    }

    private void scanForExistingDevices() {
        try {
            if (usbManager == null) return;
            HashMap<String, UsbDevice> list = usbManager.getDeviceList();
            if (list == null) return;
            for (UsbDevice dev : list.values()) {
                if (isUvcDevice(dev)) {
                    handleDeviceAttached(dev);
                    break;
                }
            }
        } catch (Throwable t) {
            Log.e(TAG, "Error scanning devices", t);
        }
    }

    // -- Device Identification --------------------------------------------------

    private boolean isUvcDevice(UsbDevice device) {
        if (device == null) return false;
        if (device.getDeviceClass() == 14) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface iface = device.getInterface(i);
            if (iface != null && (iface.getInterfaceClass() == 14 || (iface.getInterfaceClass() == 239 && iface.getInterfaceSubclass() == 2))) {
                return true;
            }
        }
        return false;
    }

    // -- Device Lifecycle -------------------------------------------------------

    private void handleDeviceAttached(UsbDevice device) {
        try {
            currentDevice = device;
            String name = null;
            try {
                name = device.getProductName();
            } catch (Throwable ignored) {}
            if (name == null || name.isEmpty()) name = "USB Capture Card";

            JSObject data = new JSObject();
            data.put("deviceName", name);
            notifyListeners("usbCameraAttached", data);
            Log.d(TAG, "UVC device attached: " + name);

            startCapture(device);
        } catch (Throwable t) {
            Log.e(TAG, "Error handling device attach", t);
        }
    }

    private void startCapture(final UsbDevice device) {
        if (device == null) return;

        // Attempt 1: Native UVC Engine (UVCAndroid / libuvc NDK)
        try {
            if (initNativeCameraHelper(device)) {
                Log.d(TAG, "Native UVC engine successfully assigned to device: " + device.getDeviceName());
                return;
            }
        } catch (Throwable t) {
            Log.w(TAG, "Native UVC engine init error, falling back to Java USB Host: " + t.getMessage());
        }

        // Attempt 2: Java USB Host API with standard Android permission
        if (usbManager != null) {
            if (usbManager.hasPermission(device)) {
                final UsbDevice dev = device;
                workerExecutor.execute(() -> openAndStream(dev));
            } else {
                Intent permIntent = new Intent(ACTION_USB_PERMISSION);
                permIntent.setPackage(getContext().getPackageName());

                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    flags |= PendingIntent.FLAG_MUTABLE;
                }

                PendingIntent pi = PendingIntent.getBroadcast(getContext(), 0, permIntent, flags);
                usbManager.requestPermission(device, pi);
            }
        }
    }

    private void handleDeviceDetached() {
        workerExecutor.execute(() -> {
            stopStreaming();
            currentDevice = null;
            notifyListeners("usbCameraDetached", new JSObject());
        });
    }

    // -- Engine 1: Native UVC Camera (UVCAndroid) -------------------------------

    private synchronized boolean initNativeCameraHelper(final UsbDevice device) {
        try {
            if (mCameraHelper != null) {
                try {
                    mCameraHelper.stopPreview();
                    mCameraHelper.closeCamera();
                    mCameraHelper.release();
                } catch (Throwable ignored) {}
                mCameraHelper = null;
            }

            mCameraHelper = new CameraHelper();
            mCameraHelper.setStateCallback(new ICameraHelper.StateCallback() {
                @Override
                public void onAttach(UsbDevice dev) {
                    Log.d(TAG, "Native UVC onAttach: " + (dev != null ? dev.getDeviceName() : "null"));
                    if (mCameraHelper != null && dev != null) {
                        mCameraHelper.selectDevice(dev);
                    }
                }

                @Override
                public void onDeviceOpen(UsbDevice dev, boolean isFirstOpen) {
                    Log.d(TAG, "Native UVC onDeviceOpen, isFirstOpen=" + isFirstOpen);
                    if (mCameraHelper != null) {
                        mCameraHelper.openCamera();
                    }
                }

                @Override
                public void onCameraOpen(UsbDevice dev) {
                    Log.d(TAG, "Native UVC onCameraOpen: configuring preview stream");
                    running.set(true);

                    Size targetSize = null;
                    int targetFps = 60;
                    try {
                        List<Size> sizes = mCameraHelper.getSupportedSizeList();
                        if (sizes != null && !sizes.isEmpty()) {
                            // First priority: 1920x1080 with highest frame rate (up to 60fps)
                            for (Size s : sizes) {
                                if (s.width == 1920 && s.height == 1080) {
                                    int bestIdx = 0;
                                    float maxFps = 0;
                                    if (s.fps != null && s.fps.length > 0) {
                                        for (int i = 0; i < s.fps.length; i++) {
                                            if (s.fps[i] > maxFps) {
                                                maxFps = s.fps[i];
                                                bestIdx = i;
                                            }
                                        }
                                    } else if (s.intervals != null && s.intervals.length > 0) {
                                        int minInt = Integer.MAX_VALUE;
                                        for (int i = 0; i < s.intervals.length; i++) {
                                            if (s.intervals[i] > 0 && s.intervals[i] < minInt) {
                                                minInt = s.intervals[i];
                                                bestIdx = i;
                                                maxFps = 10000000.0f / minInt;
                                            }
                                        }
                                    }
                                    s.frameIntervalIndex = bestIdx;
                                    if (targetSize == null || maxFps > targetFps) {
                                        targetSize = s;
                                        targetFps = Math.round(maxFps > 0 ? maxFps : 60);
                                    }
                                    if (maxFps >= 59.0f) break; // Optimal 1080p60 found
                                }
                            }

                            // Second priority: 1280x720 (if capture card only supports 60fps in 720p or no 1080p)
                            if (targetSize == null) {
                                for (Size s : sizes) {
                                    if (s.width == 1280 && s.height == 720) {
                                        int bestIdx = 0;
                                        float maxFps = 0;
                                        if (s.fps != null && s.fps.length > 0) {
                                            for (int i = 0; i < s.fps.length; i++) {
                                                if (s.fps[i] > maxFps) {
                                                    maxFps = s.fps[i];
                                                    bestIdx = i;
                                                }
                                            }
                                        } else if (s.intervals != null && s.intervals.length > 0) {
                                            int minInt = Integer.MAX_VALUE;
                                            for (int i = 0; i < s.intervals.length; i++) {
                                                if (s.intervals[i] > 0 && s.intervals[i] < minInt) {
                                                    minInt = s.intervals[i];
                                                    bestIdx = i;
                                                    maxFps = 10000000.0f / minInt;
                                                }
                                            }
                                        }
                                        s.frameIntervalIndex = bestIdx;
                                        if (targetSize == null || maxFps > targetFps) {
                                            targetSize = s;
                                            targetFps = Math.round(maxFps > 0 ? maxFps : 60);
                                        }
                                    }
                                }
                            }

                            if (targetSize == null) {
                                targetSize = sizes.get(0);
                            }
                        }
                    } catch (Throwable t) {
                        Log.w(TAG, "Could not query supported sizes: " + t.getMessage());
                    }

                    if (targetSize != null) {
                        try {
                            mCameraHelper.setPreviewSize(targetSize);
                            currentWidth = targetSize.width;
                            currentHeight = targetSize.height;
                            currentFps = targetFps > 0 ? targetFps : 60;
                            Log.d(TAG, "Configured native UVC preview: " + currentWidth + "x" + currentHeight + " @" + currentFps + "fps");
                        } catch (Throwable ignored) {}
                    } else {
                        currentWidth = TARGET_W;
                        currentHeight = TARGET_H;
                        currentFps = 60;
                    }

                    try {
                        mCameraHelper.setFrameCallback(new IFrameCallback() {
                            @Override
                            public void onFrame(ByteBuffer frame) {
                                handleNativeFrame(frame);
                            }
                        }, UVCCamera.PIXEL_FORMAT_NV21);
                    } catch (Throwable t) {
                        Log.e(TAG, "Failed to register frame callback: " + t.getMessage());
                    }

                    try {
                        mCameraHelper.startPreview();
                    } catch (Throwable t) {
                        Log.e(TAG, "Failed to start native preview: " + t.getMessage());
                    }

                    startMjpegServer();
                }

                @Override
                public void onCameraClose(UsbDevice dev) {
                    Log.d(TAG, "Native UVC onCameraClose");
                }

                @Override
                public void onDeviceClose(UsbDevice dev) {
                    Log.d(TAG, "Native UVC onDeviceClose");
                }

                @Override
                public void onDetach(UsbDevice dev) {
                    Log.d(TAG, "Native UVC onDetach");
                    handleDeviceDetached();
                }

                @Override
                public void onCancel(UsbDevice dev) {
                    Log.w(TAG, "Native UVC onCancel (permission cancelled or denied)");
                    JSObject err = new JSObject();
                    err.put("message", "USB capture permission was cancelled or denied.");
                    notifyListeners("usbCameraError", err);
                }
            });

            mCameraHelper.selectDevice(device);
            return true;
        } catch (Throwable t) {
            Log.w(TAG, "Native CameraHelper init error: " + t.getMessage() + ", falling back to Java USB Host");
            if (mCameraHelper != null) {
                try { mCameraHelper.release(); } catch (Throwable ignored) {}
                mCameraHelper = null;
            }
            return false;
        }
    }

    private void handleNativeFrame(ByteBuffer frame) {
        if (frame == null || !running.get() || mjpegServer == null) return;
        try {
            int len = frame.remaining();
            if (len <= 0) return;

            // Direct pass-through if frame begins with JPEG SOI (0xFF 0xD8)
            if (len > 4 && (frame.get(0) & 0xFF) == 0xFF && (frame.get(1) & 0xFF) == 0xD8) {
                byte[] jpeg = new byte[len];
                frame.get(jpeg);
                mjpegServer.pushFrame(jpeg);
                return;
            }

            // NV21 to JPEG encoding
            int w = currentWidth > 0 ? currentWidth : 1280;
            int h = currentHeight > 0 ? currentHeight : 720;
            int expected = (w * h * 3) / 2;
            if (len >= expected) {
                byte[] nv21 = new byte[len];
                frame.get(nv21);
                YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
                ByteArrayOutputStream out = new ByteArrayOutputStream(expected / 4);
                yuv.compressToJpeg(new Rect(0, 0, w, h), 85, out);
                mjpegServer.pushFrame(out.toByteArray());
            }
        } catch (Throwable t) {
            Log.w(TAG, "Error processing native frame: " + t.getMessage());
        }
    }

    // -- Engine 2: Java USB Host API Fallback -----------------------------------

    private synchronized void openAndStream(UsbDevice device) {
        try {
            if (device == null || usbManager == null) return;
            stopStreaming(); // Clean up previous connection if any

            currentDevice = device;
            UsbInterface bulkIface = null;
            UsbEndpoint bulkEp = null;

            // Search for bulk streaming endpoint (class 14, subclass 2 or any video interface)
            for (int i = 0; i < device.getInterfaceCount(); i++) {
                UsbInterface iface = device.getInterface(i);
                if (iface == null) continue;
                for (int j = 0; j < iface.getEndpointCount(); j++) {
                    UsbEndpoint ep = iface.getEndpoint(j);
                    if (ep != null && ep.getDirection() == UsbConstants.USB_DIR_IN
                            && ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                        bulkIface = iface;
                        bulkEp = ep;
                        break;
                    }
                }
                if (bulkEp != null) break;
            }

            // Fallback: If no interface matched class 14, check any interface with IN bulk endpoint
            if (bulkEp == null) {
                for (int i = 0; i < device.getInterfaceCount(); i++) {
                    UsbInterface iface = device.getInterface(i);
                    if (iface == null) continue;
                    for (int j = 0; j < iface.getEndpointCount(); j++) {
                        UsbEndpoint ep = iface.getEndpoint(j);
                        if (ep != null && ep.getDirection() == UsbConstants.USB_DIR_IN) {
                            bulkIface = iface;
                            bulkEp = ep;
                            break;
                        }
                    }
                    if (bulkEp != null) break;
                }
            }

            connection = usbManager.openDevice(device);
            if (connection == null) {
                Log.e(TAG, "Cannot open USB device connection");
                JSObject err = new JSObject();
                err.put("message", "Unable to open USB connection. Permission may have been revoked.");
                notifyListeners("usbCameraError", err);
                return;
            }

            if (bulkIface != null && bulkEp != null) {
                if (!connection.claimInterface(bulkIface, true)) {
                    Log.e(TAG, "Cannot claim interface " + bulkIface.getId());
                    connection.close();
                    connection = null;
                    return;
                }
                videoInterface = bulkIface;
                try {
                    connection.setInterface(bulkIface);
                } catch (Throwable ignored) {}

                // Parse descriptors for VS_FORMAT_MJPEG and target frame size
                int mjpegFormatIndex = 1;
                int mjpegFrameIndex = 1;
                try {
                    byte[] rawDesc = connection.getRawDescriptors();
                    if (rawDesc != null) {
                        int pos = 0;
                        int curFmt = 0;
                        while (pos < rawDesc.length - 2) {
                            int len = rawDesc[pos] & 0xFF;
                            if (len <= 0 || pos + len > rawDesc.length) break;
                            int descType = rawDesc[pos + 1] & 0xFF;
                            if (descType == 0x24) { // CS_INTERFACE
                                int subType = rawDesc[pos + 2] & 0xFF;
                                if (subType == 0x06 && len >= 4) { // VS_FORMAT_MJPEG
                                    curFmt = rawDesc[pos + 3] & 0xFF;
                                    mjpegFormatIndex = curFmt;
                                    Log.d(TAG, "Found VS_FORMAT_MJPEG at index: " + mjpegFormatIndex);
                                } else if (subType == 0x07 && curFmt == mjpegFormatIndex && len >= 9) { // VS_FRAME_MJPEG
                                    int fIdx = rawDesc[pos + 3] & 0xFF;
                                    int w = ((rawDesc[pos + 6] & 0xFF) << 8) | (rawDesc[pos + 5] & 0xFF);
                                    int h = ((rawDesc[pos + 8] & 0xFF) << 8) | (rawDesc[pos + 7] & 0xFF);
                                    Log.d(TAG, "MJPEG Frame " + fIdx + ": " + w + "x" + h);
                                    if (w == 1920 && h == 1080) {
                                        mjpegFrameIndex = fIdx;
                                        currentWidth = 1920;
                                        currentHeight = 1080;
                                    } else if (w == 1280 && h == 720 && mjpegFrameIndex == 1) {
                                        mjpegFrameIndex = fIdx;
                                        currentWidth = 1280;
                                        currentHeight = 720;
                                    }
                                }
                            }
                            pos += len;
                        }
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "Descriptor parsing skipped: " + t.getMessage());
                }

                negotiateFormat(connection, bulkIface.getId(), mjpegFormatIndex, mjpegFrameIndex);
                startBulkReader(bulkEp);
            } else {
                Log.e(TAG, "No video endpoint found on capture card");
                JSObject err = new JSObject();
                err.put("message", "Capture card has no compatible video bulk endpoint.");
                notifyListeners("usbCameraError", err);
                if (connection != null) { connection.close(); connection = null; }
            }
        } catch (Throwable t) {
            Log.e(TAG, "Error in openAndStream", t);
            JSObject err = new JSObject();
            err.put("message", "USB capture initialization failed: " + t.getMessage());
            notifyListeners("usbCameraError", err);
            stopStreaming();
        }
    }

    /**
     * UVC Probe/Commit handshake - probes for 60fps first, falls back to 30fps if card demands.
     */
    private void negotiateFormat(UsbDeviceConnection conn, int ifaceId, int formatIdx, int frameIdx) {
        try {
            byte[] probe = new byte[26];
            probe[0] = 0x01; probe[1] = 0x00;  // bmHint: fix frame interval
            probe[2] = (byte)(formatIdx & 0xFF); // bFormatIndex
            probe[3] = (byte)(frameIdx & 0xFF);  // bFrameIndex
            // Request 60fps (166666 units: 10,000,000 / 60)
            probe[4] = (byte)(INTERVAL_60 & 0xFF);
            probe[5] = (byte)((INTERVAL_60 >> 8)  & 0xFF);
            probe[6] = (byte)((INTERVAL_60 >> 16) & 0xFF);
            probe[7] = (byte)((INTERVAL_60 >> 24) & 0xFF);

            conn.controlTransfer(0x21, 0x01, 0x0100, ifaceId, probe, probe.length, 1000); // SET Probe
            int ret = conn.controlTransfer(0xA1, 0x81, 0x0100, ifaceId, probe, probe.length, 1000); // GET Probe
            if (ret >= 8) {
                int negotiated = (probe[4] & 0xFF) | ((probe[5] & 0xFF) << 8) | ((probe[6] & 0xFF) << 16) | ((probe[7] & 0xFF) << 24);
                if (negotiated > 0) {
                    currentFps = Math.round(10000000.0f / negotiated);
                    Log.d(TAG, "UVC negotiated frame interval: " + negotiated + " (" + currentFps + "fps)");
                }
            }
            conn.controlTransfer(0x21, 0x01, 0x0200, ifaceId, probe, probe.length, 1000); // SET Commit
            Log.d(TAG, "UVC probe/commit completed: format=" + formatIdx + " frame=" + frameIdx + " fps=" + currentFps);
        } catch (Throwable t) {
            Log.w(TAG, "Format negotiation: " + t.getMessage());
        }
    }

    // -- Frame-Accurate Bulk Stream Reader -------------------------------------

    private void startBulkReader(final UsbEndpoint endpoint) {
        running.set(true);
        startMjpegServer();

        readerThread = new Thread(() -> {
            byte[] buf = new byte[65536];
            ByteArrayOutputStream frameBuffer = new ByteArrayOutputStream(256 * 1024);
            boolean inFrame = false;
            int lastFid = -1;

            while (running.get() && connection != null) {
                try {
                    int n = connection.bulkTransfer(endpoint, buf, buf.length, 1000);
                    if (n <= 0) continue;

                    int p = 0;
                    boolean isEof = false;

                    // UVC Payload Header detection:
                    // Header length is typically 12 bytes (or 2-32 bytes).
                    // buf[0] is bHeaderLength. buf[1] is bmHeaderInfo.
                    // Bit 7 of buf[1] is reserved and MUST be 0 in standard UVC.
                    int hLen = buf[0] & 0xFF;
                    if (hLen >= 2 && hLen <= 32 && hLen <= n && (buf[1] & 0x80) == 0) {
                        int fid = buf[1] & 0x01;
                        isEof = (buf[1] & 0x02) != 0;
                        boolean isErr = (buf[1] & 0x40) != 0;

                        if (isErr) {
                            // Frame error reported by UVC hardware - discard broken segment
                            frameBuffer.reset();
                            inFrame = false;
                            continue;
                        }

                        // If FID toggled, a new video frame has started
                        if (lastFid != -1 && fid != lastFid) {
                            if (inFrame && frameBuffer.size() > 4096) {
                                byte[] raw = frameBuffer.toByteArray();
                                int len = raw.length;
                                // Verify EOI or append if clean JPEG
                                if ((raw[len - 2] & 0xFF) == 0xFF && (raw[len - 1] & 0xFF) == 0xD9) {
                                    mjpegServer.pushFrame(raw);
                                } else {
                                    byte[] patched = new byte[len + 2];
                                    System.arraycopy(raw, 0, patched, 0, len);
                                    patched[len] = (byte) 0xFF;
                                    patched[len + 1] = (byte) 0xD9;
                                    mjpegServer.pushFrame(patched);
                                }
                            }
                            frameBuffer.reset();
                            inFrame = false;
                        }
                        lastFid = fid;
                        p = hLen;
                    }

                    if (!inFrame) {
                        // Scan for JPEG Start-Of-Image marker (0xFF 0xD8)
                        while (p < n - 1) {
                            if ((buf[p] & 0xFF) == 0xFF && (buf[p + 1] & 0xFF) == 0xD8) {
                                inFrame = true;
                                frameBuffer.reset();
                                break;
                            }
                            p++;
                        }
                    }

                    if (inFrame && p < n) {
                        frameBuffer.write(buf, p, n - p);

                        if (frameBuffer.size() > MAX_FRAME_SIZE) {
                            frameBuffer.reset();
                            inFrame = false;
                            continue;
                        }

                        // Check for End-Of-Image marker (0xFF 0xD9) or EOF flag
                        byte[] raw = frameBuffer.toByteArray();
                        int len = raw.length;

                        int eoiIndex = -1;
                        int searchBack = Math.max(0, len - 256);
                        for (int i = len - 2; i >= searchBack; i--) {
                            if ((raw[i] & 0xFF) == 0xFF && (raw[i + 1] & 0xFF) == 0xD9) {
                                eoiIndex = i + 2;
                                break;
                            }
                        }

                        if (eoiIndex != -1) {
                            byte[] clean;
                            if (eoiIndex == len) {
                                clean = raw;
                            } else {
                                clean = new byte[eoiIndex];
                                System.arraycopy(raw, 0, clean, 0, eoiIndex);
                            }
                            if (clean.length > 2048) {
                                mjpegServer.pushFrame(clean);
                            }
                            frameBuffer.reset();
                            inFrame = false;
                        } else if (isEof && len > 4096) {
                            byte[] patched = new byte[len + 2];
                            System.arraycopy(raw, 0, patched, 0, len);
                            patched[len] = (byte) 0xFF;
                            patched[len + 1] = (byte) 0xD9;
                            mjpegServer.pushFrame(patched);
                            frameBuffer.reset();
                            inFrame = false;
                        }
                    }
                } catch (Throwable t) {
                    if (running.get()) Log.w(TAG, "Bulk transfer error: " + t.getMessage());
                }
            }
        }, "usb-bulk-reader");

        readerThread.setDaemon(true);
        readerThread.start();
        Log.d(TAG, "Frame-accurate bulk reader started");
    }

    // -- MJPEG Server Lifecycle -------------------------------------------------

    private synchronized void startMjpegServer() {
        try {
            if (mjpegServer == null || !mjpegServer.isAlive()) {
                if (mjpegServer != null) {
                    try { mjpegServer.stop(); } catch (Throwable ignored) {}
                }
                mjpegServer = new UsbMjpegServer();
                mjpegServer.start();
            }
            Log.d(TAG, "MJPEG server: http://127.0.0.1:8088/stream (" + currentWidth + "x" + currentHeight + "@" + currentFps + "fps)");
            JSObject result = new JSObject();
            result.put("url",    "http://127.0.0.1:8088/stream");
            result.put("width",  currentWidth);
            result.put("height", currentHeight);
            result.put("fps",    currentFps);
            notifyListeners("usbCameraReady", result);
        } catch (Throwable e) {
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
        workerExecutor.execute(() -> {
            stopStreaming();
            call.resolve();
        });
    }

    // -- Cleanup ----------------------------------------------------------------

    private synchronized void stopStreaming() {
        running.set(false);
        if (mCameraHelper != null) {
            try {
                mCameraHelper.stopPreview();
                mCameraHelper.closeCamera();
                mCameraHelper.release();
            } catch (Throwable ignored) {}
            mCameraHelper = null;
        }
        if (readerThread != null) {
            try { readerThread.interrupt(); } catch (Throwable ignored) {}
            readerThread = null;
        }
        if (videoInterface != null && connection != null) {
            try { connection.releaseInterface(videoInterface); } catch (Throwable ignored) {}
            videoInterface = null;
        }
        if (connection != null) {
            try { connection.close(); } catch (Throwable ignored) {}
            connection = null;
        }
        if (mjpegServer != null && mjpegServer.isAlive()) {
            try { mjpegServer.stop(); } catch (Throwable ignored) {}
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopStreaming();
        if (usbReceiver != null) {
            try { getContext().unregisterReceiver(usbReceiver); } catch (Throwable ignored) {}
            usbReceiver = null;
        }
        try { workerExecutor.shutdownNow(); } catch (Throwable ignored) {}
        super.handleOnDestroy();
    }
}
`;
fs.writeFileSync(path.join(javaDir, 'UsbCameraPlugin.java'), usbCameraPluginCode, 'utf8');
console.log('[OK] Wrote UsbCameraPlugin.java');

// --- 4c. MainActivity.java -------------------------------------------------
const mainActivityCode = `package com.broadcast.studio;

import android.Manifest;
import android.content.Intent;
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

        try {
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
        } catch (Throwable t) {
            Log.e(TAG, "Error configuring WebView", t);
        }

        new Handler(Looper.getMainLooper())
                .postDelayed(this::checkAndRequestPermissions, 600);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Log.d(TAG, "MainActivity onNewIntent: " + (intent != null ? intent.getAction() : "null"));
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

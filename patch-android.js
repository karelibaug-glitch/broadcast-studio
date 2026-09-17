const fs = require('fs');
const path = require('path');

console.log('--- Starting Native Android USB UVC & WebRTC Bridge Patch ---');

// 1. Create res/xml/device_filter.xml for USB Capture Cards
const resXmlDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'res', 'xml');
if (!fs.existsSync(resXmlDir)) {
    fs.mkdirSync(resXmlDir, { recursive: true });
}

const deviceFilterXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <!-- USB Video Class (UVC) Capture Cards & Webcams (Class 14 / 0x0E) -->
    <usb-device class="14" />
    <usb-device class="239" subclass="2" />
</resources>
`;
fs.writeFileSync(path.join(resXmlDir, 'device_filter.xml'), deviceFilterXml, 'utf8');
console.log('✓ Created res/xml/device_filter.xml');

// 2. Patch AndroidManifest.xml
const manifestPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (fs.existsSync(manifestPath)) {
    let content = fs.readFileSync(manifestPath, 'utf8');

    const permissions = `
    <!-- Permissions for Hardware, Camera, Audio, Network & USB Host -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
`;

    if (!content.includes('android.permission.RECORD_AUDIO')) {
        content = content.replace('<application', `${permissions}\n    <application`);
    }

    // Add hardware acceleration & cleartext traffic for local 127.0.0.1 streaming
    content = content.replace('<application', '<application android:hardwareAccelerated="true" android:usesCleartextTraffic="true"');

    // Add USB device attached intent filter to MainActivity
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
    console.log('✓ Successfully patched AndroidManifest.xml with USB Host Intent Filters');
} else {
    console.warn('AndroidManifest.xml not found at:', manifestPath);
}

// 3. Create UsbCameraBridge.java
const javaDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'java', 'com', 'broadcast', 'studio');
if (!fs.existsSync(javaDir)) {
    fs.mkdirSync(javaDir, { recursive: true });
}

const usbBridgeCode = `package com.broadcast.studio;

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
import android.os.Build;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.HashMap;
import java.util.concurrent.atomic.AtomicBoolean;

public class UsbCameraBridge {
    private static final String TAG = "UsbCameraBridge";
    private static final String ACTION_USB_PERMISSION = "com.broadcast.studio.USB_PERMISSION";
    private static final int HTTP_PORT = 8088;

    private final Context context;
    private final WebView webView;
    private final UsbManager usbManager;
    private UsbDevice connectedDevice = null;
    private UsbDeviceConnection connection = null;
    private UsbInterface streamingInterface = null;
    private UsbEndpoint streamingEndpoint = null;

    private final AtomicBoolean isStreaming = new AtomicBoolean(false);
    private ServerSocket serverSocket = null;
    private byte[] latestFrame = null;
    private final Object frameLock = new Object();

    private final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (ACTION_USB_PERMISSION.equals(action)) {
                synchronized (this) {
                    UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                        if (device != null) {
                            Log.d(TAG, "USB Permission GRANTED for device: " + device.getDeviceName());
                            startCapture(device);
                            notifyWebView("onUsbPermissionGranted", device.getDeviceName());
                        }
                    } else {
                        Log.w(TAG, "USB Permission DENIED for device");
                        notifyWebView("onUsbPermissionDenied", "");
                    }
                }
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                Log.d(TAG, "USB Device Attached event received");
                checkAndDetectDevice();
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                Log.d(TAG, "USB Device Detached event received");
                stopCapture();
                notifyWebView("onUsbDeviceDetached", "");
            }
        }
    };

    public UsbCameraBridge(Context context, WebView webView) {
        this.context = context;
        this.webView = webView;
        this.usbManager = (UsbManager) context.getSystemService(Context.USB_SERVICE);

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_USB_PERMISSION);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(usbReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            context.registerReceiver(usbReceiver, filter);
        }

        startHttpServer();
        checkAndDetectDevice();
    }

    public void checkAndDetectDevice() {
        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        for (UsbDevice device : deviceList.values()) {
            if (isUvcDevice(device)) {
                connectedDevice = device;
                Log.d(TAG, "UVC Capture Card Detected: " + device.getDeviceName() + " (Vendor: " + device.getVendorId() + ")");
                notifyWebView("onUsbDeviceDetected", device.getDeviceName());
                if (!hasUsbPermission()) {
                    requestUsbCameraPermission();
                } else {
                    startCapture(device);
                }
                return;
            }
        }
    }

    private boolean isUvcDevice(UsbDevice device) {
        if (device.getDeviceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface iface = device.getInterface(i);
            if (iface.getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO || iface.getInterfaceClass() == 239) {
                return true;
            }
        }
        return false;
    }

    @JavascriptInterface
    public boolean isUsbCameraConnected() {
        return connectedDevice != null;
    }

    @JavascriptInterface
    public boolean hasUsbPermission() {
        return connectedDevice != null && usbManager.hasPermission(connectedDevice);
    }

    @JavascriptInterface
    public void requestUsbCameraPermission() {
        if (connectedDevice == null) {
            checkAndDetectDevice();
        }
        if (connectedDevice != null && !usbManager.hasPermission(connectedDevice)) {
            int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
            PendingIntent pi = PendingIntent.getBroadcast(context, 0, new Intent(ACTION_USB_PERMISSION), flags);
            usbManager.requestPermission(connectedDevice, pi);
        }
    }

    @JavascriptInterface
    public String getStreamUrl() {
        return "http://127.0.0.1:" + HTTP_PORT + "/stream";
    }

    @JavascriptInterface
    public String getDeviceName() {
        return connectedDevice != null ? connectedDevice.getDeviceName() : "No USB Card";
    }

    private void startCapture(UsbDevice device) {
        if (isStreaming.get()) return;
        try {
            connection = usbManager.openDevice(device);
            if (connection == null) {
                Log.e(TAG, "Failed to open USB Device Connection");
                return;
            }

            // Find Video Streaming Interface and Endpoint
            for (int i = 0; i < device.getInterfaceCount(); i++) {
                UsbInterface iface = device.getInterface(i);
                if (iface.getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO && iface.getInterfaceSubclass() == 2) {
                    streamingInterface = iface;
                    connection.claimInterface(streamingInterface, true);
                    for (int j = 0; j < iface.getEndpointCount(); j++) {
                        UsbEndpoint ep = iface.getEndpoint(j);
                        if (ep.getDirection() == UsbConstants.USB_DIR_IN) {
                            streamingEndpoint = ep;
                            break;
                        }
                    }
                    break;
                }
            }

            isStreaming.set(true);
            new Thread(this::readUsbStreamLoop, "UsbUvcReaderThread").start();
            notifyWebView("onUsbStreamReady", getStreamUrl());
            Log.d(TAG, "USB UVC Streaming Loop Started Successfully");
        } catch (Exception e) {
            Log.e(TAG, "Error starting USB capture: " + e.getMessage(), e);
        }
    }

    private void readUsbStreamLoop() {
        byte[] buffer = new byte[65536];
        ByteArrayOutputStream mjpegFrameBuffer = new ByteArrayOutputStream();
        boolean inFrame = false;

        while (isStreaming.get() && connection != null && streamingEndpoint != null) {
            int bytesRead = connection.bulkTransfer(streamingEndpoint, buffer, buffer.length, 1000);
            if (bytesRead > 0) {
                for (int i = 0; i < bytesRead - 1; i++) {
                    // Detect JPEG SOI (Start of Image) marker: 0xFF, 0xD8
                    if ((buffer[i] & 0xFF) == 0xFF && (buffer[i + 1] & 0xFF) == 0xD8) {
                        inFrame = true;
                        mjpegFrameBuffer.reset();
                    }
                    if (inFrame) {
                        mjpegFrameBuffer.write(buffer[i]);
                    }
                    // Detect JPEG EOI (End of Image) marker: 0xFF, 0xD9
                    if (inFrame && (buffer[i] & 0xFF) == 0xFF && (buffer[i + 1] & 0xFF) == 0xD9) {
                        mjpegFrameBuffer.write(buffer[i + 1]);
                        byte[] frame = mjpegFrameBuffer.toByteArray();
                        synchronized (frameLock) {
                            latestFrame = frame;
                            frameLock.notifyAll();
                        }
                        inFrame = false;
                        i++;
                    }
                }
            }
        }
    }

    private void startHttpServer() {
        new Thread(() -> {
            try {
                serverSocket = new ServerSocket(HTTP_PORT);
                Log.d(TAG, "Internal UVC MJPEG Server running on port " + HTTP_PORT);
                while (!serverSocket.isClosed()) {
                    Socket client = serverSocket.accept();
                    new Thread(() -> handleHttpClient(client)).start();
                }
            } catch (Exception e) {
                Log.w(TAG, "HTTP Server stopped: " + e.getMessage());
            }
        }, "UvcHttpServerThread").start();
    }

    private void handleHttpClient(Socket socket) {
        try {
            InputStream in = socket.getInputStream();
            OutputStream out = socket.getOutputStream();

            byte[] reqBuf = new byte[1024];
            in.read(reqBuf);

            String header = "HTTP/1.1 200 OK\\r\\n" +
                    "Access-Control-Allow-Origin: *\\r\\n" +
                    "Content-Type: multipart/x-mixed-replace; boundary=--frame\\r\\n\\r\\n";
            out.write(header.getBytes());
            out.flush();

            while (isStreaming.get() && !socket.isClosed()) {
                byte[] frame;
                synchronized (frameLock) {
                    while (latestFrame == null && isStreaming.get()) {
                        frameLock.wait(100);
                    }
                    frame = latestFrame;
                }

                if (frame != null && frame.length > 0) {
                    String partHeader = "--frame\\r\\n" +
                            "Content-Type: image/jpeg\\r\\n" +
                            "Content-Length: " + frame.length + "\\r\\n\\r\\n";
                    out.write(partHeader.getBytes());
                    out.write(frame);
                    out.write("\\r\\n".getBytes());
                    out.flush();
                }
                Thread.sleep(33); // ~30 fps
            }
        } catch (Exception e) {
            // Client disconnected
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    public void stopCapture() {
        isStreaming.set(false);
        if (connection != null && streamingInterface != null) {
            try { connection.releaseInterface(streamingInterface); } catch (Exception ignored) {}
            try { connection.close(); } catch (Exception ignored) {}
        }
        connection = null;
        streamingInterface = null;
        streamingEndpoint = null;
        connectedDevice = null;
    }

    private void notifyWebView(String callback, String arg) {
        if (webView != null) {
            webView.post(() -> {
                String js = "if (window." + callback + ") { window." + callback + "('" + arg + "'); }";
                webView.evaluateJavascript(js, null);
            });
        }
    }
}
`;
fs.writeFileSync(path.join(javaDir, 'UsbCameraBridge.java'), usbBridgeCode, 'utf8');
console.log('✓ Successfully created UsbCameraBridge.java');

// 4. Patch MainActivity.java
const mainActivityPath = path.join(javaDir, 'MainActivity.java');

const mainActivityCode = `package com.broadcast.studio;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
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
    private static final int PERMISSION_REQ_CODE = 101;
    private UsbCameraBridge usbCameraBridge;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 1. Explicitly prompt user for OS Runtime Permissions on App Launch
        checkAndRequestPermissions();

        // 2. Configure WebView for WebRTC media streams and audio capture
        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setDatabaseEnabled(true);

        // 3. Attach Native USB UVC Camera Bridge to WebView
        usbCameraBridge = new UsbCameraBridge(this, webView);
        webView.addJavascriptInterface(usbCameraBridge, "AndroidUsbBridge");

        // 4. Auto-grant WebRTC Camera & Microphone requests inside WebView
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    request.grant(request.getResources());
                });
            }
        });
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (usbCameraBridge != null) {
            usbCameraBridge.stopCapture();
        }
    }

    private void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            String[] requiredPermissions = new String[]{
                Manifest.permission.CAMERA,
                Manifest.permission.RECORD_AUDIO,
                Manifest.permission.MODIFY_AUDIO_SETTINGS
            };

            List<String> listPermissionsNeeded = new ArrayList<>();
            for (String p : requiredPermissions) {
                if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                    listPermissionsNeeded.add(p);
                }
            }

            if (!listPermissionsNeeded.isEmpty()) {
                ActivityCompat.requestPermissions(
                    this,
                    listPermissionsNeeded.toArray(new String[0]),
                    PERMISSION_REQ_CODE
                );
            }
        }
    }
}
`;
fs.writeFileSync(mainActivityPath, mainActivityCode, 'utf8');
console.log('✓ Successfully patched MainActivity.java');
console.log('--- Native Android USB UVC & WebRTC Bridge Patch Complete ---');


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
    <usb-device class="0" />
    <usb-device />
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
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-feature android:name="android.hardware.camera.any" android:required="false" />
`;

    if (!content.includes('android.permission.RECORD_AUDIO')) {
        content = content.replace('<application', `${permissions}\n    <application`);
    }

    // Add hardware acceleration, cleartext traffic & network security config
    if (!content.includes('android:usesCleartextTraffic="true"')) {
        content = content.replace('<application', '<application android:hardwareAccelerated="true" android:usesCleartextTraffic="true"');
    }

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
    console.log('✓ Successfully patched AndroidManifest.xml with USB Host Intent Filters & Permissions');
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
                            Log.d(TAG, "USB Permission GRANTED for: " + device.getDeviceName());
                            connectedDevice = device;
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
            context.registerReceiver(usbReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            context.registerReceiver(usbReceiver, filter);
        }

        startHttpServer();
        checkAndDetectDevice();
    }

    public void checkAndDetectDevice() {
        if (usbManager == null) return;
        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        Log.d(TAG, "Scanning USB devices count: " + (deviceList != null ? deviceList.size() : 0));
        if (deviceList == null || deviceList.isEmpty()) {
            connectedDevice = null;
            return;
        }

        for (UsbDevice device : deviceList.values()) {
            if (isUvcDevice(device) || !isStandardPeripheral(device)) {
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

    private boolean isStandardPeripheral(UsbDevice device) {
        if (device == null) return true;
        int devClass = device.getDeviceClass();
        return devClass == UsbConstants.USB_CLASS_HUB || devClass == UsbConstants.USB_CLASS_HID || devClass == UsbConstants.USB_CLASS_MASS_STORAGE;
    }

    private boolean isUvcDevice(UsbDevice device) {
        if (device == null) return false;
        int devClass = device.getDeviceClass();
        if (devClass == UsbConstants.USB_CLASS_VIDEO || devClass == 239) return true;

        int count = device.getInterfaceCount();
        for (int i = 0; i < count; i++) {
            UsbInterface iface = device.getInterface(i);
            int ifaceClass = iface.getInterfaceClass();
            if (ifaceClass == UsbConstants.USB_CLASS_VIDEO || ifaceClass == 14 || ifaceClass == 239) {
                return true;
            }
        }

        if (!isStandardPeripheral(device)) {
            for (int i = 0; i < count; i++) {
                UsbInterface iface = device.getInterface(i);
                if (iface.getInterfaceClass() == UsbConstants.USB_CLASS_AUDIO) {
                    return true;
                }
            }
        }
        return false;
    }

    @JavascriptInterface
    public boolean isUsbCameraConnected() {
        if (connectedDevice == null) {
            checkAndDetectDevice();
        }
        return connectedDevice != null;
    }

    @JavascriptInterface
    public boolean hasUsbPermission() {
        return connectedDevice != null && usbManager != null && usbManager.hasPermission(connectedDevice);
    }

    @JavascriptInterface
    public void requestUsbCameraPermission() {
        if (usbManager == null) return;
        HashMap<String, UsbDevice> deviceList = usbManager.getDeviceList();
        if (deviceList == null || deviceList.isEmpty()) {
            Log.d(TAG, "No USB devices connected to request permission for");
            return;
        }

        for (UsbDevice device : deviceList.values()) {
            if (isUvcDevice(device) || !isStandardPeripheral(device)) {
                connectedDevice = device;
                if (!usbManager.hasPermission(device)) {
                    Log.d(TAG, "Requesting OS USB Permission Dialog for: " + device.getDeviceName());
                    int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? PendingIntent.FLAG_MUTABLE : 0;
                    Intent intent = new Intent(ACTION_USB_PERMISSION);
                    intent.setPackage(context.getPackageName());
                    PendingIntent pi = PendingIntent.getBroadcast(context, 0, intent, flags);
                    usbManager.requestPermission(device, pi);
                } else {
                    startCapture(device);
                }
                return;
            }
        }
    }

    @JavascriptInterface
    public void requestAppPermissions() {
        if (context instanceof MainActivity) {
            ((MainActivity) context).runOnUiThread(() -> {
                ((MainActivity) context).checkAndRequestPermissions();
            });
        }
    }

    @JavascriptInterface
    public void scanDevices() {
        checkAndDetectDevice();
    }

    @JavascriptInterface
    public String getStreamUrl() {
        return "http://127.0.0.1:" + HTTP_PORT + "/stream";
    }

    @JavascriptInterface
    public String getDeviceName() {
        if (connectedDevice != null) {
            String name = connectedDevice.getProductName();
            if (name != null && !name.trim().isEmpty()) return name;
            return connectedDevice.getDeviceName();
        }
        return "USB Video Capture Card";
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
                if (iface.getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO || iface.getInterfaceClass() == 14 || iface.getInterfaceClass() == 239) {
                    streamingInterface = iface;
                    connection.claimInterface(streamingInterface, true);
                    for (int j = 0; j < iface.getEndpointCount(); j++) {
                        UsbEndpoint ep = iface.getEndpoint(j);
                        if (ep.getDirection() == UsbConstants.USB_DIR_IN) {
                            streamingEndpoint = ep;
                            break;
                        }
                    }
                    if (streamingEndpoint != null) break;
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

            String header = "HTTP/1.1 200 OK\r\n" +
                    "Access-Control-Allow-Origin: *\r\n" +
                    "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n" +
                    "Cache-Control: no-cache\r\n" +
                    "Connection: keep-alive\r\n\r\n";
            out.write(header.getBytes("UTF-8"));
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
                    String partHeader = "--frame\r\n" +
                            "Content-Type: image/jpeg\r\n" +
                            "Content-Length: " + frame.length + "\r\n\r\n";
                    out.write(partHeader.getBytes("UTF-8"));
                    out.write(frame);
                    out.write("\r\n".getBytes("UTF-8"));
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
    private static final int PERMISSION_REQ_CODE = 101;
    private UsbCameraBridge usbCameraBridge;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Configure WebView for WebRTC media streams and audio capture
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);
            settings.setDatabaseEnabled(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            }

            // Attach Native USB UVC Camera Bridge to WebView
            usbCameraBridge = new UsbCameraBridge(this, webView);
            webView.addJavascriptInterface(usbCameraBridge, "AndroidUsbBridge");

            // Auto-grant WebRTC Camera & Microphone requests inside WebView
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> {
                        request.grant(request.getResources());
                    });
                }
            });
        }

        // Post delayed prompt to ensure view/window attachment is complete
        new Handler(Looper.getMainLooper()).postDelayed(this::checkAndRequestPermissions, 600);
    }

    @Override
    public void onStart() {
        super.onStart();
        new Handler(Looper.getMainLooper()).postDelayed(this::checkAndRequestPermissions, 400);
    }

    @Override
    public void onResume() {
        super.onResume();
        new Handler(Looper.getMainLooper()).postDelayed(this::checkAndRequestPermissions, 400);
        if (usbCameraBridge != null) {
            usbCameraBridge.checkAndDetectDevice();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (usbCameraBridge != null) {
            usbCameraBridge.stopCapture();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQ_CODE) {
            boolean allGranted = true;
            for (int result : grantResults) {
                if (result != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            Log.d(TAG, "Runtime permissions result - all granted: " + allGranted);
            if (usbCameraBridge != null) {
                usbCameraBridge.checkAndDetectDevice();
            }
        }
    }

    public void checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            List<String> listPermissionsNeeded = new ArrayList<>();
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                listPermissionsNeeded.add(Manifest.permission.CAMERA);
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                listPermissionsNeeded.add(Manifest.permission.RECORD_AUDIO);
            }

            if (!listPermissionsNeeded.isEmpty()) {
                Log.d(TAG, "Prompting user for missing OS permissions: " + listPermissionsNeeded);
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

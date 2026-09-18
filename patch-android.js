const fs = require('fs');
const path = require('path');

console.log('--- Starting Android WebRTC & Permissions Patch ---');

// ─────────────────────────────────────────────────────────────────
// 1. res/xml/device_filter.xml
//    Tells Android to notify the app when a USB device is attached.
//    UVC-compliant capture cards attached via USB-OTG will be
//    automatically recognized by Android Camera2 as external cameras
//    (Android 9+), then appear in navigator.mediaDevices.enumerateDevices().
// ─────────────────────────────────────────────────────────────────
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
console.log('✓ Created res/xml/device_filter.xml');

// ─────────────────────────────────────────────────────────────────
// 2. Patch AndroidManifest.xml
//    - Add camera, microphone, network and USB-host permissions
//    - Enable hardware acceleration + cleartext traffic
//    - Register USB_DEVICE_ATTACHED intent so Android routes the
//      capture card through Camera2 automatically
// ─────────────────────────────────────────────────────────────────
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
    <!-- USB host — required for OTG capture cards -->
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <!-- Camera features — optional so app installs on devices without a camera -->
    <uses-feature android:name="android.hardware.camera"         android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
    <uses-feature android:name="android.hardware.camera.any"     android:required="false" />
`;

    if (!content.includes('android.permission.RECORD_AUDIO')) {
        content = content.replace('<application', `${permissions}\n    <application`);
    }

    // Hardware acceleration + cleartext (for local PC server connections)
    if (!content.includes('android:usesCleartextTraffic="true"')) {
        content = content.replace(
            '<application',
            '<application android:hardwareAccelerated="true" android:usesCleartextTraffic="true"'
        );
    }

    // USB device attached intent — lets Android auto-open the app when
    // a capture card is plugged in and makes Camera2 register it
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
    console.log('✓ Patched AndroidManifest.xml');
} else {
    console.warn('AndroidManifest.xml not found at:', manifestPath);
}

// ─────────────────────────────────────────────────────────────────
// 3. MainActivity.java
//    Clean, minimal version that:
//      • Configures the WebView for WebRTC (no user-gesture requirement,
//        mixed content allowed, DOM storage on)
//      • Auto-grants camera & microphone permission requests inside
//        the WebView (WebChromeClient.onPermissionRequest)
//      • Requests Android OS-level CAMERA + RECORD_AUDIO at runtime
//    NOTE: No UsbCameraBridge — UVC capture cards are handled by
//    Android's native Camera2 API; they appear in enumerateDevices()
//    just like any other camera and getUserMedia() works directly.
// ─────────────────────────────────────────────────────────────────
const javaDir = path.join(
    __dirname, 'android', 'app', 'src', 'main', 'java', 'com', 'broadcast', 'studio'
);
if (!fs.existsSync(javaDir)) {
    fs.mkdirSync(javaDir, { recursive: true });
}

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
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        if (webView != null) {
            WebSettings settings = webView.getSettings();

            // Allow media playback without a user gesture (needed for live preview)
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowFileAccess(true);
            settings.setAllowContentAccess(true);

            // Allow mixed HTTP/HTTPS content (PC server may be plain HTTP)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            }

            // Auto-grant camera & microphone requests from the WebView.
            // This covers both the built-in camera AND any USB UVC capture card
            // that Android Camera2 has registered as an external camera device.
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public void onPermissionRequest(final PermissionRequest request) {
                    runOnUiThread(() -> request.grant(request.getResources()));
                }
            });
        }

        // Request OS-level permissions after the window is ready
        new Handler(Looper.getMainLooper())
                .postDelayed(this::checkAndRequestPermissions, 600);
    }

    @Override
    protected void onStart() {
        super.onStart();
        new Handler(Looper.getMainLooper())
                .postDelayed(this::checkAndRequestPermissions, 400);
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
            Log.d(TAG, "Requesting permissions: " + needed);
            ActivityCompat.requestPermissions(
                this, needed.toArray(new String[0]), PERM_REQ);
        }
    }
}
`;

const mainActivityPath = path.join(javaDir, 'MainActivity.java');
fs.writeFileSync(mainActivityPath, mainActivityCode, 'utf8');
console.log('✓ Wrote clean MainActivity.java');
console.log('--- Android Patch Complete ---');

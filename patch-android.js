const fs = require('fs');
const path = require('path');

// 1. Patch AndroidManifest.xml
const manifestPath = path.join(__dirname, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

if (fs.existsSync(manifestPath)) {
    let content = fs.readFileSync(manifestPath, 'utf8');

    const permissions = `
    <!-- Permissions for Hardware, Camera, Audio, Network & USB OTG -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <uses-feature android:name="android.hardware.camera" android:required="false" />
    <uses-feature android:name="android.hardware.camera.autofocus" android:required="false" />
`;

    if (!content.includes('android.permission.RECORD_AUDIO')) {
        content = content.replace('<application', `${permissions}\n    <application`);
        fs.writeFileSync(manifestPath, content, 'utf8');
        console.log('✓ Successfully patched AndroidManifest.xml');
    }
} else {
    console.warn('AndroidManifest.xml not found at:', manifestPath);
}

// 2. Patch MainActivity.java (searches recursively in java folder)
const javaDir = path.join(__dirname, 'android', 'app', 'src', 'main', 'java');

function findMainActivity(dir) {
    if (!fs.existsSync(dir)) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (let entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findMainActivity(fullPath);
            if (found) return found;
        } else if (entry.name === 'MainActivity.java') {
            return fullPath;
        }
    }
    return null;
}

const mainActivityPath = findMainActivity(javaDir);

if (mainActivityPath) {
    const mainActivityCode = `package com.broadcast.studio;

import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);

        // Auto-grant WebRTC Camera, Microphone, and Capture Card permissions inside WebView
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    request.grant(request.getResources());
                });
            }
        });
    }
}
`;
    fs.writeFileSync(mainActivityPath, mainActivityCode, 'utf8');
    console.log('✓ Successfully patched MainActivity.java at:', mainActivityPath);
} else {
    console.warn('MainActivity.java not found in java directory');
}

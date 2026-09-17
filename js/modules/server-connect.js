/**
 * Broadcast Studio - Dynamic Server Connection & USB Hardware Bridge Manager
 * Works across all HTML pages: index.html, index_v2.html, director_suite.html, switcher.html, guest.html, graphics.html, ai_audio.html
 */

(function () {
    const STORAGE_KEY = 'broadcast_server_url';

    window.getServerUrl = function () {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && stored.trim() !== '') {
            return stored.trim().replace(/\/+$/, '');
        }
        // If not set and not in standalone APK localhost, default to origin
        if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
            return window.location.origin;
        }
        return '';
    };

    window.setServerUrl = function (url) {
        if (!url || url.trim() === '') {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            let clean = url.trim().replace(/\/+$/, '');
            if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
                clean = 'http://' + clean;
            }
            localStorage.setItem(STORAGE_KEY, clean);
        }
    };

    window.getServerHost = function () {
        const serverUrl = window.getServerUrl();
        if (serverUrl) {
            try {
                const u = new URL(serverUrl);
                return u.host;
            } catch (_) { }
        }
        return window.location.host || 'localhost:8000';
    };

    window.getServerHostname = function () {
        const serverUrl = window.getServerUrl();
        if (serverUrl) {
            try {
                const u = new URL(serverUrl);
                return u.hostname;
            } catch (_) { }
        }
        return window.location.hostname || 'localhost';
    };

    window.getWsProtocol = function () {
        const serverUrl = window.getServerUrl();
        if (serverUrl) {
            return serverUrl.startsWith('https://') ? 'wss:' : 'ws:';
        }
        return window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    };

    // 1. Transparent Fetch Proxy for all /api/ endpoints
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        let url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        const serverUrl = window.getServerUrl();

        if (serverUrl && typeof url === 'string') {
            if (url.startsWith('/api/') || url.startsWith('/peerjs/')) {
                url = serverUrl + url;
                if (input instanceof Request) {
                    input = new Request(url, init || input);
                } else {
                    input = url;
                }
            }
        }
        return originalFetch.call(this, input, init);
    };

    // 2. Native Android USB Video Bridge Helpers & Hooks
    window.hasAndroidUsbCaptureCard = function () {
        return window.AndroidUsbBridge && typeof window.AndroidUsbBridge.isUsbCameraConnected === 'function' && window.AndroidUsbBridge.isUsbCameraConnected();
    };

    window.getAndroidUsbStreamUrl = function () {
        if (window.AndroidUsbBridge && typeof window.AndroidUsbBridge.getStreamUrl === 'function') {
            return window.AndroidUsbBridge.getStreamUrl();
        }
        return 'http://127.0.0.1:8088/stream';
    };

    // Global USB Event Callbacks for Native Android Bridge
    window.onUsbDeviceDetected = function (deviceName) {
        console.log('[AndroidUsbBridge] USB Device Detected:', deviceName);
        if (window.updateDeviceList) window.updateDeviceList();
        if (window.loadHardwareDevices) window.loadHardwareDevices();
    };

    window.onUsbPermissionGranted = function (deviceName) {
        console.log('[AndroidUsbBridge] USB Permission Granted for:', deviceName);
        if (window.updateDeviceList) window.updateDeviceList();
        if (window.loadHardwareDevices) window.loadHardwareDevices();
    };

    window.onUsbPermissionDenied = function () {
        console.warn('[AndroidUsbBridge] USB Permission Denied');
    };

    window.onUsbDeviceDetached = function () {
        console.log('[AndroidUsbBridge] USB Device Detached');
        if (window.updateDeviceList) window.updateDeviceList();
        if (window.loadHardwareDevices) window.loadHardwareDevices();
    };

    window.onUsbStreamReady = function (streamUrl) {
        console.log('[AndroidUsbBridge] USB MJPEG Stream Ready:', streamUrl);
    };

    // 3. Seamless WebRTC MediaDevices Polyfill for Android USB Capture Card
    if (navigator.mediaDevices) {
        const origEnumerate = navigator.mediaDevices.enumerateDevices ? navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices) : null;
        if (origEnumerate) {
            navigator.mediaDevices.enumerateDevices = async function () {
                let list = [];
                try {
                    list = await origEnumerate();
                } catch (_) { }

                // If running in Android APK with USB bridge
                if (window.AndroidUsbBridge) {
                    let devName = 'USB Capture Card / HDMI In';
                    try {
                        if (typeof window.AndroidUsbBridge.getDeviceName === 'function') {
                            devName = window.AndroidUsbBridge.getDeviceName() || devName;
                        }
                    } catch (_) { }

                    const alreadyInList = list.some(d => d.deviceId === 'android_usb');
                    if (!alreadyInList) {
                        list.unshift({
                            deviceId: 'android_usb',
                            kind: 'videoinput',
                            label: `🔌 ${devName} (Native UVC)`,
                            groupId: 'android_usb_group'
                        });
                    }
                }
                return list;
            };
        }

        const origGetUserMedia = navigator.mediaDevices.getUserMedia ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
        if (origGetUserMedia) {
            navigator.mediaDevices.getUserMedia = async function (constraints) {
                const videoConstraint = constraints && constraints.video;
                let reqDeviceId = null;
                if (typeof videoConstraint === 'object' && videoConstraint) {
                    reqDeviceId = videoConstraint.deviceId?.exact || videoConstraint.deviceId || null;
                }

                if (reqDeviceId === 'android_usb') {
                    // Create MediaStream from native MJPEG HTTP stream via Canvas
                    const streamUrl = window.getAndroidUsbStreamUrl();
                    const canvas = document.createElement('canvas');
                    canvas.width = 1920;
                    canvas.height = 1080;
                    const ctx = canvas.getContext('2d');
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.src = streamUrl;

                    let animId = null;
                    function drawLoop() {
                        if (img.complete && img.naturalWidth > 0) {
                            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                        }
                        animId = requestAnimationFrame(drawLoop);
                    }
                    drawLoop();

                    const stream = canvas.captureStream(30);

                    if (constraints && constraints.audio) {
                        try {
                            const audioStream = await origGetUserMedia({ audio: constraints.audio });
                            audioStream.getAudioTracks().forEach(t => stream.addTrack(t));
                        } catch (_) { }
                    }

                    const origTrackStop = stream.getVideoTracks()[0]?.stop;
                    if (origTrackStop) {
                        stream.getVideoTracks()[0].stop = function () {
                            if (animId) cancelAnimationFrame(animId);
                            img.src = '';
                            origTrackStop.call(this);
                        };
                    }
                    return stream;
                }
                return origGetUserMedia(constraints);
            };
        }
    }

    // 4. UI: Inject Server Connection Status Badge & Configuration Modal
    function injectServerConnectUI() {
        if (document.getElementById('server-connect-modal')) return;

        // Modal HTML
        const modal = document.createElement('div');
        modal.id = 'server-connect-modal';
        modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center hidden p-4';
        modal.style.cssText = 'position: fixed; inset: 0; z-index: 9999999 !important; background: rgba(0,0,0,0.85); backdrop-filter: blur(8px);';
        modal.innerHTML = `
            <div class="bg-zinc-900 border border-zinc-700/80 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4 text-white font-sans animate-fade-in" style="max-height: 90vh; overflow-y: auto;">
                <div class="flex items-center justify-between border-b border-zinc-800 pb-3">
                    <div class="flex items-center gap-2">
                        <span class="text-xl">🌐</span>
                        <h3 class="font-bold text-base text-zinc-100">Broadcast Studio Server Setup</h3>
                    </div>
                    <button onclick="closeServerConnectModal()" class="text-zinc-400 hover:text-white text-lg p-1">✕</button>
                </div>

                <p class="text-xs text-zinc-400 leading-relaxed">
                    Connect this mobile APK or remote controller to your PC running the Broadcast Studio backend.
                </p>

                <div class="space-y-1.5">
                    <label class="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Server IP Address & Port</label>
                    <div class="flex items-center gap-2">
                        <input type="text" id="server-url-input" placeholder="e.g. 192.168.1.100:8000"
                            class="w-full bg-zinc-950 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 font-mono">
                    </div>
                    <p class="text-[10px] text-zinc-500">Enter your PC's Wi-Fi IP address (e.g. <code>192.168.1.50:8000</code> or <code>https://your-studio.com</code>).</p>
                </div>

                <div id="server-test-status" class="text-xs p-3 rounded-xl bg-zinc-950 border border-zinc-800 hidden flex items-center gap-2"></div>

                <div class="flex items-center gap-2 pt-2">
                    <button onclick="testServerConnection()" id="btn-test-server"
                        class="flex-1 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 text-zinc-200 rounded-xl text-xs font-bold transition">
                        ⚡ Test Ping
                    </button>
                    <button onclick="saveServerConnection()"
                        class="flex-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition shadow-lg shadow-blue-600/30">
                        💾 Save & Connect
                    </button>
                </div>

                <div class="border-t border-zinc-800 pt-3 flex items-center justify-between text-[11px] text-zinc-500">
                    <span>USB Capture Bridge: <strong class="text-zinc-300">${window.AndroidUsbBridge ? 'Active' : 'Standby'}</strong></span>
                    <button onclick="requestPermissionsFromModal()" class="text-blue-400 hover:underline">Request Permissions</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Top Floating Server Indicator Button (Always visible on mobile & desktop)
        const badge = document.createElement('button');
        badge.id = 'server-status-badge';
        badge.onclick = window.openServerConnectModal;
        badge.style.cssText = 'position: fixed; top: 12px; right: 12px; z-index: 999999 !important; cursor: pointer;';
        badge.className = 'px-3 py-1.5 rounded-full text-xs font-bold shadow-2xl border backdrop-blur-md flex items-center gap-2 transition hover:scale-105 select-none';
        document.body.appendChild(badge);
        updateServerBadgeUI();

        // If in APK and no server IP configured, show top banner
        if (!localStorage.getItem(STORAGE_KEY) && (window.AndroidUsbBridge || window.location.hostname === 'localhost')) {
            const banner = document.createElement('div');
            banner.id = 'server-connect-banner';
            banner.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; z-index: 999990 !important; cursor: pointer;';
            banner.className = 'bg-amber-600 text-white text-xs py-1.5 px-4 text-center font-bold flex items-center justify-center gap-2 shadow-lg';
            banner.innerHTML = `<span>⚠️ Mobile APK: Connect to PC Server IP (Click here)</span> <span class="bg-black/30 px-2 py-0.5 rounded text-[10px]">Configure</span>`;
            banner.onclick = window.openServerConnectModal;
            document.body.appendChild(banner);
        }
    }

    function updateServerBadgeUI() {
        const badge = document.getElementById('server-status-badge');
        if (!badge) return;
        const current = window.getServerUrl();
        const host = window.getServerHost();

        if (current) {
            badge.className = 'px-3 py-1.5 rounded-full text-[11px] font-bold shadow-2xl border border-emerald-500/40 bg-zinc-900/90 text-emerald-400 backdrop-blur-md flex items-center gap-1.5 transition hover:scale-105 cursor-pointer';
            badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> 🌐 ${host}`;
        } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            badge.className = 'px-3 py-1.5 rounded-full text-[11px] font-bold shadow-2xl border border-amber-500/50 bg-amber-950/80 text-amber-300 backdrop-blur-md flex items-center gap-1.5 transition hover:scale-105 cursor-pointer animate-bounce';
            badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span> ⚙️ Set Server IP`;
        } else {
            badge.className = 'px-3 py-1.5 rounded-full text-[11px] font-bold shadow-2xl border border-zinc-700 bg-zinc-900/90 text-zinc-300 backdrop-blur-md flex items-center gap-1.5 transition hover:scale-105 cursor-pointer';
            badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-500"></span> 🌐 ${window.location.host}`;
        }
    }

    window.openServerConnectModal = function () {
        const modal = document.getElementById('server-connect-modal');
        const input = document.getElementById('server-url-input');
        const status = document.getElementById('server-test-status');
        if (!modal) return;
        if (input) input.value = window.getServerUrl() || '';
        if (status) status.classList.add('hidden');
        modal.classList.remove('hidden');
    };

    window.closeServerConnectModal = function () {
        const modal = document.getElementById('server-connect-modal');
        if (modal) modal.classList.add('hidden');
    };

    window.requestPermissionsFromModal = function () {
        if (window.AndroidUsbBridge && typeof window.AndroidUsbBridge.requestAppPermissions === 'function') {
            window.AndroidUsbBridge.requestAppPermissions();
        }
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(s => {
                s.getTracks().forEach(t => t.stop());
                alert("Camera and Microphone permissions granted!");
            }).catch(e => {
                alert("Permission request: " + e.message);
            });
        }
    };

    window.testServerConnection = async function () {
        const input = document.getElementById('server-url-input');
        const status = document.getElementById('server-test-status');
        const btn = document.getElementById('btn-test-server');
        if (!input || !status) return;

        let url = input.value.trim().replace(/\/+$/, '');
        if (!url) {
            status.className = 'text-xs p-3 rounded-xl bg-amber-950/50 border border-amber-800/60 text-amber-300 flex items-center gap-2';
            status.innerHTML = '⚠️ Please enter a server address.';
            status.classList.remove('hidden');
            return;
        }

        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'http://' + url;
        }

        status.className = 'text-xs p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-300 flex items-center gap-2';
        status.innerHTML = '<span class="animate-spin">⏳</span> Connecting to ' + url + '...';
        status.classList.remove('hidden');
        if (btn) btn.disabled = true;

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);
            const res = await originalFetch(url + '/api/rtmp/status', { signal: controller.signal });
            clearTimeout(timeoutId);

            if (res.ok) {
                const data = await res.json();
                status.className = 'text-xs p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/80 text-emerald-300 flex items-center gap-2';
                status.innerHTML = `✅ Connected successfully! (Active RTMP: ${data.broadcasting ? 'LIVE' : 'Ready'})`;
            } else {
                throw new Error(`HTTP ${res.status}`);
            }
        } catch (e) {
            status.className = 'text-xs p-3 rounded-xl bg-rose-950/60 border border-rose-800/80 text-rose-300 flex items-center gap-2';
            status.innerHTML = `❌ Connection failed: ${e.message}. Ensure backend is running on PC and firewall allows port.`;
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    window.saveServerConnection = function () {
        const input = document.getElementById('server-url-input');
        if (!input) return;
        window.setServerUrl(input.value);
        updateServerBadgeUI();
        const banner = document.getElementById('server-connect-banner');
        if (banner) banner.remove();
        window.closeServerConnectModal();
        if (typeof showDirectorToast === 'function') {
            showDirectorToast('Server address updated! Reconnecting...', 'success');
        }
        setTimeout(() => {
            window.location.reload();
        }, 500);
    };

    // Auto-prompt Android OS runtime permissions on load
    function initAppPermissions() {
        if (window.AndroidUsbBridge && typeof window.AndroidUsbBridge.requestAppPermissions === 'function') {
            window.AndroidUsbBridge.requestAppPermissions();
        }
        if (window.AndroidUsbBridge && typeof window.AndroidUsbBridge.scanDevices === 'function') {
            window.AndroidUsbBridge.scanDevices();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            injectServerConnectUI();
            initAppPermissions();
        });
    } else {
        injectServerConnectUI();
        initAppPermissions();
    }
})();

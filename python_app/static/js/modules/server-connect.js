/**
 * Broadcast Studio - Dynamic Server Connection & USB Hardware Bridge Manager
 * Works across all HTML pages: index_v2.html, director_suite.html, switcher.html, guest.html, graphics.html, ai_audio.html
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
            } catch (_) {}
        }
        return window.location.host || 'localhost:8000';
    };

    window.getServerHostname = function () {
        const serverUrl = window.getServerUrl();
        if (serverUrl) {
            try {
                const u = new URL(serverUrl);
                return u.hostname;
            } catch (_) {}
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

    // 2. Native Android USB Video Bridge Helpers
    window.hasAndroidUsbCaptureCard = function () {
        return window.AndroidUsbBridge && typeof window.AndroidUsbBridge.isUsbCameraConnected === 'function' && window.AndroidUsbBridge.isUsbCameraConnected();
    };

    window.getAndroidUsbStreamUrl = function () {
        if (window.hasAndroidUsbCaptureCard()) {
            return window.AndroidUsbBridge.getStreamUrl();
        }
        return '';
    };

    // 3. UI: Inject Server Connection Status Badge & Configuration Modal
    function injectServerConnectUI() {
        if (document.getElementById('server-connect-modal')) return;

        // Modal HTML
        const modal = document.createElement('div');
        modal.id = 'server-connect-modal';
        modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center hidden p-4';
        modal.innerHTML = `
            <div class="bg-zinc-900 border border-zinc-700/80 rounded-2xl w-full max-w-md p-6 shadow-2xl space-y-4 text-white font-sans animate-fade-in">
                <div class="flex items-center justify-between border-b border-zinc-800 pb-3">
                    <div class="flex items-center gap-2">
                        <span class="text-xl">🌐</span>
                        <h3 class="font-bold text-base text-zinc-100">Backend Server Connection</h3>
                    </div>
                    <button onclick="closeServerConnectModal()" class="text-zinc-400 hover:text-white text-lg p-1">✕</button>
                </div>

                <p class="text-xs text-zinc-400 leading-relaxed">
                    Connect this APK or mobile controller to your PC or Cloud VPS running the Broadcast Studio backend.
                </p>

                <div class="space-y-1.5">
                    <label class="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Server Address (IP or Domain)</label>
                    <div class="flex items-center gap-2">
                        <input type="text" id="server-url-input" placeholder="e.g. 192.168.1.50:8000 or studio.domain.com"
                            class="w-full bg-zinc-950 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-blue-500 font-mono">
                    </div>
                    <p class="text-[10px] text-zinc-500">Example: <code>http://192.168.1.100:8000</code> for Local Wi-Fi, or <code>https://your-server.com</code> for VPS.</p>
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
            </div>
        `;
        document.body.appendChild(modal);

        // Floating Server Indicator Badge
        const badge = document.createElement('button');
        badge.id = 'server-status-badge';
        badge.onclick = window.openServerConnectModal;
        badge.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-xs font-bold shadow-lg border backdrop-blur-md flex items-center gap-2 transition hover:scale-105 select-none cursor-pointer';
        document.body.appendChild(badge);
        updateServerBadgeUI();
    }

    function updateServerBadgeUI() {
        const badge = document.getElementById('server-status-badge');
        if (!badge) return;
        const current = window.getServerUrl();
        const host = window.getServerHost();

        if (current) {
            badge.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-[11px] font-bold shadow-lg border border-emerald-500/40 bg-zinc-900/90 text-emerald-400 backdrop-blur-md flex items-center gap-1.5 transition hover:scale-105 cursor-pointer';
            badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span> 🌐 ${host}`;
        } else if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            badge.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-[11px] font-bold shadow-lg border border-amber-500/40 bg-zinc-900/90 text-amber-400 backdrop-blur-md flex items-center gap-1.5 transition hover:scale-105 cursor-pointer';
            badge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span> ⚙️ Set Server IP`;
        } else {
            badge.className = 'fixed bottom-4 right-4 z-40 px-3 py-1.5 rounded-full text-[11px] font-bold shadow-lg border border-zinc-700 bg-zinc-900/90 text-zinc-300 backdrop-blur-md flex items-center gap-1.5 transition hover:scale-105 cursor-pointer';
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
            status.innerHTML = `❌ Connection failed: ${e.message}. Ensure backend is running and firewall allows port.`;
        } finally {
            if (btn) btn.disabled = false;
        }
    };

    window.saveServerConnection = function () {
        const input = document.getElementById('server-url-input');
        if (!input) return;
        window.setServerUrl(input.value);
        updateServerBadgeUI();
        window.closeServerConnectModal();
        if (typeof showDirectorToast === 'function') {
            showDirectorToast('Server address updated! Reconnecting...', 'success');
        }
        setTimeout(() => {
            window.location.reload();
        }, 500);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectServerConnectUI);
    } else {
        injectServerConnectUI();
    }
})();

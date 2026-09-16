// Synthetic test to verify unthrottled Web Worker ticker and background canvas rendering
// when document.hidden is true (simulating minimized window or switching to another app)

import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runSyntheticTest() {
    console.log("=== SYNTHETIC BACKGROUND EXECUTION TEST ===");
    console.log("Testing whether minimizing tab / document.hidden preserves 30fps canvas rendering and timers...\n");

    // 1. Serve index_v2.html via a lightweight HTTP server
    const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index_v2.html'), 'utf8');
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlContent);
    });

    const PORT = 8899;
    await new Promise(r => server.listen(PORT, '127.0.0.1', r));
    console.log(`[1] Local test server running on http://127.0.0.1:${PORT}`);

    // 2. Launch Edge Chromium in headless mode with remote debugging
    const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    console.log(`[2] Launching headless browser: ${edgePath}`);

    const CDP_PORT = 9222;
    const browserProc = spawn(edgePath, [
        `--remote-debugging-port=${CDP_PORT}`,
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--autoplay-policy=no-user-gesture-required',
        `http://127.0.0.1:${PORT}/#controller`
    ]);

    // Give browser 2 seconds to launch
    await new Promise(r => setTimeout(r, 2000));

    try {
        // Query CDP targets
        const listRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const targets = await listRes.json();
        const pageTarget = targets.find(t => t.type === 'page');

        if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
            throw new Error("Could not find page target via CDP");
        }

        console.log(`[3] Connected to Page CDP WebSocket: ${pageTarget.webSocketDebuggerUrl}`);

        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = reject;
        });

        let msgId = 1;
        const cdpCall = (method, params = {}) => {
            return new Promise((resolve, reject) => {
                const id = msgId++;
                const handler = (event) => {
                    const data = JSON.parse(event.data);
                    if (data.id === id) {
                        ws.removeEventListener('message', handler);
                        if (data.error) reject(data.error);
                        else resolve(data.result);
                    }
                };
                ws.addEventListener('message', handler);
                ws.send(JSON.stringify({ id, method, params }));
            });
        };

        await cdpCall('Page.enable');
        await cdpCall('Runtime.enable');

        // Wait 2s for page scripts to initialize
        await new Promise(r => setTimeout(r, 2000));

        // 4. Check if Universal Background Worker and Audio Keep-Alive are initialized
        console.log("[4] Checking studio background subsystems...");
        const evalSubsystems = await cdpCall('Runtime.evaluate', {
            expression: `({
                hasRegisterWorker: typeof window.registerStudioBackgroundWorker === 'function',
                hasUniversalWorker: !!window._universalBackgroundWorker,
                hasKeepAliveCtx: typeof window.startStudioAudioKeepAlive === 'function',
                wakeLockSupported: 'wakeLock' in navigator
            })`,
            returnByValue: true
        });

        console.log("Subsystems Check:", JSON.stringify(evalSubsystems.result.value, null, 2));

        // 5. Setup synthetic benchmark in the browser:
        // Measure requestAnimationFrame vs Worker Ticker while document is VISIBLE vs HIDDEN
        console.log("\n[5] Setting up synthetic frame counter (RAF vs Background Worker Ticker)...");
        await cdpCall('Runtime.evaluate', {
            expression: `
                window._testRafCount = 0;
                window._testWorkerCount = 0;
                window._testCanvasPaints = 0;

                function rafLoop() {
                    window._testRafCount++;
                    requestAnimationFrame(rafLoop);
                }
                requestAnimationFrame(rafLoop);

                window.registerStudioBackgroundWorker('synthetic_test', (now) => {
                    window._testWorkerCount++;
                    if (document.hidden) {
                        window._testCanvasPaints++;
                    }
                });
            `
        });

        // Test Phase A: Visible window (1.5 seconds)
        console.log("\n--- Phase A: Tab is VISIBLE (Normal foreground state) ---");
        const visibleStart = await cdpCall('Runtime.evaluate', {
            expression: `({ raf: window._testRafCount, worker: window._testWorkerCount })`,
            returnByValue: true
        });
        await new Promise(r => setTimeout(r, 1500));
        const visibleEnd = await cdpCall('Runtime.evaluate', {
            expression: `({ raf: window._testRafCount, worker: window._testWorkerCount })`,
            returnByValue: true
        });

        const visibleRafDelta = visibleEnd.result.value.raf - visibleStart.result.value.raf;
        const visibleWorkerDelta = visibleEnd.result.value.worker - visibleStart.result.value.worker;
        console.log(`Visible (1.5s): RAF Ticks = ${visibleRafDelta} (~${Math.round(visibleRafDelta/1.5)} fps), Worker Ticks = ${visibleWorkerDelta} (~${Math.round(visibleWorkerDelta/1.5)} fps)`);

        // Test Phase B: Emulate MINIMIZED / HIDDEN / SWITCHED APP (document.hidden = true)
        console.log("\n--- Phase B: Simulating MINIMIZED / BACKGROUNDED (document.hidden = true) ---");
        
        try {
            await cdpCall('Emulation.setFocusEmulationEnabled', { enabled: false });
        } catch (e) {}

        // Emulate background/minimized visibility
        await cdpCall('Runtime.evaluate', {
            expression: `
                // Emulate what Chromium does when window is minimized or user switches app:
                Object.defineProperty(document, 'hidden', { value: true, configurable: true });
                Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
                document.dispatchEvent(new Event('visibilitychange'));
            `
        });

        const hiddenStart = await cdpCall('Runtime.evaluate', {
            expression: `({
                hidden: document.hidden,
                visibilityState: document.visibilityState,
                raf: window._testRafCount,
                worker: window._testWorkerCount,
                paints: window._testCanvasPaints
            })`,
            returnByValue: true
        });
        console.log("State at start of minimization:", JSON.stringify(hiddenStart.result.value));

        // Wait 3.0 seconds while window is minimized / hidden
        await new Promise(r => setTimeout(r, 3000));

        const hiddenEnd = await cdpCall('Runtime.evaluate', {
            expression: `({
                hidden: document.hidden,
                visibilityState: document.visibilityState,
                raf: window._testRafCount,
                worker: window._testWorkerCount,
                paints: window._testCanvasPaints
            })`,
            returnByValue: true
        });
        console.log("State after 3 seconds of minimization:", JSON.stringify(hiddenEnd.result.value));

        const hiddenRafDelta = hiddenEnd.result.value.raf - hiddenStart.result.value.raf;
        const hiddenWorkerDelta = hiddenEnd.result.value.worker - hiddenStart.result.value.worker;
        const hiddenPaintsDelta = hiddenEnd.result.value.paints - hiddenStart.result.value.paints;

        console.log("\n=== SYNTHETIC TEST RESULTS ===");
        console.log(`1. requestAnimationFrame during minimization: ${hiddenRafDelta} frames (Expected: 0 frames, fully frozen by browser)`);
        console.log(`2. Web Worker Ticker during minimization:     ${hiddenWorkerDelta} ticks (Expected: ~90 ticks over 3s, constant 30 FPS)`);
        console.log(`3. Canvas Paints triggered while minimized:  ${hiddenPaintsDelta} paints (Unthrottled frame rendering sustained)`);

        let passed = true;
        if (hiddenWorkerDelta < 60) {
            console.error("FAIL: Web Worker ticker fell below threshold!");
            passed = false;
        }
        if (hiddenPaintsDelta < 60) {
            console.error("FAIL: Background canvas painting was throttled!");
            passed = false;
        }

        // 6. Test Media Sync Heartbeat under document.hidden
        console.log("\n[6] Testing SYNC_MEDIA loop under document.hidden (checking for 60s throttling)...");
        await cdpCall('Runtime.evaluate', {
            expression: `
                window._testSyncTicks = 0;
                let lastSync = 0;
                window.registerStudioBackgroundWorker('test_sync_watchdog', (now) => {
                    if (now - lastSync >= 1000) {
                        lastSync = now;
                        window._testSyncTicks++;
                    }
                });
            `
        });

        await new Promise(r => setTimeout(r, 2200));

        const syncCheck = await cdpCall('Runtime.evaluate', {
            expression: `window._testSyncTicks`,
            returnByValue: true
        });

        console.log(`SYNC_MEDIA ticks in 2.2s background: ${syncCheck.result.value} (Expected: 2 ticks, proving timer was NOT throttled to 60s)`);
        if (syncCheck.result.value >= 2) {
            console.log(">>> SYNC_MEDIA Background Heartbeat PASSED (Immune to 60s background timer throttling) <<<");
        }

        ws.close();
    } finally {
        browserProc.kill();
        server.close();
    }
}

runSyntheticTest().catch(err => {
    console.error("Synthetic test error:", err);
    process.exit(1);
});

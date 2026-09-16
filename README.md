# 🎛️ Pro Broadcast Studio

A single-file, browser-based **remote broadcast production suite**. It lets you run a full multi-layer video switcher/mixer ("Controller") on one device and beam the final composited output live to a fullscreen "Player" window on another device — over the internet — using **WebRTC** (peer-to-peer, no server-side media relay). Installable as a **PWA (Progressive Web App)** on desktop or mobile.

Think of it as a lightweight, self-hosted alternative to OBS/vMix remote outputs: one device is your production desk, the other is the "clean feed" screen you capture into your streaming/recording software.

---

## ✨ Key Features

### 🖥️ Two Roles, One App
- **Controller** — the production desk. Add layers, arrange a scene, mix audio, and drive playback.
- **Player** — a fullscreen, distraction-free output window that renders the live composited program. Point OBS/vMix's "Window Capture" (or a browser source) at this window to send it to your stream.
- Both roles connect using a shared **Studio ID**, so a Controller on one PC can drive a Player on a completely different device/network.

### 🧩 Layer-Based Compositing
- **Live Camera / Mic** — select from any connected camera and microphone.
- **Screen / Window Share** — capture a screen, window, or browser tab as a layer.
- **Local File Streaming (WebRTC)** — drag & drop video, audio, or image files to stream them live to the Player in real time.
- **Remote File Path / Web URL** — add a video/audio/image URL or an embedded web iframe (useful for feeding vMix or other downstream tools).
- **Text Overlays** — customizable live text with color and font-size controls.
- Full **Layer Stack** manager: reorder, show/hide, and select layers (layer #1 = on Program Monitor).
- Per-layer **Properties Panel**: position (X/Y), uniform scale/zoom, drag-to-move and corner-resize directly on the canvas.

### 🎚️ Audio & Video Control
- **Master Audio Mixer** with per-layer mute and volume sliders.
- **Persistent Video Controller** — play/pause, restart, loop, and scrub playback position for any video layer.

### 📡 Streaming Quality & Transport
- Adjustable **Bitrate Mode**: VBR (recommended) or CBR (fixed quality).
- Selectable **stream quality**, with automatic fallback between direct video rendering and canvas-based rendering for lower-end connections.
- Live **P2P connection status**, ping, and **FPS monitors** for both host and player, so you can watch stream health in real time.

### 📱 Progressive Web App
- Installable as a standalone desktop/mobile app (custom install prompt + instructions banner).
- Offline-capable shell via a Service Worker (caches core app assets).
- App icons and manifest included for a native-like install experience.

---

## 🗂️ Project Structure

```
Brod_cast_App-main/
├── index.html       # Entire application (UI + WebRTC/PeerJS logic + canvas compositor)
├── manifest.json     # PWA manifest (name, icons, theme, display mode)
├── sw.js             # Service worker — caches app shell for offline/installable use
├── vercel.json        # Deployment config (cache headers for the service worker)
├── icon-192.png       # PWA icon (192x192)
├── icon-512.png       # PWA icon (512x512)
└── README.md
```

The entire application logic lives in **`index.html`** — there is no build step, backend server, or database. It's a static site.

---

## 🔧 Tech Stack

| Layer | Technology |
|---|---|
| UI | Vanilla HTML/CSS + [Tailwind CSS](https://tailwindcss.com/) (via CDN) |
| Peer-to-peer streaming | [PeerJS](https://peerjs.com/) (WebRTC wrapper) v1.5.2 |
| Fonts | Google Fonts (Inter) |
| Compositing | HTML5 `<canvas>` + native `<video>` elements |
| Offline / installability | Web App Manifest + Service Worker |
| Hosting | Static hosting, configured for [Vercel](https://vercel.com/) |

No frameworks, no bundler, no `npm install` — just static files.

---

## 🚀 Getting Started

### Option 1 — Run locally
1. Serve the folder with any static file server (opening `index.html` directly via `file://` will show a warning, since WebRTC/PWA features need `http(s)://`):
   ```bash
   npx serve .
   # or
   python3 -m http.server 8080
   ```
2. Open the app in a browser on your **Controller** device.
3. Open the same URL on your **Player** device (another PC, tablet, or phone).
4. Enter the **same Studio ID** on both devices.
5. On the Controller, click **"Open Controller Here"**; on the Player, click **"Launch Player Window"**, then click to start (this satisfies browser autoplay/fullscreen requirements).
6. Add camera, screen share, media, or text layers on the Controller — they appear live on the Player.

### Option 2 — Deploy to Vercel
The included `vercel.json` sets the correct cache headers for the service worker. Simply import the repo into Vercel and deploy — no build settings required (static site).

### Capturing the output for streaming
Point your streaming software (OBS Studio, vMix, etc.) at the **Player window** using a Window Capture / Browser Source, then start your stream/recording as normal.

---

## 📚 Comprehensive Documentation

For a detailed technical deep dive into all design decisions, transport protocols, bonding math, and API specifications, see:
👉 **[ARCHITECTURE_AND_FEATURES.md](file:///e:/Brod_cast_App/ARCHITECTURE_AND_FEATURES.md)**

---

## 📄 License

MIT License.


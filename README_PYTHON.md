# 🎛️ Pro Broadcast Studio (Python Engine)

A high-performance, **cross-platform Python broadcast production switcher, multi-layer compositor, and live media mixer**. It operates natively across **Windows, macOS, and Linux**, while supporting remote controller & player clients on **mobile (iOS/Android)** and other computers over the local network or internet.

---

## 🌟 Key Capabilities

- **Python Multi-Layer Compositor Engine**: Real-time 1080p frame mixing using `OpenCV`, `NumPy`, and `PIL` with z-order hierarchy, alpha transparency, scaling, positioning, and lower-third overlays.
- **Cross-Platform Screen Capture**: Seamless desktop/monitor capture across Windows, macOS, and Linux via `mss`.
- **Camera & Local Media Ingest**: Live USB/Built-in webcam capture (`cv2.VideoCapture`), MP4 video loops, PNG graphics with transparency, and animated lower-third titles.
- **Virtual Webcam Output**: Feeds the mixed Program stream directly to a virtual webcam device (`pyvirtualcam`) for OBS Studio, vMix, Zoom, Teams, and Discord.
- **Real-Time WebSockets & WebRTC**: Instantaneous multi-device state synchronization via WebSockets and low-latency video streaming with `aiortc`.
- **Zero-Install Client Access**: Anyone on the local network (PC, Mac, iPhone, Android tablet) can access the studio by opening `http://<your-ip>:8000`.

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Launch Studio

- **Windows**: Double-click `run.bat` or run:
  ```bash
  python run.py
  ```
- **macOS / Linux**:
  ```bash
  chmod +x run.sh
  ./run.sh
  ```

Your default web browser will automatically open `http://localhost:8000` to the broadcast control deck.

---

## 🧭 Architecture

```
Brod_cast_App/
├── python_app/
│   ├── main.py                  # FastAPI server & WebSocket dispatch
│   ├── core/
│   │   ├── compositor.py        # Frame mixing & layer composition (OpenCV/NumPy)
│   │   ├── screen_capture.py    # Cross-platform screen/monitor grabber (mss)
│   │   ├── virtual_cam.py       # Virtual webcam output sink (pyvirtualcam)
│   │   ├── webrtc_manager.py    # aiortc WebRTC peer streaming & track handling
│   │   └── state_manager.py     # Live studio state & layer hierarchy store
│   ├── api/
│   │   ├── routes.py            # REST endpoints (devices, layers, upload, status)
│   │   └── websocket.py         # Real-time bidir sync for controller & player
│   └── static/                  # Production UI (index.html, CSS, JS)
├── run.py                       # Universal CLI launcher
├── run.bat                      # Windows 1-click launcher
├── run.sh                       # Linux / macOS launcher
├── requirements.txt
└── README_PYTHON.md
```

---

## 📡 Output Streams & OBS / vMix Integration

1. **Virtual Camera Sink**: Click **Virtual Camera: On** in the UI to turn your composited scene into a virtual webcam. Select this webcam in OBS Studio, vMix, Zoom, or Discord.
2. **Direct MJPEG Stream**: Point OBS Studio or vMix "Browser Source" / "Media Source" to:
   ```
   http://localhost:8000/api/stream/mjpeg
   ```
3. **Fullscreen Remote Player**: Click **Fullscreen Player** in the UI for a clean video feed to capture via Display Capture or Window Capture.

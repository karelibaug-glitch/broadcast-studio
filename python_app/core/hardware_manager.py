from __future__ import annotations
"""
Hardware Device Manager for Pro Broadcast Studio
Enables direct native capture of USB Webcams, HDMI Capture Cards (Elgato, CamLink, etc.)
outside browser sandbox restrictions. Works across Windows, macOS, and Linux.
"""


import sys
import time
import threading
from typing import List, Dict, Any, Optional
try:
    import cv2
except Exception:
    cv2 = None

try:
    import numpy as np
except Exception:
    np = None



class HardwareDeviceStreamer:
    """Manages concurrent capture and streaming for a single hardware device."""

    def __init__(self, device_id: int):
        self.device_id = device_id
        self.cap: Optional[cv2.VideoCapture] = None
        self.active_viewers = 0
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.latest_frame_bytes: Optional[bytes] = None
        self.frame_lock = threading.Lock()
        self.width = 1920
        self.height = 1080
        self.fps = 30
        self.name = f"Hardware Device #{device_id}"

    def _get_api_preference(self) -> int:
        if sys.platform.startswith('win'):
            return cv2.CAP_DSHOW
        elif sys.platform.startswith('linux'):
            return cv2.CAP_V4L2
        elif sys.platform.startswith('darwin'):
            return cv2.CAP_AVFOUNDATION
        return cv2.CAP_ANY

    def start(self) -> bool:
        with self.frame_lock:
            if self.running:
                self.active_viewers += 1
                return True

            api_pref = self._get_api_preference()
            cap = cv2.VideoCapture(self.device_id, api_pref)
            if not cap.isOpened():
                # Fallback to default API
                cap = cv2.VideoCapture(self.device_id)

            if cap.isOpened():
                # Configure high performance HD capture
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
                cap.set(cv2.CAP_PROP_FPS, 30)
                self.width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
                self.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
                self.cap = cap
            else:
                # No physical camera or busy: use resilient synthetic broadcast pattern
                self.cap = None
                self.width = 1280
                self.height = 720

            self.running = True
            self.active_viewers = 1

            self.thread = threading.Thread(target=self._capture_loop, daemon=True)
            self.thread.start()
            return True

    def _capture_loop(self):
        encode_params = [cv2.IMWRITE_JPEG_QUALITY, 80]
        t0 = time.time()
        while self.running:
            if self.cap and self.cap.isOpened():
                ret, frame = self.cap.read()
                if not ret or frame is None:
                    time.sleep(0.02)
                    continue
            else:
                # Generate synthetic studio test pattern
                frame = np.zeros((720, 1280, 3), dtype=np.uint8)
                colors = [
                    (255, 255, 255), (0, 255, 255), (255, 255, 0), (0, 255, 0),
                    (255, 0, 255), (0, 0, 255), (255, 0, 0), (0, 0, 0)
                ]
                bar_w = 1280 // len(colors)
                for i, col in enumerate(colors):
                    frame[0:500, i * bar_w:(i + 1) * bar_w] = col
                frame[500:720, :] = (24, 24, 27)
                elapsed = time.time() - t0
                timecode = time.strftime("%H:%M:%S") + f".{int((elapsed % 1) * 100):02d}"
                cv2.putText(frame, f"HOST HARDWARE CH {self.device_id} (STUDIO TEST CARD)", (50, 580),
                            cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2, cv2.LINE_AA)
                cv2.putText(frame, f"TC: {timecode} | 720p 30FPS | Zero-Perm Direct Stream", (50, 640),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 200), 2, cv2.LINE_AA)

            success, buffer = cv2.imencode('.jpg', frame, encode_params)
            if success:
                with self.frame_lock:
                    self.latest_frame_bytes = buffer.tobytes()

            time.sleep(1.0 / 30.0)

        with self.frame_lock:
            if self.cap:
                try:
                    self.cap.release()
                except Exception:
                    pass
                self.cap = None

    def get_frame(self) -> Optional[bytes]:
        with self.frame_lock:
            return self.latest_frame_bytes

    def release_viewer(self):
        with self.frame_lock:
            self.active_viewers = max(0, self.active_viewers - 1)
            if self.active_viewers <= 0:
                self.running = False


class HardwareManager:
    """Singleton manager for discovering and routing local hardware video devices."""

    def __init__(self):
        self.streamers: Dict[int, HardwareDeviceStreamer] = {}
        self.last_scan_time = 0.0
        self.cached_devices: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def get_backend_name(self) -> str:
        if sys.platform.startswith('win'):
            return "DirectShow"
        elif sys.platform.startswith('linux'):
            return "V4L2"
        elif sys.platform.startswith('darwin'):
            return "AVFoundation"
        return "Generic"

    def get_api_preference(self) -> int:
        if sys.platform.startswith('win'):
            return cv2.CAP_DSHOW
        elif sys.platform.startswith('linux'):
            return cv2.CAP_V4L2
        elif sys.platform.startswith('darwin'):
            return cv2.CAP_AVFOUNDATION
        return cv2.CAP_ANY

    def scan_devices(self, force: bool = False) -> List[Dict[str, Any]]:
        """Scans video capture indices (0..4) to detect connected hardware."""
        now = time.time()
        with self._lock:
            if not force and (now - self.last_scan_time < 4.0) and self.cached_devices:
                return self.cached_devices

            devices = []
            api_pref = self.get_api_preference()
            backend = self.get_backend_name()

            # Probe indices 0 to 4
            for idx in range(5):
                # If currently streaming, we already know it is available
                if idx in self.streamers and self.streamers[idx].running:
                    devices.append({
                        "id": idx,
                        "name": f"USB Video / Capture Card #{idx}",
                        "backend": backend,
                        "max_resolution": "1080p",
                        "active": True,
                        "width": self.streamers[idx].width,
                        "height": self.streamers[idx].height,
                    })
                    continue

                cap = cv2.VideoCapture(idx, api_pref)
                if not cap.isOpened():
                    cap = cv2.VideoCapture(idx)

                if cap.isOpened():
                    ret, _ = cap.read()
                    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
                    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
                    cap.release()
                    devices.append({
                        "id": idx,
                        "name": f"USB Video / Capture Card #{idx}",
                        "backend": backend,
                        "max_resolution": "1080p",
                        "active": False,
                        "width": w,
                        "height": h,
                    })

            # Always ensure at least default host device is available for zero-config testing
            if not devices:
                devices.append({
                    "id": 0,
                    "name": f"Host Video / Capture Card #0 ({backend})",
                    "backend": backend,
                    "max_resolution": "1080p",
                    "active": 0 in self.streamers and self.streamers[0].running,
                    "width": 1920,
                    "height": 1080,
                })

            self.cached_devices = devices
            self.last_scan_time = now
            return devices

    def list_capture_devices(self, force: bool = False) -> List[Dict[str, Any]]:
        """Alias for scan_devices."""
        return self.scan_devices(force=force)

    def get_streamer(self, device_id: int) -> Optional[HardwareDeviceStreamer]:
        with self._lock:
            if device_id not in self.streamers:
                self.streamers[device_id] = HardwareDeviceStreamer(device_id)
            return self.streamers[device_id]

    def generate_mjpeg_stream(self, device_id: int):
        streamer = self.get_streamer(device_id)
        if not streamer:
            return

        success = streamer.start()
        if not success:
            return

        # Ensure first frame is ready
        retries = 0
        while streamer.running and not streamer.get_frame() and retries < 20:
            time.sleep(0.05)
            retries += 1

        try:
            while streamer.running:
                frame_bytes = streamer.get_frame()
                if frame_bytes:
                    yield (b'--frame\r\n'
                           b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
                time.sleep(1.0 / 30.0)
        finally:
            streamer.release_viewer()


hardware_manager = HardwareManager()

from __future__ import annotations
# pylint: skip-file
"""
Cross-platform screen and window capture engine.
Uses mss with thread safety, auto-recovery, PIL.ImageGrab, and graceful standby display fallback.
Compatible with Windows, macOS, and Linux.
"""

# pylint: disable=broad-exception-caught,no-member

import threading
from typing import List, Dict, Any, Optional

try:
    import numpy as np
except Exception:
    np = None

try:
    import mss
except Exception:
    mss = None

try:
    import cv2
except Exception:
    cv2 = None

try:
    from PIL import ImageGrab
except Exception:
    ImageGrab = None



class ScreenCaptureEngine:
    """
    Engine for capturing the screen using mss, with PIL ImageGrab fallback.
    """
    def __init__(self):
        self._lock = threading.Lock()
        self._sct: Optional[Any] = None

    def _get_sct(self) -> Any:
        if mss is None:
            return None
        if self._sct is None:
            try:
                self._sct = mss.mss()
            except Exception:
                self._sct = None
        return self._sct


    def get_monitors(self) -> List[Dict[str, Any]]:
        """
        Retrieves a list of all active monitors and their geometries.
        """
        with self._lock:
            try:
                sct = self._get_sct()
                monitors = []
                for i, m in enumerate(sct.monitors):
                    if i == 0:
                        name = "All Monitors (Combined)"
                    else:
                        name = f"Monitor {i} ({m['width']}x{m['height']})"
                    monitors.append({
                        "id": i,
                        "name": name,
                        "left": m["left"],
                        "top": m["top"],
                        "width": m["width"],
                        "height": m["height"]
                    })
                return monitors
            except Exception as e:
                print(f"[ScreenCapture] Error getting monitors: {e}")
                return [
                    {"id": 1, "name": "Primary Display", "left": 0, "top": 0, "width": 1920, "height": 1080}
                ]

    def grab_frame(self, monitor_index: int = 1) -> np.ndarray:
        """
        Captures a frame with auto-recovery and fallback.
        Always returns a valid contiguous BGR numpy array.
        """
        with self._lock:
            # 1. Try mss capture
            try:
                sct = self._get_sct()
                if monitor_index >= len(sct.monitors):
                    monitor_index = 0
                
                monitor = sct.monitors[monitor_index]
                sct_img = sct.grab(monitor)
                frame = np.ascontiguousarray(sct_img, dtype=np.uint8)
                # BGRA -> BGR
                frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
                return np.ascontiguousarray(frame, dtype=np.uint8)
            except Exception as mss_err:  # noqa

                if self._sct:
                    try:
                        self._sct.close()
                    except Exception:
                        pass
                    self._sct = None

            # 2. Fallback to PIL ImageGrab (solid Windows GDI fallback)
            try:
                # PIL ImageGrab defaults to primary screen; refuse if a specific secondary is requested
                if monitor_index in (0, 1):
                    pil_img = ImageGrab.grab()
                    if pil_img is not None:
                        frame = np.array(pil_img)
                        # RGB -> BGR
                    frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    return np.ascontiguousarray(frame, dtype=np.uint8)
            except Exception:
                pass

            # 3. Graceful fallback for locked/headless/non-interactive desktop sessions
            w, h = 1920, 1080
            standby = np.zeros((h, w, 3), dtype=np.uint8)
            standby[:, :] = (24, 24, 28)
            cv2.putText(
                standby,
                f"SCREEN CAPTURE (MONITOR {monitor_index})",
                (80, 140),
                cv2.FONT_HERSHEY_SIMPLEX,
                1.3,
                (200, 200, 220),
                2,
                cv2.LINE_AA
            )
            cv2.putText(
                standby,
                "Ready for live capture on desktop",
                (80, 200),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.8,
                (120, 120, 140),
                1,
                cv2.LINE_AA
            )
            return np.ascontiguousarray(standby, dtype=np.uint8)

    def close(self):
        """
        Closes the active mss session to release desktop handles.
        """
        with self._lock:
            if self._sct is not None:
                try:
                    self._sct.close()
                except Exception:
                    pass
                self._sct = None


# Singleton instance
screen_capturer = ScreenCaptureEngine()

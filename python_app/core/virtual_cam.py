# pylint: skip-file
"""
Virtual Camera Output Sink using pyvirtualcam.
Allows OBS, vMix, Zoom, and Discord to capture the studio feed as a webcam.
"""

# pylint: disable=broad-exception-caught,import-outside-toplevel

import threading
from typing import Optional

from python_app.core.compositor import compositor


class VirtualCameraOutput:
    """
    Manages the virtual camera output stream.
    """
    def __init__(self, width: int = 1920, height: int = 1080, fps: int = 30):
        self.width = width
        self.height = height
        self.fps = fps
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self.is_active = False

    def start(self) -> bool:
        """Starts the virtual camera feed."""
        if self._running:
            return True

        try:
            import pyvirtualcam
            # Test opening virtual cam
            with pyvirtualcam.Camera(width=self.width, height=self.height, fps=self.fps) as cam:
                print(f"[VirtualCam] Successfully found device: {cam.device}")
        except Exception as e:
            print(f"[VirtualCam] Virtual camera device not available: {e}")
            return False

        self._running = True
        self._thread = threading.Thread(target=self._cam_loop, daemon=True)
        self._thread.start()
        self.is_active = True
        return True

    def _cam_loop(self):
        try:
            import pyvirtualcam
            with pyvirtualcam.Camera(
                width=self.width, height=self.height, fps=self.fps, fmt=pyvirtualcam.PixelFormat.BGR
            ) as cam:
                while self._running:
                    frame = compositor.render_frame()
                    cam.send(frame)
                    cam.sleep_until_next_frame()
        except Exception as e:
            print(f"[VirtualCam] Stream loop error: {e}")
        finally:
            self.is_active = False

    def stop(self):
        """Stops the virtual camera feed and joins the worker thread."""
        self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.0)
        self.is_active = False


virtual_cam = VirtualCameraOutput()

from __future__ import annotations
# pylint: skip-file
"""
Real-time Video Compositor Engine.
Uses a single master rendering loop at 30 FPS with thread-safe cached frame buffers.
Features real-time 1.0x video playback clock with auto-start, seek, loop, and speed controls.
"""


try:
    import cv2
except Exception:
    cv2 = None

try:
    import numpy as np
except Exception:
    np = None

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:
    Image = None
    ImageDraw = None
    ImageFont = None

import time
import os
import threading
from typing import Dict, Optional, Tuple, Any
from python_app.core.state_manager import studio_state, LayerState
from python_app.core.screen_capture import screen_capturer



class MediaSource:
    """Wrapper for dynamic camera and video file captures with timestamp-based 1.0x playback"""
    def __init__(self, src_type: str, source_path_or_index: Any):
        self.src_type = src_type
        self.source = source_path_or_index
        self.cap: Optional[cv2.VideoCapture] = None
        self.image: Optional[np.ndarray] = None
        
        # Video playback clock attributes
        self.fps: float = 30.0
        self.total_frames: int = 1
        self.duration: float = 1.0
        self.start_wall_time: float = time.time()
        self._last_decoded_frame: Optional[np.ndarray] = None
        self._last_frame_idx: int = -1
        self._is_playing: bool = True
        
        self._init_source()

    def _init_source(self):
        if self.src_type == 'video':
            try:
                self.cap = cv2.VideoCapture(str(self.source))
                if self.cap.isOpened():
                    fps = self.cap.get(cv2.CAP_PROP_FPS)
                    self.fps = float(fps) if fps and fps > 0 and not np.isnan(fps) else 30.0
                    frames = self.cap.get(cv2.CAP_PROP_FRAME_COUNT)
                    self.total_frames = max(1, int(frames)) if frames and frames > 0 else 1
                    self.duration = max(0.1, self.total_frames / self.fps)
                    self.start_wall_time = time.time()
                    self._is_playing = True
                    
                    # Pre-decode first frame
                    ret, frame = self.cap.read()
                    if ret and frame is not None:
                        self._last_decoded_frame = np.ascontiguousarray(frame, dtype=np.uint8)
                        self._last_frame_idx = 0
            except Exception as e:
                print(f"[MediaSource] Failed to open video ({self.source}): {e}")
        elif self.src_type == 'camera':
            try:
                src = int(self.source) if str(self.source).isdigit() else self.source
                self.cap = cv2.VideoCapture(src)
            except Exception as e:
                print(f"[MediaSource] Failed to open camera ({self.source}): {e}")
        elif self.src_type == 'image' and os.path.exists(str(self.source)):
            try:
                img = cv2.imread(str(self.source), cv2.IMREAD_UNCHANGED)
                if img is not None:
                    self.image = np.ascontiguousarray(img, dtype=np.uint8)
            except Exception as e:
                print(f"[MediaSource] Error loading image {self.source}: {e}")

    def read_frame(self, layer: Optional[LayerState] = None) -> Optional[np.ndarray]:
        if self.src_type == 'image':
            return self.image
        elif self.src_type == 'screen':
            monitor_idx = int(self.source) if str(self.source).isdigit() else 1
            return screen_capturer.grab_frame(monitor_idx)
        elif self.src_type == 'camera' and self.cap and self.cap.isOpened():
            ret, frame = self.cap.read()
            return np.ascontiguousarray(frame, dtype=np.uint8) if ret else None
        elif self.src_type == 'video' and self.cap and self.cap.isOpened():
            # Real-time 1.0x playback synchronization
            playing = layer.extra.get('playing', True) if layer else True
            speed = float(layer.extra.get('speed', 1.0)) if layer else 1.0
            loop = layer.extra.get('loop', True) if layer else True
            
            # If paused, keep yielding last decoded frame
            if not playing:
                return self._last_decoded_frame

            # Calculate target frame index based on real-world elapsed wall time
            elapsed = (time.time() - self.start_wall_time) * speed
            if loop:
                elapsed = elapsed % self.duration
            elif elapsed >= self.duration:
                return self._last_decoded_frame

            target_frame = int(elapsed * self.fps) % self.total_frames

            # Decode only when frame index changes
            if target_frame != self._last_frame_idx:
                if target_frame == self._last_frame_idx + 1:
                    ret, frame = self.cap.read()
                else:
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
                    ret, frame = self.cap.read()

                if ret and frame is not None:
                    self._last_decoded_frame = np.ascontiguousarray(frame, dtype=np.uint8)
                    self._last_frame_idx = target_frame
                elif loop and not ret:
                    # Reset on EOF
                    self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    self.start_wall_time = time.time()
                    ret, frame = self.cap.read()
                    if ret and frame is not None:
                        self._last_decoded_frame = np.ascontiguousarray(frame, dtype=np.uint8)
                        self._last_frame_idx = 0

            return self._last_decoded_frame

        return None

    def restart(self):
        self.start_wall_time = time.time()
        self._last_frame_idx = -1
        if self.cap and self.cap.isOpened():
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    def release(self):
        if self.cap:
            try:
                self.cap.release()
            except Exception:
                pass
            self.cap = None


class VideoCompositor:
    def __init__(self, width: int = 1920, height: int = 1080, fps: int = 30):
        self.width = width
        self.height = height
        self.fps = fps
        self.sources: Dict[str, MediaSource] = {}
        self._lock = threading.Lock()
        self._current_frame: np.ndarray = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        self._current_frame[:, :] = (15, 15, 20)
        self._current_jpeg: bytes = b""
        self._running = True
        self._render_thread = threading.Thread(target=self._render_loop, daemon=True)
        self._render_thread.start()

    def get_or_create_source(self, layer: LayerState) -> Optional[MediaSource]:
        expected_src = layer.src if layer.type != 'screen' else layer.extra.get('monitor_index', 1)
        
        if layer.id in self.sources:
            current_src = self.sources[layer.id]
            if current_src.source == expected_src and current_src.src_type == layer.type:
                return current_src
            else:
                current_src.release()
                del self.sources[layer.id]

        if layer.type == 'camera':
            dev_id = layer.extra.get('device_id', 0)
            src = MediaSource('camera', dev_id)
        elif layer.type == 'video':
            src = MediaSource('video', layer.src)
        elif layer.type == 'screen':
            monitor_idx = layer.extra.get('monitor_index', 1)
            src = MediaSource('screen', monitor_idx)
        elif layer.type == 'image':
            src = MediaSource('image', layer.src)
        else:
            return None

        self.sources[layer.id] = src
        return src

    def render_text_layer(self, layer: LayerState, canvas: np.ndarray) -> np.ndarray:
        text = layer.content or "LIVE BROADCAST"
        font_size = max(12, int(layer.extra.get("font_size", 48) * layer.scale))

        pil_img = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(pil_img, "RGBA")

        try:
            font = ImageFont.truetype("arial.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

        x = int(layer.x)
        y = int(layer.y)
        padding = 16

        draw.rounded_rectangle(
            [x - padding, y - padding, x + text_w + padding, y + text_h + padding],
            radius=8,
            fill=(15, 15, 20, int(200 * layer.opacity))
        )
        draw.text((x, y), text, font=font, fill=(255, 255, 255, int(255 * layer.opacity)))

        bgr_res = cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR)
        return np.ascontiguousarray(bgr_res, dtype=np.uint8)

    def blend_layer_into_canvas(self, frame: np.ndarray, layer: LayerState, canvas: np.ndarray):
        if frame is None or frame.size == 0:
            return

        target_w = int(layer.width * layer.scale)
        target_h = int(layer.height * layer.scale)
        if target_w <= 0 or target_h <= 0:
            return

        resized = cv2.resize(frame, (target_w, target_h), interpolation=cv2.INTER_LINEAR)

        x_start = int(layer.x)
        y_start = int(layer.y)
        x_end = x_start + target_w
        y_end = y_start + target_h

        canvas_h, canvas_w = canvas.shape[:2]
        if x_end <= 0 or y_end <= 0 or x_start >= canvas_w or y_start >= canvas_h:
            return

        src_x1 = max(0, -x_start)
        src_y1 = max(0, -y_start)
        src_x2 = target_w - max(0, x_end - canvas_w)
        src_y2 = target_h - max(0, y_end - canvas_h)

        dst_x1 = max(0, x_start)
        dst_y1 = max(0, y_start)
        dst_x2 = min(canvas_w, x_end)
        dst_y2 = min(canvas_h, y_end)

        cropped_src = resized[src_y1:src_y2, src_x1:src_x2]
        roi = canvas[dst_y1:dst_y2, dst_x1:dst_x2]
        opacity = np.clip(layer.opacity, 0.0, 1.0)

        if cropped_src.shape[2] == 4:
            alpha = (cropped_src[:, :, 3] / 255.0) * opacity
            alpha = np.repeat(alpha[:, :, np.newaxis], 3, axis=2)
            src_rgb = cropped_src[:, :, :3]
            canvas[dst_y1:dst_y2, dst_x1:dst_x2] = (src_rgb * alpha + roi * (1.0 - alpha)).astype(np.uint8)
        else:
            if opacity >= 0.99:
                canvas[dst_y1:dst_y2, dst_x1:dst_x2] = cropped_src
            else:
                canvas[dst_y1:dst_y2, dst_x1:dst_x2] = cv2.addWeighted(cropped_src, opacity, roi, 1.0 - opacity, 0)

    def _render_loop(self):
        """Dedicated master rendering loop running at target FPS"""
        interval = 1.0 / self.fps
        while self._running:
            t0 = time.time()
            try:
                canvas = np.zeros((self.height, self.width, 3), dtype=np.uint8)
                canvas[:, :] = (15, 15, 20)

                sorted_layers = studio_state.get_sorted_layers()
                
                # Cleanup deleted layers to prevent camera handle memory leaks
                active_ids = {layer.id for layer in sorted_layers}
                deleted_ids = [lid for lid in self.sources if lid not in active_ids]
                for lid in deleted_ids:
                    self.sources[lid].release()
                    del self.sources[lid]

                for layer in sorted_layers:
                    if not layer.visible:
                        continue

                    if layer.type == 'text':
                        canvas = self.render_text_layer(layer, canvas)
                    else:
                        src = self.get_or_create_source(layer)
                        if src:
                            frame = src.read_frame(layer)
                            if frame is not None:
                                self.blend_layer_into_canvas(frame, layer, canvas)

                contiguous_canvas = np.ascontiguousarray(canvas, dtype=np.uint8)
                ret, jpeg = cv2.imencode('.jpg', contiguous_canvas, [cv2.IMWRITE_JPEG_QUALITY, 75])
                jpeg_bytes = jpeg.tobytes() if ret else b""

                with self._lock:
                    self._current_frame = contiguous_canvas
                    self._current_jpeg = jpeg_bytes

            except Exception as e:
                print(f"[VideoCompositor] Render loop error: {e}")

            elapsed = time.time() - t0
            sleep_time = max(0.001, interval - elapsed)
            time.sleep(sleep_time)

    def restart_layer_playback(self, layer_id: str):
        if layer_id in self.sources:
            self.sources[layer_id].restart()

    def render_frame(self) -> np.ndarray:
        with self._lock:
            return self._current_frame.copy()

    def get_jpeg_frame(self, quality: int = 75) -> bytes:
        with self._lock:
            if self._current_jpeg:
                return self._current_jpeg
            ret, jpeg = cv2.imencode('.jpg', self._current_frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
            return jpeg.tobytes() if ret else b""

    def cleanup(self):
        self._running = False
        for src in list(self.sources.values()):
            src.release()
        self.sources.clear()
        screen_capturer.close()


# Singleton compositor instance
compositor = VideoCompositor()

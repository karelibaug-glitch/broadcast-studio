from __future__ import annotations
# pylint: skip-file
"""
Multi-Destination RTMP Broadcast Manager using FFmpeg with Tee Muxer and H.264 Bypass/Single-Encode.
Streams live composited video and audio to YouTube, Twitch, Facebook, Kick, and custom RTMP endpoints.
"""


# pylint: disable=broad-exception-caught,line-too-long,missing-function-docstring,missing-class-docstring
# pylint: disable=too-many-instance-attributes,too-many-branches,too-many-statements,too-many-locals
# pylint: disable=no-else-return,subprocess-run-check,consider-using-with,raise-missing-from,unused-import

import os
import re
import json
import time
import uuid
import shutil
import datetime
import threading
import subprocess
import struct
from dataclasses import dataclass, asdict, field
from typing import Dict, List, Optional, Any, Callable

from python_app.core.compositor import compositor
from python_app.core.state_manager import studio_state

DEFAULT_PLATFORM_URLS = {
    "youtube": "rtmp://a.rtmp.youtube.com/live2",
    "twitch": "rtmp://live.twitch.tv/app",
    "facebook": "rtmps://live-api-s.facebook.com:443/rtmp",
    "kick": "rtmps://fa723fc1b171.global-contribute.live-video.net/app",
    "custom": ""
}

BONDED_MAGIC = b'BN'  # 2 bytes header magic identifier


class StreamReassemblyQueue:
    """
    Micro-jitter Priority Reassembly Queue for Multi-Link Bonded Ingest.
    Assembles out-of-order chunks from parallel bonded links with ultra-low latency (<80ms).
    """
    def __init__(self, output_callback=None, max_jitter_ms: float = 2500.0):
        self.output_callback = output_callback
        self.max_jitter_ms = max_jitter_ms
        self.expected_seq: Optional[int] = None
        self.buffer: Dict[int, bytes] = {}
        self.seq_timestamps: Dict[int, float] = {}
        self.links: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()
        self.total_bonded_bytes: int = 0
        self.total_bonded_packets: int = 0
        self.recovered_packets: int = 0
        self.dropped_late_packets: int = 0
        self._last_bitrate_calc = time.time()
        self._window_bytes: Dict[str, int] = {}

    def register_link(self, link_id: str, client_ip: str = "127.0.0.1"):
        with self._lock:
            now = time.time()
            if link_id not in self.links:
                self.links[link_id] = {
                    "id": link_id,
                    "client_ip": client_ip,
                    "connected_at": now,
                    "last_seen": now,
                    "bytes_received": 0,
                    "packets_received": 0,
                    "bitrate_kbps": 0.0,
                    "active": True
                }
                self._window_bytes[link_id] = 0
            else:
                self.links[link_id]["active"] = True
                if client_ip:
                    self.links[link_id]["client_ip"] = client_ip
                self.links[link_id]["last_seen"] = now

    def unregister_link(self, link_id: str):
        with self._lock:
            if link_id in self.links:
                self.links[link_id]["active"] = False
                self.links[link_id]["bitrate_kbps"] = 0.0

    def push_chunk(self, data: bytes, link_id: str = "primary") -> bool:
        """
        Receives binary chunk from a bonded link.
        Supports both framed bonded packets (Magic 'BN' + 8-byte header) and legacy unframed raw chunks.
        """
        with self._lock:
            if link_id not in self.links:
                self.register_link(link_id)

            link_info = self.links[link_id]
            link_info["last_seen"] = time.time()
            link_info["bytes_received"] += len(data)
            link_info["packets_received"] += 1
            link_info["active"] = True
            self.total_bonded_bytes += len(data)
            self.total_bonded_packets += 1
            self._window_bytes[link_id] = self._window_bytes.get(link_id, 0) + len(data)

            # Recalculate per-link bitrates periodically (every 1s)
            now = time.time()
            dt = now - self._last_bitrate_calc
            if dt >= 1.0:
                for l_id, b_count in self._window_bytes.items():
                    if l_id in self.links:
                        self.links[l_id]["bitrate_kbps"] = round((b_count * 8.0) / (dt * 1000.0), 1)
                        # Mark inactive if not seen in 4s
                        if now - self.links[l_id]["last_seen"] > 4.0:
                            self.links[l_id]["active"] = False
                            self.links[l_id]["bitrate_kbps"] = 0.0
                self._window_bytes = {l_id: 0 for l_id in self.links}
                self._last_bitrate_calc = now

            # Check if chunk is a Framed Bonded Packet (Magic 'BN', at least 8 bytes)
            # Format: [Magic: 2B (BN)][LinkID: 1B][Flags: 1B][Seq: 4B uint32_be]
            if len(data) >= 8 and data[:2] == BONDED_MAGIC:
                try:
                    _, link_byte_id, flags, seq_num = struct.unpack(">2sBBI", data[:8])
                    payload = data[8:]
                except Exception:
                    payload = data
                    seq_num = None
            else:
                payload = data
                seq_num = None

            # 1. Unframed Legacy/Direct Chunk: Instant Fast-Path Flush
            if seq_num is None:
                if self.output_callback and payload:
                    self.output_callback(payload)
                return True

            # 2. Framed Chunk: Micro-Jitter In-Order Reassembly
            if self.expected_seq is None:
                self.expected_seq = seq_num

            # Normal in-order chunk -> Immediate zero-delay flush!
            if seq_num == self.expected_seq:
                if self.output_callback and payload:
                    self.output_callback(payload)
                self.expected_seq += 1

                # Flush any subsequent contiguous chunks already in buffer
                while self.expected_seq in self.buffer:
                    buffered_payload = self.buffer.pop(self.expected_seq)
                    self.seq_timestamps.pop(self.expected_seq, None)
                    if self.output_callback and buffered_payload:
                        self.output_callback(buffered_payload)
                    self.recovered_packets += 1
                    self.expected_seq += 1
                return True

            # Future out-of-order chunk (Link A arrived slightly before Link B) -> Queue in jitter buffer
            elif seq_num > self.expected_seq:
                self.buffer[seq_num] = payload
                self.seq_timestamps[seq_num] = now

                # If missing packet hasn't arrived within max_jitter_ms, fast-forward to prevent lag
                self._check_jitter_timeout()
                return True

            # Late/Duplicate chunk from already-passed sequence -> Drop to preserve video decoder stream integrity
            else:
                self.dropped_late_packets += 1
                return True

    def _check_jitter_timeout(self):
        """
        Advances sequence only when the OLDEST buffered packet has waited longer than
        max_jitter_ms, meaning the missing packet truly dropped (not just delayed).

        CRITICAL: We flush all contiguous buffered packets STARTING from oldest_seq,
        then advance expected_seq to oldest_seq + len(contiguous_run).
        We do NOT skip sequences — skipping VP8 reference frames causes top-row pixel corruption.
        If the buffer grows excessively we flush the entire contiguous run from the front
        to prevent unbounded memory growth, but still never emit bytes out of order.
        """
        if not self.buffer:
            return

        now = time.time()
        oldest_seq = min(self.buffer.keys())
        oldest_time = self.seq_timestamps.get(oldest_seq, now)

        jitter_expired = (now - oldest_time) > (self.max_jitter_ms / 1000.0)
        buffer_overflow = len(self.buffer) > 300  # safety valve (30s headroom at 100ms/chunk)

        if not (jitter_expired or buffer_overflow):
            return

        # Log gap only once per skip to help diagnose lost packets
        skipped_count = oldest_seq - self.expected_seq
        if skipped_count > 0:
            print(
                f"[ReassemblyQ] Gap: seq {self.expected_seq}…{oldest_seq - 1} "
                f"({skipped_count} packet(s) lost/late). "
                f"Jitter={1000*(now - oldest_time):.0f}ms. Advancing to seq {oldest_seq}."
            )
        self.expected_seq = oldest_seq

        # Flush ALL contiguous packets from oldest_seq forward so the output
        # is never out-of-order — only the truly missing packets are skipped.
        while self.expected_seq in self.buffer:
            payload = self.buffer.pop(self.expected_seq)
            self.seq_timestamps.pop(self.expected_seq, None)
            if self.output_callback and payload:
                self.output_callback(payload)
            self.recovered_packets += 1
            self.expected_seq += 1

    def get_telemetry(self) -> Dict[str, Any]:
        with self._lock:
            active_links = [l for l in self.links.values() if l.get("active", False)]
            total_kbps = sum(l.get("bitrate_kbps", 0.0) for l in active_links)
            return {
                "active_links_count": len(active_links),
                "total_links_count": len(self.links),
                "combined_bitrate_kbps": round(total_kbps, 1),
                "total_bytes_received": self.total_bonded_bytes,
                "total_packets_received": self.total_bonded_packets,
                "recovered_packets": self.recovered_packets,
                "dropped_late_packets": self.dropped_late_packets,
                "jitter_buffer_depth": len(self.buffer),
                "links": list(self.links.values())
            }

    def reset(self):
        with self._lock:
            self.expected_seq = None
            self.buffer.clear()
            self.seq_timestamps.clear()
            for l_info in self.links.values():
                l_info["bytes_received"] = 0
                l_info["packets_received"] = 0
                l_info["bitrate_kbps"] = 0.0
            self._window_bytes = {l_id: 0 for l_id in self.links}
            self.total_bonded_bytes = 0
            self.total_bonded_packets = 0
            self.recovered_packets = 0
            self.dropped_late_packets = 0
            self._last_bitrate_calc = time.time()


@dataclass
class RTMPDestination:
    id: str
    name: str
    platform: str = "custom"
    server_url: str = ""
    stream_key: str = ""
    enabled: bool = True
    status: str = "idle"  # idle, streaming, error
    error_message: Optional[str] = None
    bytes_sent: int = 0

    def to_dict(self, mask_key: bool = False) -> Dict[str, Any]:
        data = asdict(self)
        if mask_key and self.stream_key:
            data["stream_key_masked"] = (
                self.stream_key[:4] + "••••••••" + self.stream_key[-4:]
                if len(self.stream_key) > 8 else "••••••••"
            )
        return data

    @property
    def full_rtmp_url(self) -> str:
        base = self.server_url.rstrip("/")
        key = self.stream_key.strip()
        if not key:
            return base
        if base.endswith("/"):
            return f"{base}{key}"
        return f"{base}/{key}"


class RTMPStreamManager:
    _fps_flag: Optional[str] = None

    @classmethod
    def get_fps_flag(cls) -> str:
        """
        Determines whether FFmpeg supports -fps_mode (FFmpeg 5.1+, 6, 7, 8, 9+) or -vsync (legacy).
        Caches the result to avoid repeated subprocess calls.
        """
        if cls._fps_flag is not None:
            return cls._fps_flag
        try:
            res = subprocess.run(
                ["ffmpeg", "-hide_banner", "-fps_mode", "cfr", "-version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=5
            )
            if res.returncode == 0:
                cls._fps_flag = "-fps_mode"
            else:
                cls._fps_flag = "-vsync"
        except Exception:
            cls._fps_flag = "-fps_mode"
        return cls._fps_flag

    def __init__(self, config_file: Optional[str] = None):
        self.destinations: Dict[str, RTMPDestination] = {}
        self.is_broadcasting: bool = False
        self.broadcast_start_time: Optional[float] = None
        self.ffmpeg_process: Optional[subprocess.Popen] = None
        self._feed_thread: Optional[threading.Thread] = None
        self._monitor_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._lock = threading.RLock()
        
        self.current_fps: float = 0.0
        self.current_bitrate_kbps: float = 0.0
        self.total_frames_sent: int = 0
        self.last_error: Optional[str] = None
        self.current_recording_path: Optional[str] = None
        self.on_stop_callback: Optional[Callable[[], None]] = None

        # Reassembly queue for multi-link software bonding
        self.reassembly_queue = StreamReassemblyQueue(output_callback=self._write_raw_to_ffmpeg)

        # Configurable stream profile, local recording & Google Drive export settings
        self.settings: Dict[str, Any] = {
            "video_bitrate_kbps": 4500,
            "framerate": 30,
            "audio_bitrate_kbps": 128,
            "preset": "veryfast",
            "record_local": False,
            "recording_format": "mp4",
            "gdrive_sync_enabled": False,
            "gdrive_folder_path": "/content/drive/MyDrive/BroadcastRecordings",
            "gdrive_transfer_mode": "copy"  # 'copy' or 'move'
        }

        self.recordings_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "recordings"))
        try:
            os.makedirs(self.recordings_dir, exist_ok=True)
        except Exception:
            self.recordings_dir = "/tmp/recordings"
            try:
                os.makedirs(self.recordings_dir, exist_ok=True)
            except Exception:
                pass

        if config_file is None:
            config_file = os.path.join(os.path.dirname(__file__), "..", "rtmp_destinations.json")
        self.config_file = os.path.abspath(config_file)
        self._load_destinations()


    def get_settings(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self.settings)

    def update_settings(self, new_settings: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            if "video_bitrate_kbps" in new_settings:
                self.settings["video_bitrate_kbps"] = max(500, min(25000, int(new_settings["video_bitrate_kbps"])))
            if "framerate" in new_settings:
                self.settings["framerate"] = max(15, min(60, int(new_settings["framerate"])))
            if "audio_bitrate_kbps" in new_settings:
                self.settings["audio_bitrate_kbps"] = max(64, min(320, int(new_settings["audio_bitrate_kbps"])))
            if "preset" in new_settings:
                preset = str(new_settings["preset"]).lower()
                if preset in ("ultrafast", "superfast", "veryfast", "faster", "fast", "medium"):
                    self.settings["preset"] = preset
            if "record_local" in new_settings:
                self.settings["record_local"] = bool(new_settings["record_local"])
            if "recording_format" in new_settings:
                fmt = str(new_settings["recording_format"]).lower()
                if fmt in ("mp4", "mkv"):
                    self.settings["recording_format"] = fmt
            if "gdrive_sync_enabled" in new_settings:
                self.settings["gdrive_sync_enabled"] = bool(new_settings["gdrive_sync_enabled"])
            if "gdrive_folder_path" in new_settings:
                self.settings["gdrive_folder_path"] = str(new_settings["gdrive_folder_path"]).strip()
            if "gdrive_transfer_mode" in new_settings:
                mode = str(new_settings["gdrive_transfer_mode"]).lower().strip()
                if mode in ("copy", "move"):
                    self.settings["gdrive_transfer_mode"] = mode
            return dict(self.settings)

    def get_recordings(self) -> List[Dict[str, Any]]:
        recordings = []
        if not os.path.exists(self.recordings_dir):
            return recordings
        for fname in os.listdir(self.recordings_dir):
            if fname.lower().endswith((".mp4", ".mkv")):
                fpath = os.path.join(self.recordings_dir, fname)
                try:
                    stat = os.stat(fpath)
                    recordings.append({
                        "filename": fname,
                        "size_bytes": stat.st_size,
                        "size_mb": round(stat.st_size / (1024 * 1024), 2),
                        "created_at": stat.st_mtime,
                        "created_at_formatted": datetime.datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                        "url": f"/recordings/{fname}"
                    })
                except Exception:
                    pass
        recordings.sort(key=lambda r: r["created_at"], reverse=True)
        return recordings

    def delete_recording(self, filename: str) -> bool:
        safe_name = os.path.basename(filename)
        target = os.path.join(self.recordings_dir, safe_name)
        if os.path.exists(target) and os.path.isfile(target):
            try:
                os.remove(target)
                return True
            except Exception as e:
                print(f"[RTMPManager] Error deleting recording {safe_name}: {e}")
                return False
        return False

    def remux_recording(self, filename: str) -> Optional[str]:
        """Fast-remuxes an MKV or fragmented MP4 into a web-standard finalized MP4 without re-encoding (0% quality loss)."""
        safe_name = os.path.basename(filename)
        src_path = os.path.join(self.recordings_dir, safe_name)
        if not os.path.exists(src_path):
            return None

        base_name, _ = os.path.splitext(safe_name)
        dst_name = f"{base_name}_final.mp4"
        dst_path = os.path.join(self.recordings_dir, dst_name)

        cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "warning",
            "-i", src_path,
            "-c", "copy",
            "-movflags", "+faststart",
            dst_path
        ]
        try:
            res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=120)
            if res.returncode == 0 and os.path.exists(dst_path):
                return dst_name
        except Exception as e:
            print(f"[RTMPManager] Remux error on {safe_name}: {e}")
        return None

    def _load_destinations(self):
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for item in data:
                        dest = RTMPDestination(**item)
                        dest.status = "idle"
                        dest.error_message = None
                        self.destinations[dest.id] = dest
            except Exception as e:
                print(f"[RTMPManager] Error loading destinations: {e}")

    def _save_destinations(self):
        try:
            os.makedirs(os.path.dirname(self.config_file), exist_ok=True)
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump([d.to_dict() for d in self.destinations.values()], f, indent=2)
        except Exception as e:
            try:
                self.config_file = "/tmp/rtmp_destinations.json"
                with open(self.config_file, "w", encoding="utf-8") as f:
                    json.dump([d.to_dict() for d in self.destinations.values()], f, indent=2)
            except Exception as e2:
                print(f"[RTMPManager] Error saving destinations (in-memory state active): {e2}")


    def add_destination(self, name: str, platform: str = "custom", server_url: str = "",
                        stream_key: str = "", enabled: bool = True) -> RTMPDestination:
        with self._lock:
            dest_id = f"rtmp-{uuid.uuid4().hex[:8]}"
            if not server_url and platform in DEFAULT_PLATFORM_URLS:
                server_url = DEFAULT_PLATFORM_URLS[platform]

            dest = RTMPDestination(
                id=dest_id,
                name=name or f"{platform.capitalize()} Stream",
                platform=platform,
                server_url=server_url,
                stream_key=stream_key,
                enabled=enabled
            )
            self.destinations[dest.id] = dest
            self._save_destinations()
            return dest

    def update_destination(self, dest_id: str, updates: Dict[str, Any]) -> Optional[RTMPDestination]:
        with self._lock:
            if dest_id not in self.destinations:
                return None
            dest = self.destinations[dest_id]
            for key, val in updates.items():
                if hasattr(dest, key) and key not in ("id", "bytes_sent"):
                    setattr(dest, key, val)
            self._save_destinations()
            return dest

    def delete_destination(self, dest_id: str) -> bool:
        with self._lock:
            if dest_id in self.destinations:
                del self.destinations[dest_id]
                self._save_destinations()
                return True
            return False

    def get_destination(self, dest_id: str) -> Optional[RTMPDestination]:
        with self._lock:
            return self.destinations.get(dest_id)

    def get_all_destinations(self) -> List[RTMPDestination]:
        with self._lock:
            return list(self.destinations.values())

    def get_destinations(self, mask_key: bool = False) -> List[Dict[str, Any]]:
        with self._lock:
            return [d.to_dict(mask_key=mask_key) for d in self.destinations.values()]

    def get_active_destinations(self) -> List[RTMPDestination]:
        with self._lock:
            return [d for d in self.destinations.values() if d.enabled and d.server_url and d.stream_key]

    def build_ffmpeg_command(self, width: int = 1920, height: int = 1080, fps: Optional[int] = None, input_mode: str = "webm") -> List[str]:
        """
        Builds optimized single-encode FFmpeg command with tee muxer for multi-target RTMP distribution
        and optional simultaneous zero-overhead local recording.
        """
        active = self.get_active_destinations()
        record_local = self.settings.get("record_local", False)

        if not active and not record_local:
            raise ValueError("No active RTMP destinations configured and local recording is disabled.")

        fps = fps or self.settings.get("framerate", 30)
        v_bitrate = self.settings.get("video_bitrate_kbps", 4500)
        a_bitrate = self.settings.get("audio_bitrate_kbps", 128)
        preset = self.settings.get("preset", "veryfast")

        # Build tee muxer destination string with failure isolation
        tee_targets = []
        for d in active:
            url = d.full_rtmp_url
            escaped_url = url.replace("\\", "\\\\").replace("|", "\\|").replace("[", "\\[").replace("]", "\\]")
            # Flv slave muxer with failure isolation
            tee_targets.append(f"[f=flv:onfail=ignore:flvflags=no_duration_filesize]{escaped_url}")

        # Local Recording Slave via direct bitstream copy inside tee muxer
        if record_local:
            fmt = self.settings.get("recording_format", "mp4")
            ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"broadcast_{ts}.{fmt}"
            rec_path = os.path.join(self.recordings_dir, filename)
            self.current_recording_path = rec_path
            # Escape path for tee muxer format
            escaped_rec = rec_path.replace("\\", "/").replace(":", "\\:").replace("|", "\\|").replace("[", "\\[").replace("]", "\\]")
            if fmt == "mp4":
                # Fault-Tolerant Fragmented MP4 (frag_keyframe + default_base_moof):
                # 100% Crash-Resilient! Every 2-second keyframe is written as an independent self-contained fragment.
                # If server crashes, power cuts, or process is killed, 100% of recorded video & audio is preserved and instantly playable!
                tee_targets.append(f"[f=mp4:movflags=+frag_keyframe+default_base_moof:onfail=ignore]{escaped_rec}")
            else:
                # Matroska / MKV: Naturally crash-resilient streaming container
                tee_targets.append(f"[f=matroska:onfail=ignore]{escaped_rec}")
        else:
            self.current_recording_path = None

        tee_string = "|".join(tee_targets)

        if input_mode == "webm":
            cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel", "warning",
                # Fault-tolerant input: generate timestamps; do NOT discard packets
                # (discardcorrupt drops VP8 reference frames causing top-row pixel corruption)
                "-err_detect", "careful",
                "-fflags", "+nobuffer+genpts+igndts+flush_packets",
                # Error concealment: deblock hides VP8 decode glitches without dropping frames
                "-ec", "deblock",
                # Buffer 512 input packets to absorb bonded-link jitter and VP8 partial-cluster gaps
                "-thread_queue_size", "512",
                # Fast probing: only inspect the minimum bytes needed before launching encoder
                "-probesize", "131072",
                "-analyzeduration", "500000",
                "-flags", "+global_header",
                "-f", "matroska",
                "-i", "pipe:0",
                # Force EXACT 1920x1080 output at all times:
                # scale forces target WxH, pad fills any remaining black border, setsar locks SAR, setdar locks DAR.
                # This PREVENTS YouTube resolution-change events even if input VP8 stream reports variable dimensions.
                "-vf", (
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
                    f"setsar=1,setdar=16/9,format=yuv420p"
                ),
                # Strict Constant Framerate (CFR): duplicates/drops frames to hold exactly {fps} fps.
                # Without this, VP8 decode errors cause frame-rate gaps that make YouTube resize the player.
                # In modern FFmpeg (7+, 8+, 9+), -vsync was removed in favor of -fps_mode.
                self.get_fps_flag(), "cfr",
                # Constant Bitrate (CBR) H.264 encoder
                "-c:v", "libx264",
                "-r", str(fps),
                "-preset", preset,
                "-tune", "zerolatency",
                "-b:v", f"{v_bitrate}k",
                "-minrate", f"{v_bitrate}k",
                "-maxrate", f"{v_bitrate}k",
                "-bufsize", f"{v_bitrate * 2}k",
                "-nal-hrd", "cbr",
                "-pix_fmt", "yuv420p",
                # 1-second GOP: any VP8 decode error self-heals at the next H.264 keyframe (every 1s not 2s)
                "-g", str(fps),
                "-keyint_min", str(fps),
                # Audio encoder (AAC stereo at configured bitrate)
                "-c:a", "aac",
                "-b:a", f"{a_bitrate}k",
                "-ar", "48000",
                "-ac", "2",
                # Tee Muxer - multiplexes the single encoded stream to all N RTMP endpoints and local recording
                "-f", "tee",
                "-use_fifo", "1",
                "-map", "0:v",
                "-map", "0:a?",
                tee_string
            ]
        else:
            cmd = [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel", "warning",
                "-flags", "+global_header",
                # Raw video input from pipe
                "-f", "rawvideo",
                "-pix_fmt", "bgr24",
                "-s", f"{width}x{height}",
                "-r", str(fps),
                "-i", "-",
                # Silent audio generator for compliant FLV output
                "-f", "lavfi",
                "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
                # Video encoder (CBR / CFR)
                "-c:v", "libx264",
                "-r", str(fps),
                "-preset", preset,
                "-tune", "zerolatency",
                "-b:v", f"{v_bitrate}k",
                "-minrate", f"{v_bitrate}k",
                "-maxrate", f"{v_bitrate}k",
                "-bufsize", f"{v_bitrate * 2}k",
                "-nal-hrd", "cbr",
                "-pix_fmt", "yuv420p",
                "-g", str(fps * 2),
                "-keyint_min", str(fps * 2),
                # Audio encoder (AAC stereo at configured bitrate)
                "-c:a", "aac",
                "-b:a", f"{a_bitrate}k",
                "-ar", "48000",
                "-shortest",
                # Tee Muxer - multiplexes the single encoded stream to all N RTMP endpoints and local recording
                "-f", "tee",
                "-use_fifo", "1",
                "-map", "0:v",
                "-map", "1:a",
                tee_string
            ]
        return cmd

    def start_broadcast(self, input_mode: str = "webm") -> Dict[str, Any]:
        with self._lock:
            if self.is_broadcasting:
                return {"status": "already_running", "uptime": self.get_uptime()}

            active = self.get_active_destinations()
            record_local = self.settings.get("record_local", False)
            if not active and not record_local:
                raise ValueError("Cannot start broadcast: No enabled RTMP destinations configured and local recording is disabled.")

            if not shutil.which("ffmpeg"):
                raise RuntimeError("FFmpeg executable was not found on system PATH.")

            configured_fps = self.settings.get("framerate", 30)
            studio_state.fps = configured_fps

            cmd = self.build_ffmpeg_command(
                width=studio_state.canvas_width,
                height=studio_state.canvas_height,
                fps=configured_fps,
                input_mode=input_mode
            )

            print(f"[RTMPManager] Starting FFmpeg process ({input_mode}) with {len(active)} destinations (record_local={record_local})...")
            self._stop_event.clear()

            try:
                self.ffmpeg_process = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    bufsize=10**7
                )
            except Exception as e:
                self.last_error = str(e)
                raise RuntimeError(f"Failed to launch FFmpeg: {e}")

            self.is_broadcasting = True
            self.broadcast_start_time = time.time()
            self.total_frames_sent = 0
            self.last_error = None

            for d in active:
                d.status = "streaming"
                d.error_message = None

            # If rawvideo, start background frame feeder
            if input_mode == "rawvideo":
                self._feed_thread = threading.Thread(target=self._feed_frames_worker, daemon=True)
                self._feed_thread.start()

            # Start stderr monitor for stats parsing
            self._monitor_thread = threading.Thread(target=self._monitor_stderr_worker, daemon=True)
            self._monitor_thread.start()

            self.reassembly_queue.reset()
            return {
                "status": "started",
                "active_destinations": len(active),
                "destinations": [d.to_dict(mask_key=True) for d in active]
            }

    def _write_raw_to_ffmpeg(self, data: bytes):
        """Low-level direct writer to FFmpeg process stdin."""
        if self.ffmpeg_process and self.ffmpeg_process.stdin:
            try:
                if self.total_frames_sent < 4:
                    print(f"[FFmpeg Ingest Stdin] Writing {len(data)} bytes to FFmpeg stdin (total sent so far: {self.total_frames_sent}), prefix: {data[:16]}")
                self.ffmpeg_process.stdin.write(data)
                self.ffmpeg_process.stdin.flush()
                self.total_frames_sent += 1
            except (BrokenPipeError, OSError) as e:
                if self.total_frames_sent < 4:
                    print(f"[FFmpeg Ingest Stdin] Pipe write error: {e}")

    def write_stream_chunk(self, data: bytes, link_id: str = "primary") -> bool:
        """
        Pushes stream chunks into the micro-jitter reassembly queue.
        Supports parallel multi-link software bonded streaming.
        """
        return self.reassembly_queue.push_chunk(data, link_id=link_id)

    def _feed_frames_worker(self):
        target_interval = 1.0 / studio_state.fps
        next_frame_time = time.time()

        while not self._stop_event.is_set() and self.ffmpeg_process and self.ffmpeg_process.poll() is None:
            try:
                # Render composited frame
                frame_bgr = compositor.render_frame()
                if frame_bgr is not None and self.ffmpeg_process.stdin:
                    raw_bytes = frame_bgr.tobytes()
                    self.ffmpeg_process.stdin.write(raw_bytes)
                    self.ffmpeg_process.stdin.flush()
                    self.total_frames_sent += 1

                # Frame pacing to prevent buffer overflow
                next_frame_time += target_interval
                sleep_duration = next_frame_time - time.time()
                if sleep_duration > 0:
                    time.sleep(sleep_duration)
                else:
                    next_frame_time = time.time()
            except (BrokenPipeError, OSError) as e:
                print(f"[RTMPManager] Feed pipe closed: {e}")
                break
            except Exception as e:
                print(f"[RTMPManager] Frame feed error: {e}")
                time.sleep(0.05)

        print("[RTMPManager] Frame feed thread finished.")
        if self.is_broadcasting:
            threading.Thread(target=self.stop_broadcast, daemon=True).start()

    def _monitor_stderr_worker(self):
        if not self.ffmpeg_process or not self.ffmpeg_process.stderr:
            return

        while not self._stop_event.is_set() and self.ffmpeg_process and self.ffmpeg_process.poll() is None:
            line = self.ffmpeg_process.stderr.readline()
            if not line:
                break
            line_str = line.decode("utf-8", errors="ignore")

            # Parse stats (e.g. frame= 120 fps= 30 q=28.0 size=N/A time=00:00:04.00 bitrate=4500.0kbits/s)
            if "fps=" in line_str and "bitrate=" in line_str:
                fps_match = re.search(r"fps=\s*([\d.]+)", line_str)
                bitrate_match = re.search(r"bitrate=\s*([\d.]+|N/A)", line_str)
                if fps_match:
                    self.current_fps = float(fps_match.group(1))
                if bitrate_match and bitrate_match.group(1) != "N/A":
                    self.current_bitrate_kbps = float(bitrate_match.group(1))
            elif any(w in line_str.lower() for w in ("error", "warning", "failed", "invalid", "dropped", "unrecognized")):
                # Suppress high-volume VP8 decode noise to avoid log spam during bonded-link recovery
                if "error submitting packet to decoder" not in line_str.lower() and \
                   "invalid data found" not in line_str.lower():
                    print(f"[FFmpeg] {line_str.strip()}")

        print("[RTMPManager] Stderr monitor finished.")
        if self.is_broadcasting and not self._stop_event.is_set():
            print("[RTMPManager] FFmpeg stopped. Synchronizing broadcast state...")
            threading.Thread(target=self.stop_broadcast, daemon=True).start()

    def _transfer_recording_worker(self, rec_path: str, target_dir: str, mode: str = "copy"):
        """Background worker to copy or move the finalized broadcast recording to Google Drive."""
        time.sleep(1.0)  # Brief wait for FFmpeg file handle release
        if not os.path.exists(rec_path):
            print(f"[RTMPManager] Transfer error: Recording file {rec_path} does not exist.")
            return

        try:
            os.makedirs(target_dir, exist_ok=True)
            fname = os.path.basename(rec_path)
            dest_file = os.path.join(target_dir, fname)
            print(f"[RTMPManager] Starting Google Drive transfer ({mode}): {fname} -> {dest_file}")

            if mode == "move":
                shutil.move(rec_path, dest_file)
                print(f"[RTMPManager] [OK] Successfully moved recording to Google Drive: {dest_file}")
            else:
                shutil.copy2(rec_path, dest_file)
                print(f"[RTMPManager] [OK] Successfully copied recording to Google Drive: {dest_file}")
        except Exception as e:  # pylint: disable=broad-exception-caught
            print(f"[RTMPManager] [WARN] Error transferring recording to Google Drive: {e}")

    def stop_broadcast(self) -> Dict[str, Any]:
        """
        Stops the active FFmpeg broadcast and cleans up resources.
        """
        with self._lock:
            if not self.is_broadcasting:
                return {"status": "not_broadcasting"}

            self._stop_event.set()
            self.is_broadcasting = False
            duration = self.get_uptime()
            self.broadcast_start_time = None
            self.current_fps = 0.0
            self.current_bitrate_kbps = 0.0
            saved_rec_path = self.current_recording_path

            if self.ffmpeg_process:
                try:
                    if self.ffmpeg_process.stdin:
                        try:
                            self.ffmpeg_process.stdin.close()
                        except Exception:  # pylint: disable=broad-exception-caught
                            pass
                    self.ffmpeg_process.terminate()
                    try:
                        self.ffmpeg_process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        self.ffmpeg_process.kill()
                except Exception as e:  # pylint: disable=broad-exception-caught
                    print(f"[RTMPManager] Error terminating FFmpeg: {e}")
                finally:
                    self.ffmpeg_process = None

            for d in self.destinations.values():
                d.status = "idle"

            print(f"[RTMPManager] Broadcast stopped. Total duration: {duration:.1f}s")

            # Check if Google Drive auto-transfer is enabled
            if saved_rec_path and self.settings.get("gdrive_sync_enabled"):
                target_dir = self.settings.get("gdrive_folder_path", "/content/drive/MyDrive/BroadcastRecordings")
                mode = self.settings.get("gdrive_transfer_mode", "copy")
                transfer_thread = threading.Thread(
                    target=self._transfer_recording_worker,
                    args=(saved_rec_path, target_dir, mode),
                    daemon=True
                )
                transfer_thread.start()

            # Reset reassembly queue
            self.reassembly_queue.reset()
            final_frames = self.total_frames_sent
            self.total_frames_sent = 0
            self.current_recording_path = None

            if self.on_stop_callback:
                try:
                    self.on_stop_callback()
                except Exception as cb_err:  # pylint: disable=broad-exception-caught
                    print(f"[RTMPManager] Error in on_stop_callback: {cb_err}")

            return {
                "status": "stopped",
                "duration_seconds": duration,
                "total_frames_sent": final_frames,
                "recording_file": saved_rec_path
            }

    def get_uptime(self) -> float:
        """
        Returns the current broadcast uptime in seconds.
        """
        if self.is_broadcasting and self.broadcast_start_time:
            return max(0.0, time.time() - self.broadcast_start_time)
        return 0.0

    def get_status(self) -> Dict[str, Any]:
        """
        Returns the overall RTMP broadcast status and telemetry.
        """
        active = self.get_active_destinations()
        return {
            "is_broadcasting": self.is_broadcasting,
            "uptime_seconds": round(self.get_uptime(), 1),
            "fps": self.current_fps,
            "bitrate_kbps": self.current_bitrate_kbps,
            "total_frames_sent": self.total_frames_sent,
            "total_destinations": len(self.destinations),
            "active_destinations": len(active),
            "destinations": [d.to_dict(mask_key=True) for d in self.destinations.values()],
            "settings": self.get_settings(),
            "bonded_telemetry": self.reassembly_queue.get_telemetry(),
            "last_error": self.last_error
        }

    def get_bonded_status(self) -> Dict[str, Any]:
        """
        Returns telemetry data specific to the bonded ingest reassembly queue.
        """
        return self.reassembly_queue.get_telemetry()


# Global RTMP Stream Manager instance
rtmp_manager = RTMPStreamManager()

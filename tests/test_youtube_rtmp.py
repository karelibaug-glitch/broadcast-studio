"""
Test RTMP streaming transmission to YouTube Live Ingest Server.
"""

import os
import sys
import time
import subprocess
import threading

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

# Configure UTF-8 encoding for Windows terminals
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

from python_app.core.rtmp_manager import rtmp_manager


def test_youtube_live_stream():
    print("=" * 70)
    print(" [TEST] YOUTUBE LIVE RTMP TRANSMISSION TEST")
    print("=" * 70)

    # 1. Load active destinations
    dests = rtmp_manager.get_active_destinations()
    print(f"Total Active Destinations Configured: {len(dests)}")
    for d in dests:
        print(f"  -> [{d.platform.upper()}] Name: {d.name}, Target: {d.server_url}/{d.stream_key[:4]}****")

    if not dests:
        print("[ERROR] No active RTMP destinations enabled. Please enable Swa.Media_T.")
        return

    # 2. Build FFmpeg command with input pipe
    cmd = rtmp_manager.build_ffmpeg_command(input_mode="rawvideo", width=1280, height=720, fps=30)
    # Insert -stats for console feedback
    if "-loglevel" in cmd:
        idx = cmd.index("-loglevel")
        cmd[idx + 1] = "info"
    cmd.insert(1, "-stats")

    print(f"\n[FFmpeg Engine Command]:")
    print(f"  {' '.join(cmd[:12])} ... -> {cmd[-1]}")

    print("\n[Broadcasting] Initiating live RTMP handshake with YouTube servers...")

    # 3. Spawn test FFmpeg process feeding synthetic 720p test frames
    import numpy as np

    process = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL
    )

    stats_lines = []
    stop_event = threading.Event()

    def read_stderr():
        buffer = ""
        while not stop_event.is_set() and process.poll() is None:
            raw = process.stderr.read(256)
            if not raw:
                break
            text = raw.decode('utf-8', errors='ignore')
            buffer += text
            while '\r' in buffer or '\n' in buffer:
                # Find earliest delimiter
                idx_r = buffer.find('\r')
                idx_n = buffer.find('\n')
                if idx_r != -1 and (idx_n == -1 or idx_r < idx_n):
                    line, buffer = buffer[:idx_r], buffer[idx_r+1:]
                else:
                    line, buffer = buffer[:idx_n], buffer[idx_n+1:]
                
                line_str = line.strip()
                if not line_str:
                    continue
                if "fps=" in line_str or "bitrate=" in line_str or "frame=" in line_str:
                    stats_lines.append(line_str)
                    print(f"  [YouTube Live Feed] {line_str}")
                elif any(k in line_str.lower() for k in ("error", "failed", "handshake", "authenticated", "connection", "stream")):
                    print(f"  [FFmpeg Log] {line_str}")

    stderr_thread = threading.Thread(target=read_stderr, daemon=True)
    stderr_thread.start()

    # Generate and feed 720p color frames for 6 seconds (180 frames)
    width, height, fps = 1280, 720, 30
    total_frames = 180
    frame_interval = 1.0 / fps

    print(f"[Streaming] Feeding {total_frames} frames (6 seconds of live video) to YouTube RTMP...")

    try:
        for i in range(total_frames):
            t0 = time.time()
            # Create colorful animated test frame
            color = (int((i * 3) % 255), int((i * 5) % 255), 200)
            frame = np.full((height, width, 3), color, dtype=np.uint8)

            process.stdin.write(frame.tobytes())
            process.stdin.flush()

            elapsed = time.time() - t0
            sleep_time = max(0.001, frame_interval - elapsed)
            time.sleep(sleep_time)

    except (BrokenPipeError, OSError) as e:
        print(f"[Stream Error] Pipe closed: {e}")
    finally:
        time.sleep(1.0)
        stop_event.set()
        try:
            if process.stdin:
                process.stdin.close()
        except Exception:
            pass
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()

    print("\n" + "=" * 70)
    print(" [REPORT] YOUTUBE TRANSMISSION TEST RESULT")
    print("=" * 70)
    if stats_lines:
        print(f"[SUCCESS] Successfully transmitted live stream data to YouTube RTMP!")
        print(f"Last Reported Stats: {stats_lines[-1]}")
    else:
        print(f"[NOTE] Completed transmission run. (Check if YouTube Studio Live control room detected the feed).")
    print("=" * 70)


if __name__ == "__main__":
    test_youtube_live_stream()

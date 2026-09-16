# pylint: skip-file
"""
WebRTC PeerConnection and Streaming Track Manager using aiortc.
Streams composited video and audio tracks directly to remote browsers and players.
"""

# pylint: disable=no-member

import asyncio
import fractions
import time
from typing import Set, Dict, Any, Optional

try:
    import numpy as np
except Exception:
    np = None

try:
    from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription, RTCRtpSender
    from aiortc.contrib.media import MediaRelay
except Exception:
    MediaStreamTrack = object
    RTCPeerConnection = None
    RTCSessionDescription = None
    RTCRtpSender = None
    MediaRelay = None

try:
    import av
except Exception:
    av = None

try:
    import cv2
except Exception:
    cv2 = None

from python_app.core.compositor import compositor



class CompositorVideoTrack(MediaStreamTrack):
    """
    A WebRTC Video Stream Track that generates frames from the Python Video Compositor.
    Properly paced at target FPS to prevent encoder thread collisions.
    """
    kind = "video"

    def __init__(self, fps: int = 30):
        super().__init__()
        self.fps = fps
        self._timestamp = 0
        self._time_base = fractions.Fraction(1, fps)
        self._start_time: Optional[float] = None

    async def recv(self):
        pts, time_base = await self.next_timestamp()

        # Render current frame from python compositor
        frame_bgr = compositor.render_frame()
        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        frame_rgb = np.ascontiguousarray(frame_rgb, dtype=np.uint8)

        video_frame = av.VideoFrame.from_ndarray(frame_rgb, format="rgb24")
        video_frame.pts = pts
        video_frame.time_base = time_base

        return video_frame

    async def next_timestamp(self):
        if self._start_time is None:
            self._start_time = time.time()
            self._timestamp = 0
        else:
            self._timestamp += 1
            # Proper video track pacing calculation
            target_time = self._start_time + (self._timestamp / self.fps)
            wait = target_time - time.time()
            if wait > 0:
                await asyncio.sleep(wait)

        return self._timestamp, self._time_base


class WebRTCManager:
    """
    Manages WebRTC Peer Connections and Media Relaying for client viewing.
    """
    def __init__(self):
        self.peer_connections: Set[RTCPeerConnection] = set()
        self.relay = MediaRelay()
        self._track: Optional[CompositorVideoTrack] = None

    def get_track(self) -> CompositorVideoTrack:
        """
        Gets or initializes the global video track for WebRTC broadcast.
        """
        if self._track is None:
            self._track = CompositorVideoTrack(fps=30)
        return self._track

    async def handle_offer(self, sdp: str, sdp_type: str) -> Dict[str, Any]:
        """
        Handles incoming WebRTC SDP offer and generates a response answer.
        """
        pc = RTCPeerConnection()
        self.peer_connections.add(pc)

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            print(f"[WebRTC] Connection state is {pc.connectionState}")
            if pc.connectionState in ("failed", "closed"):
                await pc.close()
                self.peer_connections.discard(pc)

        track = self.get_track()
        pc.addTrack(self.relay.subscribe(track))

        # Prioritize H.264 video codec for low-latency bypass compatibility
        try:
            transceiver = next((t for t in pc.getTransceivers() if t.kind == "video"), None)
            if transceiver and hasattr(RTCRtpSender, "getCapabilities"):
                caps = RTCRtpSender.getCapabilities("video")
                if caps and hasattr(caps, "codecs"):
                    h264_codecs = [c for c in caps.codecs if c.name.upper() == "H264"]
                    other_codecs = [c for c in caps.codecs if c.name.upper() != "H264"]
                    if h264_codecs and hasattr(transceiver, "setCodecPreferences"):
                        transceiver.setCodecPreferences(h264_codecs + other_codecs)
        except Exception as e:  # pylint: disable=broad-exception-caught
            print(f"[WebRTC] Codec preference warning: {e}")

        offer = RTCSessionDescription(sdp=sdp, type=sdp_type)
        await pc.setRemoteDescription(offer)

        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)

        return {
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        }

    async def cleanup(self):
        """
        Closes all active WebRTC peer connections.
        """
        coros = [pc.close() for pc in self.peer_connections]
        await asyncio.gather(*coros, return_exceptions=True)
        self.peer_connections.clear()


webrtc_manager = WebRTCManager()

"""
Comprehensive Automated Test Suite for Python Broadcast Studio Features.
"""

import unittest
import asyncio
import time
import numpy as np
import os
import shutil
import cv2

from python_app.core.state_manager import StudioStateManager, LayerState
from python_app.core.screen_capture import screen_capturer
from python_app.core.compositor import VideoCompositor
from python_app.core.webrtc_manager import WebRTCManager, CompositorVideoTrack
from fastapi.testclient import TestClient
from python_app.main import app


class TestBroadcastStudioFeatures(unittest.TestCase):

    def setUp(self):
        self.state = StudioStateManager("TEST-STUDIO")
        self.client = TestClient(app)

    def test_01_state_manager_crud(self):
        """Test layer addition, update, reordering, and removal"""
        # Add text layer
        l1 = self.state.add_layer("text", title="Title 1", content="Live Test")
        self.assertIn(l1.id, self.state.layers)
        self.assertEqual(l1.content, "Live Test")

        # Add image layer
        l2 = self.state.add_layer("image", title="Image Overlay", x=100, y=200, scale=1.5)
        self.assertEqual(len(self.state.layers), 2)
        self.assertEqual(self.state.active_program_layer_id, l2.id)

        # Update layer
        updated = self.state.update_layer(l1.id, {"opacity": 0.8, "scale": 1.2})
        self.assertIsNotNone(updated)
        self.assertEqual(updated.opacity, 0.8)

        # Reorder layers
        self.state.reorder_layers([l1.id, l2.id])
        self.assertEqual(self.state.active_program_layer_id, l1.id)

        # Delete layer
        deleted = self.state.remove_layer(l2.id)
        self.assertTrue(deleted)
        self.assertEqual(len(self.state.layers), 1)

    def test_02_screen_capture_engine(self):
        """Test cross-platform screen and monitor capture"""
        monitors = screen_capturer.get_monitors()
        self.assertGreater(len(monitors), 0)

        # Test grab frame from monitor 1 (or 0)
        frame = screen_capturer.grab_frame(1)
        if frame is None:
            frame = screen_capturer.grab_frame(0)
        
        self.assertIsNotNone(frame)
        self.assertEqual(len(frame.shape), 3)
        self.assertEqual(frame.shape[2], 3)  # BGR 3-channel
        self.assertEqual(frame.dtype, np.uint8)

    def test_03_compositor_rendering(self):
        """Test multi-layer compositor rendering with text and screen layers"""
        comp = VideoCompositor(width=1920, height=1080, fps=30)
        
        # Add text layer to global state
        from python_app.core.state_manager import studio_state
        test_layer = studio_state.add_layer("text", title="Breaking", content="VERIFICATION IN PROGRESS", x=50, y=50, extra={"font_size": 36})
        
        # Give compositor thread a moment to render
        time.sleep(0.1)
        
        try:
            frame = comp.render_frame()
            self.assertEqual(frame.shape, (1080, 1920, 3))
            self.assertEqual(frame.dtype, np.uint8)

            jpeg = comp.get_jpeg_frame()
            self.assertIsInstance(jpeg, bytes)
            self.assertGreater(len(jpeg), 1000)
        finally:
            if test_layer:
                studio_state.remove_layer(test_layer.id)
            comp.cleanup()

    def test_04_rest_api_endpoints(self):
        """Test REST API status, devices, and layer creation"""
        # 1. Status
        res = self.client.get("/api/status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["status"], "online")
        self.assertEqual(data["canvas"]["width"], 1920)

        # 2. Devices
        res = self.client.get("/api/devices")
        self.assertEqual(res.status_code, 200)
        devices = res.json()
        self.assertIn("monitors", devices)
        self.assertIn("cameras", devices)

        # 3. Create Layer
        res = self.client.post("/api/layers", json={
            "type": "text",
            "title": "API Layer",
            "content": "API Ingest",
            "x": 200,
            "y": 300
        })
        self.assertEqual(res.status_code, 200)
        layer_data = res.json()
        layer_id = layer_data["id"]

        # 4. Update Layer
        res = self.client.patch(f"/api/layers/{layer_id}", json={
            "scale": 1.25,
            "opacity": 0.9
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["scale"], 1.25)

        # 5. Delete Layer
        res = self.client.delete(f"/api/layers/{layer_id}")
        self.assertEqual(res.status_code, 200)

    def test_05_webrtc_track_generation(self):
        """Test WebRTC video track generation from python compositor"""
        async def _test_track():
            mgr = WebRTCManager()
            track = mgr.get_track()
            self.assertEqual(track.kind, "video")
            
            # Fetch a video frame from track
            video_frame = await track.recv()
            self.assertIsNotNone(video_frame)
            self.assertEqual(video_frame.width, 1920)
            self.assertEqual(video_frame.height, 1080)
            self.assertEqual(video_frame.format.name, "rgb24")

        asyncio.run(_test_track())

    def test_06_rtmp_destination_management(self):
        """Test adding, updating, and removing RTMP destinations"""
        from python_app.core.rtmp_manager import RTMPStreamManager
        mgr = RTMPStreamManager(config_file="tests/test_rtmp.json")
        try:
            # Add YouTube destination
            d1 = mgr.add_destination(
                name="YT Stream",
                platform="youtube",
                stream_key="live_12345_yt"
            )
            self.assertIn(d1.id, mgr.destinations)
            self.assertEqual(d1.server_url, "rtmp://a.rtmp.youtube.com/live2")
            self.assertEqual(d1.full_rtmp_url, "rtmp://a.rtmp.youtube.com/live2/live_12345_yt")

            # Add Twitch destination
            d2 = mgr.add_destination(
                name="Twitch Stream",
                platform="twitch",
                stream_key="live_67890_tw"
            )
            self.assertEqual(len(mgr.destinations), 2)
            self.assertEqual(len(mgr.get_active_destinations()), 2)

            # Update destination
            updated = mgr.update_destination(d1.id, {"enabled": False})
            self.assertIsNotNone(updated)
            self.assertFalse(updated.enabled)
            self.assertEqual(len(mgr.get_active_destinations()), 1)

            # Delete destination
            deleted = mgr.delete_destination(d2.id)
            self.assertTrue(deleted)
            self.assertEqual(len(mgr.destinations), 1)
        finally:
            if os.path.exists("tests/test_rtmp.json"):
                os.remove("tests/test_rtmp.json")

    def test_07_rtmp_tee_command_generation(self):
        """Test FFmpeg tee muxer command construction with failure isolation"""
        from python_app.core.rtmp_manager import RTMPStreamManager
        mgr = RTMPStreamManager(config_file="tests/test_rtmp_cmd.json")
        try:
            mgr.add_destination("YT", "youtube", stream_key="yt-key-1")
            mgr.add_destination("Twitch", "twitch", stream_key="tw-key-2")

            cmd = mgr.build_ffmpeg_command(width=1920, height=1080, fps=30)
            self.assertIn("ffmpeg", cmd)
            self.assertIn("tee", cmd)
            self.assertIn("-f", cmd)
            self.assertIn("libx264", cmd)
            self.assertIn("aac", cmd)

            # Check that tee string contains both targets with onfail=ignore
            tee_arg = cmd[-1]
            self.assertIn("[f=flv:onfail=ignore", tee_arg)
            self.assertIn("yt-key-1", tee_arg)
            self.assertIn("tw-key-2", tee_arg)
        finally:
            if os.path.exists("tests/test_rtmp_cmd.json"):
                os.remove("tests/test_rtmp_cmd.json")

    def test_08_rtmp_rest_api(self):
        """Test RTMP REST API endpoints"""
        # 1. Create Destination
        res = self.client.post("/api/rtmp/destinations", json={
            "name": "Facebook Live Test",
            "platform": "facebook",
            "stream_key": "fb_stream_secret_123",
            "enabled": True
        })
        self.assertEqual(res.status_code, 200)
        dest_data = res.json()
        dest_id = dest_data["id"]
        self.assertEqual(dest_data["platform"], "facebook")

        # 2. List Destinations
        res = self.client.get("/api/rtmp/destinations")
        self.assertEqual(res.status_code, 200)
        dest_list = res.json()
        self.assertGreaterEqual(len(dest_list), 1)

        # 3. Update Destination
        res = self.client.patch(f"/api/rtmp/destinations/{dest_id}", json={
            "name": "Updated Facebook Live",
            "enabled": False
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["name"], "Updated Facebook Live")

        # 4. Status
        res = self.client.get("/api/rtmp/status")
        self.assertEqual(res.status_code, 200)
        status_data = res.json()
        self.assertIn("is_broadcasting", status_data)
        self.assertIn("total_destinations", status_data)

        # 5. Cleanup Test Destination
        res = self.client.delete(f"/api/rtmp/destinations/{dest_id}")
        self.assertEqual(res.status_code, 200)

    def test_09_rtmp_settings_and_recording_controls(self):
        """Test stream profile settings (FPS, Bitrate, Preset) and local recording command generation"""
        from python_app.core.rtmp_manager import RTMPStreamManager
        mgr = RTMPStreamManager(config_file="tests/test_rtmp_settings.json")
        try:
            # Add destination
            mgr.add_destination("YT", "youtube", stream_key="test_key_abc")

            # Update settings
            new_settings = mgr.update_settings({
                "video_bitrate_kbps": 6000,
                "framerate": 60,
                "audio_bitrate_kbps": 192,
                "preset": "faster",
                "record_local": True,
                "recording_format": "mp4"
            })
            self.assertEqual(new_settings["video_bitrate_kbps"], 6000)
            self.assertEqual(new_settings["framerate"], 60)
            self.assertEqual(new_settings["audio_bitrate_kbps"], 192)
            self.assertEqual(new_settings["preset"], "faster")
            self.assertTrue(new_settings["record_local"])

            # Build command and verify parameters
            cmd = mgr.build_ffmpeg_command(width=1920, height=1080)
            cmd_str = " ".join(cmd)
            self.assertIn("-b:v 6000k", cmd_str)
            self.assertIn("-b:a 192k", cmd_str)
            self.assertIn("-preset faster", cmd_str)
            self.assertIn("-flags +global_header", cmd_str)

            # Verify local MP4 recording target in tee command
            tee_arg = cmd[-1]
            self.assertIn("f=mp4:", tee_arg)
            self.assertIn("movflags=+frag_keyframe+default_base_moof", tee_arg)
            self.assertIn("onfail=ignore", tee_arg)
            self.assertIn(".mp4", tee_arg)
        finally:
            if os.path.exists("tests/test_rtmp_settings.json"):
                os.remove("tests/test_rtmp_settings.json")

    def test_10_settings_and_recordings_api(self):
        """Test REST API for settings and recordings CRUD"""
        # 1. Get Settings
        res = self.client.get("/api/rtmp/settings")
        self.assertEqual(res.status_code, 200)
        settings = res.json()
        self.assertIn("video_bitrate_kbps", settings)
        self.assertIn("framerate", settings)

        # 2. Update Settings
        res = self.client.post("/api/rtmp/settings", json={
            "video_bitrate_kbps": 5000,
            "framerate": 60,
            "record_local": True
        })
        self.assertEqual(res.status_code, 200)
        updated = res.json()
        self.assertEqual(updated["video_bitrate_kbps"], 5000)
        self.assertEqual(updated["framerate"], 60)
        self.assertTrue(updated["record_local"])

        # 3. List Recordings
        res = self.client.get("/api/recordings")
        self.assertEqual(res.status_code, 200)
        self.assertIn("recordings", res.json())

        # 4. Restore Default Settings
        self.client.post("/api/rtmp/settings", json={
            "video_bitrate_kbps": 4500,
            "framerate": 30,
            "record_local": False
        })

    def test_11_gdrive_auto_transfer(self):
        """Test Google Drive auto-transfer worker copying recording to export folder"""
        from python_app.core.rtmp_manager import RTMPStreamManager
        mgr = RTMPStreamManager(config_file="tests/test_rtmp_gdrive.json")
        test_rec = "tests/test_broadcast_sample.mp4"
        test_drive = "tests/mock_gdrive"

        try:
            # Create dummy recording
            with open(test_rec, "wb") as f:
                f.write(b"SAMPLE_MP4_BROADCAST_DATA_BYTES")

            # Execute transfer worker
            mgr._transfer_recording_worker(test_rec, test_drive, mode="copy")

            # Check that file was copied to target folder
            copied_file = os.path.join(test_drive, "test_broadcast_sample.mp4")
            self.assertTrue(os.path.exists(copied_file))
            self.assertTrue(os.path.exists(test_rec))  # original retained in copy mode

            # Test move mode
            mgr._transfer_recording_worker(test_rec, test_drive, mode="move")
            self.assertTrue(os.path.exists(copied_file))
            self.assertFalse(os.path.exists(test_rec))  # original moved
        finally:
            if os.path.exists(test_rec):
                os.remove(test_rec)
            if os.path.exists("tests/mock_gdrive"):
                shutil.rmtree("tests/mock_gdrive")
            if os.path.exists("tests/test_rtmp_gdrive.json"):
                os.remove("tests/test_rtmp_gdrive.json")

    def test_12_bonded_reassembly_queue(self):
        """Test StreamReassemblyQueue in-order, out-of-order, and failover reassembly"""
        import struct
        from python_app.core.rtmp_manager import StreamReassemblyQueue, BONDED_MAGIC

        collected = []
        queue = StreamReassemblyQueue(output_callback=lambda data: collected.append(data), max_jitter_ms=60.0)

        def make_framed_chunk(seq: int, link_id: int, payload: bytes) -> bytes:
            header = struct.pack(">2sBBI", BONDED_MAGIC, link_id, 0, seq)
            return header + payload

        # 1. In-order chunks across 2 links
        c0 = make_framed_chunk(0, 0, b"DATA_0_WIFI")
        c1 = make_framed_chunk(1, 1, b"DATA_1_LAN")
        queue.push_chunk(c0, link_id="wifi")
        queue.push_chunk(c1, link_id="lan")
        self.assertEqual(collected, [b"DATA_0_WIFI", b"DATA_1_LAN"])

        # 2. Out-of-order chunks (Link 1 arrives before Link 0)
        c3 = make_framed_chunk(3, 1, b"DATA_3_LAN")
        c4 = make_framed_chunk(4, 0, b"DATA_4_WIFI")
        queue.push_chunk(c3, link_id="lan")
        queue.push_chunk(c4, link_id="wifi")
        # Should not have flushed yet because chunk 2 is missing
        self.assertEqual(len(collected), 2)

        # Now chunk 2 arrives
        c2 = make_framed_chunk(2, 0, b"DATA_2_WIFI")
        queue.push_chunk(c2, link_id="wifi")
        # Now all chunks 2, 3, 4 should be flushed in exact numerical order!
        self.assertEqual(collected, [b"DATA_0_WIFI", b"DATA_1_LAN", b"DATA_2_WIFI", b"DATA_3_LAN", b"DATA_4_WIFI"])

        # 3. Telemetry inspection
        telemetry = queue.get_telemetry()
        self.assertEqual(telemetry["total_links_count"], 2)
        self.assertEqual(telemetry["recovered_packets"], 2)

    def test_13_bonded_api_telemetry(self):
        """Test REST API endpoint for bonded link status"""
        res = self.client.get("/api/rtmp/bonded_status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("active_links_count", data)
        self.assertIn("combined_bitrate_kbps", data)
        self.assertIn("links", data)


if __name__ == "__main__":
    unittest.main()


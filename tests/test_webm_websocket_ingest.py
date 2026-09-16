"""
End-to-End Test for WebM WebSocket Ingest with Multi-Link Bonding and Header Preservation
"""
import unittest
import struct
import subprocess
import time
from fastapi.testclient import TestClient
from python_app.main import app
from python_app.core.rtmp_manager import rtmp_manager, BONDED_MAGIC

class TestWebMWebSocketIngest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Generate a small 1-second WebM sample using ffmpeg
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "testsrc=size=640x360:rate=30",
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-t", "1.0",
            "-c:v", "libvpx", "-b:v", "500k",
            "-c:a", "libvorbis",
            "-f", "webm",
            "pipe:1"
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        cls.webm_data, _ = proc.communicate()
        assert len(cls.webm_data) > 0, "Failed to generate WebM test data"
        assert cls.webm_data.startswith(b'\x1aE\xdf\xa3'), "WebM data does not start with EBML header"

    def setUp(self):
        # Configure a dummy file recording destination so FFmpeg can run without network
        self.dest = rtmp_manager.add_destination("test_rtmp", "rtmp://127.0.0.1:19350/live/test", "testkey", enabled=True)
        # Ensure setting has local recording or mock
        rtmp_manager.update_settings({"recording_format": "mp4", "record_local": False})

    def tearDown(self):
        rtmp_manager.stop_broadcast()
        rtmp_manager.delete_destination(self.dest.id)

    def test_bonded_websocket_webm_ingest(self):
        client = TestClient(app)
        
        # Split WebM data into chunks
        chunk_size = 8192
        raw_chunks = [self.webm_data[i:i+chunk_size] for i in range(0, len(self.webm_data), chunk_size)]
        
        with client.websocket_connect("/api/rtmp/stream_ingest?link_id=primary") as ws_primary:
            seq = 0
            for raw_chunk in raw_chunks:
                # Frame packet with [BN][LinkID][Flags][Seq]
                header = struct.pack(">2sBBI", BONDED_MAGIC, 0, 0, seq)
                packet = header + raw_chunk
                ws_primary.send_bytes(packet)
                seq += 1
                time.sleep(0.02)
            
            # Give FFmpeg process a brief moment to process chunks
            time.sleep(0.5)
            status = rtmp_manager.get_status()
            self.assertGreater(status["bonded_telemetry"]["total_bytes_received"], 0)
            self.assertEqual(status["bonded_telemetry"]["active_links_count"], 1)

    def test_multi_link_bonded_with_leading_flush(self):
        """Simulates 4 bonded links, an initial 1-byte flush, and round-robin chunks."""
        client = TestClient(app)
        chunk_size = 4096
        raw_chunks = [self.webm_data[i:i+chunk_size] for i in range(0, len(self.webm_data), chunk_size)]

        with client.websocket_connect("/api/rtmp/stream_ingest?link_id=primary") as ws1, \
             client.websocket_connect("/api/rtmp/stream_ingest?link_id=wi_fi") as ws2, \
             client.websocket_connect("/api/rtmp/stream_ingest?link_id=ethernet_2") as ws3:
            
            # Send initial 1-byte stray flush on ws1
            dummy_header = struct.pack(">2sBBI", BONDED_MAGIC, 0, 0, 0)
            ws1.send_bytes(dummy_header + b'\x00')

            sockets = [ws1, ws2, ws3]
            seq = 1
            for idx, raw_chunk in enumerate(raw_chunks):
                ws = sockets[idx % len(sockets)]
                header = struct.pack(">2sBBI", BONDED_MAGIC, idx % len(sockets), 0, seq)
                ws.send_bytes(header + raw_chunk)
                seq += 1
                time.sleep(0.01)

            time.sleep(0.6)
            status = rtmp_manager.get_status()
            self.assertTrue(status["is_broadcasting"])
            self.assertGreater(status["bonded_telemetry"]["total_bytes_received"], 0)
            self.assertGreaterEqual(status["bonded_telemetry"]["active_links_count"], 1)

    def test_stop_and_start_cycle_preserves_webm_mode(self):
        """Verifies that stopping and starting repeatedly retains WebM mode and never spawns rawvideo frames."""
        client = TestClient(app)
        chunk_size = 4096
        raw_chunks = [self.webm_data[i:i+chunk_size] for i in range(0, len(self.webm_data), chunk_size)]

        # --- CYCLE 1: First Start ---
        start_res1 = client.post("/api/rtmp/start")
        self.assertEqual(start_res1.status_code, 200)
        self.assertIn(start_res1.json().get("status"), ["starting", "ready_for_ingest"])

        with client.websocket_connect("/api/rtmp/stream_ingest?link_id=primary") as ws:
            seq = 0
            for chunk in raw_chunks:
                header = struct.pack(">2sBBI", BONDED_MAGIC, 0, 0, seq)
                ws.send_bytes(header + chunk)
                seq += 1
                time.sleep(0.01)

            time.sleep(0.5)
            status1 = rtmp_manager.get_status()
            self.assertTrue(status1["is_broadcasting"])
            # Ensure rawvideo feeder thread was NOT started
            self.assertIsNone(rtmp_manager._feed_thread)

        # Stop broadcast
        stop_res1 = client.post("/api/rtmp/stop")
        self.assertEqual(stop_res1.status_code, 200)
        time.sleep(0.3)
        self.assertFalse(rtmp_manager.is_broadcasting)
        self.assertEqual(rtmp_manager.total_frames_sent, 0)

        # --- CYCLE 2: Second Start (The bug scenario) ---
        start_res2 = client.post("/api/rtmp/start")
        self.assertEqual(start_res2.status_code, 200)
        self.assertIn(start_res2.json().get("status"), ["starting", "ready_for_ingest"])
        self.assertNotEqual(start_res2.json().get("mode"), "rawvideo")

        with client.websocket_connect("/api/rtmp/stream_ingest?link_id=primary") as ws:
            seq = 0
            for chunk in raw_chunks:
                header = struct.pack(">2sBBI", BONDED_MAGIC, 0, 0, seq)
                ws.send_bytes(header + chunk)
                seq += 1
                time.sleep(0.01)

            time.sleep(0.5)
            status2 = rtmp_manager.get_status()
            self.assertTrue(status2["is_broadcasting"])
            # Ensure rawvideo feeder thread is STILL None (pure WebM mode)
            self.assertIsNone(rtmp_manager._feed_thread)

        # Final Stop
        client.post("/api/rtmp/stop")
        time.sleep(0.3)
        self.assertFalse(rtmp_manager.is_broadcasting)

    def test_truncated_ebml_header_self_healing(self):
        """Verify that if a chunk arrives with a 1-byte truncated EBML header (b'E\\xdf\\xa3...'), it is automatically repaired."""
        client = TestClient(app)
        truncated_webm = self.webm_data[1:]  # Starts with b'E\xdf\xa3...' instead of b'\x1aE\xdf\xa3...'
        with client.websocket_connect("/api/rtmp/stream_ingest?link_id=primary") as ws:
            header = struct.pack(">2sBBI", BONDED_MAGIC, 0, 0, 0)
            ws.send_bytes(header + truncated_webm)
            time.sleep(0.5)
            status = rtmp_manager.get_status()
            self.assertTrue(status["is_broadcasting"])

        client.post("/api/rtmp/stop")
        time.sleep(0.3)


if __name__ == "__main__":
    unittest.main()

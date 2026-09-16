# pylint: skip-file
"""
Main FastAPI Application for Python Broadcast Studio.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os
import asyncio

from python_app.api.routes import router as api_router, UPLOAD_DIR
from python_app.api.websocket import ws_manager, handle_websocket_message
from python_app.core.compositor import compositor
from python_app.core.webrtc_manager import webrtc_manager
from python_app.core.virtual_cam import virtual_cam
from python_app.core.rtmp_manager import rtmp_manager
from python_app.core.peerjs_signaling import peerjs_router

STATIC_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _main_event_loop
    _main_event_loop = asyncio.get_running_loop()
    print("[BroadcastApp] Python Broadcast Studio Engine starting up...")
    try:
        loop = asyncio.get_running_loop()
        def _proactor_exception_handler(current_loop, context):
            exc = context.get('exception')
            if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
                return
            current_loop.default_exception_handler(context)
        loop.set_exception_handler(_proactor_exception_handler)
    except Exception:
        pass
    yield
    print("[BroadcastApp] Shutting down broadcast engine...")

    # Force close active WebSockets to unblock receive_json loops and prevent shutdown hang
    closing_coros = []
    for ws in list(ws_manager.active_connections):
        closing_coros.append(ws.close())
    for ws in list(active_ingest_sockets):
        closing_coros.append(ws.close())
    if closing_coros:
        await asyncio.gather(*closing_coros, return_exceptions=True)

    rtmp_manager.stop_broadcast()
    virtual_cam.stop()
    await webrtc_manager.cleanup()
    compositor.cleanup()
    print("[BroadcastApp] Shutdown complete.")


app = FastAPI(
    title="Pro Broadcast Studio Engine",
    description="Cross-Platform Python Broadcast & Streaming Studio Suite",
    version="1.0.0",
    lifespan=lifespan
)

# CORS middleware for LAN and cross-origin controllers
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.responses import FileResponse

# Explicit route for Production Broadcast Controller v2
@app.get("/")
@app.get("/v2")
@app.get("/index_v2.html")
async def get_v2_page():
    v2_path = os.path.join(STATIC_DIR, "index_v2.html")
    if os.path.exists(v2_path):
        return FileResponse(v2_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# Explicit route for Standalone Multi-Scene Director Switcher Desk
@app.get("/switcher")
@app.get("/switcher.html")
async def get_switcher_page():
    switcher_path = os.path.join(STATIC_DIR, "switcher.html")
    if os.path.exists(switcher_path):
        return FileResponse(switcher_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# Explicit route for Standalone Guest Camera Feeder & Intercom Page
@app.get("/guest")
@app.get("/guest.html")
async def get_guest_page():
    guest_path = os.path.join(STATIC_DIR, "guest.html")
    if os.path.exists(guest_path):
        return FileResponse(guest_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# Explicit route for Standalone Multi Camera Director Suite
@app.get("/director")
@app.get("/director_suite.html")
async def get_director_suite_page():
    director_path = os.path.join(STATIC_DIR, "director_suite.html")
    if os.path.exists(director_path):
        return FileResponse(director_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# Favicon handler
@app.get("/favicon.ico")
async def get_favicon():
    icon_path = os.path.join(STATIC_DIR, "icon-192.png")
    if not os.path.exists(icon_path):
        icon_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "icon-192.png"))
    if os.path.exists(icon_path):
        return FileResponse(icon_path, media_type="image/png")
    from fastapi import Response
    return Response(status_code=204)

# Include REST API & Built-in WebRTC PeerJS Signaling
app.include_router(api_router)
app.include_router(peerjs_router)

# WebSocket Control endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_json()
            await handle_websocket_message(websocket, data)
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)
    except Exception as e:
        print(f"[WebSocket] Error: {e}")
        ws_manager.disconnect(websocket)


# Active Ingest Links Pool for Multi-Link Software Bonding
active_ingest_sockets = set()


# In-memory cache for active session WebM header & pre-broadcast accumulator
cached_webm_header = None
accumulated_pre_broadcast_data = bytearray()
pre_broadcast_packets = []
pre_broadcast_lock = asyncio.Lock()


def reset_ingest_state():
    """Resets pre-broadcast packet buffers and cached headers across broadcast sessions."""
    global accumulated_pre_broadcast_data, pre_broadcast_packets, cached_webm_header
    accumulated_pre_broadcast_data = bytearray()
    pre_broadcast_packets = []
    cached_webm_header = None


# Event loop reference stored at startup so background threads can schedule async work
_main_event_loop: asyncio.AbstractEventLoop = None

# Guard flag: set True when user stops broadcast to block auto-relaunch
# from stale mid-stream cluster data still arriving on bonded links.
_user_stop_guard = False


def _get_main_loop() -> asyncio.AbstractEventLoop:
    """Returns the main event loop. Works from both async and background threads."""
    return _main_event_loop


def _on_broadcast_stopped():
    """Called from RTMPManager when broadcast ends (either manual stop or FFmpeg crash).
    Resets ingest state and raises the guard flag to block auto-relaunches from
    still-connected bonded links that are still streaming mid-session data.
    """
    global _user_stop_guard
    _user_stop_guard = True
    reset_ingest_state()
    print("[RTMP Ingest] Broadcast stopped — relaunch guard engaged. Closing active ingest links...")
    # Schedule close of all still-open ingest sockets on the main event loop.
    # IMPORTANT: This callback is called from a background thread (FFmpeg monitor),
    # so we MUST use run_coroutine_threadsafe instead of asyncio.get_running_loop().
    loop = _get_main_loop()
    if loop and loop.is_running():
        async def _close_all_sockets():
            coros = [ws.close() for ws in list(active_ingest_sockets)]
            if coros:
                await asyncio.gather(*coros, return_exceptions=True)
        asyncio.run_coroutine_threadsafe(_close_all_sockets(), loop)


# Register stop callback
rtmp_manager.on_stop_callback = _on_broadcast_stopped


# Live Canvas Stream Ingest WebSocket Endpoint (Browser -> FFmpeg RTMP Bridge with Multi-Link Bonding)
@app.websocket("/api/rtmp/stream_ingest")
@app.websocket("/ws/stream_ingest")
async def rtmp_stream_ingest(websocket: WebSocket, link_id: str = "primary", session_id: str = "default"):
    global cached_webm_header, accumulated_pre_broadcast_data, pre_broadcast_packets, _user_stop_guard
    await websocket.accept()
    active_ingest_sockets.add(websocket)
    client_ip = websocket.client.host if websocket.client else "127.0.0.1"
    rtmp_manager.reassembly_queue.register_link(link_id, client_ip=client_ip)
    print(f"[RTMP Ingest] Bonded Link connected: '{link_id}' ({client_ip}). Total active links: {len(active_ingest_sockets)}")

    if not rtmp_manager.is_broadcasting:
        # Clear the guard on a fresh connection so the next valid stream can auto-launch
        _user_stop_guard = False
        if len(active_ingest_sockets) == 1:
            reset_ingest_state()

    chunk_count = 0
    try:
        while True:
            data = await websocket.receive_bytes()
            if not data:
                continue

            chunk_count += 1
            is_framed = (len(data) >= 8 and data[:2] == b'BN')
            payload = data[8:] if is_framed else data

            # Auto-repair edge case: missing 0x1A byte (e.g. b'E\xdf\xa3\x9fB\x86')
            if payload.startswith(b'E\xdf\xa3\x9fB\x86') or payload.startswith(b'E\xdf\xa3\x9f'):
                payload = b'\x1a' + payload
                if is_framed:
                    data = data[:8] + payload
                else:
                    data = payload

            # Filter out tiny <=4 byte empty/flush fragments before broadcast starts
            if not rtmp_manager.is_broadcasting and len(payload) <= 4:
                continue

            # Check for EBML header (either unframed or framed after 8-byte header)
            ebml_pos = payload.find(b'\x1aE\xdf\xa3')
            is_header = (ebml_pos != -1)

            if is_header and not rtmp_manager.is_broadcasting:
                # If there is pre-header junk in this initial chunk, trim it so the chunk begins at byte 0 with \x1a
                if ebml_pos > 0:
                    payload = payload[ebml_pos:]
                    if is_framed:
                        data = data[:8] + payload
                    else:
                        data = payload
                    ebml_pos = 0
                cached_webm_header = payload[:8192]
                print(f"[RTMP Ingest] Captured fresh WebM EBML Header ({len(cached_webm_header)} bytes) on link '{link_id}'")

            if not rtmp_manager.is_broadcasting:
                async with pre_broadcast_lock:
                    if not rtmp_manager.is_broadcasting:
                        # Only buffer data once a valid EBML header is captured or present in current chunk
                        if is_header or cached_webm_header is not None:
                            pre_broadcast_packets.append((data, link_id))
                            accumulated_pre_broadcast_data.extend(payload)

                        # Launch conditions:
                        # - FRESH EBML header in current chunk → ALWAYS launch immediately.
                        # - 64KB accumulated data with captured header + no guard → launch.
                        if is_header:
                            _user_stop_guard = False

                        should_launch = is_header or (cached_webm_header is not None and not _user_stop_guard and len(accumulated_pre_broadcast_data) >= 65536)

                        if should_launch and len(pre_broadcast_packets) > 0:
                            try:
                                print(f"[RTMP Ingest] Launching FFmpeg with {len(pre_broadcast_packets)} buffered packet(s) ({len(accumulated_pre_broadcast_data)} bytes)...")
                                rtmp_manager.start_broadcast(input_mode="webm")
                                await ws_manager.broadcast_rtmp_status()

                                # Stream buffered packets cleanly in exact order without prepending duplicate headers
                                for p_data, p_link in pre_broadcast_packets:
                                    rtmp_manager.write_stream_chunk(p_data, link_id=p_link)
                                pre_broadcast_packets.clear()
                                accumulated_pre_broadcast_data.clear()
                                continue
                            except Exception as e:
                                print(f"[RTMP Ingest] Cannot start FFmpeg: {e}")
                                pre_broadcast_packets.clear()
                                accumulated_pre_broadcast_data.clear()
                                continue
                        else:
                            if chunk_count <= 5:
                                print(f"[RTMP Ingest] Buffering stream data before launching FFmpeg ({len(data)} bytes, total buffer {len(accumulated_pre_broadcast_data)} bytes)...")
                            continue

            # If FFmpeg is live, drop a chunk that starts a NEW EBML segment.
            # Feeding a fresh segment header into a running matroska demuxer causes the
            # decoder to briefly re-initialize and can temporarily report different
            # dimensions, triggering the YouTube player to resize.
            if is_header and ebml_pos == 0:
                print(f"[RTMP Ingest] Mid-stream EBML header suppressed on link '{link_id}' — already broadcasting.")
                continue

            rtmp_manager.write_stream_chunk(data, link_id=link_id)

    except WebSocketDisconnect:
        print(f"[RTMP Ingest] Bonded Link '{link_id}' disconnected.")
    except Exception as e:
        print(f"[RTMP Ingest] Stream ingest error on link '{link_id}': {e}")
    finally:
        active_ingest_sockets.discard(websocket)
        rtmp_manager.reassembly_queue.unregister_link(link_id)
        print(f"[RTMP Ingest] Link '{link_id}' closed. Active links remaining: {len(active_ingest_sockets)}")

        # Only stop broadcast if ALL bonded links have disconnected
        if not active_ingest_sockets and rtmp_manager.is_broadcasting:
            await asyncio.sleep(1.0)  # Grace period for quick link reconnection
            if not active_ingest_sockets and rtmp_manager.is_broadcasting:
                print("[RTMP Ingest] All bonded links disconnected. Stopping broadcast...")
                rtmp_manager.stop_broadcast()
                reset_ingest_state()
                await ws_manager.broadcast_rtmp_status()


# Mount Recordings directory
RECORDINGS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "recordings"))
try:
    os.makedirs(RECORDINGS_DIR, exist_ok=True)
except Exception:
    RECORDINGS_DIR = "/tmp/recordings"
    try:
        os.makedirs(RECORDINGS_DIR, exist_ok=True)
    except Exception:
        pass

if os.path.exists(RECORDINGS_DIR):
    app.mount("/recordings", StaticFiles(directory=RECORDINGS_DIR), name="recordings")

# Mount Uploads directory
if os.path.exists(UPLOAD_DIR):
    app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# Mount Static UI directory
if os.path.exists(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")


from __future__ import annotations
# pylint: skip-file
"""
REST Endpoints for Broadcast Studio.
"""


from fastapi import APIRouter, UploadFile, File, Form, HTTPException, Response
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from pydantic import BaseModel
from typing import Dict, Any, List, Optional
import os
import shutil
import time

try:
    import cv2
except Exception:
    cv2 = None


from python_app.core.state_manager import studio_state
from python_app.core.compositor import compositor
from python_app.core.screen_capture import screen_capturer
from python_app.core.virtual_cam import virtual_cam
from python_app.core.webrtc_manager import webrtc_manager
from python_app.core.rtmp_manager import rtmp_manager
from python_app.api.websocket import ws_manager

router = APIRouter(prefix="/api")

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
try:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
except Exception:
    UPLOAD_DIR = "/tmp/uploads"
    try:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
    except Exception:
        pass



class LayerCreateRequest(BaseModel):
    type: str
    title: Optional[str] = ""
    x: Optional[float] = 0.0
    y: Optional[float] = 0.0
    width: Optional[float] = 1920.0
    height: Optional[float] = 1080.0
    scale: Optional[float] = 1.0
    opacity: Optional[float] = 1.0
    visible: Optional[bool] = True
    content: Optional[str] = ""
    src: Optional[str] = ""
    extra: Optional[Dict[str, Any]] = None


class LayerUpdateRequest(BaseModel):
    title: Optional[str] = None
    x: Optional[float] = None
    y: Optional[float] = None
    width: Optional[float] = None
    height: Optional[float] = None
    scale: Optional[float] = None
    opacity: Optional[float] = None
    visible: Optional[bool] = None
    volume: Optional[float] = None
    muted: Optional[bool] = None
    content: Optional[str] = None
    src: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


class ReorderRequest(BaseModel):
    order: List[str]


class WebRTCOfferRequest(BaseModel):
    sdp: str
    type: str


class RTMPDestinationCreateRequest(BaseModel):
    name: Optional[str] = ""
    platform: Optional[str] = "custom"
    server_url: Optional[str] = ""
    stream_key: str = ""
    enabled: Optional[bool] = True


class RTMPDestinationUpdateRequest(BaseModel):
    name: Optional[str] = None
    platform: Optional[str] = None
    server_url: Optional[str] = None
    stream_key: Optional[str] = None
    enabled: Optional[bool] = None


@router.get("/status")
def get_status():
    return {
        "status": "online",
        "studio_id": studio_state.studio_id,
        "layers_count": len(studio_state.layers),
        "canvas": {
            "width": studio_state.canvas_width,
            "height": studio_state.canvas_height,
            "fps": studio_state.fps
        },
        "virtual_cam_active": virtual_cam.is_active,
        "active_webrtc_connections": len(webrtc_manager.peer_connections),
        "uptime_seconds": round(time.time() - studio_state.created_at, 1)
    }


@router.get("/devices")
def get_devices():
    # Monitors via mss
    monitors = screen_capturer.get_monitors()

    # Detect cameras (probe first 4 index slots)
    cameras = []
    for i in range(4):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            cameras.append({
                "id": i,
                "name": f"Camera Device {i}"
            })
        cap.release()

    return {
        "monitors": monitors,
        "cameras": cameras
    }


@router.get("/network/interfaces")
def get_network_interfaces():
    """Detects and returns all physical and virtual network adapters/interfaces on the host system."""
    import psutil
    import socket

    interfaces = []
    addrs = psutil.net_if_addrs()
    stats = psutil.net_if_stats()

    for iface_name, addr_list in addrs.items():
        # Skip loopback
        if "loopback" in iface_name.lower():
            continue

        ipv4 = None
        mac = None
        for addr in addr_list:
            if addr.family == socket.AF_INET:
                ipv4 = addr.address
            elif getattr(addr, "family", None) == psutil.AF_LINK or getattr(addr, "family", None) == -1:
                mac = addr.address

        stat = stats.get(iface_name)
        stat_up = stat.isup if stat else False
        speed = stat.speed if stat else 0

        # An interface is online if it has a non-APIPA (169.254) IPv4 or psutil reports it as up
        has_valid_ip = bool(ipv4 and not ipv4.startswith("169.254") and ipv4 != "127.0.0.1")
        is_up = stat_up or has_valid_ip

        # Classify interface type
        name_lower = iface_name.lower()
        if any(w in name_lower for w in ("cellular", "mobile", "lte", "4g", "5g", "rndis", "tether", "samsung", "apple", "android", "usb")):
            iface_type = "cellular"
            icon = "📱"
        elif any(w in name_lower for w in ("wi-fi", "wifi", "wireless", "wlan")):
            iface_type = "wifi"
            icon = "📶"
        elif any(w in name_lower for w in ("ethernet", "eth", "lan", "gigabit", "realtek", "intel")):
            iface_type = "ethernet"
            icon = "🔌"
        else:
            iface_type = "virtual"
            icon = "🌐"

        interfaces.append({
            "name": iface_name,
            "type": iface_type,
            "icon": icon,
            "ip": ipv4 or "No IP assigned",
            "mac": mac,
            "is_up": is_up,
            "speed_mbps": speed,
            "has_ip": has_valid_ip
        })

    # Sort so active/connected interfaces with valid IPs appear first
    interfaces.sort(key=lambda x: (not x["has_ip"], not x["is_up"], x["name"]))
    return {"interfaces": interfaces}


@router.get("/layers")
def list_layers():
    return studio_state.get_state_snapshot()


@router.post("/layers")
async def create_layer(req: LayerCreateRequest):
    data = req.model_dump(exclude_unset=True)
    layer_type = data.pop("type")
    title = data.pop("title", "")
    layer = studio_state.add_layer(layer_type, title=title, **data)
    await ws_manager.broadcast_state()
    return layer.to_dict()


@router.patch("/layers/{layer_id}")
async def update_layer(layer_id: str, req: LayerUpdateRequest):
    updates = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
    layer = studio_state.update_layer(layer_id, updates)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    await ws_manager.broadcast_state()
    return layer.to_dict()


@router.delete("/layers/{layer_id}")
async def delete_layer(layer_id: str):
    success = studio_state.remove_layer(layer_id)
    if not success:
        raise HTTPException(status_code=404, detail="Layer not found")
    await ws_manager.broadcast_state()
    return {"status": "deleted", "id": layer_id}


@router.post("/layers/reorder")
async def reorder_layers(req: ReorderRequest):
    studio_state.reorder_layers(req.order)
    await ws_manager.broadcast_state()
    return {"status": "reordered", "order": req.order}


@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    filename = f"{int(time.time())}_{file.filename}"
    file_path = os.path.join(UPLOAD_DIR, filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    url = f"/uploads/{filename}"
    return {
        "filename": filename,
        "filepath": file_path,
        "url": url
    }


@router.post("/webrtc/offer")
async def webrtc_offer(offer: WebRTCOfferRequest):
    try:
        answer = await webrtc_manager.handle_offer(offer.sdp, offer.type)
        return answer
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/virtualcam/toggle")
def toggle_virtual_cam():
    if virtual_cam.is_active:
        virtual_cam.stop()
        return {"status": "stopped", "active": False}
    else:
        success = virtual_cam.start()
        return {"status": "started" if success else "failed", "active": virtual_cam.is_active}


def _mjpeg_generator():
    """Generates continuous multipart JPEG stream for low-latency live preview"""
    while True:
        frame_bytes = compositor.get_jpeg_frame(quality=75)
        if frame_bytes:
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        time.sleep(1.0 / studio_state.fps)


@router.get("/stream/mjpeg")
def stream_mjpeg():
    return StreamingResponse(
        _mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# --- Multi-Destination RTMP Streaming Endpoints ---

@router.get("/rtmp/destinations")
def list_rtmp_destinations():
    return rtmp_manager.get_destinations(mask_key=False)


@router.post("/rtmp/destinations")
async def create_rtmp_destination(req: RTMPDestinationCreateRequest):
    dest = rtmp_manager.add_destination(
        name=req.name or "",
        platform=req.platform or "custom",
        server_url=req.server_url or "",
        stream_key=req.stream_key or "",
        enabled=req.enabled if req.enabled is not None else True
    )
    await ws_manager.broadcast_rtmp_status()
    return dest.to_dict()


@router.patch("/rtmp/destinations/{dest_id}")
async def update_rtmp_destination(dest_id: str, req: RTMPDestinationUpdateRequest):
    updates = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
    dest = rtmp_manager.update_destination(dest_id, updates)
    if not dest:
        raise HTTPException(status_code=404, detail="RTMP destination not found")
    await ws_manager.broadcast_rtmp_status()
    return dest.to_dict()


@router.delete("/rtmp/destinations/{dest_id}")
async def delete_rtmp_destination(dest_id: str):
    success = rtmp_manager.delete_destination(dest_id)
    if not success:
        raise HTTPException(status_code=404, detail="RTMP destination not found")
    await ws_manager.broadcast_rtmp_status()
    return {"status": "deleted", "id": dest_id}


@router.post("/rtmp/start")
async def start_rtmp_broadcast(mode: Optional[str] = None):
    try:
        active = rtmp_manager.get_active_destinations()
        record_local = rtmp_manager.settings.get("record_local", False)
        if not active and not record_local:
            raise ValueError("No active RTMP destinations configured and local recording is disabled.")

        if rtmp_manager.is_broadcasting:
            return {"status": "already_running", "active_destinations": len(active)}

        # Direct server-side launch (only if explicitly requested, e.g. headless tests)
        if mode == "rawvideo":
            result = rtmp_manager.start_broadcast(input_mode="rawvideo")
            await ws_manager.broadcast_rtmp_status()
            return result

        # Web studio live canvas ingest mode:
        # Incoming WebM packets from WebSocket ingest will trigger FFmpeg launch in webm mode with exact EBML headers.
        has_ingest = any(l.get("active", False) for l in rtmp_manager.reassembly_queue.links.values())
        return {
            "status": "starting" if has_ingest else "ready_for_ingest",
            "active_destinations": len(active),
            "mode": "webm"
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/rtmp/stop")
async def stop_rtmp_broadcast():
    result = rtmp_manager.stop_broadcast()
    await ws_manager.broadcast_rtmp_status()
    return result


class RTMPSettingsUpdateRequest(BaseModel):
    video_bitrate_kbps: Optional[int] = None
    framerate: Optional[int] = None
    audio_bitrate_kbps: Optional[int] = None
    preset: Optional[str] = None
    record_local: Optional[bool] = None
    recording_format: Optional[str] = None
    gdrive_sync_enabled: Optional[bool] = None
    gdrive_folder_path: Optional[str] = None
    gdrive_transfer_mode: Optional[str] = None


@router.get("/rtmp/settings")
def get_rtmp_settings():
    return rtmp_manager.get_settings()


@router.post("/rtmp/settings")
def update_rtmp_settings(req: RTMPSettingsUpdateRequest):
    updates = {k: v for k, v in req.model_dump(exclude_unset=True).items() if v is not None}
    return rtmp_manager.update_settings(updates)


@router.get("/recordings")
def get_recordings():
    return {"recordings": rtmp_manager.get_recordings()}


@router.delete("/recordings/{filename}")
def delete_recording(filename: str):
    success = rtmp_manager.delete_recording(filename)
    if not success:
        raise HTTPException(status_code=404, detail="Recording not found")
    return {"status": "deleted", "filename": filename}


@router.post("/recordings/{filename}/remux")
def remux_recording(filename: str):
    output_name = rtmp_manager.remux_recording(filename)
    if not output_name:
        raise HTTPException(status_code=400, detail="Failed to remux recording. File might not exist or is corrupted.")
    return {"status": "remuxed", "original": filename, "final_file": output_name, "url": f"/recordings/{output_name}"}


@router.get("/rtmp/status")
def get_rtmp_status():
    status = rtmp_manager.get_status()
    status["settings"] = rtmp_manager.get_settings()
    status["current_recording"] = rtmp_manager.current_recording_path
    status["bonded_telemetry"] = rtmp_manager.get_bonded_status()
    return status


@router.get("/rtmp/bonded_status")
def get_bonded_status():
    return rtmp_manager.get_bonded_status()


# --- Native Hardware Capture & System Security Endpoints ---
from python_app.core.hardware_manager import hardware_manager
from python_app.core.ssl_helper import get_local_ip_addresses


@router.get("/hardware/devices")
def list_hardware_devices():
    devices = hardware_manager.scan_devices()
    return {"status": "ok", "devices": devices}


@router.get("/hardware/stream/{device_id}")
def stream_hardware_device(device_id: int):
    return StreamingResponse(
        hardware_manager.generate_mjpeg_stream(device_id),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


@router.get("/system/security")
def get_system_security_info():
    ips = [ip for ip in get_local_ip_addresses() if ip not in ("127.0.0.1", "0.0.0.0")]
    primary_lan = ips[0] if ips else "127.0.0.1"
    is_ssl = os.path.exists("ssl/cert.pem") and os.path.exists("ssl/key.pem")
    ssl_active = os.environ.get("STUDIO_SSL_ACTIVE") == "1"
    https_port = int(os.environ.get("STUDIO_HTTPS_PORT", "8000" if ssl_active else "8443"))
    http_port = int(os.environ.get("STUDIO_HTTP_PORT", "8000"))
    return {
        "status": "ok",
        "lan_ips": ips,
        "primary_lan": primary_lan,
        "is_ssl_configured": is_ssl,
        "https_available": is_ssl,
        "ssl_active": ssl_active,
        "http_port": http_port,
        "https_port": https_port,
        "recommended_https_port": https_port,
    }


@router.get("/media/file")
def stream_local_media_file(path: str):
    """Safely streams local media files directly to the browser without file:/// security blocks."""
    clean_path = path.replace("file:///", "").replace("file://", "")
    clean_path = os.path.normpath(clean_path)
    if not os.path.exists(clean_path):
        raise HTTPException(status_code=404, detail=f"File not found: {clean_path}")

    ext = os.path.splitext(clean_path)[1].lower()
    media_types = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mov": "video/quicktime",
        ".mkv": "video/x-matroska",
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".ogg": "audio/ogg",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
    }
    media_type = media_types.get(ext, "application/octet-stream")
    return FileResponse(clean_path, media_type=media_type)



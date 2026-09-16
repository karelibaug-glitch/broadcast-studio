# pylint: skip-file
"""
High-Performance Built-in WebRTC PeerJS Signaling Server.
Allows Broadcast Studio (Host, Switcher, Guests, Players) to handshake completely offline
over Local LAN / Wi-Fi as well as across the Internet without third-party signaling servers.
"""

import json
import uuid
import asyncio
from typing import Dict, Optional, Any
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import PlainTextResponse, JSONResponse


class PeerJSSignalingManager:
    """
    Manages active WebSockets and routes WebRTC Offer, Answer, Candidate,
    and Disconnect signaling messages between PeerJS clients.
    """
    def __init__(self):
        # Maps peer_id -> WebSocket connection
        self.peers: Dict[str, WebSocket] = {}
        # Maps WebSocket connection -> peer_id
        self.ws_to_peer: Dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    def generate_id(self) -> str:
        """Generates a unique peer ID."""
        return uuid.uuid4().hex[:16]

    async def register(self, peer_id: str, websocket: WebSocket) -> bool:
        """Registers a newly connected peer."""
        async with self._lock:
            # If peer already registered, cleanly close old connection
            if peer_id in self.peers and self.peers[peer_id] != websocket:
                old_ws = self.peers[peer_id]
                try:
                    await old_ws.close()
                except Exception:
                    pass
                self.ws_to_peer.pop(old_ws, None)

            self.peers[peer_id] = websocket
            self.ws_to_peer[websocket] = peer_id
            print(f"[PeerJS Signaling] Registered peer: {peer_id} (Total active: {len(self.peers)})")
            return True

    async def unregister(self, websocket: WebSocket):
        """Unregisters a disconnecting peer."""
        async with self._lock:
            peer_id = self.ws_to_peer.pop(websocket, None)
            if peer_id and self.peers.get(peer_id) == websocket:
                del self.peers[peer_id]
                print(f"[PeerJS Signaling] Unregistered peer: {peer_id} (Total active: {len(self.peers)})")

    async def route_message(self, src_ws: WebSocket, raw_text: str):
        """
        Parses and forwards a signaling message from sender to target peer.
        PeerJS protocol message format:
        {
            "type": "OFFER" | "ANSWER" | "CANDIDATE" | "LEAVE" | "HEARTBEAT",
            "src": "<sender_id>",
            "dst": "<receiver_id>",
            "payload": { ... }
        }
        """
        try:
            data = json.loads(raw_text)
        except Exception:
            return

        msg_type = data.get("type", "").upper()

        if msg_type == "HEARTBEAT":
            # Keep-alive heartbeat; acknowledge if needed
            return

        dst_id = data.get("dst")
        async with self._lock:
            src_id = self.ws_to_peer.get(src_ws)
            target_ws = self.peers.get(dst_id)

        # PeerJS protocol requires the server to attach 'src' so receiver knows who called
        if src_id and not data.get("src"):
            data["src"] = src_id

        forward_text = json.dumps(data)

        if target_ws:
            try:
                await target_ws.send_text(forward_text)
                if msg_type in ("OFFER", "ANSWER"):
                    print(f"[PeerJS Signaling] Relayed {msg_type}: {src_id} -> {dst_id}")
            except Exception as e:
                print(f"[PeerJS Signaling] Error forwarding {msg_type} to {dst_id}: {e}")
        else:
            if msg_type == "OFFER":
                print(f"[PeerJS Signaling] Notice: Target peer {dst_id} not connected (probing or offline)")
                try:
                    # Notify sender that target peer is currently unavailable
                    await src_ws.send_text(json.dumps({"type": "EXPIRE", "src": dst_id}))
                except Exception:
                    pass



# Global signaling manager instance
signaling_manager = PeerJSSignalingManager()

# Router for PeerJS HTTP & WebSocket endpoints
peerjs_router = APIRouter(prefix="/peerjs")


@peerjs_router.get("/id")
@peerjs_router.get("/{key}/id")
async def get_peer_id(key: str = "peerjs"):
    """
    Returns a unique peer ID as plain text for PeerJS client initialization.
    """
    new_id = signaling_manager.generate_id()
    return PlainTextResponse(new_id)


@peerjs_router.websocket("/peerjs")
@peerjs_router.websocket("/{key}/peerjs")
async def peerjs_websocket_endpoint(websocket: WebSocket, key: str = "peerjs", id: Optional[str] = None, token: Optional[str] = None):
    """
    WebSocket endpoint implementing the PeerJS Server signaling protocol.
    """
    await websocket.accept()

    # Query params fallback if not in route signature
    query_params = websocket.query_params
    peer_id = id or query_params.get("id") or signaling_manager.generate_id()

    # Register client
    await signaling_manager.register(peer_id, websocket)

    try:
        # Step 1: Send OPEN confirmation message to acknowledge registration
        await websocket.send_text(json.dumps({"type": "OPEN"}))

        # Step 2: Handle incoming signaling messages loop
        while True:
            raw_text = await websocket.receive_text()
            await signaling_manager.route_message(websocket, raw_text)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[PeerJS Signaling] Connection error for {peer_id}: {e}")
    finally:
        await signaling_manager.unregister(websocket)

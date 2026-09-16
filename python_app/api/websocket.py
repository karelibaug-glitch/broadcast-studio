# pylint: skip-file
"""
WebSocket Connection & Broadcast Manager.
Synchronizes all controllers, players, and remote studio endpoints.
"""

from fastapi import WebSocket, WebSocketDisconnect
from typing import Set, Dict, Any
import json
import asyncio
from python_app.core.state_manager import studio_state
from python_app.core.compositor import compositor


class ConnectionManager:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        # Send initial full state snapshot
        await websocket.send_json({
            "type": "INITIAL_STATE",
            "state": studio_state.get_state_snapshot()
        })

    def disconnect(self, websocket: WebSocket):
        self.active_connections.discard(websocket)

    async def broadcast(self, message: Dict[str, Any]):
        dead_connections = set()
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception:
                dead_connections.add(connection)
        
        for dead in dead_connections:
            self.active_connections.discard(dead)

    async def broadcast_state(self):
        await self.broadcast({
            "type": "STATE_UPDATE",
            "state": studio_state.get_state_snapshot()
        })

    async def broadcast_rtmp_status(self):
        from python_app.core.rtmp_manager import rtmp_manager
        await self.broadcast({
            "type": "RTMP_STATUS_UPDATE",
            "status": rtmp_manager.get_status()
        })


ws_manager = ConnectionManager()


async def handle_websocket_message(websocket: WebSocket, data: Dict[str, Any]):
    msg_type = data.get("type", "")

    if msg_type == "ADD_LAYER":
        layer_type = data.get("layer_type", "image")
        kwargs = data.get("params", {})
        title = data.get("title", "")
        layer = studio_state.add_layer(layer_type, title=title, **kwargs)
        await ws_manager.broadcast_state()

    elif msg_type == "UPDATE_LAYER":
        layer_id = data.get("layer_id")
        updates = data.get("updates", {})
        if layer_id:
            studio_state.update_layer(layer_id, updates)
            await ws_manager.broadcast_state()

    elif msg_type == "RESTART_MEDIA":
        layer_id = data.get("layer_id")
        if layer_id:
            compositor.restart_layer_playback(layer_id)
            await ws_manager.broadcast_state()

    elif msg_type == "REMOVE_LAYER":
        layer_id = data.get("layer_id")
        if layer_id:
            studio_state.remove_layer(layer_id)
            await ws_manager.broadcast_state()

    elif msg_type == "REORDER_LAYERS":
        order = data.get("order", [])
        if order:
            studio_state.reorder_layers(order)
            await ws_manager.broadcast_state()

    elif msg_type == "GET_RTMP_STATUS":
        from python_app.core.rtmp_manager import rtmp_manager
        await websocket.send_json({
            "type": "RTMP_STATUS_UPDATE",
            "status": rtmp_manager.get_status()
        })

    elif msg_type == "PING":
        await websocket.send_json({
            "type": "PONG",
            "timestamp": data.get("timestamp")
        })

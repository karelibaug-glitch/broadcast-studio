"""
State manager for the broadcast studio.
Holds active layers, studio configuration, and broadcast state.
"""

from dataclasses import dataclass, field, asdict
from typing import Dict, Any, Optional, List
import asyncio
import uuid
import time


@dataclass
class LayerState:  # pylint: disable=too-many-instance-attributes
    """
    Represents the visual and audio state of a single broadcast layer.
    """
    id: str
    type: str  # 'camera', 'screen', 'video', 'image', 'text', 'color'
    title: str = ""
    x: float = 0.0
    y: float = 0.0
    width: float = 1920.0
    height: float = 1080.0
    scale: float = 1.0
    opacity: float = 1.0
    z_index: int = 1
    visible: bool = True
    volume: float = 1.0
    muted: bool = False
    content: str = ""  # text content or source description
    src: str = ""      # local file path or stream url
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """Converts the layer state to a JSON-serializable dictionary."""
        return asdict(self)


class StudioStateManager:  # pylint: disable=too-many-instance-attributes
    """
    Global state manager for tracking all active studio layers and metadata.
    """
    def __init__(self, studio_id: str = "DEFAULT-STUDIO"):
        self.studio_id = studio_id
        self.layers: Dict[str, LayerState] = {}
        self.active_program_layer_id: Optional[str] = None
        self.fps: int = 30
        self.canvas_width: int = 1920
        self.canvas_height: int = 1080
        self.created_at: float = time.time()
        self._lock = asyncio.Lock()

    def add_layer(self, layer_type: str, title: str = "", **kwargs) -> LayerState:
        """Adds a new layer to the studio state."""
        layer_id = kwargs.pop("id", None) or f"layer-{uuid.uuid4().hex[:8]}"
        next_z = max((l.z_index for l in self.layers.values()), default=0) + 1
        layer = LayerState(
            id=layer_id,
            type=layer_type,
            title=title or f"{layer_type.capitalize()} Layer",
            z_index=kwargs.pop("z_index", next_z),
            **kwargs
        )
        self.layers[layer.id] = layer
        self._update_program_layer()
        return layer

    def update_layer(self, layer_id: str, updates: Dict[str, Any]) -> Optional[LayerState]:
        """Updates an existing layer's properties."""
        if layer_id not in self.layers:
            return None
        layer = self.layers[layer_id]
        for key, value in updates.items():
            if hasattr(layer, key):
                setattr(layer, key, value)
            else:
                layer.extra[key] = value
        self._update_program_layer()
        return layer

    def remove_layer(self, layer_id: str) -> bool:
        """Removes a layer from the studio state."""
        if layer_id in self.layers:
            del self.layers[layer_id]
            self._update_program_layer()
            return True
        return False

    def reorder_layers(self, layer_order: List[str]) -> None:
        """
        Reorders layers based on an ordered list of IDs.
        First in list gets highest z_index.
        """
        total = len(layer_order)
        for idx, layer_id in enumerate(layer_order):
            if layer_id in self.layers:
                self.layers[layer_id].z_index = total - idx
        self._update_program_layer()

    def get_sorted_layers(self) -> List[LayerState]:
        """Returns visible layers sorted by z_index ascending (back-to-front for rendering)"""
        return sorted(
            [l for l in self.layers.values() if l.visible],
            key=lambda l: l.z_index
        )

    def _update_program_layer(self) -> None:
        sorted_layers = sorted(self.layers.values(), key=lambda l: l.z_index, reverse=True)
        self.active_program_layer_id = sorted_layers[0].id if sorted_layers else None

    def get_state_snapshot(self) -> Dict[str, Any]:
        """Returns a deep-copy snapshot of the full studio state."""
        return {
            "studio_id": self.studio_id,
            "layers": {l_id: l.to_dict() for l_id, l in self.layers.items()},
            "program_layer_id": self.active_program_layer_id,
            "canvas": {
                "width": self.canvas_width,
                "height": self.canvas_height,
                "fps": self.fps
            },
            "timestamp": time.time()
        }


# Global state instance
studio_state = StudioStateManager()

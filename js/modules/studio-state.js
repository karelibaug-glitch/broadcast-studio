/**
 * studio-state.js - Centralized state store for Pro Broadcast Studio
 */

export class StudioState {
  constructor() {
    this.role = 'controller'; // 'controller' or 'player'
    this.studioId = '';
    this.layers = [];
    this.selectedLayerId = null;
    this.qualityMode = 'vbr'; // 'vbr', 'cbr', '720p', '480p', '360p'
    this.ispStates = JSON.parse(localStorage.getItem('broadcast_isp_states') || '{}');
    this.activeLinksCount = 1;
    this.isBroadcasting = false;
  }

  saveISPStates() {
    localStorage.setItem('broadcast_isp_states', JSON.stringify(this.ispStates));
  }

  addLayer(layer) {
    this.layers.push(layer);
    this.selectedLayerId = layer.id;
    return layer;
  }

  removeLayer(id) {
    this.layers = this.layers.filter(l => l.id !== id);
    if (this.selectedLayerId === id) {
      this.selectedLayerId = this.layers.length > 0 ? this.layers[0].id : null;
    }
  }

  getLayer(id) {
    return this.layers.find(l => l.id === id);
  }

  reorderLayers(newOrderIds) {
    const layerMap = new Map(this.layers.map(l => [l.id, l]));
    this.layers = newOrderIds.map(id => layerMap.get(id)).filter(Boolean);
  }
}

export const studioState = new StudioState();

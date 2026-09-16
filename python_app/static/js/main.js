/**
 * main.js - Pro Broadcast Studio Main ES Module Orchestrator
 */

import { studioState } from './modules/studio-state.js';
import { AudioVUMeter } from './modules/audio-meter.js';
import { ispRadar } from './modules/isp-radar.js';
import { CanvasCompositor } from './modules/canvas-compositor.js';
import { webrtcPeer } from './modules/webrtc-peer.js';
import { emergencyManager } from './modules/emergency-manager.js';

console.log('🚀 Pro Broadcast Studio ES Modules Engine Initialized.');

window.ProBroadcastStudio = {
  state: studioState,
  AudioVUMeter,
  ispRadar,
  CanvasCompositor,
  webrtcPeer,
  emergencyManager
};

// Auto-initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  console.log('[ProBroadcastStudio] DOM ready. Initializing emergency manager & studio role.');
  emergencyManager.init();
});

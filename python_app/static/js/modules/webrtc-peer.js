/**
 * webrtc-peer.js - PeerJS Signaling & P2P Stream Transport Manager
 */

import { studioState } from './studio-state.js';

export class WebRTCPeerManager {
  constructor() {
    this.peer = null;
    this.connection = null;
    this.mediaCall = null;
    this.onStatusChange = null;
    this.onDataReceived = null;
  }

  initPeer(studioId, role, callbacks = {}) {
    studioState.studioId = studioId;
    studioState.role = role;
    this.onStatusChange = callbacks.onStatusChange;
    this.onDataReceived = callbacks.onDataReceived;

    const peerId = role === 'controller' ? `studio-${studioId}-controller` : `studio-${studioId}-player`;

    if (window.Peer) {
      this.peer = new window.Peer(peerId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      });

      this.peer.on('open', (id) => {
        console.log(`[WebRTCPeer] Peer connected with ID: ${id}`);
        if (this.onStatusChange) this.onStatusChange('CONNECTED', id);
        if (role === 'player') {
          this.connectToController(studioId);
        }
      });

      this.peer.on('connection', (conn) => {
        this.connection = conn;
        this.setupDataChannel(conn);
      });

      this.peer.on('error', (err) => {
        console.warn('[WebRTCPeer] Peer error:', err);
        if (this.onStatusChange) this.onStatusChange('ERROR', err.message);
      });
    } else {
      console.warn('[WebRTCPeer] PeerJS library not loaded.');
    }
  }

  connectToController(studioId) {
    const targetId = `studio-${studioId}-controller`;
    const conn = this.peer.connect(targetId);
    this.connection = conn;
    this.setupDataChannel(conn);
  }

  setupDataChannel(conn) {
    conn.on('open', () => {
      console.log('[WebRTCPeer] Data channel open.');
      if (this.onStatusChange) this.onStatusChange('CHANNEL_OPEN');
    });

    conn.on('data', (data) => {
      if (this.onDataReceived) this.onDataReceived(data);
    });

    conn.on('close', () => {
      console.log('[WebRTCPeer] Data channel closed.');
      if (this.onStatusChange) this.onStatusChange('DISCONNECTED');
    });
  }

  sendState(data) {
    if (this.connection && this.connection.open) {
      this.connection.send(data);
    }
  }

  callStream(targetId, stream) {
    if (this.peer && stream) {
      this.mediaCall = this.peer.call(targetId, stream);
      return this.mediaCall;
    }
    return null;
  }
}

export const webrtcPeer = new WebRTCPeerManager();

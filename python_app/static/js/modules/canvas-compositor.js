/**
 * canvas-compositor.js - 1080p Stage Canvas Compositor & Quality Engine
 */

import { studioState } from './studio-state.js';

export class CanvasCompositor {
  constructor(canvasId) {
    this.canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;
    this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    this.width = 1920;
    this.height = 1080;
    this.isRendering = false;
    this.animId = null;
  }

  init() {
    if (this.canvas) {
      this.canvas.width = this.width;
      this.canvas.height = this.height;
    }
  }

  start() {
    if (this.isRendering) return;
    this.isRendering = true;
    const loop = () => {
      if (!this.isRendering) return;
      this.renderFrame();
      this.animId = requestAnimationFrame(loop);
    };
    this.animId = requestAnimationFrame(loop);
  }

  stop() {
    this.isRendering = false;
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = null;
    }
  }

  renderFrame() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.width, this.height);

    // Render background
    this.ctx.fillStyle = '#0f172a';
    this.ctx.fillRect(0, 0, this.width, this.height);

    // Render layers in Z-order
    for (const layer of studioState.layers) {
      if (!layer.visible) continue;
      this.renderLayer(layer);
    }
  }

  renderLayer(layer) {
    this.ctx.save();
    this.ctx.globalAlpha = layer.opacity !== undefined ? layer.opacity : 1.0;

    const x = layer.x || 0;
    const y = layer.y || 0;
    const w = layer.width || 1920;
    const h = layer.height || 1080;

    if (layer.type === 'text') {
      this.ctx.fillStyle = layer.color || '#ffffff';
      this.ctx.font = `${layer.fontSize || 48}px Inter, sans-serif`;
      this.ctx.fillText(layer.content || '', x, y + (layer.fontSize || 48));
    } else if (layer.type === 'video' || layer.type === 'camera' || layer.type === 'screen') {
      if (layer.element && layer.element.readyState >= 2) {
        this.ctx.drawImage(layer.element, x, y, w, h);
      } else {
        this.ctx.fillStyle = '#1e293b';
        this.ctx.fillRect(x, y, w, h);
        this.ctx.fillStyle = '#64748b';
        this.ctx.font = '24px Inter, sans-serif';
        this.ctx.fillText(`[${layer.type.toUpperCase()}: ${layer.title || 'Loading...'}]`, x + 20, y + 50);
      }
    } else if (layer.type === 'image') {
      if (layer.element && layer.element.complete) {
        this.ctx.drawImage(layer.element, x, y, w, h);
      }
    }

    // Draw selection outline on Controller
    if (studioState.role === 'controller' && studioState.selectedLayerId === layer.id) {
      this.ctx.strokeStyle = '#3b82f6';
      this.ctx.lineWidth = 4;
      this.ctx.strokeRect(x, y, w, h);
    }

    this.ctx.restore();
  }

  applyQualityMode(mode) {
    studioState.qualityMode = mode;
    console.log(`[CanvasCompositor] Applied quality mode: ${mode}`);
  }
}

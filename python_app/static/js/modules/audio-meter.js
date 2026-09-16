/**
 * audio-meter.js - AudioContext, AnalyserNode, and Dual Stereo VU Meter Processor
 */

export class AudioVUMeter {
  constructor(canvasElementId) {
    this.canvas = typeof canvasElementId === 'string' ? document.getElementById(canvasElementId) : canvasElementId;
    this.audioCtx = null;
    this.analyserL = null;
    this.analyserR = null;
    this.splitter = null;
    this.animFrameId = null;
    this.dbL = -40;
    this.dbR = -40;
  }

  init(stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
      const source = this.audioCtx.createMediaStreamSource(stream);

      this.analyserL = this.audioCtx.createAnalyser();
      this.analyserR = this.audioCtx.createAnalyser();
      this.analyserL.fftSize = 256;
      this.analyserR.fftSize = 256;

      this.splitter = this.audioCtx.createChannelSplitter(2);
      source.connect(this.splitter);
      this.splitter.connect(this.analyserL, 0);
      this.splitter.connect(this.analyserR, 1);

      this.startLoop();
    } catch (e) {
      console.warn('[AudioVUMeter] Error initializing Web Audio API:', e);
    }
  }

  calculateDB(analyserNode) {
    if (!analyserNode) return -40;
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = (data[i] - 128) / 128;
      sum += val * val;
    }
    const rms = Math.sqrt(sum / data.length);
    if (rms < 0.0001) return -40;
    const db = 20 * Math.log10(rms);
    return Math.max(-40, Math.min(0, db));
  }

  startLoop() {
    const update = () => {
      this.dbL = this.calculateDB(this.analyserL);
      this.dbR = this.calculateDB(this.analyserR);
      this.render();
      this.animFrameId = requestAnimationFrame(update);
    };
    this.stopLoop();
    this.animFrameId = requestAnimationFrame(update);
  }

  stopLoop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  render() {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Draw Left channel bar
    this.drawChannelBar(ctx, 0, 0, w / 2 - 2, h, this.dbL);
    // Draw Right channel bar
    this.drawChannelBar(ctx, w / 2 + 2, 0, w / 2 - 2, h, this.dbR);
  }

  drawChannelBar(ctx, x, y, width, height, db) {
    const norm = (db + 40) / 40; // 0.0 to 1.0
    const fillHeight = height * norm;

    // Background track
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(x, y, width, height);

    // Gradient bar: Green -> Yellow -> Red
    const grad = ctx.createLinearGradient(0, y + height, 0, y);
    grad.addColorStop(0, '#22c55e');
    grad.addColorStop(0.7, '#eab308');
    grad.addColorStop(0.9, '#ef4444');

    ctx.fillStyle = grad;
    ctx.fillRect(x, y + (height - fillHeight), width, fillHeight);
  }
}

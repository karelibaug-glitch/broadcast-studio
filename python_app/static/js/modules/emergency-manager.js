/**
 * emergency-manager.js - Emergency Panic System, Voice Alerts & OLED Blackout Engine
 */

import { studioState } from './studio-state.js';

export class EmergencyManager {
  constructor() {
    this.isBlackoutActive = false;
    this.isAudioMuted = false;
    this.lastTapTime = 0;
    this.lastShakeTime = 0;
    this.speechSynth = 'speechSynthesis' in window ? window.speechSynthesis : null;
  }

  init() {
    this.bindKeyboardHotkeys();
    this.bindMobileTouchGestures();
    this.bindShakeDetection();
    console.log('[EmergencyManager] Emergency Panic & Voice Alert Engine initialized.');
  }

  speakAlert(text) {
    if (!this.speechSynth) return;
    try {
      this.speechSynth.cancel(); // Cancel any active speech
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.1; // Clear, crisp rate
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      this.speechSynth.speak(utterance);
    } catch (e) {
      console.warn('[EmergencyManager] Speech synthesis error:', e);
    }
  }

  toggleMasterMute() {
    this.isAudioMuted = !this.isAudioMuted;
    studioState.layers.forEach(l => {
      if (l.element && l.element.muted !== undefined) {
        l.element.muted = this.isAudioMuted;
      }
    });

    const muteBtn = document.getElementById('master-audio-mute-btn');
    if (muteBtn) {
      muteBtn.classList.toggle('bg-red-600', this.isAudioMuted);
    }

    if (this.isAudioMuted) {
      this.speakAlert("Emergency cut activated. All audio muted.");
    } else {
      this.speakAlert("Audio restored.");
    }
    return this.isAudioMuted;
  }

  toggleOLEDBlackout(enable) {
    const overlay = document.getElementById('oled-blackout-overlay');
    if (!overlay) return;

    this.isBlackoutActive = enable !== undefined ? enable : !this.isBlackoutActive;

    if (this.isBlackoutActive) {
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');
      this.speakAlert("Emergency blackout engaged. Audio muted.");
      if (!this.isAudioMuted) {
        this.toggleMasterMute();
      }
    } else {
      overlay.classList.add('hidden');
      overlay.classList.remove('flex');
      this.speakAlert("Emergency cut disengaged. Studio restored.");
      if (this.isAudioMuted) {
        this.toggleMasterMute();
      }
    }
  }

  triggerPanicCut() {
    this.toggleOLEDBlackout(true);
    this.speakAlert("Panic cut executed. Broadcast paused.");
  }

  bindKeyboardHotkeys() {
    window.addEventListener('keydown', (e) => {
      // Ignore keybindings if user is typing inside an input/textarea
      const tag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || document.activeElement.isContentEditable) {
        return;
      }

      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        this.toggleMasterMute();
      } else if (e.key === 'b' || e.key === 'B' || e.key === 'Escape') {
        e.preventDefault();
        this.toggleOLEDBlackout(!this.isBlackoutActive);
      } else if (e.shiftKey && e.key === 'Escape') {
        e.preventDefault();
        this.triggerPanicCut();
      }
    });
  }

  bindMobileTouchGestures() {
    const stage = document.getElementById('program-stage-container') || document.body;
    stage.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - this.lastTapTime < 350) {
        // Mobile Double-Tap Gesture
        this.toggleOLEDBlackout(!this.isBlackoutActive);
      }
      this.lastTapTime = now;
    });
  }

  bindShakeDetection() {
    if ('DeviceMotionEvent' in window) {
      let lastX = 0, lastY = 0, lastZ = 0;
      window.addEventListener('devicemotion', (e) => {
        const acc = e.accelerationIncludingGravity;
        if (!acc) return;
        const now = Date.now();
        if (now - this.lastShakeTime > 2000) {
          const deltaX = Math.abs(acc.x - lastX);
          const deltaY = Math.abs(acc.y - lastY);
          const deltaZ = Math.abs(acc.z - lastZ);
          if (deltaX + deltaY + deltaZ > 25) {
            // Significant shake detected
            this.lastShakeTime = now;
            this.toggleOLEDBlackout(true);
          }
        }
        lastX = acc.x;
        lastY = acc.y;
        lastZ = acc.z;
      });
    }
  }
}

export const emergencyManager = new EmergencyManager();

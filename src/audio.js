// Procedural sound: engine rumble, aero/reentry roar, staging thumps and
// radio blips. Everything is synthesized — no audio assets, works offline.
// The AudioContext is created on the first user gesture (iOS requirement).

import { atmoDensity } from './physics.js';

export class AudioFx {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);

    // Shared looped noise source (brown-ish, heavy low end).
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.03 * white) / 1.03;
      d[i] = last * 3.2;
    }

    const mkNoise = () => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      // Detune per-source so the two loops don't phase-lock audibly.
      src.playbackRate.value = 0.9 + Math.random() * 0.25;
      src.start();
      return src;
    };

    // Engine: noise -> lowpass -> gain, plus a sub-oscillator rumble.
    this.engLP = ctx.createBiquadFilter();
    this.engLP.type = 'lowpass';
    this.engLP.frequency.value = 220;
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    mkNoise().connect(this.engLP);
    this.engLP.connect(this.engGain);
    this.engGain.connect(this.master);

    this.sub = ctx.createOscillator();
    this.sub.type = 'triangle';
    this.sub.frequency.value = 31;
    this.subGain = ctx.createGain();
    this.subGain.gain.value = 0;
    this.sub.connect(this.subGain);
    this.subGain.connect(this.master);
    this.sub.start();

    // Aero / reentry: noise -> bandpass -> gain.
    this.windBP = ctx.createBiquadFilter();
    this.windBP.type = 'bandpass';
    this.windBP.frequency.value = 650;
    this.windBP.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    mkNoise().connect(this.windBP);
    this.windBP.connect(this.windGain);
    this.windGain.connect(this.master);

    this.noiseBuf = buf;
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 1;
  }

  // Called every frame with the live sim.
  update(sim, dt) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const alt = sim.altitude;
    const thr = sim.effThrottle;

    // Engine loudness: throttle scaled by how much air carries the sound,
    // with a floor for structure-borne noise the crew always hears.
    const air = Math.min(1, atmoDensity(alt) / 0.02);
    const eng = thr > 0 ? thr * (0.25 + 0.75 * air) : 0;
    const k = Math.min(1, dt * 8); // smooth
    this.engGain.gain.value += (eng * 0.5 - this.engGain.gain.value) * k;
    this.subGain.gain.value += (eng * 0.33 - this.subGain.gain.value) * k;
    this.engLP.frequency.value = 160 + 320 * thr;

    // Aero roar from dynamic pressure; screams during reentry heating.
    const q = sim.qDyn || 0;
    const heat = Math.min(1, (sim.heat || 0) / 5e9);
    const wind = Math.min(0.65, q / 28_000 * 0.5 + heat * 0.55);
    this.windGain.gain.value += (wind - this.windGain.gain.value) * k;
    this.windBP.frequency.value = 450 + Math.min(1600, q / 40 + heat * 900);
  }

  // Short filtered burst: staging, chute, touchdown.
  thump(strength = 1) {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 140;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.9 * strength, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.6);
  }

  // Radio blip for mission-control messages (quindar-ish).
  blip() {
    if (!this.ctx || this.ctx.state !== 'running' || this.muted) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = 2525;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.045, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    o.connect(g); g.connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }
}

import { Sim, PHASE } from './sim.js';
import { SceneView } from './scene.js';
import { Hud } from './hud.js';
import { Navball } from './navball.js';
import { AudioFx } from './audio.js';
import { initControls } from './controls.js';
import { Vab } from './vab.js';
import { loadDesign, applyDesign, DEFAULT_DESIGN } from './craft.js';

// Apply any saved craft design BEFORE the sim/scene read VEHICLE.
const savedDesign = loadDesign();
if (savedDesign) applyDesign(savedDesign);

const canvas = document.getElementById('c');
const sim = new Sim();
const view = new SceneView(canvas);
const hud = new Hud(sim);
const navball = new Navball(document.getElementById('navball'));
const audio = new AudioFx();
hud.audio = audio;

let started = false;
let paused = false;
let autoWarp = false;

// ---- mission records (localStorage; Safari private mode may deny) --------
const RECORD_KEY = 'meridian-record';
function loadRecord() {
  try { return JSON.parse(localStorage.getItem(RECORD_KEY)); } catch { return null; }
}
function saveRecord(stats) {
  try {
    const prev = loadRecord();
    const better = !prev || (stats.orbitAchieved && !prev.orbitAchieved)
      || (stats.orbitAchieved === !!prev.orbitAchieved && stats.met < prev.met);
    if (better) localStorage.setItem(RECORD_KEY, JSON.stringify(stats));
  } catch { /* storage unavailable */ }
}
{
  const rec = loadRecord();
  const line = document.getElementById('record-line');
  if (rec && line) {
    const mins = (rec.met / 60).toFixed(1);
    line.textContent = rec.orbitAchieved
      ? `Program record: orbit achieved and crew recovered in ${mins} min.`
      : `Program record: crew recovered (no orbit yet) in ${mins} min.`;
    line.classList.remove('hidden');
  }
}
let recordSaved = false;

const callbacks = initControls(sim, view, {
  onBegin: () => {
    started = true;
    audio.init();
  },
  onRestart: () => {
    sim.reset();
    sim.throttle = 0;
    autoWarp = false;
    paused = false;
    recordSaved = false;
    document.getElementById('met').classList.remove('paused');
    hud.hideEnd();
    callbacks.syncThrottle();
    view.rebuildVehicle();
    lastStageIndex = 0;
    view.camDist = 0.14;
    view.mapMode = false;
    document.getElementById('btn-map').classList.remove('active');
  },
  onOpenVab: () => {
    paused = false;
    vab.show();
  },
  onTimeOfDay: (key) => {
    view.applyPreset(key);
    try { localStorage.setItem('meridian-tod', key); } catch { /* ok */ }
  },
  onToggleSound: () => {
    audio.init();
    audio.setMuted(!audio.muted);
    return audio.muted;
  },
  onTogglePause: () => {
    if (!started) return false;
    paused = !paused;
    return paused;
  },
  onWarpToAp: () => {
    if (sim.phase !== PHASE.FLIGHT) return;
    autoWarp = true;
    sim.say('FIDO', 'Time compression to apoapsis — engines are safed.');
  },
  onManualWarp: () => { autoWarp = false; },
});

// Vehicle assembly: closing with TO THE PAD resets onto the pad with the
// new craft.
const vab = new Vab(view, () => {
  callbacks.onRestart();
});
vab.setDesign(savedDesign || DEFAULT_DESIGN);

// Restore the launch-time preset.
{
  let tod = 'day';
  try { tod = localStorage.getItem('meridian-tod') || 'day'; } catch { /* ok */ }
  view.applyPreset(tod);
  document.querySelectorAll('.chip.tod').forEach((b) => {
    b.classList.toggle('active', b.dataset.tod === tod);
  });
}

// Auto-warp: pick the warp level from time-to-apoapsis, drop out near it.
function updateAutoWarp() {
  const wapBtn = document.getElementById('btn-wap');
  const el = sim.orbit;
  const eligible = sim.phase === PHASE.FLIGHT && sim.effThrottle === 0
    && sim.altitude > 130_000 && !el.hyperbolic && Number.isFinite(el.tToAp)
    && el.tToAp > 25 && el.apoapsis > sim.altitude + 5_000;
  wapBtn.classList.toggle('hidden', !eligible && !autoWarp);
  wapBtn.classList.toggle('active', autoWarp);
  if (!autoWarp) return;
  if (!eligible || el.tToAp <= 25) {
    autoWarp = false;
    sim.warp = 1;
    if (el.tToAp <= 25) sim.say('GUIDANCE', 'Approaching apoapsis — burn prograde to raise your periapsis.');
    return;
  }
  const t = el.tToAp;
  const target = t > 900 ? 1000 : t > 240 ? 200 : t > 80 ? 50 : t > 40 ? 10 : 4;
  if (sim.warp !== target) sim.setWarp(target);
}

// Detect staging to remove dropped stage meshes.
let lastStageIndex = sim.vs.stageIndex;
let lastPhase = sim.phase;
let lastChute = 0;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  view.resize(w, h);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
resize();

// iOS: block double-tap zoom / pinch page zoom outside the canvas.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

// Resume audio when returning to the app (iOS suspends the context).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') audio.resume();
});

// Keep the screen awake during flight where supported (iOS 16.4+).
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      const lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') requestWakeLock();
      }, { once: true });
      return lock;
    }
  } catch { /* not critical */ }
}
requestWakeLock();

// Debug/automation handle (used by the headless smoke test).
window.__meridian = { sim, view, hud, vab, start: () => { started = true; } };

let last = performance.now();
let hudAccum = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (started && !paused) {
    sim.update(dtReal);
    updateAutoWarp();
  }

  if (sim.vs.stageIndex !== lastStageIndex) {
    for (let i = lastStageIndex; i < sim.vs.stageIndex; i++) view.removeStageMesh(i);
    lastStageIndex = sim.vs.stageIndex;
    audio.thump(1);
  }
  if (sim.vs.chute > 0 && lastChute === 0) audio.thump(0.6);
  lastChute = sim.vs.chute;
  if (sim.phase !== lastPhase) {
    if (sim.phase === PHASE.LANDED || sim.phase === PHASE.LOST) audio.thump(1.2);
    if (sim.phase === PHASE.LANDED && !recordSaved) {
      recordSaved = true;
      saveRecord(sim.endStats);
    }
    lastPhase = sim.phase;
  }

  view.update(sim, dtReal);
  navball.draw(sim);
  audio.update(sim, dtReal);
  hudAccum += dtReal;
  if (hudAccum > 0.12) { hud.update(); hudAccum = 0; }
}
requestAnimationFrame(frame);

// Service worker for offline play.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

import { Sim } from './sim.js';
import { SceneView } from './scene.js';
import { Hud } from './hud.js';
import { initControls } from './controls.js';

const canvas = document.getElementById('c');
const sim = new Sim();
const view = new SceneView(canvas);
const hud = new Hud(sim);

let started = false;
const callbacks = initControls(sim, view, {
  onBegin: () => { started = true; },
  onRestart: () => {
    sim.reset();
    sim.throttle = 0;
    hud.hideEnd();
    callbacks.syncThrottle();
    // Rebuild vessel visuals.
    for (const g of view.stageGroups) view.meshRoot.add(g);
    view.activeBottomY = view.stackBase;
    view.meshRoot.position.y = -view.stackBase;
    lastStageIndex = 0;
    view.camDist = 0.14;
    view.mapMode = false;
    document.getElementById('btn-map').classList.remove('active');
  },
});

// Detect staging to remove dropped stage meshes.
let lastStageIndex = sim.vs.stageIndex;

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
window.__meridian = { sim, view, hud, start: () => { started = true; } };

let last = performance.now();
let hudAccum = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (started) sim.update(dtReal);

  if (sim.vs.stageIndex !== lastStageIndex) {
    for (let i = lastStageIndex; i < sim.vs.stageIndex; i++) view.removeStageMesh(i);
    lastStageIndex = sim.vs.stageIndex;
  }

  view.update(sim, dtReal);
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

// Touch-first input: camera gestures on the canvas, virtual joystick,
// throttle slider, hold-to-stage button, SAS modes, warp stepper.
// Pointer Events cover touch, pen and mouse uniformly.

import { SAS } from './sim.js';
import { MISSION } from './config.js';

const $ = (id) => document.getElementById(id);

export function initControls(sim, view, callbacks = {}) {
  // ---- camera: drag to orbit, pinch to zoom, wheel for desktop ----------
  const canvas = view.renderer.domElement;
  const pointers = new Map();
  let pinchDist = 0;

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    const p = pointers.get(ev.pointerId);
    if (!p) return;
    const dx = ev.clientX - p.x, dy = ev.clientY - p.y;
    p.x = ev.clientX; p.y = ev.clientY;
    if (pointers.size === 1) {
      view.camTheta -= dx * 0.008;
      view.camPhi = Math.min(3.0, Math.max(0.12, view.camPhi - dy * 0.008));
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist > 0 && d > 0) view.setZoom(pinchDist / d);
      pinchDist = d;
    }
  });
  const releasePointer = (ev) => {
    pointers.delete(ev.pointerId);
    pinchDist = 0;
  };
  canvas.addEventListener('pointerup', releasePointer);
  canvas.addEventListener('pointercancel', releasePointer);
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    view.setZoom(Math.exp(ev.deltaY * 0.0012));
  }, { passive: false });

  // ---- virtual joystick: pitch / yaw rate command ------------------------
  const joy = $('joy'), knob = $('joy-knob');
  let joyId = null;
  const joyMax = 42;
  const setJoy = (nx, ny) => {
    knob.style.transform = `translate(${nx * joyMax}px, ${ny * joyMax}px)`;
    // Stick up = pitch downrange; stick x = yaw.
    sim.rotInput.pitch = -ny;
    sim.rotInput.yaw = nx;
  };
  joy.addEventListener('pointerdown', (ev) => {
    joyId = ev.pointerId;
    joy.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  joy.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== joyId) return;
    const r = joy.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let nx = (ev.clientX - cx) / (r.width / 2), ny = (ev.clientY - cy) / (r.height / 2);
    const m = Math.hypot(nx, ny);
    if (m > 1) { nx /= m; ny /= m; }
    setJoy(nx, ny);
  });
  const joyEnd = (ev) => {
    if (ev.pointerId !== joyId) return;
    joyId = null;
    setJoy(0, 0);
  };
  joy.addEventListener('pointerup', joyEnd);
  joy.addEventListener('pointercancel', joyEnd);

  // Roll buttons (hold).
  const bindHold = (el, on, off) => {
    el.addEventListener('pointerdown', (ev) => { ev.preventDefault(); el.setPointerCapture(ev.pointerId); on(); });
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
  };
  bindHold($('roll-l'), () => { sim.rotInput.roll = -1; }, () => { sim.rotInput.roll = 0; });
  bindHold($('roll-r'), () => { sim.rotInput.roll = 1; }, () => { sim.rotInput.roll = 0; });

  // ---- throttle slider ----------------------------------------------------
  const thr = $('throttle'), thrFill = $('throttle-fill');
  let thrId = null;
  const setThrottleFromEvent = (ev) => {
    const r = thr.getBoundingClientRect();
    const frac = 1 - (ev.clientY - r.top) / r.height;
    sim.throttle = Math.min(1, Math.max(0, frac));
    thrFill.style.height = (sim.throttle * 100) + '%';
  };
  thr.addEventListener('pointerdown', (ev) => {
    thrId = ev.pointerId;
    thr.setPointerCapture(ev.pointerId);
    ev.preventDefault();
    setThrottleFromEvent(ev);
  });
  thr.addEventListener('pointermove', (ev) => { if (ev.pointerId === thrId) setThrottleFromEvent(ev); });
  thr.addEventListener('pointerup', () => { thrId = null; });
  thr.addEventListener('pointercancel', () => { thrId = null; });
  $('thr-full').addEventListener('click', () => { sim.throttle = 1; thrFill.style.height = '100%'; });
  $('thr-cut').addEventListener('click', () => { sim.throttle = 0; thrFill.style.height = '0%'; });
  // Keep the fill in sync if sim resets.
  callbacks.syncThrottle = () => { thrFill.style.height = (sim.throttle * 100) + '%'; };

  // ---- hold-to-stage ------------------------------------------------------
  const stageBtn = $('btn-stage');
  const HOLD_MS = 550;
  let stageTimer = null, stageDownAt = 0, stageFired = false;
  const stageFire = () => {
    if (stageFired) return;
    stageFired = true;
    stageBtn.classList.remove('arming');
    sim.stageAction();
    if (navigator.vibrate) navigator.vibrate(30);
  };
  stageBtn.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    stageBtn.setPointerCapture(ev.pointerId);
    stageBtn.classList.add('arming');
    stageDownAt = performance.now();
    stageFired = false;
    stageTimer = setTimeout(stageFire, HOLD_MS);
  });
  const stageRelease = () => {
    stageBtn.classList.remove('arming');
    if (stageTimer) { clearTimeout(stageTimer); stageTimer = null; }
    // If a slow frame delayed the timer past the release, honor the hold.
    if (stageDownAt && performance.now() - stageDownAt >= HOLD_MS) stageFire();
    stageDownAt = 0;
  };
  stageBtn.addEventListener('pointerup', stageRelease);
  stageBtn.addEventListener('pointercancel', stageRelease);

  $('btn-chute').addEventListener('click', () => sim.deployChute());

  // ---- SAS ----------------------------------------------------------------
  const sasBtns = {
    [SAS.HOLD]: $('sas-hold'),
    [SAS.PROGRADE]: $('sas-pro'),
    [SAS.RETROGRADE]: $('sas-retro'),
  };
  const setSas = (mode) => {
    sim.sas = mode;
    for (const [m, b] of Object.entries(sasBtns)) b.classList.toggle('active', m === mode);
  };
  for (const [mode, btn] of Object.entries(sasBtns)) {
    btn.addEventListener('click', () => setSas(mode));
  }
  setSas(SAS.HOLD);
  callbacks.syncSas = () => setSas(sim.sas);

  // ---- warp ----------------------------------------------------------------
  const warpStep = (dir) => {
    const levels = MISSION.warpLevels;
    const i = levels.indexOf(sim.warp);
    const next = levels[Math.min(levels.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))];
    sim.setWarp(next);
    if (callbacks.onManualWarp) callbacks.onManualWarp(); // cancels auto-warp
  };
  $('warp-down').addEventListener('click', () => warpStep(-1));
  $('warp-up').addEventListener('click', () => warpStep(1));

  $('btn-wap').addEventListener('click', () => callbacks.onWarpToAp && callbacks.onWarpToAp());

  // ---- misc ----------------------------------------------------------------
  $('btn-snd').addEventListener('click', () => {
    const muted = callbacks.onToggleSound ? callbacks.onToggleSound() : false;
    $('btn-snd').classList.toggle('active', !muted);
    $('btn-snd').textContent = muted ? 'MUTE' : 'SND';
  });
  $('met').addEventListener('click', () => {
    const paused = callbacks.onTogglePause ? callbacks.onTogglePause() : false;
    $('met').classList.toggle('paused', paused);
  });
  $('btn-map').addEventListener('click', () => {
    view.toggleMap();
    $('btn-map').classList.toggle('active', view.mapMode);
  });
  $('btn-restart').addEventListener('click', () => callbacks.onRestart && callbacks.onRestart());
  $('end-restart').addEventListener('click', () => callbacks.onRestart && callbacks.onRestart());
  $('btn-begin').addEventListener('click', () => {
    document.getElementById('start-overlay').classList.add('hidden');
    callbacks.onBegin && callbacks.onBegin();
  });

  return callbacks;
}

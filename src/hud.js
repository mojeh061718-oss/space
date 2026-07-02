// DOM HUD: telemetry readouts, mission-control message feed, overlays.

import { PHASE } from './sim.js';
import { VEHICLE } from './config.js';
import * as vehicle from './vehicle.js';

const $ = (id) => document.getElementById(id);

export function fmtDist(m) {
  if (!Number.isFinite(m)) return '—';
  if (Math.abs(m) >= 1_000_000) return (m / 1_000_000).toFixed(2) + ' Mm';
  if (Math.abs(m) >= 10_000) return (m / 1000).toFixed(1) + ' km';
  if (Math.abs(m) >= 1000) return (m / 1000).toFixed(2) + ' km';
  return m.toFixed(0) + ' m';
}
export function fmtSpeed(v) {
  if (v >= 10_000) return (v / 1000).toFixed(2) + ' km/s';
  return v.toFixed(0) + ' m/s';
}
export function fmtTime(s) {
  if (!Number.isFinite(s)) return '—';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  return `${m}:${String(ss).padStart(2, '0')}`;
}

export class Hud {
  constructor(sim) {
    this.sim = sim;
    this.lastMsgCount = 0;
    this.els = {
      met: $('met'), warp: $('warp-val'),
      alt: $('v-alt'), vel: $('v-vel'), vsi: $('v-vsi'),
      ap: $('v-ap'), pe: $('v-pe'), tap: $('v-tap'),
      twr: $('v-twr'), dv: $('v-dv'), g: $('v-g'),
      stage: $('v-stage'), fuelbar: $('fuel-fill'),
      pitch: $('v-pitch'),
      msgs: $('msgs'),
      throttlePct: $('throttle-pct'),
      stageBtn: $('btn-stage'), stageLabel: $('stage-label'),
      chuteBtn: $('btn-chute'),
      end: $('end-overlay'), endTitle: $('end-title'), endBody: $('end-body'),
      endStats: $('end-stats'),
    };
  }

  update() {
    const s = this.sim;
    const el = s.orbit;
    const e = this.els;
    const flying = s.phase !== PHASE.PRELAUNCH;

    e.met.textContent = (s.phase === PHASE.PRELAUNCH ? 'T−READY' : 'T+' + fmtTime(s.met));
    e.warp.textContent = s.warp + '×';
    e.alt.textContent = fmtDist(Math.max(0, s.altitude));
    e.vel.textContent = fmtSpeed(s.speed);
    const vs = s.verticalSpeed;
    e.vsi.textContent = (vs >= 0 ? '+' : '') + fmtSpeed(Math.abs(vs)).replace(' ', ' ');

    const validOrbit = flying && s.speed > 100;
    e.ap.textContent = validOrbit && !el.hyperbolic ? fmtDist(el.apoapsis) : (validOrbit ? 'ESC' : '—');
    e.pe.textContent = validOrbit ? fmtDist(el.periapsis) : '—';
    e.tap.textContent = validOrbit && Number.isFinite(el.tToAp) ? fmtTime(el.tToAp) : '—';

    e.twr.textContent = s.stage.thrustVac > 0 && s.vs.prop[s.vs.stageIndex] > 0 ? s.twr.toFixed(2) : '—';
    e.dv.textContent = Math.round(s.deltaV()) + ' m/s';
    e.g.textContent = s.gForce.toFixed(1) + ' g';
    e.pitch.textContent = Math.round(s.pitchDeg) + '°';

    const st = s.stage;
    e.stage.textContent = st.name;
    e.fuelbar.style.width = (s.stagePropFrac() * 100).toFixed(1) + '%';
    e.throttlePct.textContent = Math.round(s.throttle * 100) + '%';

    // Contextual buttons.
    const capsule = vehicle.isCapsuleOnly(s.vs);
    e.stageLabel.textContent = s.phase === PHASE.PRELAUNCH ? 'IGNITE' : 'STAGE';
    e.stageBtn.classList.toggle('hidden', capsule || s.phase === PHASE.LANDED || s.phase === PHASE.LOST);
    e.chuteBtn.classList.toggle('hidden', !capsule || s.vs.chuteArmed || s.phase !== PHASE.FLIGHT);

    // Message feed.
    if (s.messages.length !== this.lastMsgCount) {
      const fresh = s.messages.slice(this.lastMsgCount === 0 ? -1 : this.lastMsgCount - s.messages.length);
      this.lastMsgCount = s.messages.length;
      for (const m of fresh.slice(-3)) this.pushMsg(m);
    }

    // End screen.
    if ((s.phase === PHASE.LANDED || s.phase === PHASE.LOST) && s.endStats && !this.endShown) {
      this.endShown = true;
      setTimeout(() => this.showEnd(), 1200);
    }
  }

  pushMsg(m) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<span class="who">${m.who}</span>${m.text}`;
    this.els.msgs.appendChild(div);
    while (this.els.msgs.children.length > 3) this.els.msgs.firstChild.remove();
    setTimeout(() => { div.classList.add('fade'); }, 9000);
    setTimeout(() => { if (div.parentNode) div.remove(); }, 10_000);
  }

  showEnd() {
    const s = this.sim;
    const ok = s.phase === PHASE.LANDED;
    this.els.endTitle.textContent = ok ? 'MISSION COMPLETE' : 'LOSS OF VEHICLE';
    this.els.endTitle.className = ok ? 'good' : 'bad';
    this.els.endBody.textContent = s.endStats.text;
    const rows = [
      ['Mission time', fmtTime(s.endStats.met)],
      ['Max speed', fmtSpeed(s.endStats.maxSpeed)],
      ['Max g-load', s.endStats.maxG.toFixed(1) + ' g'],
      ['Highest apoapsis', fmtDist(s.endStats.apoapsisReached)],
      ['Stable orbit', s.endStats.orbitAchieved ? 'ACHIEVED' : 'not reached'],
      ['Crew', ok ? VEHICLE.crew.join(', ') + ' — safe' : 'lost'],
    ];
    this.els.endStats.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    this.els.end.classList.remove('hidden');
  }

  hideEnd() {
    this.endShown = false;
    this.els.end.classList.add('hidden');
    this.els.msgs.innerHTML = '';
    this.lastMsgCount = 0;
  }
}

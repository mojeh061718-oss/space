// Mission simulation: owns the vessel state, attitude, staging, time warp,
// debris, and the mission event/message stream. Pure JS — runs in the
// browser and headless in Node for tests.

import { PLANET, VEHICLE, MISSION, G0 } from './config.js';
import { rk4Step, atmoDensity, heatFlux, localGravity, engineThrust } from './physics.js';
import { orbitalElements } from './orbit.js';
import * as vehicle from './vehicle.js';

// --- minimal quaternion helpers (x,y,z,w) ---------------------------------
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxisAngle = (ax, angle) => {
  const s = Math.sin(angle / 2);
  return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(angle / 2)];
};
const qNormalize = (q) => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const qRotate = (q, v) => {
  // v' = q v q*
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
};
const vNorm = (v) => Math.hypot(v[0], v[1], v[2]);
const vHat = (v) => { const n = vNorm(v) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const SAS = { MANUAL: 'manual', HOLD: 'hold', PROGRADE: 'prograde', RETROGRADE: 'retrograde' };
export const PHASE = { PRELAUNCH: 'prelaunch', COUNTDOWN: 'countdown', FLIGHT: 'flight', LANDED: 'landed', LOST: 'lost' };

// Body axes: ship "forward" (thrust direction / nose) is local +Y.
const FORWARD = [0, 1, 0];

export class Sim {
  constructor() {
    this.reset();
  }

  reset() {
    const R = PLANET.radius;
    this.vs = vehicle.createVehicleState();
    // Pad on the equator at +X; east is +Z. Body center a bit above surface.
    // The physics point tracks the BOTTOM of the active stack (so ground
    // contact is simply altitude <= 0). It rests on the 4 m launch plinth.
    this.padUp = [1, 0, 0];
    this.r = [R + 4.5, 0, 0];
    this.v = [0, 0, 0];
    // Nose pointing radially out (+X), with ship belly toward -Z: rotate
    // local +Y onto +X (about Z by -90 deg).
    this.q = qNormalize(qAxisAngle([0, 0, 1], -Math.PI / 2));
    this.throttle = 0;
    this.rotInput = { pitch: 0, yaw: 0, roll: 0 }; // -1..1 rate commands
    this.sas = SAS.HOLD;
    this.warp = 1;
    this.met = 0;          // mission elapsed time, s (counts from liftoff)
    this.clock = 0;        // total sim time
    this.phase = PHASE.PRELAUNCH;
    this.countdown = 0;    // s remaining in the auto sequence
    this.ignRamp = 0;      // 0..1 engine thrust ramp during ignition
    this.debris = [];
    this.messages = [];
    this.msgTotal = 0;       // monotonic count (messages array is capped)
    this.flags = new Set();
    this.maxQSeen = 0; this.maxQFalling = false;
    this.peakHeat = 0;
    this.gForce = 0; this.maxG = 0;
    this.maxSpeed = 0;
    this.heat = 0;
    this.endStats = null;
    this.say('FLIGHT', `${VEHICLE.name} on ${PLANET.name === 'Earth' ? 'the pad' : 'the pad'}, crew of ${VEHICLE.crew.length} aboard. Throttle up and hold STAGE to ignite when ready.`);
  }

  say(who, text) {
    this.messages.push({ who, text, t: this.clock });
    this.msgTotal++;
    if (this.messages.length > 60) this.messages.shift();
  }
  once(flag, who, text) {
    if (this.flags.has(flag)) return false;
    this.flags.add(flag);
    if (text) this.say(who, text);
    return true;
  }

  get altitude() { return vNorm(this.r) - PLANET.radius; }
  get speed() { return vNorm(this.v); }
  get mass() { return vehicle.totalMass(this.vs); }
  get facing() { return qRotate(this.q, FORWARD); }
  get up() { return vHat(this.r); }
  get stage() { return vehicle.activeStage(this.vs); }

  get orbit() { return orbitalElements(this.r, this.v); }

  // Vertical speed and surface-frame speed (planet doesn't rotate, so the
  // surface frame equals the inertial frame — flagged simplification).
  get verticalSpeed() { return vDot(this.v, this.up); }

  get twr() {
    const st = this.stage;
    const { thrust } = engineThrust(st, Math.max(this.effThrottle, 0.0001), this.altitude);
    const t = this.effThrottle > 0 ? thrust : engineThrust(st, 1, this.altitude).thrust;
    return t / (this.mass * localGravity(this.r));
  }

  // Displayed throttle maps onto [minThrottle, 1] when nonzero (engines
  // can't deep-throttle below their limit). Engines only burn once the
  // ignition sequence commands them (countdown ramp) or in free flight.
  get effThrottle() {
    if (this.phase !== PHASE.FLIGHT && this.phase !== PHASE.COUNTDOWN) return 0;
    const st = this.stage;
    if (this.throttle <= 0 || !st || st.thrustVac === 0 || this.vs.prop[this.vs.stageIndex] <= 0) return 0;
    const base = st.minThrottle + (1 - st.minThrottle) * this.throttle;
    return this.phase === PHASE.COUNTDOWN ? base * this.ignRamp : base;
  }

  get pitchDeg() {
    // Angle of nose above local horizon.
    return 90 - Math.acos(Math.max(-1, Math.min(1, vDot(this.facing, this.up)))) * 180 / Math.PI;
  }

  deltaV() { return vehicle.deltaVRemaining(this.vs); }
  stagePropFrac() {
    const i = this.vs.stageIndex;
    return VEHICLE.stages[i].propMass > 0 ? this.vs.prop[i] / VEHICLE.stages[i].propMass : 0;
  }

  setWarp(level) {
    if (level > 1 && this.phase === PHASE.COUNTDOWN) return false;
    if (level > MISSION.maxWarpAtmo) {
      if (this.altitude < 130_000 || this.effThrottle > 0 || this.phase !== PHASE.FLIGHT) {
        this.say('FIDO', 'Time compression above 4x requires coasting above 130 km.');
        return false;
      }
    }
    this.warp = level;
    return true;
  }

  stageAction() {
    if (this.phase === PHASE.PRELAUNCH) {
      if (this.throttle <= 0) {
        this.say('FLIGHT', 'Set throttle before ignition, pilot.');
        return;
      }
      this.phase = PHASE.COUNTDOWN;
      this.countdown = 4;
      this.warp = 1;
      this.say('FLIGHT', 'Auto sequence start. Ignition in three.');
      return;
    }
    if (this.phase !== PHASE.FLIGHT) return;
    const dropped = vehicle.jettison(this.vs);
    if (!dropped) {
      this.say('FLIGHT', 'Nothing left to stage.');
      return;
    }
    // The physics point tracks the active stack's bottom: move it up past
    // the dropped stage, and spawn the debris body where that stage was.
    const back = this.facing;
    const debrisR = [this.r[0] - back[0] * 2, this.r[1] - back[1] * 2, this.r[2] - back[2] * 2];
    const L = dropped.stage.length;
    this.r = [this.r[0] + back[0] * L, this.r[1] + back[1] * L, this.r[2] + back[2] * L];
    this.debris.push({
      r: debrisR,
      v: [this.v[0] - back[0] * 2.5, this.v[1] - back[1] * 2.5, this.v[2] - back[2] * 2.5],
      m: dropped.mass,
      cdA: 8,
      chute: 0, chuteCdA: 0,
      throttle: 0, stage: null, facing: [0, 1, 0],
      ttl: 240,
      stageName: dropped.stage.name,
      length: dropped.stage.length,
      diameter: dropped.stage.diameter,
    });
    this.say('FLIGHT', `${dropped.stage.name} separation confirmed. Clean sep.`);
    if (vehicle.isCapsuleOnly(this.vs)) {
      this.say('FLIGHT', 'Capsule free flight. Heat shield is your forward face — hold RETRO for entry.');
    }
  }

  deployChute() {
    const a = VEHICLE.aero;
    if (!vehicle.isCapsuleOnly(this.vs) || this.vs.chuteArmed) return;
    if (this.altitude > a.chuteDeployAlt || this.speed > a.chuteDeploySpeed) {
      this.say('RECOVERY', `Chute envelope: below ${(a.chuteDeployAlt / 1000).toFixed(0)} km and ${a.chuteDeploySpeed} m/s.`);
      return;
    }
    this.vs.chuteArmed = true;
    this.say('RECOVERY', 'Main chutes deployed.');
  }

  // ---- attitude ----------------------------------------------------------
  updateAttitude(dt) {
    const st = this.stage;
    const maxRate = (st.gimbalRate * Math.PI / 180);
    const { pitch, yaw, roll } = this.rotInput;
    const manual = Math.abs(pitch) + Math.abs(yaw) + Math.abs(roll) > 0.01;

    if (manual || this.sas === SAS.MANUAL || this.sas === SAS.HOLD) {
      if (manual) {
        // Rate command about body axes. Body: +Y forward, +X pitch axis,
        // +Z yaw axis, roll about +Y.
        const dq = qMul(
          qMul(
            qAxisAngle(qRotate(this.q, [1, 0, 0]), pitch * maxRate * dt),
            qAxisAngle(qRotate(this.q, [0, 0, 1]), yaw * maxRate * dt),
          ),
          qAxisAngle(qRotate(this.q, [0, 1, 0]), roll * maxRate * dt),
        );
        this.q = qNormalize(qMul(dq, this.q));
      }
      return;
    }

    // SAS prograde/retrograde: rotate nose toward target at limited rate.
    let target = vHat(this.v);
    if (this.speed < 5) return;
    if (this.sas === SAS.RETROGRADE) target = [-target[0], -target[1], -target[2]];
    const f = this.facing;
    const dotFT = Math.max(-1, Math.min(1, vDot(f, target)));
    const ang = Math.acos(dotFT);
    if (ang < 1e-4) return;
    let axis = vCross(f, target);
    if (vNorm(axis) < 1e-6) axis = qRotate(this.q, [1, 0, 0]);
    axis = vHat(axis);
    const step = Math.min(ang, maxRate * dt * (this.warp > 4 ? this.warp : 1));
    this.q = qNormalize(qMul(qAxisAngle(axis, Math.min(step, ang)), this.q));
  }

  // ---- main update -------------------------------------------------------
  update(realDt) {
    if (this.phase === PHASE.LANDED || this.phase === PHASE.LOST) return;
    if (this.phase === PHASE.COUNTDOWN) {
      this.warp = 1;
      this.countdown -= realDt;
      this.ignRamp = this.countdown <= 3 ? Math.min(1, (3 - this.countdown) / 1.6) : 0;
      if (this.countdown <= 0) {
        this.phase = PHASE.FLIGHT;
        this.met = 0;
        this.ignRamp = 1;
        this.say('FLIGHT', `Hold-down release — liftoff of ${VEHICLE.name}. Tower on your right.`);
      }
    }
    let simDt = realDt * this.warp;
    // Auto-drop warp when hitting atmosphere.
    if (this.warp > MISSION.maxWarpAtmo && (this.altitude < 125_000 || this.effThrottle > 0)) {
      this.warp = MISSION.maxWarpAtmo;
      this.say('FIDO', 'Atmospheric interface — time compression reduced.');
      simDt = realDt * this.warp;
    }

    const inAtmo = this.altitude < PLANET.atmo.cutoff + 10_000;
    const burning = this.effThrottle > 0;
    const maxStep = (inAtmo || burning) ? 0.02 : 0.5;
    let steps = Math.min(1000, Math.ceil(simDt / maxStep));
    const dt = simDt / steps;

    for (let i = 0; i < steps; i++) {
      this.updateAttitude(dt);
      this.stepPhysics(dt);
      if (this.phase !== PHASE.FLIGHT && this.phase !== PHASE.PRELAUNCH) break;
    }
    this.stepDebris(simDt);
    this.checkEvents();
    this.clock += simDt;
    if (this.phase === PHASE.FLIGHT) this.met += simDt;
  }

  stepPhysics(dt) {
    const a = VEHICLE.aero;
    const capsule = vehicle.isCapsuleOnly(this.vs);
    const si = this.vs.stageIndex;
    const st = this.stage;
    let thr = this.effThrottle;

    // Clamp the step to remaining burn time so mass never goes negative.
    if (thr > 0) {
      const { mdot } = engineThrust(st, thr, this.altitude);
      const tBurn = this.vs.prop[si] / mdot;
      if (tBurn <= 0) thr = 0;
      else if (tBurn < dt) dt = Math.max(tBurn, 1e-4);
    }

    // Chute inflation ramp.
    if (this.vs.chuteArmed && this.vs.chute < 1) {
      this.vs.chute = Math.min(1, this.vs.chute + dt / a.chuteOpenTime);
    }

    const body = {
      r: this.r, v: this.v, m: this.mass,
      facing: this.facing,
      throttle: thr, stage: st,
      cdA: capsule ? a.capsuleCd * a.capsuleArea : a.stackCd * a.stackArea,
      chute: this.vs.chute, chuteCdA: a.chuteCdA,
    };
    const m0 = body.m;
    rk4Step(body, dt);
    this.r = body.r; this.v = body.v;
    const burned = m0 - body.m;
    if (burned > 0) this.vs.prop[si] = Math.max(0, this.vs.prop[si] - burned);

    // Ground contact.
    const alt = this.altitude;
    const held = this.phase === PHASE.PRELAUNCH || this.phase === PHASE.COUNTDOWN;
    if (held || alt <= 0.5) {
      const vs = this.verticalSpeed;
      if (vs <= 0 && (held ? alt <= 4.6 : alt <= 0.5)) {
        if (held || (this.met < 10 && this.speed < 3)) {
          // Held on the pad.
          const R = PLANET.radius + 4.5;
          this.r = vHat(this.r).map((c) => c * R);
          this.v = [0, 0, 0];
        } else {
          this.touchdown();
          return;
        }
      }
    }

    // Track dynamic pressure, g-load, heating.
    const rho = atmoDensity(alt);
    const spd = this.speed;
    this.maxSpeed = Math.max(this.maxSpeed, spd);
    const qDyn = 0.5 * rho * spd * spd;
    if (qDyn > this.maxQSeen) { this.maxQSeen = qDyn; this.maxQFalling = false; }
    else if (qDyn < this.maxQSeen * 0.85 && this.maxQSeen > 5000) this.maxQFalling = true;
    this.qDyn = qDyn;

    const { thrust } = engineThrust(st, thr, alt);
    const dragA = qDyn * body.cdA * (1 + (this.vs.chute || 0) * (a.chuteCdA / body.cdA)) / this.mass;
    this.gForce = Math.hypot(thrust / this.mass, dragA) / G0;
    this.maxG = Math.max(this.maxG, this.gForce);

    this.heat = heatFlux(alt, spd);
    this.peakHeat = Math.max(this.peakHeat, this.heat);
    // Stack (no heat shield) breaks up under severe heating; the capsule's
    // shield protects it regardless of attitude (simplification).
    if (!capsule && this.heat > 6.0e9 && this.phase === PHASE.FLIGHT) {
      this.phase = PHASE.LOST;
      this.endStats = this.buildEndStats('Vehicle broke up under reentry heating — the stack has no heat shield. Separate the capsule before entry.');
      this.say('FLIGHT', 'We have lost the vehicle. Structural breakup during entry.');
    }

    // Recovery automation.
    if (capsule && !this.vs.chuteArmed && alt < a.chuteAutoAlt && spd < a.chuteDeploySpeed && this.verticalSpeed < 0) {
      this.vs.chuteArmed = true;
      this.say('RECOVERY', 'Auto-sequence: main chutes deployed.');
    }
  }

  touchdown() {
    const spd = this.speed;
    const capsule = vehicle.isCapsuleOnly(this.vs);
    const safe = capsule && spd <= 16;
    this.v = [0, 0, 0];
    const R = PLANET.radius;
    this.r = vHat(this.r).map((c) => c * R);
    if (safe) {
      this.phase = PHASE.LANDED;
      this.endStats = this.buildEndStats(spd <= 12
        ? 'Splashdown. Recovery teams en route — crew is in good spirits.'
        : 'Hard splashdown, but the crew is safe.');
      this.say('RECOVERY', `Splashdown confirmed at ${spd.toFixed(1)} m/s. Welcome home.`);
    } else {
      this.phase = PHASE.LOST;
      this.endStats = this.buildEndStats(capsule
        ? `Impact at ${spd.toFixed(0)} m/s — chutes ${this.vs.chute > 0 ? 'opened too late' : 'never opened'}.`
        : `Vehicle impacted the surface at ${spd.toFixed(0)} m/s.`);
      this.say('FLIGHT', 'Loss of vehicle confirmed.');
    }
  }

  buildEndStats(text) {
    return {
      text,
      met: this.met,
      maxSpeed: this.maxSpeed,
      maxG: this.maxG,
      apoapsisReached: this.bestApoapsis || 0,
      orbitAchieved: this.flags.has('orbit'),
    };
  }

  stepDebris(dt) {
    const steps = Math.max(1, Math.ceil(dt / 0.1));
    const h = dt / steps;
    for (const d of this.debris) {
      for (let i = 0; i < steps; i++) rk4Step(d, h);
      d.ttl -= dt;
    }
    this.debris = this.debris.filter((d) =>
      d.ttl > 0 && vNorm(d.r) > PLANET.radius);
  }

  checkEvents() {
    if (this.phase !== PHASE.FLIGHT) return;
    const alt = this.altitude;
    const el = this.orbit;
    this.bestApoapsis = Math.max(this.bestApoapsis || 0, el.apoapsis);

    if (alt > 150) this.once('tower', 'FLIGHT', 'Tower cleared. Roll program complete — begin pitching downrange (east) around 1 km.');
    if (alt > 1500) this.once('gturn', 'GUIDANCE', 'Start your gravity turn: pitch over gently toward the horizon as you climb. Aim for ~45° by 12 km.');
    if (this.maxQFalling) this.once('maxq', 'FLIGHT', 'Max Q. Vehicle is through maximum dynamic pressure.');
    if (this.vs.stageIndex === 0 && this.stagePropFrac() < 0.04) this.once('s1low', 'BOOSTER', 'Stage I propellant low — stand by for MECO and separation.');
    if (this.vs.stageIndex === 0 && this.vs.prop[0] <= 0) this.once('meco', 'FLIGHT', 'MECO. Stage when ready.');
    if (alt > 70_000) this.once('space', 'FLIGHT', 'Passing 70 km — thin air. Almost out of the atmosphere.');
    if (el.apoapsis > MISSION.targetOrbit && this.effThrottle > 0 && this.vs.stageIndex >= 1) {
      this.once('apok', 'GUIDANCE', `Apoapsis ${(el.apoapsis / 1000).toFixed(0)} km — cut throttle and coast. Circularize with a prograde burn at apoapsis (watch time-to-Ap).`);
    }
    if (el.periapsis > MISSION.stableOrbitPe && el.apoapsis > MISSION.stableOrbitPe) {
      if (this.once('orbit', 'FLIGHT', `Orbit confirmed: ${(el.apoapsis / 1000).toFixed(0)} × ${(el.periapsis / 1000).toFixed(0)} km. Outstanding work. When ready to come home: burn RETRO until periapsis drops to ~30 km, then separate the capsule.`)) {
        this.orbitElements0 = { ap: el.apoapsis, pe: el.periapsis };
      }
    }
    if (this.flags.has('orbit') && el.periapsis < 60_000 && el.periapsis > -1000 && this.effThrottle === 0) {
      this.once('deorbit', 'FLIGHT', 'Deorbit burn complete. Separate the capsule and hold RETRO — heat shield forward.');
    }
    if (this.flags.has('orbit') && alt < MISSION.entryInterface && this.verticalSpeed < 0) {
      this.once('entry', 'FLIGHT', 'Entry interface. Expect comm blackout through peak heating.');
    }
    if (this.heat > 8e8 && vehicle.isCapsuleOnly(this.vs)) this.once('plasma', 'CAPCOM', 'Plasma forming — you are in the blackout. Hang on.');
    if (this.flags.has('plasma') && this.heat < 2e8 && alt < 40_000) this.once('blackout-out', 'CAPCOM', 'Out of blackout, we read you. Chutes arm below 7 km and 300 m/s.');
  }
}

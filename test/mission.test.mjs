// Headless full-mission test: launch -> gravity turn -> stable orbit ->
// deorbit -> reentry -> splashdown. Run with: node test/mission.test.mjs
// This exercises the exact physics the game uses; if this passes, the
// rocket as configured can fly the MVP mission.

import { Sim, SAS, PHASE } from '../src/sim.js';
import { MISSION } from '../src/config.js';

const sim = new Sim();
const dt = 1 / 30;
let fail = (msg) => { console.error('FAIL:', msg); process.exit(1); };
const log = (msg) => console.log(`  t=${sim.met.toFixed(0).padStart(5)}s alt=${(sim.altitude / 1000).toFixed(1).padStart(6)}km v=${sim.speed.toFixed(0).padStart(4)} | ${msg}`);

// Simple ascent guidance: pitch program via direct attitude command.
function setPitch(pitchDegFromVertical) {
  // Nose direction = rotate "up" toward east (+Z tangent at launch meridian)
  // by pitch angle, in the plane containing up and east.
  const up = sim.up;
  // East at current position for an equatorial launch: h = r x v ... before
  // there is velocity, use +Z projected tangent.
  let east = [
    -(up[1] * 0 - up[2] * 1) , 0, 0,
  ];
  // east = normalize(Z - (Z.up)up)
  const zd = up[2];
  east = [ -zd * up[0], -zd * up[1], 1 - zd * up[2] ];
  const em = Math.hypot(...east); east = east.map((c) => c / em);
  const a = pitchDegFromVertical * Math.PI / 180;
  const dir = [
    up[0] * Math.cos(a) + east[0] * Math.sin(a),
    up[1] * Math.cos(a) + east[1] * Math.sin(a),
    up[2] * Math.cos(a) + east[2] * Math.sin(a),
  ];
  // Directly set the quaternion to point local +Y at dir.
  const f = [0, 1, 0];
  const dotFV = f[0] * dir[0] + f[1] * dir[1] + f[2] * dir[2];
  const ax = [
    f[1] * dir[2] - f[2] * dir[1],
    f[2] * dir[0] - f[0] * dir[2],
    f[0] * dir[1] - f[1] * dir[0],
  ];
  const axm = Math.hypot(...ax);
  if (axm < 1e-9) return;
  const ang = Math.acos(Math.max(-1, Math.min(1, dotFV)));
  const s = Math.sin(ang / 2);
  sim.q = [ax[0] / axm * s, ax[1] / axm * s, ax[2] / axm * s, Math.cos(ang / 2)];
}

console.log('== ASCENT ==');
console.log(`dV budget at liftoff: ${sim.deltaV().toFixed(0)} m/s (need ~9400 for LEO)`);
sim.throttle = 1;
sim.sas = SAS.MANUAL;
sim.stageAction(); // ignition

let staged2 = false;
let cutoff = false;
for (let t = 0; t < 1200 && !cutoff; t += dt) {
  // Pitch program: sqrt profile with time-to-apoapsis feedback (stay more
  // vertical when Ap is falling toward us, push horizontal when it runs away).
  const alt = sim.altitude;
  let pitch = 0;
  if (alt > 800) {
    pitch = 90 * Math.min(1, Math.sqrt(alt / 110_000));
    if (alt > 30_000 && Number.isFinite(sim.orbit.tToAp)) {
      const corr = Math.max(-25, Math.min(30, (60 - sim.orbit.tToAp) * 0.5));
      pitch = Math.max(20, Math.min(90, pitch - corr));
    }
  }
  setPitch(pitch);
  sim.update(dt);

  if (sim.vs.stageIndex === 0 && sim.vs.prop[0] <= 0) {
    log('MECO -> staging');
    sim.stageAction();
    staged2 = true;
  }
  if (alt > 20_000 && sim.orbit.apoapsis > MISSION.targetOrbit) {
    sim.throttle = 0;
    cutoff = true;
    log(`Ap ${(sim.orbit.apoapsis / 1000).toFixed(1)} km reached, engine cutoff`);
  }
  if (sim.phase === PHASE.LOST) fail('vehicle lost during ascent: ' + sim.endStats.text);
}
if (!staged2) fail('never staged');
if (!cutoff) fail('never reached target apoapsis');

console.log('== COAST TO AP ==');
sim.sas = SAS.PROGRADE;
sim.setWarp(50);
while (sim.orbit.tToAp > 20 && sim.altitude > 0) sim.update(dt);
sim.warp = 1;
log(`near apoapsis, tToAp=${sim.orbit.tToAp.toFixed(0)}s Pe=${(sim.orbit.periapsis / 1000).toFixed(1)}km`);

console.log('== CIRCULARIZE ==');
sim.throttle = 1;
let circOk = false;
for (let t = 0; t < 300; t += dt) {
  sim.update(dt);
  if (sim.orbit.periapsis > MISSION.stableOrbitPe + 20_000) {
    sim.throttle = 0; circOk = true; break;
  }
  if (sim.vs.prop[1] <= 0) fail('stage 2 ran dry before circularization');
}
if (!circOk) fail('circularization did not raise periapsis');
const el = sim.orbit;
log(`ORBIT: ${(el.apoapsis / 1000).toFixed(1)} x ${(el.periapsis / 1000).toFixed(1)} km, period ${(el.period / 60).toFixed(1)} min`);
if (!sim.flags.has('orbit')) fail('orbit event never fired');
console.log(`dV remaining in orbit: ${sim.deltaV().toFixed(0)} m/s`);

console.log('== COAST HALF ORBIT, DEORBIT ==');
sim.setWarp(200) || fail('warp to 200 refused in orbit');
const tCoast = el.period / 2;
let coasted = 0;
while (coasted < tCoast) { sim.update(dt); coasted += dt * sim.warp; }
sim.warp = 1;
sim.sas = SAS.RETROGRADE;
for (let t = 0; t < 60; t += dt) sim.update(dt); // let SAS swing around
sim.throttle = 1;
let deorbited = false;
for (let t = 0; t < 400; t += dt) {
  sim.update(dt);
  if (sim.orbit.periapsis < 25_000) { sim.throttle = 0; deorbited = true; break; }
  if (sim.vs.prop[1] <= 0) break;
}
if (!deorbited) fail(`deorbit failed, Pe=${(sim.orbit.periapsis / 1000).toFixed(0)}km, s2 prop=${sim.vs.prop[1].toFixed(0)}kg`);
log(`deorbit burn done, Pe=${(sim.orbit.periapsis / 1000).toFixed(1)}km`);
sim.stageAction(); // separate capsule
if (!sim.vs || sim.vs.stageIndex !== 2) fail('capsule separation failed');

console.log('== REENTRY ==');
sim.sas = SAS.RETROGRADE;
sim.setWarp(4);
let guard = 0;
while (sim.phase === PHASE.FLIGHT && guard < 4_000_000) {
  sim.update(dt);
  guard++;
  if (sim.altitude < 50_000 && sim.warp > 1) sim.warp = 1;
}
if (sim.phase !== PHASE.LANDED) fail(`mission ended as ${sim.phase}: ${sim.endStats?.text}`);
log(`SPLASHDOWN — ${sim.endStats.text}`);
console.log(`  MET ${(sim.met / 60).toFixed(1)} min, max speed ${sim.maxSpeed.toFixed(0)} m/s, max G ${sim.maxG.toFixed(1)}`);
console.log('\nALL CHECKS PASSED');

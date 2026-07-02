// Stage bookkeeping: masses, delta-v budget, staging.

import { VEHICLE, G0 } from './config.js';

export function createVehicleState() {
  return {
    stageIndex: 0, // index into VEHICLE.stages of the currently active stage
    prop: VEHICLE.stages.map((s) => s.propMass),
    chute: 0,        // 0..1 inflation
    chuteArmed: false,
  };
}

export function activeStage(vs) {
  return VEHICLE.stages[vs.stageIndex];
}

// Total mass of everything from the active stage upward.
export function totalMass(vs) {
  let m = 0;
  for (let i = vs.stageIndex; i < VEHICLE.stages.length; i++) {
    m += VEHICLE.stages[i].dryMass + vs.prop[i];
  }
  return m;
}

export function isCapsuleOnly(vs) {
  return vs.stageIndex === VEHICLE.stages.length - 1;
}

// Remaining delta-v (vacuum Isp, ideal rocket equation), summed over stages.
// SIMPLIFICATION: quoted with vacuum Isp and no gravity/drag losses — the
// same convention KSP uses for its vacuum dV readout.
export function deltaVRemaining(vs) {
  let dv = 0;
  let massAbove = 0;
  for (let i = VEHICLE.stages.length - 1; i >= vs.stageIndex; i--) {
    const st = VEHICLE.stages[i];
    const m0 = massAbove + st.dryMass + vs.prop[i];
    const m1 = massAbove + st.dryMass;
    if (st.ispVac > 0 && vs.prop[i] > 0) dv += st.ispVac * G0 * Math.log(m0 / m1);
    massAbove = m0;
  }
  return dv;
}

export function stageDeltaV(vs) {
  const st = activeStage(vs);
  if (st.ispVac <= 0) return 0;
  const m0 = totalMass(vs);
  const m1 = m0 - vs.prop[vs.stageIndex];
  return st.ispVac * G0 * Math.log(m0 / m1);
}

// Drop the current stage; returns the jettisoned stage config or null.
export function jettison(vs) {
  if (vs.stageIndex >= VEHICLE.stages.length - 1) return null;
  const dropped = {
    stage: VEHICLE.stages[vs.stageIndex],
    mass: VEHICLE.stages[vs.stageIndex].dryMass + vs.prop[vs.stageIndex],
  };
  vs.prop[vs.stageIndex] = 0;
  vs.stageIndex++;
  return dropped;
}

// Two-body gravity + thrust + drag, integrated with RK4 in double precision.
// State vector per body: position r[3], velocity v[3], mass m. The planet is
// fixed at the origin (its mass >> vehicle mass).

import { PLANET, G0 } from './config.js';

export function atmoDensity(alt) {
  const a = PLANET.atmo;
  if (alt >= a.cutoff || alt < -500) return alt < -500 ? a.rho0 : 0;
  return a.rho0 * Math.exp(-Math.max(alt, 0) / a.scaleHeight);
}

export function atmoPressure(alt) {
  const a = PLANET.atmo;
  if (alt >= a.cutoff) return 0;
  return a.pressure0 * Math.exp(-Math.max(alt, 0) / a.scaleHeight);
}

// Engine performance vs ambient pressure: mass flow is constant for a given
// throttle; thrust (and thus effective Isp) drops with back-pressure.
export function engineThrust(stage, throttle, alt) {
  if (!stage || stage.thrustVac === 0 || throttle <= 0) return { thrust: 0, mdot: 0 };
  const p = atmoPressure(alt) / PLANET.atmo.pressure0;
  const mdotMax = stage.thrustVac / (G0 * stage.ispVac);
  const mdot = mdotMax * throttle;
  const thrustFull = stage.thrustVac + (stage.thrustSL - stage.thrustVac) * p;
  return { thrust: thrustFull * throttle, mdot };
}

// Acceleration function for RK4. `body` supplies everything that is constant
// across the sub-step: facing (unit thrust direction), throttle, stage,
// cd*A that applies, chute state.
export function derivatives(r, v, m, body) {
  const rm = Math.hypot(r[0], r[1], r[2]);
  const alt = rm - PLANET.radius;
  const gScale = -PLANET.mu / (rm * rm * rm);
  let ax = gScale * r[0], ay = gScale * r[1], az = gScale * r[2];

  let mdot = 0;
  if (body.throttle > 0 && body.stage && body.stage.thrustVac > 0) {
    const e = engineThrust(body.stage, body.throttle, alt);
    const at = e.thrust / m;
    ax += at * body.facing[0];
    ay += at * body.facing[1];
    az += at * body.facing[2];
    mdot = e.mdot;
  }

  const rho = atmoDensity(alt);
  if (rho > 0) {
    const vm = Math.hypot(v[0], v[1], v[2]);
    if (vm > 0.01) {
      const cda = body.cdA + (body.chute || 0) * body.chuteCdA;
      const fd = 0.5 * rho * vm * cda; // N per (m/s), applied opposite v
      const ad = -fd * vm / m / vm;    // = -0.5 rho vm cda / m
      ax += ad * v[0]; ay += ad * v[1]; az += ad * v[2];
    }
  }
  return [v[0], v[1], v[2], ax, ay, az, -mdot];
}

// One RK4 step of size dt. body: {r,v,m, facing, throttle, stage, cdA, chute, chuteCdA}
export function rk4Step(body, dt) {
  const { r, v, m } = body;
  const k1 = derivatives(r, v, m, body);
  const r2 = [r[0] + k1[0] * dt / 2, r[1] + k1[1] * dt / 2, r[2] + k1[2] * dt / 2];
  const v2 = [v[0] + k1[3] * dt / 2, v[1] + k1[4] * dt / 2, v[2] + k1[5] * dt / 2];
  const k2 = derivatives(r2, v2, m + k1[6] * dt / 2, body);
  const r3 = [r[0] + k2[0] * dt / 2, r[1] + k2[1] * dt / 2, r[2] + k2[2] * dt / 2];
  const v3 = [v[0] + k2[3] * dt / 2, v[1] + k2[4] * dt / 2, v[2] + k2[5] * dt / 2];
  const k3 = derivatives(r3, v3, m + k2[6] * dt / 2, body);
  const r4 = [r[0] + k3[0] * dt, r[1] + k3[1] * dt, r[2] + k3[2] * dt];
  const v4 = [v[0] + k3[3] * dt, v[1] + k3[4] * dt, v[2] + k3[5] * dt];
  const k4 = derivatives(r4, v4, m + k3[6] * dt, body);

  body.r = [
    r[0] + dt / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
    r[1] + dt / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
    r[2] + dt / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
  ];
  body.v = [
    v[0] + dt / 6 * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]),
    v[1] + dt / 6 * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]),
    v[2] + dt / 6 * (k1[5] + 2 * k2[5] + 2 * k3[5] + k4[5]),
  ];
  body.m = m + dt / 6 * (k1[6] + 2 * k2[6] + 2 * k3[6] + k4[6]);
}

export function altitudeOf(r) {
  return Math.hypot(r[0], r[1], r[2]) - PLANET.radius;
}

export function localGravity(r) {
  const rm = Math.hypot(r[0], r[1], r[2]);
  return PLANET.mu / (rm * rm);
}

// Convective-heating proxy (Sutton-Graves-ish scaling, unnormalized):
// used only to drive reentry glow and a "peak heating" callout.
export function heatFlux(alt, speed) {
  return Math.sqrt(atmoDensity(alt)) * speed * speed * speed;
}

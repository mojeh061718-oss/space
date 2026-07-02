// Osculating orbital elements from a state vector (two-body / patched-conic).

import { PLANET } from './config.js';

const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

export function orbitalElements(r, v) {
  const mu = PLANET.mu;
  const rm = norm(r);
  const vm = norm(v);
  const h = cross(r, v);
  const hm = norm(h);
  const energy = vm * vm / 2 - mu / rm;
  const a = -mu / (2 * energy); // negative for hyperbolic

  // Eccentricity vector points at periapsis.
  const vxh = cross(v, h);
  const eVec = [
    vxh[0] / mu - r[0] / rm,
    vxh[1] / mu - r[1] / rm,
    vxh[2] / mu - r[2] / rm,
  ];
  const e = norm(eVec);
  const p = hm * hm / mu; // semi-latus rectum

  const rPe = p / (1 + e);
  const rAp = e < 1 ? p / (1 - e) : Infinity;

  // True anomaly.
  let nu = Math.acos(Math.min(1, Math.max(-1, dot(eVec, r) / (e * rm || 1))));
  if (dot(r, v) < 0) nu = 2 * Math.PI - nu;

  const period = e < 1 ? 2 * Math.PI * Math.sqrt(a * a * a / mu) : Infinity;

  // Time to apoapsis / periapsis (elliptic only).
  let tToAp = NaN, tToPe = NaN;
  if (e < 1 && e > 1e-8) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    const M = E - e * Math.sin(E); // mean anomaly, -pi..pi
    const n = 2 * Math.PI / period;
    const mNorm = (M % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    tToPe = (2 * Math.PI - mNorm) / n;
    tToAp = ((Math.PI - M + 2 * Math.PI) % (2 * Math.PI)) / n;
  }

  return {
    a, e, p,
    apoapsis: rAp - PLANET.radius,
    periapsis: rPe - PLANET.radius,
    period,
    trueAnomaly: nu,
    tToAp, tToPe,
    h, eVec,
    energy,
    hyperbolic: e >= 1,
  };
}

// Sample the conic into an array of 3D points (planet-centered, meters) for
// drawing the trajectory. For hyperbolic orbits, clamp to rMax.
export function sampleOrbitPath(el, segments = 180, rMax = PLANET.radius * 12) {
  const { e, p, h, eVec } = el;
  const hm = norm(h);
  if (hm < 1) return [];
  // Perifocal basis: P = periapsis dir, Q = P rotated 90 deg in orbit plane.
  let P;
  if (e > 1e-6) {
    P = [eVec[0] / e, eVec[1] / e, eVec[2] / e];
  } else {
    // Circular: any in-plane direction works.
    const w = [h[0] / hm, h[1] / hm, h[2] / hm];
    const trial = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    P = cross(trial, w);
    const pm = norm(P);
    P = [P[0] / pm, P[1] / pm, P[2] / pm];
  }
  const W = [h[0] / hm, h[1] / hm, h[2] / hm];
  const Q = cross(W, P);

  let nuMax = Math.PI;
  if (e >= 1) {
    // Limit to where r would exceed rMax (and inside the asymptote).
    const cosLim = (p / rMax - 1) / e;
    nuMax = Math.acos(Math.max(-0.999, Math.min(1, cosLim)));
  }
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const nu = -nuMax + (2 * nuMax) * (i / segments);
    const denom = 1 + e * Math.cos(nu);
    if (denom <= 1e-6) continue;
    const rr = p / denom;
    const c = Math.cos(nu), s = Math.sin(nu);
    pts.push([
      rr * (c * P[0] + s * Q[0]),
      rr * (c * P[1] + s * Q[1]),
      rr * (c * P[2] + s * Q[2]),
    ]);
  }
  return pts;
}

// Position on the conic at a given true anomaly (used for Ap/Pe markers).
export function pointAtAnomaly(el, nu) {
  const { e, p, h, eVec } = el;
  const hm = norm(h);
  let P;
  if (e > 1e-6) P = [eVec[0] / e, eVec[1] / e, eVec[2] / e];
  else return null;
  const W = [h[0] / hm, h[1] / hm, h[2] / hm];
  const Q = cross(W, P);
  const rr = p / (1 + e * Math.cos(nu));
  const c = Math.cos(nu), s = Math.sin(nu);
  return [
    rr * (c * P[0] + s * Q[0]),
    rr * (c * P[1] + s * Q[1]),
    rr * (c * P[2] + s * Q[2]),
  ];
}

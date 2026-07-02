// All physics in SI units (m, kg, s). Rendering converts to km.

export const G0 = 9.80665; // standard gravity for Isp conversions

// Earth-like planet. Real radius and gravitational parameter.
// SIMPLIFICATION: the planet does not rotate (no eastward launch bonus of
// ~465 m/s, no Coriolis). The rocket is sized so orbit is reachable anyway.
export const PLANET = {
  name: 'Earth',
  radius: 6_371_000,          // m (real)
  mu: 3.986004418e14,          // m^3/s^2 (real GM)
  atmo: {
    rho0: 1.225,               // kg/m^3 sea-level density (real)
    scaleHeight: 8500,         // m, exponential model (approximation)
    cutoff: 140_000,           // m, density treated as 0 above this
    pressure0: 101_325,        // Pa
  },
  soi: 9.24e8,                 // m, sphere of influence (patched-conic boundary)
};

// Launch site on the equator at (R, 0, 0). Equatorial plane is world XZ,
// "east" (launch azimuth) is +Z, north is +Y.
export const PAD = {
  lat: 0,
  name: 'LC-1, Meridian Space Center',
};

// ---------------------------------------------------------------------------
// Vehicle: "Meridian 1" — a two-stage crewed launcher closely modeled on a
// Falcon-9-class rocket, with a crew capsule on top. Real-ish masses, thrust
// and Isp values.
// ---------------------------------------------------------------------------
export const VEHICLE = {
  name: 'Meridian 1',
  crew: ['CDR V. Okafor', 'PLT S. Lindqvist', 'MS1 D. Aluko'],
  // Stages are ordered bottom (fired first) to top.
  stages: [
    {
      name: 'Stage I',
      dryMass: 25_600,        // kg
      propMass: 395_700,      // kg
      thrustVac: 8_227_000,   // N (9 engines)
      thrustSL: 7_607_000,    // N
      ispVac: 311,            // s
      ispSL: 282,             // s
      engines: 9,
      minThrottle: 0.4,       // deep throttle limit while burning
      length: 41.2,           // m (visual)
      diameter: 3.7,
      gimbalRate: 5,          // deg/s max commanded rotation rate
    },
    {
      name: 'Stage II',
      dryMass: 4_500,
      propMass: 92_670,
      thrustVac: 981_000,
      thrustSL: 610_000,      // (never used at SL in practice)
      ispVac: 348,
      ispSL: 220,
      engines: 1,
      minThrottle: 0.39,
      length: 13.8,
      diameter: 3.7,
      gimbalRate: 4,
    },
    {
      name: 'Capsule',
      dryMass: 9_600,         // kg, crew capsule incl. heat shield + chutes
      propMass: 0,            // RCS attitude only (not modeled as mass)
      thrustVac: 0,
      thrustSL: 0,
      ispVac: 0,
      ispSL: 0,
      engines: 0,
      minThrottle: 0,
      length: 5.0,
      diameter: 3.7,
      gimbalRate: 6,          // RCS rate authority
    },
  ],
  // Aerodynamics. SIMPLIFICATION: constant Cd per configuration (no Mach
  // dependence), frontal area only, no lift, no angle-of-attack effects.
  aero: {
    stackCd: 0.35,
    stackArea: Math.PI * 1.85 * 1.85,   // m^2, 3.7 m diameter
    capsuleCd: 1.30,                     // blunt body, heat shield forward
    capsuleArea: Math.PI * 1.9 * 1.9,
    chuteCdA: 1300,                      // m^2 effective Cd*A, main chutes
    chuteDeployAlt: 7_000,               // m, envelope: below this ...
    chuteDeploySpeed: 300,               // m/s ... and slower than this
    chuteAutoAlt: 2_500,                 // m, recovery automation deploys
    chuteOpenTime: 4.0,                  // s, inflation ramp
  },
};

export const MISSION = {
  targetOrbit: 220_000,        // m target circular altitude (guidance text)
  stableOrbitPe: 140_000,      // m, periapsis above atmosphere = "orbit"
  entryInterface: 120_000,     // m
  maxWarpAtmo: 4,
  warpLevels: [1, 2, 4, 10, 50, 200, 1000],
};

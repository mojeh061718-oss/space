// Craft assembly: part catalog, design -> flight-vehicle compiler, stats.
// A "design" is small JSON: { capsule: id, stages: [{engine, count, tank}] }
// with stages ordered bottom (fired first) to top. Compiling a design
// mutates the shared VEHICLE object that the sim/scene/HUD read.

import { VEHICLE, G0 } from './config.js';

export const ENGINES = {
  m90: {
    name: 'M-90 Kestrel', short: 'M-90',
    thrustSL: 845_000, thrustVac: 914_000, ispSL: 283, ispVac: 311,
    mass: 470, minThrottle: 0.4, gimbal: 5,
    counts: [1, 3, 5, 7, 9],
    blurb: 'Workhorse kerolox booster engine.',
  },
  m90v: {
    name: 'M-90V Vacuum', short: 'M-90V',
    thrustSL: 210_000, thrustVac: 981_000, ispSL: 160, ispVac: 348,
    mass: 620, minThrottle: 0.39, gimbal: 4,
    counts: [1, 3], vacOnly: true,
    blurb: 'Extended-nozzle upper-stage engine. Poor at sea level.',
  },
  hl120: {
    name: 'HL-120 Hydra', short: 'HL-120',
    thrustSL: 32_000, thrustVac: 110_000, ispSL: 210, ispVac: 451,
    mass: 330, minThrottle: 0.15, gimbal: 4,
    counts: [1, 3], vacOnly: true,
    blurb: 'High-efficiency hydrolox. Low thrust, huge Isp.',
  },
  t1600: {
    name: 'T-1600 Titanhawk', short: 'T-1600',
    thrustSL: 1_650_000, thrustVac: 1_830_000, ispSL: 296, ispVac: 328,
    mass: 2_100, minThrottle: 0.5, gimbal: 5,
    counts: [1, 3, 5],
    blurb: 'Heavy staged-combustion booster engine.',
  },
};

// 3.7 m propellant tanks. Dry structure ~5.5% of prop plus interstage.
export const TANKS = {
  s: { name: 'S', prop: 30_000 },
  m: { name: 'M', prop: 60_000 },
  l: { name: 'L', prop: 92_700 },
  xl: { name: 'XL', prop: 160_000 },
  xxl: { name: 'XXL', prop: 395_700 },
};

export const CAPSULES = {
  pilgrim: {
    name: 'Pilgrim', crew: 3, mass: 9_600, length: 5.0,
    blurb: '3-crew orbital capsule. Shield, chutes, 5 t of margin.',
  },
  sparrow: {
    name: 'Sparrow', crew: 2, mass: 6_500, length: 4.2,
    blurb: 'Light 2-crew capsule for hot-rod ascents.',
  },
};

const CREW_NAMES = ['CDR V. Okafor', 'PLT S. Lindqvist', 'MS1 D. Aluko'];
const ROMAN = ['I', 'II', 'III', 'IV'];
const DIA = 3.7;
const TANK_XSEC = Math.PI * (DIA / 2) * (DIA / 2); // m^2
const PROP_DENSITY = 1030;                          // kg/m^3, kerolox bulk

export const DEFAULT_DESIGN = {
  capsule: 'pilgrim',
  stages: [
    { engine: 'm90', count: 9, tank: 'xxl' },
    { engine: 'm90v', count: 1, tank: 'l' },
  ],
};

export function stageLength(st) {
  const tank = TANKS[st.tank];
  return 2.6 + 1.6 + tank.prop / PROP_DENSITY / TANK_XSEC; // bay + domes + tank
}

// Compile a design into VEHICLE-shaped stage configs (without mutating).
export function compile(design) {
  const stages = design.stages.map((st, i) => {
    const e = ENGINES[st.engine];
    const tank = TANKS[st.tank];
    return {
      name: `Stage ${ROMAN[i] || i + 1}`,
      dryMass: Math.round(0.055 * tank.prop + 1200 + st.count * e.mass),
      propMass: tank.prop,
      thrustVac: e.thrustVac * st.count,
      thrustSL: e.thrustSL * st.count,
      ispVac: e.ispVac,
      ispSL: e.ispSL,
      engines: st.count,
      minThrottle: e.minThrottle,
      length: stageLength(st),
      diameter: DIA,
      gimbalRate: e.gimbal,
      engineId: st.engine,
    };
  });
  const cap = CAPSULES[design.capsule];
  stages.push({
    name: cap.name, dryMass: cap.mass, propMass: 0,
    thrustVac: 0, thrustSL: 0, ispVac: 0, ispSL: 0, engines: 0,
    minThrottle: 0, length: cap.length, diameter: DIA, gimbalRate: 6,
    capsule: true, crew: cap.crew,
  });
  return stages;
}

// Per-design performance numbers for the assembly UI.
export function analyze(design) {
  const stages = compile(design);
  let massAbove = 0;
  const perStage = [];
  for (let i = stages.length - 1; i >= 0; i--) {
    const st = stages[i];
    const m0 = massAbove + st.dryMass + st.propMass;
    const m1 = massAbove + st.dryMass;
    const dv = st.ispVac > 0 && st.propMass > 0 ? st.ispVac * G0 * Math.log(m0 / m1) : 0;
    const thrust = i === 0 ? st.thrustSL : st.thrustVac;
    perStage[i] = { dv, twr: thrust > 0 ? thrust / (m0 * G0) : 0, m0 };
    massAbove = m0;
  }
  const warnings = [];
  if (perStage[0].twr < 1.05 && stages[0].thrustSL > 0) {
    warnings.push(`Stage I TWR ${perStage[0].twr.toFixed(2)} — it will not leave the pad.`);
  }
  const s0 = design.stages[0] && ENGINES[design.stages[0].engine];
  if (s0 && s0.vacOnly) warnings.push(`${s0.short} is a vacuum engine — dreadful at sea level.`);
  const totalDv = perStage.reduce((a, s) => a + s.dv, 0);
  if (totalDv < 9_200) warnings.push(`Total ΔV ${Math.round(totalDv)} m/s — LEO needs ~9,400.`);
  return {
    stages, perStage, totalDv,
    liftoffMass: perStage[0].m0,
    padTwr: perStage[0].twr,
    warnings,
  };
}

// Apply a design to the live VEHICLE (the sim reads it on reset).
export function applyDesign(design) {
  const cap = CAPSULES[design.capsule];
  VEHICLE.stages = compile(design);
  VEHICLE.crew = CREW_NAMES.slice(0, cap.crew);
  VEHICLE.aero.capsuleArea = Math.PI * 1.9 * 1.9;
  VEHICLE.aero.stackArea = TANK_XSEC * 1.04;
  return VEHICLE;
}

const CRAFT_KEY = 'meridian-craft';

export function saveDesign(design) {
  try { localStorage.setItem(CRAFT_KEY, JSON.stringify(design)); } catch { /* private mode */ }
}

export function loadDesign() {
  try {
    const d = JSON.parse(localStorage.getItem(CRAFT_KEY));
    if (!d || !CAPSULES[d.capsule] || !Array.isArray(d.stages) || d.stages.length < 1) return null;
    for (const st of d.stages) {
      if (!ENGINES[st.engine] || !TANKS[st.tank] || !ENGINES[st.engine].counts.includes(st.count)) return null;
    }
    return d;
  } catch { return null; }
}

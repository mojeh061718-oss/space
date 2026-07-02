# Meridian — Orbital Flight Simulator

A realistic orbital rocket simulator as an installable Progressive Web App,
built for iPhone. Launch a crewed two-stage rocket from a pad on an
Earth-scale planet, fly a gravity turn to a stable orbit, then deorbit,
survive reentry, and splash down. Real physics, real scale, human crew,
mission-control tone — no cartoon aliens.

Everything runs client-side: no backend, no build step, playable offline
after the first load.

## Run it

```bash
npm run serve          # any static file server works
# open http://localhost:8080
```

**Install on iPhone:** open the URL in Safari → Share → *Add to Home
Screen*. The app runs fullscreen (standalone), respects the notch/Dynamic
Island and home-indicator safe areas, and works offline after the first
visit (service-worker precache).

## Building your rocket

Tap **VAB** (pre-launch) or **VEHICLE ASSEMBLY** on the title screen to
open the assembly building — the pad camera orbits your craft live while
you edit it. Stack up to four booster stages under the crew capsule:

- **Engines** — M-90 Kestrel (kerolox workhorse), M-90V Vacuum, HL-120
  Hydra (hydrolox, Isp 451), T-1600 Titanhawk (heavy booster) — each with
  real-ish thrust/Isp/mass, cluster counts up to ×9
- **Tanks** — S through XXL (30 t to 396 t of propellant; stage length
  and dry mass follow from tank volume)
- **Capsules** — Pilgrim (3 crew) or the lighter Sparrow (2 crew)

Per-stage ΔV and TWR update live, with warnings when a design can't
lift off or lacks the ~9,400 m/s LEO budget. Designs persist in
localStorage and survive restarts. Launch time (dawn/day/dusk/night)
is selectable on the title screen — night launches are floodlit.

## How to fly

| Control | What it does |
| --- | --- |
| Throttle slider (right) + FULL / CUT | Engine throttle |
| Hold **IGNITE / STAGE** (ring fills ~½ s) | Starts the 4 s ignition auto-sequence (engines ramp at T−3, hold-downs release at T−0), then stage separation |
| Joystick (left) | Pitch / yaw rate command; buttons below roll |
| HOLD / PRO / RETRO | Attitude autopilot: hold attitude, track prograde, track retrograde |
| Drag / pinch on the view | Orbit camera / zoom (zoom all the way out for the orbit map, or tap MAP) |
| − / + (top) | Time warp 1× → 1000× (above 4× only while coasting above 130 km) |
| ⇥ AP (right column) | Auto-warp to apoapsis; drops back to 1× as you arrive |
| Attitude ball (bottom center) | Artificial horizon + pitch ladder; ● prograde, ✕ retrograde |
| CHUTE | Deploy mains (below 7 km and 300 m/s; auto-deploys at 2.5 km as backup) |
| SND | Toggle sound (engine rumble, aero roar, staging, radio blips — all synthesized) |
| Tap the mission clock | Pause / resume |

**Nominal mission:** full throttle, ignite → climb vertically to ~1 km →
pitch east gradually (~45° by 12 km, following prograde after that) → at
MECO, stage and keep burning → cut throttle when apoapsis passes ~200 km →
coast to apoapsis (watch →AP), burn prograde until periapsis is above
140 km → **orbit**. To come home: burn retrograde until periapsis is
~25–35 km, stage the capsule off, hold RETRO (heat shield forward), ride
out reentry, chutes below 7 km, splash down.

## What's real vs. approximated

Real (or real-ish):

- Earth radius (6371 km) and gravitational parameter GM — orbital velocity
  at 200 km is the real ~7.78 km/s, LEO period ~88 min.
- Two-body gravity integrated with RK4 in double precision; orbital
  elements (Ap/Pe/period/time-to-apoapsis) computed from the state vector,
  patched-conic style. No distance compression anywhere.
- The vehicle is Falcon-9-class: ~528 t on the pad, stage masses, thrust,
  and sea-level/vacuum Isp are real-ish numbers; thrust and Isp vary with
  ambient pressure; mass drops as propellant burns. Pad TWR ~1.47.
- Rocket-equation ΔV readout (vacuum Isp convention), ~11.1 km/s at
  liftoff — you need roughly 9.4 km/s to reach LEO, so a sloppy ascent
  still makes orbit, a bad one doesn't.
- Exponential atmosphere (8.5 km scale height), quadratic drag, dynamic
  pressure (Max-Q callout), reentry heating that grows with √ρ·v³ — the
  discarded stack burns up on reentry; the capsule's heat shield survives.

Simplified / approximated (deliberately, for the MVP):

- **The planet doesn't rotate.** No ~465 m/s eastward launch bonus, no
  Coriolis; surface-relative and inertial speed are the same. The rocket
  has margin to compensate.
- **Attitude is rate-command, not torque simulation.** The vehicle rotates
  at a capped rate (≈4–6°/s) with no angular momentum, engine gimbal
  dynamics, or aerodynamic torque; there is no loss-of-control regime.
- **Drag uses a constant Cd and frontal area per configuration** — no Mach
  dependence, lift, or angle-of-attack effects.
- **The capsule's heat shield always protects it** regardless of attitude
  (holding retrograde is flying the mission right, but entry attitude
  isn't lethal). G-load is reported but doesn't harm the crew.
- **Atmosphere model is a single exponential** — real atmospheres have
  layered temperature structure; density above ~140 km is treated as zero
  (that's the "stable orbit" line).
- **Orbits are numerically integrated, not on rails** — tiny energy drift
  over many warped orbits is possible (RK4 keeps it negligible on mission
  timescales).
- **One vehicle, one launch site, equatorial trajectories** are the
  designed path (you *can* steer out of plane; there's just no reason to).
- Delta-v readout uses vacuum Isp and ignores gravity/drag losses (the
  standard convention).

## Tech

- **Three.js** (vendored locally — the app is fully offline-capable) with
  ACES filmic tonemapping, a procedural IBL environment (PMREM), real-time
  shadows near the pad, a shader sky dome (sun disc, horizon haze, fades
  to space with altitude), procedurally textured planet + clouds, fresnel
  atmosphere shell, and a floating-origin scene graph so f32 precision
  holds at planetary scale.
- **Launch complex**: lattice service tower with umbilicals, animated
  hold-down clamps, tank farm, lightning masts, floodlights (lit at
  night/dusk), scorched concrete apron, cryo boil-off wisps, pooled
  smoke billboards, layered engine plume (core/mid/outer + shock
  diamonds in atmosphere) with a dynamic engine light.
- **Craft compiler**: VAB designs compile to the same stage config the
  physics flies; vehicle meshes are rebuilt procedurally from it (engine
  cluster layouts, tank-derived stage lengths).
- **Custom physics, not Rapier/Cannon** — a deliberate deviation from the
  brief: rigid-body game engines are built for contact dynamics at
  human scale and fight you at orbital scale (f32 state, no analytic
  conics, integrators that damp energy). Orbital flight needs a precise
  f64 RK4 over two-body gravity + thrust + drag, which is ~150 lines and
  is exactly what `src/physics.js` is. The full mission is verified by a
  headless test (below).
- **Vanilla JS ES modules**, no bundler, no build step.
- **PWA**: web app manifest (standalone, full icon set incl.
  `apple-touch-icon`), cache-first service worker, `viewport-fit=cover`
  with safe-area insets, 100% Pointer-Events touch controls, wake-lock
  where supported. No desktop-only APIs assumed.
- **Procedural audio** (Web Audio, no assets): engine noise scales with
  throttle and ambient air density, aero roar with dynamic pressure and
  reentry heating; AudioContext unlocks on first tap per iOS rules.
- **Best-mission record** persists in localStorage (guarded for Safari
  private mode) and shows on the title screen.

## Tests

```bash
npm test              # headless full mission: launch → orbit → reentry → splashdown
npm run test:browser  # Playwright smoke test: boots the app, launches, screenshots
```

The mission test flies the whole profile with a simple guidance law and
asserts orbit insertion, deorbit, and a safe splashdown — if the physics
or vehicle config regress, it fails.

## Roadmap (not in this MVP)

- Docking and rendezvous (target vessel, RCS translation, approach HUD)
- Moon + more bodies with patched-conic SOI transfers and transfer
  planning UI
- Save/load missions and quicksaves (localStorage, mindful of Safari caps)
- Mission log / career progression (contracts, crew roster, program funds)
- Planet rotation + launch azimuth, inclination targeting
- Better aero (Mach-dependent Cd, AoA, body lift) and attitude dynamics

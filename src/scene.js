// Three.js rendering. Units: kilometers. Floating origin — the active
// vessel sits at (0,0,0) and the world group is offset by -vesselPos so
// f32 precision stays high near the camera.
//
// Graphics: ACES tonemapping + procedural IBL environment, shader sky dome
// with sun disc and horizon haze, detailed launch complex (lattice tower,
// hold-down clamps, tank farm, floodlights), layered engine plume with
// dynamic light, real shadows near the ground, time-of-day presets, and
// vehicle meshes generated from the (rebuildable) VEHICLE config.

import * as THREE from '../vendor/three.module.min.js';
import { PLANET, VEHICLE } from './config.js';
import { sampleOrbitPath, pointAtAnomaly } from './orbit.js';
import { makePlanetTexture, makePlanetRoughnessTexture, makeCloudTexture } from './planettex.js';

const KM = 1 / 1000;
const R_KM = PLANET.radius * KM;

export const TIME_PRESETS = {
  dawn: {
    label: 'DAWN', el: 9, az: 105,
    sunColor: 0xffc182, sunI: 2.5, ambI: 0.36, hemiI: 0.3,
    zenith: [0.10, 0.17, 0.48], horizon: [1.0, 0.63, 0.44], haze: [1.0, 0.78, 0.56],
    floods: 0.4, starFloor: 0.12, exposure: 1.02,
  },
  day: {
    label: 'DAY', el: 48, az: 40,
    sunColor: 0xfff4e2, sunI: 2.7, ambI: 0.42, hemiI: 0.42,
    zenith: [0.13, 0.40, 0.88], horizon: [0.46, 0.74, 0.99], haze: [0.72, 0.89, 1.0],
    floods: 0, starFloor: 0, exposure: 0.98,
  },
  dusk: {
    label: 'DUSK', el: 7, az: 255,
    sunColor: 0xff9557, sunI: 2.6, ambI: 0.32, hemiI: 0.26,
    zenith: [0.10, 0.11, 0.40], horizon: [1.0, 0.52, 0.33], haze: [1.0, 0.64, 0.42],
    floods: 0.8, starFloor: 0.2, exposure: 1.02,
  },
  night: {
    label: 'NIGHT', el: -16, az: 250,
    sunColor: 0x93a8d8, sunI: 0.35, ambI: 0.12, hemiI: 0.09,
    zenith: [0.006, 0.012, 0.035], horizon: [0.02, 0.05, 0.11], haze: [0.07, 0.12, 0.22],
    floods: 1.0, starFloor: 0.55, exposure: 1.12,
  },
};

export class SceneView {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000308);
    this.scene.environmentIntensity = 0.45;
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.002, 400_000);
    this.camDist = 0.14;       // km from vessel
    this.camTheta = 0.5;       // azimuth around local up
    this.camPhi = 1.35;        // polar angle from local up
    this.savedCloseDist = this.camDist;
    this.mapMode = false;
    this.vabSpin = false;

    // Lights.
    this.sun = new THREE.DirectionalLight(0xfff2e0, 3.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = -0.14; sc.right = 0.14; sc.top = 0.14; sc.bottom = -0.14;
    sc.near = 0.02; sc.far = 12;
    this.sun.shadow.bias = -0.00018;
    this.sun.shadow.normalBias = 0.0025;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.amb = new THREE.AmbientLight(0x51637a, 0.9);
    this.scene.add(this.amb);
    this.hemi = new THREE.HemisphereLight(0xcfe0ff, 0x4a5f52, 0.65);
    this.scene.add(this.hemi);
    this.rim = new THREE.DirectionalLight(0x9fc4ff, 0.55);
    this.scene.add(this.rim);
    this.sunDir = new THREE.Vector3(1, 0, 0);

    // World group (floating origin).
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.buildSky();
    this.buildPlanet();
    this.buildStars();
    this.buildPad();
    this.rocket = new THREE.Group();
    this.scene.add(this.rocket);
    this.rebuildVehicle();
    this.buildOrbitLine();
    this.debrisMeshes = new Map();

    this.tmpV = new THREE.Vector3();
    this.clampT = 0;
    this.lookBias = 0; // km along -up; shifts the craft up-screen (VAB sheet)
    this.applyPreset('day');
  }

  // ---- environment / time of day ------------------------------------------
  applyPreset(key) {
    const p = TIME_PRESETS[key] || TIME_PRESETS.day;
    this.preset = p;
    this.presetKey = key;
    const el = p.el * Math.PI / 180, az = p.az * Math.PI / 180;
    // Pad frame: up=+X, east=+Z, north=+Y.
    this.sunDir.set(
      Math.sin(el),
      Math.cos(el) * Math.sin(az),
      Math.cos(el) * Math.cos(az),
    ).normalize();
    this.sun.color.setHex(p.sunColor);
    this.sun.intensity = Math.max(0.15, p.sunI);
    this.amb.intensity = p.ambI;
    this.hemi.intensity = p.hemiI;
    this.renderer.toneMappingExposure = p.exposure;

    const u = this.skyMat.uniforms;
    u.zenith.value.setRGB(...p.zenith);
    u.horizon.value.setRGB(...p.horizon);
    u.haze.value.setRGB(...p.haze);
    u.sunColor.value.setHex(p.sunColor);

    for (const f of this.floods) f.intensity = p.floods * 260;
    for (const h of this.floodHeads) h.material.emissiveIntensity = p.floods * 3;

    this.buildEnvironment(p);
  }

  buildEnvironment(p) {
    // Small equirect gradient matching the sky -> PMREM for PBR reflections.
    const c = document.createElement('canvas');
    c.width = 128; c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 64);
    const rgb = (a, m = 255) => `rgb(${a.map((v) => Math.min(255, Math.round(v * m))).join(',')})`;
    g.addColorStop(0, rgb(p.zenith));
    g.addColorStop(0.48, rgb(p.horizon));
    g.addColorStop(0.52, rgb(p.haze, 160));
    g.addColorStop(1, 'rgb(28,30,26)'); // ground bounce
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const env = this.pmrem.fromEquirectangular(tex);
    if (this.scene.environment) this.scene.environment.dispose();
    this.scene.environment = env.texture;
    tex.dispose();
  }

  buildSky() {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      uniforms: {
        sunDir: { value: new THREE.Vector3(1, 0, 0) },
        upDir: { value: new THREE.Vector3(1, 0, 0) },
        zenith: { value: new THREE.Color(0.10, 0.30, 0.62) },
        horizon: { value: new THREE.Color(0.62, 0.78, 0.94) },
        haze: { value: new THREE.Color(0.85, 0.92, 1.0) },
        sunColor: { value: new THREE.Color(0xfff2e0) },
        fade: { value: 1 },
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vDir;
        uniform vec3 sunDir, upDir, zenith, horizon, haze, sunColor;
        uniform float fade;
        void main() {
          vec3 d = normalize(vDir);
          float e = dot(d, upDir);
          float sd = dot(d, sunDir);
          vec3 col = mix(horizon, zenith, pow(clamp(e, 0.0, 1.0), 0.42));
          // Below-horizon: darkened haze so the ground plane blends.
          col = mix(col, haze * 0.25, smoothstep(0.0, -0.12, e));
          // Horizon haze band.
          col += haze * 0.2 * exp(-abs(e) * 10.0);
          // Sun disc + glow.
          float disc = smoothstep(0.99988, 0.99997, sd);
          float glow = pow(max(sd, 0.0), 280.0) * 1.1 + pow(max(sd, 0.0), 12.0) * 0.2;
          col += sunColor * (disc * 6.0 + glow);
          gl_FragColor = vec4(col, fade);
        }`,
    });
    this.skyDome = new THREE.Mesh(new THREE.SphereGeometry(120_000, 32, 20), this.skyMat);
    this.skyDome.renderOrder = -10;
    this.skyDome.frustumCulled = false;
    this.scene.add(this.skyDome);
  }

  buildPlanet() {
    const tex = new THREE.CanvasTexture(makePlanetTexture(2048, 1024));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const roughTex = new THREE.CanvasTexture(makePlanetRoughnessTexture());
    const geo = new THREE.SphereGeometry(R_KM, 128, 96);
    const mat = new THREE.MeshStandardMaterial({
      map: tex, roughnessMap: roughTex, roughness: 1, metalness: 0, envMapIntensity: 0.3,
    });
    this.planet = new THREE.Mesh(geo, mat);
    this.world.add(this.planet);

    const cloudTex = new THREE.CanvasTexture(makeCloudTexture());
    cloudTex.colorSpace = THREE.SRGBColorSpace;
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(R_KM * 1.0015, 96, 64),
      new THREE.MeshLambertMaterial({ map: cloudTex, transparent: true, depthWrite: false }),
    );
    this.world.add(this.clouds);

    // Atmosphere rim glow: fresnel on a back-side shell.
    const atmoMat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.BackSide, depthWrite: false,
      uniforms: { c: { value: new THREE.Color(0x5ec8ff) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vP;
        void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vP = mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `
        varying vec3 vN; varying vec3 vP; uniform vec3 c;
        void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(-vP))), 3.5); gl_FragColor = vec4(c, f * 0.9); }`,
    });
    this.atmo = new THREE.Mesh(new THREE.SphereGeometry(R_KM * 1.028, 96, 64), atmoMat);
    this.world.add(this.atmo);
  }

  buildStars() {
    const n = 2400;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < n; i++) {
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
      const q = Math.sqrt(1 - u * u);
      const R = 200_000;
      pos[i * 3] = R * q * Math.cos(a); pos[i * 3 + 1] = R * u; pos[i * 3 + 2] = R * q * Math.sin(a);
      const b = 0.35 + rnd() * 0.65;
      col[i * 3] = b; col[i * 3 + 1] = b * (0.92 + rnd() * 0.08); col[i * 3 + 2] = b * (0.9 + rnd() * 0.15);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.starMat = new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false });
    this.stars = new THREE.Points(geo, this.starMat);
    this.stars.renderOrder = -9;
    this.scene.add(this.stars); // camera-space, not world group
  }

  // ---- launch complex ------------------------------------------------------
  makeConcreteTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    // Clean stylized pad tiles with a subtle checker and thin joints.
    for (let ty = 0; ty < 8; ty++) {
      for (let tx = 0; tx < 8; tx++) {
        const even = (tx + ty) % 2 === 0;
        ctx.fillStyle = even ? '#aeb4bc' : '#a4abb4';
        ctx.fillRect(tx * 64, ty * 64, 64, 64);
      }
    }
    ctx.strokeStyle = 'rgba(60, 66, 76, 0.5)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64, 512); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * 64); ctx.lineTo(512, i * 64); ctx.stroke();
    }
    // Light scorch ring under the mount — story detail, kept subtle.
    const g = ctx.createRadialGradient(256, 256, 8, 256, 256, 90);
    g.addColorStop(0, 'rgba(52, 48, 46, 0.5)');
    g.addColorStop(1, 'rgba(52, 48, 46, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    return new THREE.CanvasTexture(c);
  }

  makeGrassTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    // Saturated lawn with wide mowed stripes.
    for (let i = 0; i < 16; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#3f9a4a' : '#379044';
      ctx.fillRect(0, i * 32, 512, 32);
    }
    // Soft meadow patches for organic variety.
    for (let i = 0; i < 26; i++) {
      ctx.fillStyle = `rgba(${120 + Math.random() * 40}, ${190 + Math.random() * 30}, 90, 0.10)`;
      ctx.beginPath();
      ctx.ellipse(Math.random() * 512, Math.random() * 512, 20 + Math.random() * 60, 14 + Math.random() * 40, Math.random() * 3, 0, 7);
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  buildPad() {
    // Local launch-site detail, tangent to the sphere at (R,0,0).
    // Pad-local frame: +X up, ground plane = YZ (east = +Z).
    this.pad = new THREE.Group();
    const steel = new THREE.MeshStandardMaterial({ color: 0xb9c0c7, roughness: 0.5, metalness: 0.65 });
    const darkSteel = new THREE.MeshStandardMaterial({ color: 0x3a4046, roughness: 0.6, metalness: 0.5 });

    const grassTex = this.makeGrassTexture();
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }),
    );
    ground.rotation.y = Math.PI / 2;
    ground.receiveShadow = true;
    this.pad.add(ground);

    const concreteTex = this.makeConcreteTexture();
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(0.26, 40),
      new THREE.MeshStandardMaterial({ map: concreteTex, roughness: 0.92 }),
    );
    apron.rotation.y = Math.PI / 2;
    apron.position.x = 0.0002;
    apron.receiveShadow = true;
    this.pad.add(apron);

    // Launch mount: octagonal pedestal with flame deflector notch.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.011, 0.014, 0.004, 8),
      new THREE.MeshStandardMaterial({ map: concreteTex, color: 0x9aa0a6, roughness: 0.85 }),
    );
    plinth.rotation.z = Math.PI / 2;
    plinth.position.x = 0.002;
    plinth.castShadow = plinth.receiveShadow = true;
    this.pad.add(plinth);

    // Hold-down clamps (animate away at release).
    this.clamps = [];
    for (const side of [-1, 1]) {
      const clamp = new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.0012, 0.0016), darkSteel);
      clamp.position.set(0.0055, 0, side * 0.0028);
      clamp.castShadow = true;
      this.pad.add(clamp);
      this.clamps.push({ mesh: clamp, side });
    }

    // Service tower: 4-leg lattice with braces and a crane arm.
    const tower = new THREE.Group();
    const legGeo = new THREE.BoxGeometry(0.068, 0.0012, 0.0012);
    for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, steel);
      leg.position.set(0.034, dy * 0.0032, dz * 0.0032);
      leg.castShadow = true;
      tower.add(leg);
    }
    const braceY = new THREE.BoxGeometry(0.0008, 0.0076, 0.0008);
    const braceZ = new THREE.BoxGeometry(0.0008, 0.0008, 0.0076);
    for (let i = 1; i <= 8; i++) {
      const h = i * 0.0082;
      for (const dz of [-1, 1]) {
        const b = new THREE.Mesh(braceY, steel);
        b.position.set(h, 0, dz * 0.0032);
        tower.add(b);
      }
      for (const dy of [-1, 1]) {
        const b = new THREE.Mesh(braceZ, steel);
        b.position.set(h, dy * 0.0032, 0);
        tower.add(b);
      }
    }
    const crane = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.0016, 0.02), steel);
    crane.position.set(0.0672, 0, -0.006);
    crane.castShadow = true;
    tower.add(crane);
    // Umbilical arms reaching toward the vehicle.
    this.umbilicals = [];
    for (const h of [0.02, 0.045]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.0012, 0.0012, 0.011), darkSteel);
      arm.position.set(h, 0, -0.0085);
      arm.castShadow = true;
      tower.add(arm);
      this.umbilicals.push(arm);
    }
    tower.position.set(0, 0, 0.0165);
    this.pad.add(tower);

    // Lightning masts.
    for (const [my, mz] of [[0.09, 0.05], [-0.07, -0.08], [-0.02, 0.11]]) {
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.0004, 0.0009, 0.09, 6), steel);
      mast.rotation.z = Math.PI / 2;
      mast.position.set(0.045, my, mz);
      this.pad.add(mast);
    }

    // Propellant farm: spheres + horizontal tanks.
    const tankMat = new THREE.MeshStandardMaterial({ color: 0xe8ebee, roughness: 0.35, metalness: 0.2 });
    for (const [ty, tz] of [[0.1, -0.06], [0.115, -0.045]]) {
      const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.006, 20, 14), tankMat);
      sphere.position.set(0.006, ty, tz);
      this.pad.add(sphere);
    }
    for (let i = 0; i < 3; i++) {
      const tk = new THREE.Mesh(new THREE.CylinderGeometry(0.0028, 0.0028, 0.018, 12), tankMat);
      tk.rotation.x = Math.PI / 2;
      tk.position.set(0.003, 0.095 + i * 0.007, -0.075);
      this.pad.add(tk);
    }

    // Assembly hangar + road out to the pad.
    const hangar = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.09, 0.06),
      new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.6, metalness: 0.1 }),
    );
    hangar.position.set(0.015, -1.6, -0.55);
    this.pad.add(hangar);
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(0.003, 0.093, 0.062),
      new THREE.MeshStandardMaterial({ color: 0x2e64a8, roughness: 0.5 }),
    );
    roof.position.set(0.031, -1.6, -0.55);
    this.pad.add(roof);
    const road = new THREE.Mesh(
      new THREE.BoxGeometry(0.0002, 1.6, 0.012),
      new THREE.MeshStandardMaterial({ color: 0x4c4f53, roughness: 0.95 }),
    );
    road.position.set(0.0001, -0.8, -0.02);
    road.receiveShadow = true;
    this.pad.add(road);

    // Floodlights: emissive heads + real spotlights (night/dusk presets).
    this.floods = [];
    this.floodHeads = [];
    for (const [fy, fz] of [[0.045, 0.045], [-0.045, 0.045], [0.045, -0.045], [-0.045, -0.045]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.0005, 0.0007, 0.02, 6), darkSteel);
      pole.rotation.z = Math.PI / 2;
      pole.position.set(0.01, fy, fz);
      this.pad.add(pole);
      const head = new THREE.Mesh(
        new THREE.BoxGeometry(0.0016, 0.0026, 0.0026),
        new THREE.MeshStandardMaterial({ color: 0x222528, emissive: 0xfff6dd, emissiveIntensity: 0 }),
      );
      head.position.set(0.02, fy, fz);
      this.pad.add(head);
      this.floodHeads.push(head);
    }
    // Two real spotlights carry the night look (perf: not four).
    for (const [fy, fz] of [[0.045, 0.045], [-0.045, -0.045]]) {
      const spot = new THREE.SpotLight(0xffe9c4, 0, 1.4, 0.42, 0.6, 1.4);
      spot.position.set(0.02, fy, fz);
      this.pad.add(spot);
      this.floods.push(spot);
    }

    // Launch smoke + cryo vent wisps: pooled billboards.
    const sc = document.createElement('canvas');
    sc.width = sc.height = 64;
    const sctx = sc.getContext('2d');
    const grad = sctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.6, 'rgba(235,235,235,0.45)');
    grad.addColorStop(1, 'rgba(230,230,230,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 64, 64);
    const smokeTex = new THREE.CanvasTexture(sc);
    this.smoke = [];
    for (let i = 0; i < 46; i++) {
      const mat = new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0, depthWrite: false });
      const sp = new THREE.Sprite(mat);
      sp.visible = false;
      this.pad.add(sp);
      this.smoke.push({ sp, life: 0, max: 1, vel: [0, 0, 0], grow: 0.05 });
    }
    this.ventAccum = 0;

    this.scene.add(this.pad);

    // Spotlight targets must be in the scene graph.
    for (const spot of this.floods) {
      spot.target = this.rocketTargetProxy = this.rocketTargetProxy || new THREE.Object3D();
    }
    this.scene.add(this.rocketTargetProxy);
  }

  updateSmoke(sim, dt) {
    const thr = sim.effThrottle;
    const igniting = thr > 0.03 && sim.altitude < 300
      && (sim.phase === 'flight' || sim.phase === 'countdown');
    let toSpawn = igniting ? (sim.met < 6 ? 5 : 2) : 0;

    // Cryo boil-off wisps while the vehicle sits fueled on the pad.
    let vent = 0;
    if ((sim.phase === 'prelaunch' || sim.phase === 'countdown') && thr < 0.02) {
      this.ventAccum += dt;
      if (this.ventAccum > 0.5) { this.ventAccum = 0; vent = 1; }
    }

    for (const s of this.smoke) {
      if (s.life <= 0) {
        if (toSpawn > 0) {
          toSpawn--;
          s.max = 2.2 + Math.random() * 1.8;
          s.life = s.max;
          s.grow = 0.05 + Math.random() * 0.03;
          const a = Math.random() * Math.PI * 2;
          const speed = 0.02 + Math.random() * 0.045;
          s.vel = [0.005 + Math.random() * 0.008, Math.cos(a) * speed, Math.sin(a) * speed];
          s.sp.position.set(0.003, (Math.random() - 0.5) * 0.008, (Math.random() - 0.5) * 0.008);
          s.sp.material.color.setHex(0xffffff);
          s.sp.visible = true;
        } else if (vent > 0) {
          vent--;
          s.max = 1.6;
          s.life = s.max;
          s.grow = 0.008;
          s.vel = [0.0012, (Math.random() - 0.5) * 0.004, 0.001 + Math.random() * 0.002];
          s.sp.position.set(0.038 + Math.random() * 0.012, 0, -0.002);
          s.sp.material.color.setHex(0xffffff);
          s.sp.visible = true;
        } else if (s.sp.visible) {
          s.sp.visible = false;
        }
        continue;
      }
      s.life -= dt;
      const age = 1 - s.life / s.max;
      s.sp.position.x += s.vel[0] * dt;
      s.sp.position.y += s.vel[1] * dt;
      s.sp.position.z += s.vel[2] * dt;
      s.vel = s.vel.map((v) => v * (1 - dt * 1.1));
      const size = 0.01 + age * s.grow;
      s.sp.scale.set(size, size, 1);
      // Engine light tints fresh smoke at ignition.
      if (thr > 0.05 && age < 0.4) s.sp.material.color.setRGB(1, 0.86, 0.72);
      s.sp.material.opacity = Math.min(age * 6, 1) * (1 - age) * (s.grow > 0.02 ? 0.8 : 0.35);
    }
  }

  // ---- vehicle -------------------------------------------------------------
  rebuildVehicle() {
    // Drop and rebuild everything under this.rocket from VEHICLE.
    for (const child of [...this.rocket.children]) this.rocket.remove(child);
    this.meshRoot = new THREE.Group();
    this.rocket.add(this.meshRoot);
    this.stageGroups = [];

    const white = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.22, metalness: 0.04, clearcoat: 0.7, clearcoatRoughness: 0.25,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1f2833, roughness: 0.45, metalness: 0.35 });
    const bell = new THREE.MeshStandardMaterial({ color: 0x333940, roughness: 0.3, metalness: 0.85 });
    const shield = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.65 });
    const finMat = new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.45, metalness: 0.5 });
    const accents = [0xff7a29, 0x37b6ff, 0xffd166, 0x9d7bff].map((c) =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.15 }));

    const stages = VEHICLE.stages;
    this.stackLens = stages.map((s) => s.length * KM);
    const total = this.stackLens.reduce((a, b) => a + b, 0);
    const base = -total / 2;
    this.stackBase = base;
    this.activeBottomY = base;
    this.activeTopY = base + total;
    this.meshRoot.position.y = -base;

    let y = base;
    stages.forEach((st, idx) => {
      const g = new THREE.Group();
      const rad = st.diameter / 2 * KM;
      const L = st.length * KM;
      if (st.capsule || st.thrustVac === 0) {
        // Capsule: truncated cone + shield + nose.
        const cone = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.35, rad * 0.98, L * 0.72, 24), white);
        cone.position.y = y + L * 0.36;
        cone.castShadow = true;
        g.add(cone);
        const hs = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.98, rad * 0.9, L * 0.1, 24), shield);
        hs.position.y = y - L * 0.04;
        g.add(hs);
        const nose = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.16, rad * 0.35, L * 0.2, 24), dark);
        nose.position.y = y + L * 0.8;
        g.add(nose);
        // Windows.
        for (const wz of [-1, 1]) {
          const win = new THREE.Mesh(
            new THREE.CylinderGeometry(rad * 0.09, rad * 0.09, rad * 0.03, 10),
            new THREE.MeshStandardMaterial({ color: 0x0d1b2e, roughness: 0.1, metalness: 0.6 }),
          );
          win.rotation.x = Math.PI / 2 - 0.35;
          win.position.set(0, y + L * 0.42, wz * rad * 0.62);
          g.add(win);
        }
      } else {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, L, 28), white);
        body.position.y = y + L / 2;
        body.castShadow = true;
        g.add(body);
        // Engines arranged by count.
        const n = st.engines;
        const nozGeo = new THREE.CylinderGeometry(rad * 0.09, rad * (n > 5 ? 0.20 : 0.30), L * 0.05, 12);
        const ringR = n === 1 ? 0 : rad * (n > 5 ? 0.62 : 0.5);
        const ring = n === 1 ? 0 : (n >= 7 ? n - 1 : n);
        for (let i = 0; i < n; i++) {
          const noz = new THREE.Mesh(nozGeo, bell);
          const onRing = n === 1 ? false : (n >= 7 ? i < n - 1 : true);
          const a = ring ? (i / ring) * Math.PI * 2 : 0;
          const rr = onRing ? ringR : 0;
          noz.position.set(Math.cos(a) * rr, y - L * 0.024, Math.sin(a) * rr);
          g.add(noz);
        }
        const skirt = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.01, rad * 1.035, L * 0.06, 28), dark);
        skirt.position.y = y + L * 0.03;
        skirt.castShadow = true;
        g.add(skirt);
        const inter = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.004, rad * 1.004, L * 0.05, 28), dark);
        inter.position.y = y + L - L * 0.025;
        g.add(inter);
        const stripe = new THREE.Mesh(
          new THREE.CylinderGeometry(rad * 1.003, rad * 1.003, L * 0.035, 28),
          accents[idx % accents.length],
        );
        stripe.position.y = y + L * 0.885;
        g.add(stripe);
        if (idx === 0) {
          const finGeo = new THREE.BoxGeometry(rad * 0.22, L * 0.04, rad * 0.06);
          for (let i = 0; i < 4; i++) {
            const fin = new THREE.Mesh(finGeo, finMat);
            const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
            fin.position.set(Math.cos(a) * rad * 1.08, y + L * 0.92, Math.sin(a) * rad * 1.08);
            fin.rotation.y = -a;
            fin.castShadow = true;
            g.add(fin);
          }
        }
      }
      this.meshRoot.add(g);
      this.stageGroups.push(g);
      y += L;
    });

    // Layered plume + engine light.
    this.plume = new THREE.Group();
    const mkCone = (color, opacity, blending = THREE.AdditiveBlending) => {
      const m = new THREE.Mesh(
        new THREE.ConeGeometry(1, 1, 18, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending, depthWrite: false }),
      );
      m.rotation.x = Math.PI;
      this.plume.add(m);
      return m;
    };
    this.plumeCore = mkCone(0xfff3b0, 0.95, THREE.NormalBlending);
    this.plumeMid = mkCone(0xffb347, 0.75);
    this.plumeOuter = mkCone(0xff7b2e, 0.3);
    this.shockDiamonds = [];
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(
        new THREE.SphereGeometry(1, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      this.plume.add(d);
      this.shockDiamonds.push(d);
    }
    this.plume.visible = false;
    this.meshRoot.add(this.plume);
    this.engineLight = new THREE.PointLight(0xffa050, 0, 1.6, 1.8);
    this.meshRoot.add(this.engineLight);

    const capRad = VEHICLE.stages[VEHICLE.stages.length - 1].diameter / 2 * KM;
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff7733, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.reentryGlow = new THREE.Mesh(new THREE.SphereGeometry(capRad * 3.2, 20, 16), glowMat);
    this.reentryGlow.visible = false;
    this.meshRoot.add(this.reentryGlow);

    // Parachute canopy anchored at the capsule apex.
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(capRad * 5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xff7a29, roughness: 0.85, side: THREE.DoubleSide }),
    );
    canopy.position.y = capRad * 9;
    const lines = new THREE.Mesh(
      new THREE.ConeGeometry(capRad * 4.6, capRad * 8, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xcfd6de, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    lines.position.y = capRad * 4.5;
    lines.rotation.x = Math.PI;
    this.chute = new THREE.Group();
    this.chute.add(canopy); this.chute.add(lines);
    this.chute.position.y = base + total;
    this.chute.visible = false;
    this.meshRoot.add(this.chute);

    this.updatePlumeConfig(0);
    this.clampT = 0;
  }

  updatePlumeConfig(stageIndex) {
    const st = VEHICLE.stages[Math.min(stageIndex, VEHICLE.stages.length - 1)];
    const rad = st.diameter / 2 * KM;
    this.plumeR = rad * (0.36 + 0.2 * Math.sqrt(Math.max(1, st.engines)));
    this.plumeL = 0.018 + (st.thrustVac / 8.2e6) * 0.05;
  }

  removeStageMesh(index) {
    const g = this.stageGroups[index];
    if (g) this.meshRoot.remove(g);
    this.activeBottomY = this.stackBase + this.stackLens.slice(0, index + 1).reduce((a, b) => a + b, 0);
    this.meshRoot.position.y = -this.activeBottomY;
    this.updatePlumeConfig(index + 1);
  }

  makeDebrisMesh(d) {
    const rad = (d.diameter || 3.7) / 2 * 0.001;
    const len = (d.length || 20) * 0.001;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(rad, rad, len, 16),
      new THREE.MeshStandardMaterial({ color: 0xcfd4d8, roughness: 0.6 }),
    );
    this.world.add(mesh);
    return mesh;
  }

  buildOrbitLine() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * 256), 3));
    this.orbitLine = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0x37e0ff, transparent: true, opacity: 0.75,
    }));
    this.orbitLine.frustumCulled = false;
    this.world.add(this.orbitLine);

    const mk = (color) => {
      const m = new THREE.Sprite(new THREE.SpriteMaterial({ color, depthTest: false, sizeAttenuation: false }));
      m.scale.set(0.018, 0.018, 1);
      m.visible = false;
      this.world.add(m);
      return m;
    };
    this.apMarker = mk(0x37e0ff);
    this.peMarker = mk(0xffa02e);
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setZoom(factor) {
    this.camDist = Math.min(60_000, Math.max(0.045, this.camDist * factor));
  }

  toggleMap() {
    this.mapMode = !this.mapMode;
    if (this.mapMode) {
      this.savedCloseDist = this.camDist;
      this.camDist = R_KM * 2.4;
    } else {
      this.camDist = this.savedCloseDist;
    }
  }

  // ---- frame update --------------------------------------------------------
  update(sim, dtReal) {
    const rp = sim.r; // meters
    const px = rp[0] * KM, py = rp[1] * KM, pz = rp[2] * KM;
    this.world.position.set(-px, -py, -pz);

    // Vessel orientation.
    this.rocket.quaternion.set(sim.q[0], sim.q[1], sim.q[2], sim.q[3]);

    if (this.vabSpin) this.camTheta += dtReal * 0.14;

    // Camera on a local sphere around the vessel, up = radial out.
    const rm = Math.hypot(px, py, pz) || 1;
    const up = this.tmpV.set(px / rm, py / rm, pz / rm);
    const ref = Math.abs(up.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const e1 = new THREE.Vector3().crossVectors(ref, up).normalize();
    const e2 = new THREE.Vector3().crossVectors(up, e1).normalize();
    const sp = Math.sin(this.camPhi), cp = Math.cos(this.camPhi);
    const st = Math.sin(this.camTheta), ct = Math.cos(this.camTheta);
    const dir = new THREE.Vector3()
      .addScaledVector(up, cp)
      .addScaledVector(e1, sp * ct)
      .addScaledVector(e2, sp * st);
    // Frame the middle of the active stack, not the physics point (bottom).
    const halfLen = (this.activeTopY - this.activeBottomY) / 2;
    const target = new THREE.Vector3(0, halfLen, 0).applyQuaternion(this.rocket.quaternion);
    const altKm = sim.altitude * KM;
    this.camera.position.copy(dir).multiplyScalar(this.camDist).add(target);
    if (altKm + this.camera.position.dot(up) < 0.004) {
      const need = 0.004 - altKm;
      this.camera.position.addScaledVector(up, need - this.camera.position.dot(up));
    }
    this.camera.up.copy(up);
    const lookTarget = this.lookBias
      ? target.clone().addScaledVector(up, -this.lookBias)
      : target;
    this.camera.lookAt(lookTarget);

    // Camera shake: engine vibration near the pad, buffet at Max-Q, reentry.
    const shake = (sim.altitude < 600 ? sim.effThrottle * 0.7 : 0)
      + Math.min(1, (sim.qDyn || 0) / 35_000) * (0.35 + sim.effThrottle * 0.4)
      + Math.min(1, (sim.heat || 0) / 4e9) * 0.6;
    if (shake > 0.02 && this.camDist < 2) {
      const amp = 0.00045 * shake * Math.min(1, this.camDist / 0.3);
      this.camera.position.addScaledVector(e1, (Math.random() - 0.5) * amp);
      this.camera.position.addScaledVector(e2, (Math.random() - 0.5) * amp);
    }

    // Sun light + shadows follow the vessel (scene origin).
    this.sun.position.copy(this.sunDir).multiplyScalar(5);
    this.rim.position.set(-this.sunDir.x, this.sunDir.y * 0.5 + 0.6, -this.sunDir.z).multiplyScalar(5);
    this.sun.target.position.set(0, 0, 0);
    this.sun.castShadow = sim.altitude < 2_500 && this.preset.el > 3;

    // Sky dome rides on the camera; fades out with CAMERA altitude.
    this.skyDome.position.copy(this.camera.position);
    const camAltKm = Math.hypot(px + this.camera.position.x, py + this.camera.position.y, pz + this.camera.position.z) - R_KM;
    const k = Math.min(1, Math.max(0, camAltKm / 90));
    this.skyMat.uniforms.fade.value = Math.pow(1 - k, 1.3);
    this.skyMat.uniforms.upDir.value.copy(up);
    this.skyMat.uniforms.sunDir.value.copy(this.sunDir);
    this.starMat.opacity = Math.max(Math.pow(k, 1.4), this.preset.starFloor * (1 - k * 0.5));

    // Pad detail: position relative to vessel in doubles, fade with altitude.
    const alt = sim.altitude;
    const padVisible = alt < 30_000;
    this.pad.visible = padVisible;
    if (padVisible) {
      this.pad.position.set(PLANET.radius * KM - px, -py, -pz);
      this.rocketTargetProxy.position.set(0, 0, 0);
      this.updateSmoke(sim, dtReal);
      // Hold-down clamps swing away at release.
      const wantOpen = sim.phase === 'flight' ? 1 : 0;
      this.clampT += (wantOpen - this.clampT) * Math.min(1, dtReal * 3.2);
      for (const c of this.clamps) {
        c.mesh.position.z = c.side * (0.0028 + this.clampT * 0.004);
        c.mesh.rotation.x = c.side * this.clampT * 0.9;
      }
      for (const u2 of this.umbilicals) {
        u2.position.z = -0.0085 - this.clampT * 0.006;
      }
    }

    // Plume.
    const thr = sim.effThrottle;
    if (thr > 0.01) {
      this.plume.visible = true;
      const flick = 0.9 + Math.random() * 0.2;
      const bottom = this.activeBottomY;
      const vac = Math.min(1, alt / 60_000);
      const len = this.plumeL * (0.35 + thr * 0.85) * (1 + vac * 1.9) * flick;
      const r0 = this.plumeR * (0.75 + 0.25 * thr) * (1 + vac * 2.2);
      this.plumeCore.scale.set(r0 * 0.58, len * 0.6, r0 * 0.58);
      this.plumeCore.position.y = bottom - len * 0.3;
      this.plumeMid.scale.set(r0 * 0.8, len, r0 * 0.8);
      this.plumeMid.position.y = bottom - len / 2;
      this.plumeOuter.scale.set(r0 * 2.1, len * 1.35, r0 * 2.1);
      this.plumeOuter.position.y = bottom - len * 0.62;
      this.plumeMid.material.opacity = 0.45 + 0.3 * thr;
      this.plumeOuter.material.opacity = 0.16 + 0.14 * thr;
      // Shock diamonds only in meaningful atmosphere.
      const dia = Math.max(0, 1 - alt / 25_000);
      for (let i = 0; i < this.shockDiamonds.length; i++) {
        const d = this.shockDiamonds[i];
        d.visible = dia > 0.05;
        if (d.visible) {
          const f = 0.22 + i * 0.24;
          d.position.y = bottom - len * f;
          const ds = r0 * 0.22 * (1 - f * 0.5) * flick;
          d.scale.set(ds, ds * 1.7, ds);
          d.material.opacity = 0.55 * dia * thr;
        }
      }
      this.engineLight.intensity = thr * (alt < 40_000 ? 22 : 9) * flick;
      this.engineLight.position.y = bottom - this.plumeL * 0.2;
      this.engineLight.color.setHex(vac > 0.6 ? 0xffc890 : 0xffa050);
    } else {
      this.plume.visible = false;
      this.engineLight.intensity = 0;
    }

    // Reentry glow.
    const glow = Math.min(1, Math.max(0, (sim.heat - 4e8) / 4e9));
    this.reentryGlow.visible = glow > 0.01;
    if (this.reentryGlow.visible) {
      this.reentryGlow.material.opacity = glow * 0.85;
      const s = 1 + glow * 2.5 + Math.random() * 0.15;
      this.reentryGlow.scale.set(s, s * 1.6, s);
      this.reentryGlow.position.y = this.activeBottomY;
    }

    // Parachute: inflate with deployment, stream opposite the airflow.
    const chuteK = sim.vs.chute || 0;
    this.chute.visible = chuteK > 0.02;
    if (this.chute.visible) {
      const cs = 0.15 + 0.85 * chuteK;
      this.chute.scale.set(cs, cs, cs);
      const spd = sim.speed;
      const worldDir = spd > 1
        ? new THREE.Vector3(-sim.v[0] / spd, -sim.v[1] / spd, -sim.v[2] / spd).normalize()
        : up.clone();
      const localDir = worldDir.applyQuaternion(this.rocket.quaternion.clone().invert());
      this.chute.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), localDir);
    }

    // Orbit line: show whenever the trajectory is meaningfully suborbital+.
    const el = sim.orbit;
    const show = sim.speed > 200 && Number.isFinite(el.a) && el.p > 1;
    this.orbitLine.visible = show;
    if (show && (this.orbitFrame = (this.orbitFrame || 0) + 1) % 5 === 1) {
      const pts = sampleOrbitPath(el, 200);
      const attr = this.orbitLine.geometry.getAttribute('position');
      const n = Math.min(pts.length, 256);
      for (let i = 0; i < n; i++) {
        attr.setXYZ(i, pts[i][0] * KM, pts[i][1] * KM, pts[i][2] * KM);
      }
      for (let i = n; i < 256; i++) {
        const lastPt = pts.length ? pts[pts.length - 1] : [0, 0, 0];
        attr.setXYZ(i, lastPt[0] * KM, lastPt[1] * KM, lastPt[2] * KM);
      }
      attr.needsUpdate = true;

      const showMk = this.camDist > 300 && !el.hyperbolic;
      this.apMarker.visible = showMk && el.e > 1e-4;
      this.peMarker.visible = showMk && el.e > 1e-4 && el.periapsis > -PLANET.radius * 0.5;
      if (this.apMarker.visible) {
        const ap = pointAtAnomaly(el, Math.PI);
        if (ap) this.apMarker.position.set(ap[0] * KM, ap[1] * KM, ap[2] * KM);
      }
      if (this.peMarker.visible) {
        const pe = pointAtAnomaly(el, 0);
        if (pe) this.peMarker.position.set(pe[0] * KM, pe[1] * KM, pe[2] * KM);
      }
    } else if (!show) {
      this.apMarker.visible = this.peMarker.visible = false;
    }

    // Debris meshes.
    for (const d of sim.debris) {
      if (!this.debrisMeshes.has(d)) this.debrisMeshes.set(d, this.makeDebrisMesh(d));
      const m = this.debrisMeshes.get(d);
      m.position.set(d.r[0] * KM, d.r[1] * KM, d.r[2] * KM);
      m.rotation.x += dtReal * 0.4; m.rotation.z += dtReal * 0.23;
    }
    for (const [d, m] of this.debrisMeshes) {
      if (!sim.debris.includes(d)) {
        this.world.remove(m);
        this.debrisMeshes.delete(d);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}

// Three.js rendering. Units: kilometers. Floating origin — the active
// vessel sits at (0,0,0) and the world group is offset by -vesselPos so
// f32 precision stays high near the camera.

import * as THREE from '../vendor/three.module.min.js';
import { PLANET, VEHICLE } from './config.js';
import { sampleOrbitPath, pointAtAnomaly } from './orbit.js';
import { makePlanetTexture, makeCloudTexture } from './planettex.js';

const KM = 1 / 1000;
const R_KM = PLANET.radius * KM;

export class SceneView {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a1a33);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.002, 400_000);
    this.camDist = 0.14;       // km from vessel
    this.camTheta = 0.5;       // azimuth around local up
    this.camPhi = 1.35;        // polar angle from local up
    this.savedCloseDist = this.camDist;
    this.mapMode = false;

    // Lights.
    this.sun = new THREE.DirectionalLight(0xfff4e5, 3.0);
    this.sunDir = new THREE.Vector3(0.9, 0.35, 0.5).normalize();
    this.scene.add(this.sun);
    this.scene.add(new THREE.AmbientLight(0x51637a, 1.5));
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x3a4a58, 0.8));

    // World group (floating origin).
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.buildPlanet();
    this.buildStars();
    this.buildPad();
    this.buildRocket();
    this.buildOrbitLine();
    this.debrisMeshes = new Map();

    this.tmpV = new THREE.Vector3();
  }

  buildPlanet() {
    const tex = new THREE.CanvasTexture(makePlanetTexture());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const geo = new THREE.SphereGeometry(R_KM, 128, 96);
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 });
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
      uniforms: { c: { value: new THREE.Color(0x4d9fff) } },
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
    const n = 2200;
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
    this.scene.add(this.stars); // camera-space, not world group
  }

  buildPad() {
    // Local launch-site detail, tangent to the sphere at (R,0,0).
    this.pad = new THREE.Group();
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(9, 48),
      new THREE.MeshStandardMaterial({ color: 0x3d5a3a, roughness: 1 }),
    );
    ground.rotation.y = Math.PI / 2; // face +X (local up)
    this.pad.add(ground);
    const apron = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 32),
      new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.95 }),
    );
    apron.rotation.y = Math.PI / 2;
    apron.position.x = 0.0002;
    this.pad.add(apron);
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.012, 0.012, 0.004, 24),
      new THREE.MeshStandardMaterial({ color: 0x2e3238, roughness: 0.8 }),
    );
    plinth.rotation.z = Math.PI / 2;
    plinth.position.x = 0.002;
    this.pad.add(plinth);
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x99a3ad, roughness: 0.65, metalness: 0.35 });
    const tower = new THREE.Mesh(new THREE.BoxGeometry(0.068, 0.0045, 0.0045), towerMat);
    tower.position.set(0.034, 0, 0.02);
    this.pad.add(tower);
    for (let i = 1; i <= 3; i++) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.0018, 0.0015, 0.012), towerMat);
      arm.position.set(0.016 * i, 0, 0.013);
      this.pad.add(arm);
    }
    this.scene.add(this.pad);
  }

  buildRocket() {
    this.rocket = new THREE.Group();
    // meshRoot keeps the ACTIVE stack's bottom at the vessel origin (the
    // physics point is the stack bottom); it shifts up as stages drop.
    this.meshRoot = new THREE.Group();
    this.rocket.add(this.meshRoot);
    this.stageGroups = [];
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f6, roughness: 0.45, metalness: 0.1 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.6, metalness: 0.3 });
    const shield = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 0.8 });

    const s1 = VEHICLE.stages[0], s2 = VEHICLE.stages[1], cap = VEHICLE.stages[2];
    const rad = s1.diameter / 2 * KM;
    const L1 = s1.length * KM, L2 = s2.length * KM, LC = cap.length * KM;
    const total = L1 + L2 + LC;
    const base = -total / 2; // stack centered on origin, +Y forward

    // Stage I.
    const g1 = new THREE.Group();
    const body1 = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, L1, 24), white);
    body1.position.y = base + L1 / 2;
    g1.add(body1);
    for (let i = 0; i < 4; i++) {
      const noz = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.16, rad * 0.34, L1 * 0.05, 12), dark);
      const a = (i / 4) * Math.PI * 2;
      noz.position.set(Math.cos(a) * rad * 0.55, base - L1 * 0.02, Math.sin(a) * rad * 0.55);
      g1.add(noz);
    }
    const nozC = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.16, rad * 0.34, L1 * 0.05, 12), dark);
    nozC.position.y = base - L1 * 0.02;
    g1.add(nozC);
    const inter = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.002, rad * 1.002, L1 * 0.06, 24), dark);
    inter.position.y = base + L1 - L1 * 0.03;
    g1.add(inter);
    this.meshRoot.add(g1);
    this.stageGroups.push(g1);

    // Stage II.
    const g2 = new THREE.Group();
    const body2 = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, L2, 24), white);
    body2.position.y = base + L1 + L2 / 2;
    g2.add(body2);
    const band2 = new THREE.Mesh(new THREE.CylinderGeometry(rad * 1.002, rad * 1.002, L2 * 0.12, 24), dark);
    band2.position.y = base + L1 + L2 * 0.06;
    g2.add(band2);
    this.meshRoot.add(g2);
    this.stageGroups.push(g2);

    // Capsule (truncated cone + heat shield).
    const gc = new THREE.Group();
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.35, rad * 0.98, LC * 0.72, 24), white);
    cone.position.y = base + L1 + L2 + LC * 0.36;
    gc.add(cone);
    const hs = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.98, rad * 0.9, LC * 0.1, 24), shield);
    hs.position.y = base + L1 + L2 - LC * 0.04;
    gc.add(hs);
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.16, rad * 0.35, LC * 0.2, 24), dark);
    nose.position.y = base + L1 + L2 + LC * 0.8;
    gc.add(nose);
    this.meshRoot.add(gc);
    this.stageGroups.push(gc);
    this.stackBase = base;
    this.stackLens = [L1, L2, LC];
    this.activeBottomY = base;          // bottom of active stack, stack coords
    this.activeTopY = base + total;
    this.meshRoot.position.y = -base;   // active bottom sits at vessel origin

    // Exhaust plume (billboard-ish cone, additive).
    const plumeMat = new THREE.MeshBasicMaterial({
      color: 0xffb14d, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.plume = new THREE.Mesh(new THREE.ConeGeometry(rad * 0.75, L1 * 0.9, 16, 1, true), plumeMat);
    this.plume.visible = false;
    this.meshRoot.add(this.plume);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff7733, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.reentryGlow = new THREE.Mesh(new THREE.SphereGeometry(rad * 3.2, 20, 16), glowMat);
    this.reentryGlow.visible = false;
    this.meshRoot.add(this.reentryGlow);

    // Parachute canopy: half-dome above the capsule, scaled by inflation.
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(rad * 5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xff7a29, roughness: 0.85, side: THREE.DoubleSide }),
    );
    canopy.position.y = rad * 9;
    const lines = new THREE.Mesh(
      new THREE.ConeGeometry(rad * 4.6, rad * 8, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xcfd6de, wireframe: true, transparent: true, opacity: 0.5 }),
    );
    lines.position.y = rad * 4.5;
    lines.rotation.x = Math.PI; // apex at the capsule, rim up at the canopy
    this.chute = new THREE.Group();
    this.chute.add(canopy); this.chute.add(lines);
    this.chute.position.y = base + total; // anchored at the capsule apex
    this.chute.visible = false;
    this.meshRoot.add(this.chute);

    this.scene.add(this.rocket);
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

  removeStageMesh(index) {
    const g = this.stageGroups[index];
    if (g) this.meshRoot.remove(g);
    this.activeBottomY = this.stackBase + this.stackLens.slice(0, index + 1).reduce((a, b) => a + b, 0);
    this.meshRoot.position.y = -this.activeBottomY;
  }

  makeDebrisMesh(d) {
    const rad = 3.7 / 2 * 0.001;
    const len = (d.stageName === 'Stage I' ? 41 : 14) * 0.001;
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(rad, rad, len, 16),
      new THREE.MeshStandardMaterial({ color: 0xcfd4d8, roughness: 0.6 }),
    );
    this.world.add(mesh);
    return mesh;
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

  update(sim, dtReal) {
    const rp = sim.r; // meters
    const px = rp[0] * KM, py = rp[1] * KM, pz = rp[2] * KM;
    this.world.position.set(-px, -py, -pz);

    // Vessel orientation.
    this.rocket.quaternion.set(sim.q[0], sim.q[1], sim.q[2], sim.q[3]);

    // Camera on a local sphere around the vessel, up = radial out.
    const rm = Math.hypot(px, py, pz) || 1;
    const up = this.tmpV.set(px / rm, py / rm, pz / rm);
    // Build tangent basis.
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
    // Keep the camera above the local ground when close in.
    if (altKm + this.camera.position.dot(up) < 0.004) {
      const need = 0.004 - altKm;
      this.camera.position.addScaledVector(up, need - this.camera.position.dot(up));
    }
    this.camera.up.copy(up);
    this.camera.lookAt(target);

    this.sun.position.copy(this.sunDir).multiplyScalar(10000);

    // Sky color and stars by altitude.
    const alt = sim.altitude;
    const k = Math.min(1, Math.max(0, alt / 90_000));
    const skyK = Math.pow(1 - k, 1.6);
    this.scene.background.setRGB(0.045 * skyK + 0.29 * skyK * skyK, 0.10 * skyK + 0.42 * skyK * skyK, 0.22 * skyK + 0.62 * skyK * skyK);
    this.starMat.opacity = Math.pow(k, 1.4);

    // Pad detail: position relative to vessel in doubles, fade with altitude.
    const padVisible = alt < 30_000;
    this.pad.visible = padVisible;
    if (padVisible) {
      this.pad.position.set(PLANET.radius * KM - px, -py, -pz);
    }

    // Plume.
    const thr = sim.effThrottle;
    if (thr > 0) {
      this.plume.visible = true;
      const flick = 0.92 + Math.random() * 0.16;
      const bottom = this.activeBottomY;
      const vac = Math.min(1, alt / 60_000);
      const len = this.stackLens[0] * (0.5 + thr * 0.9) * (1 + vac * 1.6) * flick;
      this.plume.scale.set(1 + vac * 2.2, len / (this.stackLens[0] * 0.9), 1 + vac * 2.2);
      this.plume.position.y = bottom - len / 2;
      this.plume.rotation.x = Math.PI;
      this.plume.material.opacity = 0.55 + 0.35 * thr;
    } else {
      this.plume.visible = false;
    }

    // Reentry glow.
    const glow = Math.min(1, Math.max(0, (sim.heat - 4e8) / 4e9));
    this.reentryGlow.visible = glow > 0.01;
    if (this.reentryGlow.visible) {
      this.reentryGlow.material.opacity = glow * 0.85;
      const s = 1 + glow * 2.5 + Math.random() * 0.15;
      this.reentryGlow.scale.set(s, s * 1.6, s);
      // Glow trails opposite the velocity vector (roughly behind heat shield).
      this.reentryGlow.position.y = this.stackBase + this.stackLens[0] + this.stackLens[1];
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
        const last = pts.length ? pts[pts.length - 1] : [0, 0, 0];
        attr.setXYZ(i, last[0] * KM, last[1] * KM, last[2] * KM);
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

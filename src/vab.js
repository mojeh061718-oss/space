// Vehicle Assembly: touch-first stack editor with a live 3D preview.
// The rocket on the pad IS the preview — while the VAB is open the camera
// slowly orbits it and every change rebuilds the meshes immediately.

import { ENGINES, TANKS, CAPSULES, DEFAULT_DESIGN, analyze, applyDesign, saveDesign } from './craft.js';

const $ = (id) => document.getElementById(id);
const cycle = (arr, cur, dir = 1) => arr[(arr.indexOf(cur) + dir + arr.length) % arr.length];

export class Vab {
  constructor(view, onLaunch) {
    this.view = view;
    this.onLaunch = onLaunch;
    this.design = JSON.parse(JSON.stringify(DEFAULT_DESIGN));
    this.open = false;

    $('vab-add').addEventListener('click', () => {
      if (this.design.stages.length >= 4) return;
      // New boosters go on the bottom (fired first).
      this.design.stages.unshift({ engine: 'm90', count: 5, tank: 'm' });
      this.refresh();
    });
    $('vab-launch').addEventListener('click', () => this.close(true));
  }

  setDesign(design) {
    if (design) this.design = JSON.parse(JSON.stringify(design));
  }

  show() {
    this.open = true;
    document.body.classList.add('vab-mode');
    $('vab-overlay').classList.remove('hidden');
    this.view.vabSpin = true;
    this.savedCam = { d: this.view.camDist, p: this.view.camPhi };
    this.view.camPhi = 1.25;
    this.refresh();
  }

  close(launch) {
    this.open = false;
    document.body.classList.remove('vab-mode');
    $('vab-overlay').classList.add('hidden');
    this.view.vabSpin = false;
    this.view.lookBias = 0;
    if (this.savedCam) { this.view.camDist = this.savedCam.d; this.view.camPhi = this.savedCam.p; }
    if (launch) {
      saveDesign(this.design);
      applyDesign(this.design);
      this.onLaunch();
    }
  }

  frameCraft() {
    const a = analyze(this.design);
    const totalLen = a.stages.reduce((s, st) => s + st.length, 0) / 1000;
    const portrait = window.innerHeight > window.innerWidth;
    this.view.camDist = Math.max(0.08, totalLen * (portrait ? 2.6 : 2.1));
    // Portrait uses a bottom sheet — bias the view so the craft sits in
    // the visible upper half.
    this.view.lookBias = portrait ? totalLen * 0.55 : 0;
  }

  refresh() {
    // Apply to the live vehicle + rebuild meshes so the preview is real.
    saveDesign(this.design);
    applyDesign(this.design);
    this.view.rebuildVehicle();
    this.frameCraft();

    const a = analyze(this.design);
    $('vab-mass').textContent = (a.liftoffMass / 1000).toFixed(1) + ' t';
    $('vab-dv').textContent = Math.round(a.totalDv) + ' m/s';
    $('vab-twr').textContent = a.padTwr.toFixed(2);
    $('vab-twr').className = a.padTwr < 1.05 ? 'bad' : 'good';

    const box = $('vab-stages');
    box.innerHTML = '';

    // Capsule row (top of stack).
    const capRow = document.createElement('div');
    capRow.className = 'vab-row';
    const cap = CAPSULES[this.design.capsule];
    capRow.innerHTML = `<span class="vab-tag">CREW</span>`;
    const capBtn = document.createElement('button');
    capBtn.className = 'vab-chip';
    capBtn.textContent = `${cap.name} · ${cap.crew} crew`;
    capBtn.addEventListener('click', () => {
      this.design.capsule = cycle(Object.keys(CAPSULES), this.design.capsule);
      this.refresh();
    });
    capRow.appendChild(capBtn);
    box.appendChild(capRow);

    // Stage rows, top stage first (matches the visual stack).
    for (let i = this.design.stages.length - 1; i >= 0; i--) {
      const st = this.design.stages[i];
      const e = ENGINES[st.engine];
      const row = document.createElement('div');
      row.className = 'vab-row';
      const perf = a.perStage[i];
      row.innerHTML = `<span class="vab-tag">S${i + 1}</span>`;

      const engBtn = document.createElement('button');
      engBtn.className = 'vab-chip';
      engBtn.textContent = e.short;
      engBtn.title = e.blurb;
      engBtn.addEventListener('click', () => {
        st.engine = cycle(Object.keys(ENGINES), st.engine);
        const ne = ENGINES[st.engine];
        if (!ne.counts.includes(st.count)) st.count = ne.counts[ne.counts.length - 1];
        this.refresh();
      });
      row.appendChild(engBtn);

      const cntBtn = document.createElement('button');
      cntBtn.className = 'vab-chip';
      cntBtn.textContent = '×' + st.count;
      cntBtn.addEventListener('click', () => {
        st.count = cycle(e.counts, st.count);
        this.refresh();
      });
      row.appendChild(cntBtn);

      const tankBtn = document.createElement('button');
      tankBtn.className = 'vab-chip';
      tankBtn.textContent = 'TANK ' + TANKS[st.tank].name;
      tankBtn.addEventListener('click', () => {
        st.tank = cycle(Object.keys(TANKS), st.tank);
        this.refresh();
      });
      row.appendChild(tankBtn);

      const info = document.createElement('span');
      info.className = 'vab-info';
      info.textContent = `${Math.round(perf.dv)} m/s · TWR ${perf.twr.toFixed(2)}`;
      row.appendChild(info);

      if (this.design.stages.length > 1) {
        const del = document.createElement('button');
        del.className = 'vab-chip vab-del';
        del.textContent = '✕';
        del.addEventListener('click', () => {
          this.design.stages.splice(i, 1);
          this.refresh();
        });
        row.appendChild(del);
      }
      box.appendChild(row);
    }

    $('vab-add').classList.toggle('hidden', this.design.stages.length >= 4);
    $('vab-warn').innerHTML = a.warnings.map((w) => `<div>⚠ ${w}</div>`).join('');
  }
}

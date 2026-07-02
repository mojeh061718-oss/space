// Compact attitude indicator: artificial horizon with pitch ladder, fixed
// nose marker, and prograde/retrograde markers projected into the body
// frame. Screen axes match the joystick: stick up pitches the nose toward
// the top of the ball, stick right yaws it toward the right.

const TAU = Math.PI * 2;

// Body axes (see sim.js): +Y = nose. Stick up rotates nose toward +Z,
// stick right rotates nose toward -X. So screen-up = body +Z and
// screen-right = body -X.
export class Navball {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.size = canvas.clientWidth || 96;
    canvas.width = this.size * dpr;
    canvas.height = this.size * dpr;
    this.ctx.scale(dpr, dpr);
    this.r = this.size / 2 - 3;
  }

  draw(sim) {
    const ctx = this.ctx;
    const c = this.size / 2;
    const r = this.r;
    ctx.clearRect(0, 0, this.size, this.size);

    // Basis vectors in world space.
    const q = sim.q;
    const rot = (v) => { // quaternion rotate
      const [x, y, z, w] = q;
      const ix = w * v[0] + y * v[2] - z * v[1];
      const iy = w * v[1] + z * v[0] - x * v[2];
      const iz = w * v[2] + x * v[1] - y * v[0];
      const iw = -x * v[0] - y * v[1] - z * v[2];
      return [
        ix * w + iw * -x + iy * -z - iz * -y,
        iy * w + iw * -y + iz * -x - ix * -z,
        iz * w + iw * -z + ix * -y - iy * -x,
      ];
    };
    const nose = rot([0, 1, 0]);
    const scrRight = rot([-1, 0, 0]);
    const scrUp = rot([0, 0, 1]);
    const rm = Math.hypot(sim.r[0], sim.r[1], sim.r[2]) || 1;
    const up = [sim.r[0] / rm, sim.r[1] / rm, sim.r[2] / rm];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

    const pitch = Math.asin(Math.max(-1, Math.min(1, dot(nose, up)))); // rad above horizon
    // Roll: direction of world-up projected on the screen plane.
    const ux = dot(up, scrRight), uy = dot(up, scrUp);
    const roll = Math.hypot(ux, uy) > 1e-4 ? Math.atan2(ux, uy) : 0;

    const pxPerRad = r / (Math.PI / 2) * 1.35; // ~60 deg visible from center to rim

    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, r, 0, TAU);
    ctx.clip();

    // Horizon: rotate by roll, shift by pitch.
    ctx.translate(c, c);
    ctx.rotate(-roll);
    const off = pitch * pxPerRad;
    ctx.fillStyle = '#173a5e';                     // sky
    ctx.fillRect(-r * 2, -r * 3 + off, r * 4, r * 3);
    ctx.fillStyle = '#3a2c20';                     // ground
    ctx.fillRect(-r * 2, off, r * 4, r * 3);
    ctx.strokeStyle = 'rgba(215, 227, 242, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r, off); ctx.lineTo(r, off);
    ctx.stroke();

    // Pitch ladder every 30 degrees.
    ctx.strokeStyle = 'rgba(215, 227, 242, 0.35)';
    ctx.fillStyle = 'rgba(215, 227, 242, 0.55)';
    ctx.lineWidth = 1;
    ctx.font = '7px ui-monospace, monospace';
    ctx.textAlign = 'center';
    for (let deg = -60; deg <= 60; deg += 30) {
      if (deg === 0) continue;
      const y = off - deg * Math.PI / 180 * pxPerRad;
      ctx.beginPath();
      ctx.moveTo(-r * 0.4, y); ctx.lineTo(r * 0.4, y);
      ctx.stroke();
      ctx.fillText(String(Math.abs(deg)), r * 0.58, y + 2.5);
    }
    ctx.restore();

    // Prograde / retrograde markers.
    if (sim.speed > 20) {
      const sm = sim.speed;
      const vh = [sim.v[0] / sm, sim.v[1] / sm, sim.v[2] / sm];
      this.marker(vh, nose, scrRight, scrUp, '#43e97b', 'pro');
      this.marker([-vh[0], -vh[1], -vh[2]], nose, scrRight, scrUp, '#ffa02e', 'retro');
    }

    // Fixed nose marker (center chevron).
    const ctx2 = this.ctx;
    ctx2.strokeStyle = '#37e0ff';
    ctx2.lineWidth = 2;
    ctx2.beginPath();
    ctx2.moveTo(c - 12, c); ctx2.lineTo(c - 4, c); ctx2.lineTo(c, c + 5); ctx2.lineTo(c + 4, c); ctx2.lineTo(c + 12, c);
    ctx2.stroke();
    ctx2.beginPath();
    ctx2.arc(c, c, 1.6, 0, TAU);
    ctx2.fillStyle = '#37e0ff';
    ctx2.fill();

    // Rim.
    ctx2.strokeStyle = 'rgba(90, 140, 200, 0.5)';
    ctx2.lineWidth = 1.5;
    ctx2.beginPath();
    ctx2.arc(c, c, r + 1, 0, TAU);
    ctx2.stroke();
  }

  marker(dir, nose, scrRight, scrUp, color, kind) {
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const fwd = dot(dir, nose);
    let x = dot(dir, scrRight);
    let y = -dot(dir, scrUp);
    const c = this.size / 2, r = this.r;
    const pxPerRad = r / (Math.PI / 2) * 1.35;
    // Angular offset projection; clamp to the rim when behind or far off.
    const ang = Math.acos(Math.max(-1, Math.min(1, fwd)));
    const m = Math.hypot(x, y) || 1e-6;
    let px = (x / m) * ang * pxPerRad;
    let py = (y / m) * ang * pxPerRad;
    const behind = fwd < 0;
    const lim = r - 8;
    const pm = Math.hypot(px, py);
    if (pm > lim) { px *= lim / pm; py *= lim / pm; }

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = behind ? 0.45 : 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.translate(c + px, c + py);
    if (kind === 'pro') {
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, 1.2, 0, TAU); ctx.fillStyle = color; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-9, 0); ctx.lineTo(-5, 0); ctx.moveTo(5, 0); ctx.lineTo(9, 0);
      ctx.moveTo(0, -9); ctx.lineTo(0, -5);
      ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, TAU); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3.5, -3.5); ctx.lineTo(3.5, 3.5);
      ctx.moveTo(3.5, -3.5); ctx.lineTo(-3.5, 3.5);
      ctx.stroke();
    }
    ctx.restore();
  }
}

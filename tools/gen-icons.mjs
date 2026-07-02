// Generates the PWA icon set as PNGs with no external dependencies:
// a software rasterizer + minimal PNG encoder (zlib from node core).
// Run: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

// ---- PNG encoder -----------------------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function encodePNG(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- rasterizer ------------------------------------------------------------
// Icon design: deep-space navy rounded square, planet limb at the bottom,
// a thin orbit ellipse, a white rocket climbing the orbit line.
const S = 1024;
const px = Buffer.alloc(S * S * 4);
const put = (i, r, g, b, a = 255) => {
  const bg = [px[i], px[i + 1], px[i + 2]];
  const k = a / 255;
  px[i] = r * k + bg[0] * (1 - k);
  px[i + 1] = g * k + bg[1] * (1 - k);
  px[i + 2] = b * k + bg[2] * (1 - k);
  px[i + 3] = 255;
};
const smooth = (d, aa = 2) => Math.max(0, Math.min(1, 0.5 - d / aa));

// Rocket at 62% up the canvas, tilted 35 degrees.
const rocketCX = S * 0.56, rocketCY = S * 0.40, rocketAng = 0.62, rocketL = S * 0.30, rocketW = S * 0.085;
const ca = Math.cos(rocketAng), sa = Math.sin(rocketAng);

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    // Background: vertical deep-space gradient inside a rounded square.
    const t = y / S;
    put(i, 8 + 14 * t, 14 + 24 * t, 30 + 46 * t);

    // Stars (hash sparkle).
    let hsh = (x * 374761393 + y * 668265263) >>> 0;
    hsh = ((hsh ^ (hsh >>> 13)) * 1274126177) >>> 0;
    if ((hsh & 0x3fff) < 3) {
      const fade = Math.max(0, Math.min(1, (S * 0.72 - y) / (S * 0.2)));
      const b = 120 + (hsh % 120);
      put(i, b, b, b + 15, 255 * fade);
    }

    // Planet limb: circle centered far below.
    const pcx = S * 0.5, pcy = S * 1.72, pr = S * 0.95;
    const dp = Math.hypot(x - pcx, y - pcy) - pr;
    if (dp < 0) {
      const glow = Math.max(0, 1 + dp / (S * 0.09));
      put(i, 20 + 40 * glow, 90 + 60 * glow, 170 + 60 * glow, 255 * smooth(dp, 3));
    } else if (dp < S * 0.045) {
      // Atmosphere glow above the limb.
      const k = 1 - dp / (S * 0.045);
      put(i, 60, 150, 255, 110 * k * k);
    }

    // Orbit ellipse (thin ring).
    const ex = (x - S * 0.5) / (S * 0.40), ey = (y - S * 0.52) / (S * 0.315);
    const er = Math.hypot(ex, ey);
    const de = Math.abs(er - 1) * S * 0.05;
    if (de < 4 && !(x > rocketCX - S * 0.14 && x < rocketCX + S * 0.14 && y > rocketCY - S * 0.14 && y < rocketCY + S * 0.14)) {
      put(i, 55, 224, 255, 190 * smooth(de - 2, 2.4));
    }

    // Rocket: body capsule shape in rotated frame.
    const rx = (x - rocketCX) * ca - (y - rocketCY) * sa; // along body
    const ry = (x - rocketCX) * sa + (y - rocketCY) * ca; // across body
    // Body.
    const half = rocketL / 2;
    let d = Math.max(Math.abs(ry) - rocketW / 2, Math.abs(rx) - half);
    if (rx > half - rocketW * 0.9) {
      // Nose cone: taper.
      const k = (rx - (half - rocketW * 0.9)) / (rocketW * 0.9);
      d = Math.abs(ry) - (rocketW / 2) * (1 - k * 0.92);
      d = Math.max(d, rx - half - rocketW * 0.15);
    }
    if (d < 0) {
      const shade = 235 - Math.max(0, ry / (rocketW / 2)) * 50;
      put(i, shade, shade + 6, shade + 12, 255 * smooth(d, 2.5));
      // Window.
      const dw = Math.hypot(rx - half * 0.45, ry) - rocketW * 0.16;
      if (dw < 0) put(i, 30, 60, 100, 255 * smooth(dw, 2));
      // Fin band.
      if (rx < -half * 0.72) put(i, 40, 52, 66, 235 * smooth(d, 2.5));
    }
    // Flame.
    if (rx < -half && rx > -half - rocketL * 0.38) {
      const k = (-half - rx) / (rocketL * 0.38);
      const dfl = Math.abs(ry) - (rocketW / 2) * (1 - k) * 0.8;
      if (dfl < 0) put(i, 255, 170 - 90 * k, 60, 240 * (1 - k) * smooth(dfl, 3));
    }
  }
}

// Downsample with box filter.
function scale(src, sw, dw) {
  const out = Buffer.alloc(dw * dw * 4);
  const r = sw / dw;
  for (let y = 0; y < dw; y++) {
    for (let x = 0; x < dw; x++) {
      let acc = [0, 0, 0, 0], n = 0;
      for (let sy = Math.floor(y * r); sy < Math.min(sw, (y + 1) * r); sy++) {
        for (let sx = Math.floor(x * r); sx < Math.min(sw, (x + 1) * r); sx++) {
          const si = (sy * sw + sx) * 4;
          acc[0] += src[si]; acc[1] += src[si + 1]; acc[2] += src[si + 2]; acc[3] += src[si + 3];
          n++;
        }
      }
      const di = (y * dw + x) * 4;
      out[di] = acc[0] / n; out[di + 1] = acc[1] / n; out[di + 2] = acc[2] / n; out[di + 3] = acc[3] / n;
    }
  }
  return out;
}

mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-512.png', encodePNG(scale(px, S, 512), 512, 512));
writeFileSync('icons/icon-192.png', encodePNG(scale(px, S, 192), 192, 192));
writeFileSync('icons/icon-180.png', encodePNG(scale(px, S, 180), 180, 180));
writeFileSync('icons/icon-maskable-512.png', encodePNG(scale(px, S, 512), 512, 512));
console.log('icons written');

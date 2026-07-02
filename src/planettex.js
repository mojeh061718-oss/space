// Procedural Earth-like textures generated at runtime (keeps the app small
// and fully offline). Deterministic seeded value-noise FBM.

function makeNoise(seed) {
  // Simple hash-based value noise with bilinear interpolation.
  const hash = (x, y) => {
    let h = seed + x * 374761393 + y * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const at = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
  return (x, y, octaves = 5) => {
    let v = 0, amp = 0.5, f = 1;
    for (let i = 0; i < octaves; i++) {
      v += amp * at(x * f, y * f);
      amp *= 0.5; f *= 2.05;
    }
    return v;
  };
}

export function makePlanetTexture(w = 1024, h = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const noise = makeNoise(1337);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const lat = (y / h - 0.5) * Math.PI; // -pi/2..pi/2
    const latAbs = Math.abs(lat) / (Math.PI / 2);
    for (let x = 0; x < w; x++) {
      // Sample on a wrapped cylinder so the seam matches.
      const lon = (x / w) * Math.PI * 2;
      const nx = Math.cos(lon) * 2 + 4, nz = Math.sin(lon) * 2 + 4;
      const e = noise(nx + (y / h) * 0.4, y / h * 4 + nz, 6)
        + 0.16 * noise(nx * 6, y / h * 20 + nz * 6, 3);
      let r, g, b;
      const sea = 0.62;
      if (e < sea) {
        const depth = (sea - e) / sea;
        r = 8 + 20 * (1 - depth); g = 40 + 60 * (1 - depth); b = 90 + 90 * (1 - depth);
      } else {
        const hgt = (e - sea) / (1 - sea);
        if (hgt < 0.12) { r = 194; g = 178; b = 128; }          // coast
        else if (hgt < 0.5) { r = 60 + 30 * hgt; g = 105 - 20 * hgt; b = 48; } // green
        else if (hgt < 0.8) { r = 120; g = 100; b = 72; }        // highlands
        else { r = 200; g = 198; b = 195; }                       // peaks
        // Dry out toward the subtropics a touch.
        const dry = Math.exp(-Math.pow((latAbs - 0.35) / 0.12, 2)) * 0.5;
        r = r * (1 - dry) + 180 * dry; g = g * (1 - dry) + 155 * dry; b = b * (1 - dry) + 95 * dry;
      }
      // Polar ice.
      const ice = Math.max(0, (latAbs - 0.78) / 0.1 + (e - 0.5) * 0.6);
      if (ice > 0) {
        const k = Math.min(1, ice);
        r = r * (1 - k) + 235 * k; g = g * (1 - k) + 240 * k; b = b * (1 - k) + 245 * k;
      }
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function makeCloudTexture(w = 1024, h = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const noise = makeNoise(7717);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const lon = (x / w) * Math.PI * 2;
      const nx = Math.cos(lon) * 2 + 9, nz = Math.sin(lon) * 2 + 9;
      // Stretch along longitude for streaky weather bands.
      let c = noise(nx * 1.4 + y / h * 0.3, y / h * 7 + nz * 1.4, 5);
      c = Math.max(0, (c - 0.52) * 3.2);
      const a = Math.min(1, c) * 235;
      const i = (y * w + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

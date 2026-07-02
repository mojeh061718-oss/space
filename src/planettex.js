// Stylized planet textures generated at runtime — clean banded colors with
// soft coasts, premium "artbook" look rather than photoreal noise.
// Deterministic seeded value-noise FBM.

function makeNoise(seed) {
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

// Shared heightfield so color and roughness maps agree.
function heightAt(noise, x, y, w, h) {
  const lon = (x / w) * Math.PI * 2;
  const nx = Math.cos(lon) * 2 + 4, nz = Math.sin(lon) * 2 + 4;
  // Fewer octaves = smoother, friendlier continents.
  return noise(nx + (y / h) * 0.4, (y / h) * 4 + nz, 4);
}

const SEA = 0.60;

// Stylized palette, banded by height with soft blends at the edges.
function shade(e, latAbs) {
  let r, g, b;
  if (e < SEA) {
    const depth = Math.min(1, (SEA - e) / 0.28);
    // Deep ocean -> bright tropical shallows.
    r = 24 + (12 - 24) * depth;
    g = 132 + (78 - 132) * depth;
    b = 205 + (160 - 205) * depth;
    // Shelf glow right at the coast.
    if (SEA - e < 0.025) { r = 72; g = 190; b = 214; }
  } else {
    const t = (e - SEA) / (1 - SEA);
    if (t < 0.06) { r = 255; g = 226; b = 156; }        // beach
    else if (t < 0.42) { r = 92; g = 182; b = 92; }     // meadow green
    else if (t < 0.66) { r = 52; g = 138; b = 84; }     // forest
    else if (t < 0.85) { r = 148; g = 138; b = 122; }   // highlands
    else { r = 245; g = 248; b = 250; }                  // peaks
  }
  // Polar ice with a clean stylized edge.
  const ice = (latAbs - 0.76) / 0.06 + (e - 0.5) * 0.4;
  if (ice > 0) {
    const kIce = Math.min(1, Math.max(0, ice));
    r = r * (1 - kIce) + 240 * kIce;
    g = g * (1 - kIce) + 246 * kIce;
    b = b * (1 - kIce) + 250 * kIce;
  }
  return [r, g, b];
}

export function makePlanetTexture(w = 1024, h = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const noise = makeNoise(1337);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const latAbs = Math.abs((y / h - 0.5) * 2);
    for (let x = 0; x < w; x++) {
      const e = heightAt(noise, x, y, w, h);
      const [r, g, b] = shade(e, latAbs);
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Ocean is glossy (sun glint), land is matte — sells the "premium globe".
export function makePlanetRoughnessTexture(w = 512, h = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const noise = makeNoise(1337);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = heightAt(noise, x, y, w, h);
      const rough = e < SEA ? 72 : 235;
      const i = (y * w + x) * 4;
      d[i] = rough; d[i + 1] = rough; d[i + 2] = rough; d[i + 3] = 255;
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
      // Puffy, high-contrast stylized clouds.
      let c = noise(nx * 1.2 + (y / h) * 0.3, (y / h) * 6 + nz * 1.2, 4);
      c = Math.max(0, (c - 0.55) * 4.2);
      const a = Math.min(1, c) * 255;
      const i = (y * w + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

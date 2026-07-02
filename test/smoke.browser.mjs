// Browser smoke test: serves the app, loads it in Chromium with an
// iPhone-like viewport, checks for console errors, drives a quick launch,
// and saves screenshots. Run: node test/smoke.browser.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const root = process.cwd();
const server = createServer(async (req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  try {
    const data = await readFile(join(root, p));
    res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('nope');
  }
});
await new Promise((r) => server.listen(8931, r));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 }, // iPhone 14-ish portrait
  deviceScaleFactor: 2,
  hasTouch: true,
});
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:8931/');
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test/shot-1-start.png' });

// Begin mission, throttle up, ignite.
await page.tap('#btn-begin');
await page.evaluate(() => {
  const { sim } = window.__meridian;
  sim.throttle = 1;
});
// Hold the stage button past its 550 ms arm time.
const box = await page.locator('#btn-stage').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(750);
await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: 'test/shot-2-liftoff.png' });

// Warp the sim ahead into a hand-flown ascent snapshot: inject state at
// 80 km, 3 km/s, pitched over, to exercise scene + HUD at altitude.
await page.evaluate(() => {
  const { sim } = window.__meridian;
  const R = 6371000;
  sim.vs.stageIndex = 1;
  sim.vs.prop[0] = 0;
  sim.r = [R + 90_000, 0, 60_000];
  sim.v = [900, 0, 4200];
  sim.q = [0, 0, Math.SQRT1_2 * -0.4, Math.SQRT1_2 * 1.35]; // rough pitched-over attitude
  const l = Math.hypot(...sim.q, 0); sim.q = sim.q.map((c) => c / l);
  sim.sas = 'prograde';
  sim.throttle = 1;
});
await page.waitForTimeout(2500);
await page.screenshot({ path: 'test/shot-3-ascent.png' });

// Zoom out to map scale.
await page.evaluate(() => { window.__meridian.view.camDist = 16000; });
await page.waitForTimeout(800);
await page.screenshot({ path: 'test/shot-4-map.png' });

// Capsule descending under chute: exercises staging visuals + canopy.
await page.evaluate(() => {
  const { sim, view } = window.__meridian;
  const R = 6371000;
  sim.vs.stageIndex = 2;
  sim.vs.prop[1] = 0;
  sim.r = [R + 2_000, 0, 900_000];
  sim.v = [-60, 0, 30];
  sim.vs.chuteArmed = true;
  sim.throttle = 0;
  sim.sas = 'hold';
  view.camDist = 0.06;
});
await page.waitForTimeout(2000);
await page.screenshot({ path: 'test/shot-6-chute.png' });

// Landscape check for safe areas / layout.
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(600);
await page.screenshot({ path: 'test/shot-5-landscape.png' });

const stats = await page.evaluate(() => {
  const { sim } = window.__meridian;
  return {
    alt: sim.altitude, speed: sim.speed, phase: sim.phase,
    ap: sim.orbit.apoapsis, pe: sim.orbit.periapsis,
    stage: sim.vs.stageIndex, met: sim.met,
    msgs: sim.messages.map((m) => m.text),
  };
});
console.log('sim state:', JSON.stringify(stats, null, 1));

// Service worker registration reachable?
const swOk = await page.evaluate(async () => {
  try {
    const r = await fetch('./sw.js'); return r.ok;
  } catch { return false; }
});
const manifestOk = await page.evaluate(async () => {
  const r = await fetch('./manifest.webmanifest'); return r.ok && (await r.json()).display === 'standalone';
});
console.log('sw fetchable:', swOk, '| manifest standalone:', manifestOk);

// RESET must restore a flyable pre-launch state with all stage meshes.
await page.tap('#btn-restart');
await page.waitForTimeout(400);
const afterReset = await page.evaluate(() => {
  const { sim, view } = window.__meridian;
  return {
    phase: sim.phase,
    stage: sim.vs.stageIndex,
    meshes: view.meshRoot.children.filter((c) => view.stageGroups.includes(c)).length,
  };
});
console.log('after reset:', JSON.stringify(afterReset));
if (afterReset.phase !== 'prelaunch' || afterReset.stage !== 0 || afterReset.meshes !== 3) {
  console.error('FAIL: reset did not restore vehicle');
  process.exit(1);
}

await browser.close();
server.close();

if (errors.length) {
  console.error('CONSOLE ERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
if (stats.met < 1 || stats.alt < 100) {
  console.error('FAIL: rocket did not lift off (alt=' + stats.alt + ')');
  process.exit(1);
}
console.log('SMOKE TEST PASSED');

/**
 * Browser smoke test: boots the app against a dev server in a real Chromium
 * and verifies the phase-1 guarantees end to end:
 *
 *   1. the page loads without errors,
 *   2. the simulation actually runs inside the Web Worker (tick advances),
 *   3. the population is correct (50 agents),
 *   4. the canvas renders a varied world + agents (pixel sampling),
 *   5. the in-worker determinism self-check passes.
 *
 * Requirements: a dev server on SMOKE_URL (default http://localhost:5173) and
 * a Playwright Chromium browser:
 *
 *   npx playwright install chromium && npm run test:e2e
 */

import { chromium } from 'playwright';

const url = process.env.SMOKE_URL ?? 'http://localhost:5173';
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name} ${detail}`);
    failures.push(name);
  }
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (error) {
  console.error(
    'Could not launch Chromium. Install the Playwright browser first:\n' +
      '  npx playwright install chromium\n' +
      `(${error.message.split('\n')[0]})`,
  );
  process.exit(2);
}
const page = await browser.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

  // --- Worker boot -----------------------------------------------------------
  await page.waitForFunction(
    () => window.__evosim !== undefined && window.__evosim.status().workerStatus !== 'boot',
    null,
    { timeout: 15_000 },
  );

  const first = await page.evaluate(() => window.__evosim.status());
  check('worker initialized (ready message received)', first.workerStatus !== 'boot');
  check('worker reports running', first.workerStatus === 'running', `(status: ${first.workerStatus})`);
  check('initial population is 50', first.population === 50, `(population: ${first.population})`);

  // --- Simulation advances inside the worker ---------------------------------
  await page.waitForTimeout(1500);
  const second = await page.evaluate(() => window.__evosim.status());
  check('simulation tick advances (worker loop alive)', second.tick > first.tick, `(${first.tick} -> ${second.tick})`);
  check('snapshots flow to the main thread', second.snapshotCount > first.snapshotCount);
  check('render loop runs (fps > 0)', second.renderFps > 0, `(fps: ${second.renderFps})`);

  // --- Canvas rendering --------------------------------------------------------
  const canvasInfo = await page.evaluate(() => {
    const canvas = document.getElementById('world-canvas');
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) return null;
    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const colors = new Set();
    for (let i = 0; i < data.length; i += 4 * 17) {
      colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
    }
    return { width, height, distinctColors: colors.size };
  });
  check('canvas has a painted, varied world', canvasInfo !== null && canvasInfo.distinctColors > 8, JSON.stringify(canvasInfo));

  // --- Agent interaction --------------------------------------------------------
  const selected = await page.evaluate(() => {
    const canvas = document.getElementById('world-canvas');
    const rect = canvas.getBoundingClientRect();
    // Click somewhere near the middle of the world where agents wander.
    window.__evosim;
    return { width: rect.width, height: rect.height };
  });
  // Click a few spots; at least one may select an agent — no crash either way.
  for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.55], [0.55, 0.45]]) {
    await page.mouse.click(selected.width * fx, selected.height * fy);
  }
  const afterClicks = await page.evaluate(() => window.__evosim.status());
  check('app healthy after interaction', afterClicks.workerStatus === 'running');

  // --- Determinism (executed inside the worker) --------------------------------
  const determinism = await page.evaluate(() => window.__evosim.verifyDeterminism(300));
  check('in-worker determinism self-check: same-seed runs identical', determinism.sameSeedMatch);
  check('in-worker determinism self-check: save/load continuation identical', determinism.restoreContinuationMatch);

  // --- Pause/resume control ------------------------------------------------------
  await page.click('#btn-toggle-running');
  await page.waitForTimeout(300);
  const paused = await page.evaluate(() => window.__evosim.status());
  check('pause stops the simulation', paused.workerStatus === 'paused' && !paused.running);
  await page.click('#btn-toggle-running');
  await page.waitForTimeout(300);
  const resumed = await page.evaluate(() => window.__evosim.status());
  check('resume restarts the simulation', resumed.workerStatus === 'running' && resumed.running);

  // --- Error hygiene --------------------------------------------------------------
  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\nSMOKE TEST FAILED (${failures.length} failing checks)`);
  process.exit(1);
}
console.log('\nSmoke test passed.');

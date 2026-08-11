// Dev-only browser smoke test: loads the app in headless Chromium, captures
// console errors, drives the desktop mouse interactions, and verifies the
// rendered frame contains actual content. Run with: bun run browser:smoke
// (requires the dev server on http://localhost:5173, i.e. `bun run dev`).
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const errors: string[] = [];
const warnings: string[] = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--ignore-certificate-errors',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
  if (msg.type() === 'warning') warnings.push(msg.text());
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

const status = async () => (await page.$eval('#status', (el) => el.textContent ?? '')).trim();
const moveCount = async () =>
  (await page.evaluate(() => {
    const c = (window as unknown as { __cubeDebug?: { history: unknown[] } }).__cubeDebug;
    return c ? c.history.length : -1;
  })) as number;

// 1. drag on the cube (a circular sweep around its projected centre) → a layer turn
interface PageDebug {
  THREE: typeof import('three');
  __cubeDebug: { history: unknown[] };
  __camera: unknown;
}
const center = await page.evaluate(() => {
  const w = window as unknown as PageDebug & {
    __cubeDebug: { getWorldPosition: (v: unknown) => { project: (c: unknown) => { x: number; y: number } } };
  };
  const rect = document.querySelector('canvas')!.getBoundingClientRect();
  const p = w.__cubeDebug.getWorldPosition(new w.THREE.Vector3()).project(w.__camera);
  return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height };
});
const R = 40;
const N = 24;
const pts: Array<[number, number]> = [];
for (let i = 0; i <= N; i++) {
  const a = Math.PI * 0.75 + (i / N) * Math.PI * 1.5;
  pts.push([center.x + R * Math.cos(a), center.y + R * Math.sin(a)]);
}
let dragTried = 0;
while ((await moveCount()) === 0 && dragTried < 2) {
  dragTried++;
  await page.mouse.move(pts[0][0], pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts) await page.mouse.move(x, y, { steps: 1 });
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 1500));
}
const movesAfterDrag = await moveCount();
console.log(`drag attempts: ${dragTried}, moves after drag: ${movesAfterDrag}`);

// 2. undo → back to solved
await page.click('#btnUndo');
await new Promise((r) => setTimeout(r, 1500));
const afterUndo = await moveCount();
console.log('moves after undo:', afterUndo);

// 3. orbit drag on empty space (top area of screen)
await page.mouse.move(640, 100);
await page.mouse.down();
await page.mouse.move(740, 140, { steps: 10 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 500));

// 4. scramble and wait for it to finish
await page.click('#btnScramble');
let waited = 0;
while ((await status()).includes('Scrambling') && waited < 20000) {
  await new Promise((r) => setTimeout(r, 500));
  waited += 500;
}
const afterScramble = await status();
console.log('status after scramble:', afterScramble);

await page.screenshot({ path: 'screenshot.png' });
const png = PNG.sync.read(readFileSync('screenshot.png'));
let min = 255, max = 0, sum = 0, black = 0, n = 0;
for (let y = 0; y < png.height; y += 4) {
  for (let x = 0; x < png.width; x += 4) {
    const i = (png.width * y + x) << 2;
    const luma = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
    min = Math.min(min, luma);
    max = Math.max(max, luma);
    sum += luma;
    if (luma < 4) black++;
    n++;
  }
}
console.log(`frame luma min=${min.toFixed(1)} max=${max.toFixed(1)} mean=${(sum / n).toFixed(1)} nearBlack=${((black / n) * 100).toFixed(1)}%`);

let failed = false;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}   ${name}${cond ? '' : detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = true;
};

check('no JS errors', errors.length === 0, errors.join(' | '));
check('drag turned a layer', movesAfterDrag >= 1, `attempts=${dragTried} moves=${movesAfterDrag}`);
check('undo restored solved', afterUndo === 0, String(afterUndo));
check('scramble completed', /22 moves/.test(afterScramble), afterScramble);
check('frame rendered content', max > 100 && black / n < 0.85, `max=${max} black=${(black / n) * 100}%`);

// 5. WebXR button creation: fake navigator.xr detection and verify the buttons appear
const xrPage = await browser.newPage();
await xrPage.setViewport({ width: 1280, height: 800 });
await xrPage.evaluateOnNewDocument(() => {
  Object.defineProperty(navigator, 'xr', {
    value: {
      isSessionSupported: async () => true,
    },
    configurable: true,
  });
});
await xrPage.goto('http://localhost:5173/', { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1000));
const xrButtons = await xrPage.$$eval('.xr-btn', (els) => els.map((el) => el.textContent ?? ''));
console.log('XR buttons:', xrButtons.join(', '));
check('XR enter buttons appear', xrButtons.some((t) => t.includes('Enter AR')) && xrButtons.some((t) => t.includes('Enter VR')), xrButtons.join(', '));
await xrPage.close();

await browser.close();

if (failed) process.exit(1);

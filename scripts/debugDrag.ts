import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
page.on('console', (m) => console.log('CONSOLE', m.type(), '|', m.text().slice(0, 200)));
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, 2000));

await page.evaluate(() => {
  window.__log = [];
  const c = window.__cubeDebug;
  const b = c.beginLiveTurn.bind(c);
  c.beginLiveTurn = (...a) => {
    window.__log.push('begin ' + JSON.stringify(a));
    return b(...a);
  };
  const s = c.setLiveAngle.bind(c);
  c.setLiveAngle = (a) => {
    window.__log.push('ang ' + (a / Math.PI * 180).toFixed(0));
    return s(a);
  };
  const e = c.endLiveTurn.bind(c);
  c.endLiveTurn = () => {
    window.__log.push('end');
    return e();
  };
});

const center = await page.evaluate(() => {
  const rect = document.querySelector('canvas').getBoundingClientRect();
  const p = window.__cubeDebug.getWorldPosition(new THREE.Vector3()).project(window.__camera);
  return { x: rect.left + (p.x * 0.5 + 0.5) * rect.width, y: rect.top + (-p.y * 0.5 + 0.5) * rect.height };
});

const R = 15;
const N = 24;
const pts = [];
for (let i = 0; i <= N; i++) {
  const a = Math.PI * 0.75 + (i / N) * Math.PI * 1.5;
  pts.push([center.x + R * Math.cos(a), center.y + R * Math.sin(a)]);
}

await page.mouse.move(pts[0][0], pts[0][1]);
await page.mouse.down();
for (const [x, y] of pts) await page.mouse.move(x, y, { steps: 1 });
await page.mouse.up();
await new Promise((r) => setTimeout(r, 1500));

const log = await page.evaluate(() => window.__log);
console.log('LOG (' + log.length + '):');
console.log(log.slice(0, 20).join('\n'));
console.log('... tail:');
console.log(log.slice(-5).join('\n'));
console.log('history:', await page.evaluate(() => window.__cubeDebug.history.length));
await browser.close();

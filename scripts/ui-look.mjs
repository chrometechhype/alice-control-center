import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const API = 'http://127.0.0.1:8722';
const OUT = 'shots/look';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const pages = await (await fetch(`${BROWSER}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => {
      if (pending.has(mid)) {
        pending.delete(mid);
        reject(new Error(`timeout ${method}`));
      }
    }, 30000);
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');

const setTheme = async (theme) => {
  const res = await fetch(`${API}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) throw new Error(`theme ${res.status}`);
};

const shot = async (name, path, width, height, theme) => {
  await setTheme(theme);
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 500,
  });
  await send('Page.navigate', { url: `${BASE}${path}?x=${theme}-${Date.now()}` });
  await sleep(2800);
  const probe = await evaluate(`(() => {
    const img = document.querySelector('.look .device-portrait img');
    return {
      theme: document.documentElement.dataset.theme,
      src: img?.getAttribute('src') ?? null,
      natural: img?.naturalWidth ?? 0,
      saved: localStorage.getItem('acc-station-look'),
      swatches: document.querySelectorAll('.look__swatch').length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.data, 'base64'));
  console.log(name, JSON.stringify(probe));
};

try {
  await shot('light-settings', '/settings', 1440, 1200, 'light');
  await evaluate(`(() => {
    const look = document.querySelector('.look');
    look?.scrollIntoView({ block: 'center' });
    return Boolean(look);
  })()`);
  await sleep(400);
  let png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/light-look-card.png`, Buffer.from(png.data, 'base64'));

  const changed = await evaluate(`(async () => {
    const swatches = [...document.querySelectorAll('.look__swatch')];
    swatches.find((b) => b.getAttribute('aria-label') === 'Синий')?.click();
    [...document.querySelectorAll('.seg')].find((b) => b.textContent.trim() === 'С часами')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const img = document.querySelector('.look .device-portrait img');
    return { src: img?.getAttribute('src'), saved: localStorage.getItem('acc-station-look') };
  })()`);
  console.log('changed', JSON.stringify(changed));
  png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/light-look-changed.png`, Buffer.from(png.data, 'base64'));

  const reset = await evaluate(`(async () => {
    [...document.querySelectorAll('.look .btn')].find((b) => b.textContent.includes('Сбросить'))?.click();
    await new Promise((r) => setTimeout(r, 400));
    const img = document.querySelector('.look .device-portrait img');
    return { src: img?.getAttribute('src'), saved: localStorage.getItem('acc-station-look') };
  })()`);
  console.log('reset', JSON.stringify(reset));

  await shot('dark-settings', '/settings', 1440, 1200, 'dark');
  await evaluate(`(() => { document.querySelector('.look')?.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(400);
  png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/dark-look-card.png`, Buffer.from(png.data, 'base64'));

  await shot('dark-dashboard', '/', 1440, 900, 'dark');
  await shot('light-dashboard', '/', 1440, 900, 'light');
  await shot('dark-mobile-dashboard', '/', 390, 844, 'dark');
} finally {
  await setTheme('system');
  ws.close();
}

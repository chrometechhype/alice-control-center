import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const API = 'http://127.0.0.1:8722';
const OUT = 'shots/theme';
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
    deviceScaleFactor: theme === 'dark' && width < 500 ? 2 : 1,
    mobile: width < 500,
  });
  await send('Page.navigate', { url: `${BASE}${path}?x=${theme}-${Date.now()}` });
  await sleep(3000);
  const probe = await send('Runtime.evaluate', {
    expression: `(() => ({
      theme: document.documentElement.dataset.theme,
      img: document.querySelector('.device-portrait img')?.getAttribute('src') ?? null,
      loaded: document.querySelector('.device-portrait img')?.complete ?? false,
      natural: (() => { const i = document.querySelector('.device-portrait img'); return i ? i.naturalWidth : 0 })(),
      heroTitle: document.querySelector('.hero h2')?.textContent?.trim() ?? null,
      pill: document.querySelector('.pill')?.textContent?.trim() ?? null,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    }))()`,
    returnByValue: true,
  });
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.data, 'base64'));
  console.log(name, JSON.stringify(probe.result.value));
};

try {
  await shot('final-light-dashboard', '/', 1440, 900, 'light');
  await shot('final-dark-dashboard', '/', 1440, 900, 'dark');
  await shot('final-dark-setup', '/setup', 1440, 900, 'dark');
  await shot('final-dark-mobile', '/', 390, 844, 'dark');
  await shot('final-light-mobile', '/', 390, 844, 'light');
} finally {
  await setTheme('system');
  ws.close();
}

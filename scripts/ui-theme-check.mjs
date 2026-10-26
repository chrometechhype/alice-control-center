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
const shot = async (name) => {
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.data, 'base64'));
};
const setTheme = async (theme) => {
  const res = await fetch(`${API}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) throw new Error(`theme ${res.status} ${await res.text()}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await evaluate(`localStorage.setItem('acc-welcome-v2','done'); true`);

for (const theme of ['dark', 'light']) {
  await setTheme(theme);
  await send('Page.navigate', { url: `${BASE}/?theme=${theme}-${Date.now()}` });
  await sleep(3000);
  const probe = await evaluate(`(() => ({
    theme: document.documentElement.dataset.theme,
    accent: getComputedStyle(document.documentElement).getPropertyValue('--station-accent').trim(),
    bg: getComputedStyle(document.body).backgroundColor,
    surface: getComputedStyle(document.querySelector('.card')).backgroundColor,
    heroBg: getComputedStyle(document.querySelector('.hero')).backgroundImage.slice(0, 90),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    primaryBtn: getComputedStyle(document.querySelector('.btn--primary')).backgroundColor,
    navActive: getComputedStyle(document.querySelector('.nav-link.router-link-active')).backgroundColor,
    brand: getComputedStyle(document.querySelector('.brand-mark')).backgroundImage.slice(0, 90),
  }))()`);
  console.log(theme, JSON.stringify(probe));
  await shot(`dash-${theme}`);
  await send('Page.navigate', { url: `${BASE}/settings?theme=${theme}-${Date.now()}` });
  await sleep(2600);
  await evaluate(`(() => { document.querySelector('.look')?.scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(400);
  await shot(`settings-${theme}`);
}

ws.close();

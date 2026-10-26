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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};
const shot = async (name) => {
  const png = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(png.data, 'base64'));
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
});

await fetch(`${API}/api/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ theme: 'dark' }),
});

await send('Page.navigate', { url: `${BASE}/?welcome=${Date.now()}` });
await sleep(1200);
await evaluate(`localStorage.removeItem('acc-welcome-v2'); localStorage.removeItem('acc-station-look'); true`);
await send('Page.reload');
await sleep(3200);

const probe1 = await evaluate(`(() => {
  const modal = document.querySelector('.modal');
  const img = modal?.querySelector('.device-portrait img');
  return {
    open: Boolean(modal),
    title: modal?.querySelector('h3')?.textContent?.trim() ?? null,
    hasPortrait: Boolean(img),
    accent: getComputedStyle(document.documentElement).getPropertyValue('--station-accent').trim(),
    savedWelcome: localStorage.getItem('acc-welcome-v2'),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
  };
})()`);
console.log('step1', JSON.stringify(probe1));
await shot('welcome-step1-dark');

await evaluate(`(() => {
  [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('Далее'))?.click();
  return true;
})()`);
await sleep(600);
const probe2 = await evaluate(`(() => {
  const modal = document.querySelector('.modal');
  const img = modal?.querySelector('.device-portrait img');
  return {
    title: modal?.querySelector('h3')?.textContent?.trim() ?? null,
    stepLabel: modal?.querySelector('.welcome-progress__label')?.textContent?.trim() ?? null,
    hasPortrait: Boolean(img),
    portraitSrc: img?.getAttribute('src') ?? null,
    swatches: modal?.querySelectorAll('.look__swatch').length ?? 0,
    footer: [...(modal?.querySelectorAll('.modal-foot .btn') ?? [])].map((b) => b.textContent.trim()),
  };
})()`);
console.log('step2', JSON.stringify(probe2));
await shot('welcome-step2-dark');

const changed = await evaluate(`(async () => {
  const blue = [...document.querySelectorAll('.modal .look__swatch')].find((b) => b.getAttribute('aria-label') === 'Синий');
  blue?.click();
  await new Promise((r) => setTimeout(r, 500));
  return {
    accent: getComputedStyle(document.documentElement).getPropertyValue('--station-accent').trim(),
    saved: localStorage.getItem('acc-station-look'),
    src: document.querySelector('.modal .device-portrait img')?.getAttribute('src'),
    primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  };
})()`);
console.log('changed', JSON.stringify(changed));
await shot('welcome-step2-blue-dark');

await evaluate(`(async () => {
  const green = [...document.querySelectorAll('.modal .look__swatch')].find((b) => b.getAttribute('aria-label') === 'Зелёный');
  green?.click();
  await new Promise((r) => setTimeout(r, 300));
  [...document.querySelectorAll('.modal-foot .btn')].find((b) => b.textContent.includes('Готово'))?.click();
  return true;
})()`);
await sleep(700);
const after = await evaluate(`(() => ({
  modalOpen: Boolean(document.querySelector('.modal')),
  savedWelcome: localStorage.getItem('acc-welcome-v2'),
  accent: getComputedStyle(document.documentElement).getPropertyValue('--station-accent').trim(),
  bodyBg: getComputedStyle(document.body).backgroundColor,
  heroBg: getComputedStyle(document.querySelector('.hero')).backgroundImage.slice(0, 120),
}))()`);
console.log('after', JSON.stringify(after));
await shot('dashboard-dark-green');

await fetch(`${API}/api/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ theme: 'light' }),
});
await sleep(900);
await shot('dashboard-light-green');
const light = await evaluate(`(() => ({
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
  surface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
  primary: getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
  heroBg: getComputedStyle(document.querySelector('.hero')).backgroundImage.slice(0, 120),
  brandBg: getComputedStyle(document.querySelector('.brand-mark')).backgroundImage.slice(0, 160),
}))()`);
console.log('light', JSON.stringify(light));

await send('Page.navigate', { url: `${BASE}/settings?w=${Date.now()}` });
await sleep(2500);
const settingsProbe = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.setting-row')].find((r) => r.textContent.includes('Приветствие'));
  return {
    hasWelcomeRow: Boolean(row),
    button: row?.querySelector('.btn')?.textContent?.trim() ?? null,
  };
})()`);
console.log('settings', JSON.stringify(settingsProbe));
await evaluate(`(() => {
  [...document.querySelectorAll('.setting-row')].find((r) => r.textContent.includes('Приветствие'))?.scrollIntoView({ block: 'center' });
  return true;
})()`);
await sleep(400);
await shot('settings-welcome-row-light');

await evaluate(`(() => {
  [...document.querySelectorAll('.setting-row')].find((r) => r.textContent.includes('Приветствие'))?.querySelector('.btn')?.click();
  return true;
})()`);
await sleep(600);
const reopened = await evaluate(`(() => ({
  open: Boolean(document.querySelector('.modal')),
  title: document.querySelector('.modal h3')?.textContent?.trim() ?? null,
}))()`);
console.log('reopened', JSON.stringify(reopened));
await shot('welcome-reopened-light');

ws.close();

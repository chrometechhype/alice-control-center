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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await fetch(`${API}/api/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ theme: 'dark' }),
});
await send('Page.navigate', { url: `${BASE}/fun?x=${Date.now()}` });
await sleep(1000);
await evaluate(`localStorage.setItem('acc-welcome-v2','done'); localStorage.setItem('acc-fun-loop','0'); true`);
await send('Page.reload');
await sleep(3000);

const probe = await evaluate(`(() => {
  const topbar = document.querySelector('.topbar-title');
  const cards = [...document.querySelectorAll('.page .card')];
  const myScenes = cards.find((c) => c.textContent.includes('Мои сцены'));
  const sceneGrid = document.querySelector('.scene-grid');
  const aiCard = cards.find((c) => c.textContent.includes('Генератор сцены'));
  const loopSwitch = document.querySelector('[aria-label="Работать без таймаута"]');
  return {
    topbar: topbar?.textContent?.trim(),
    topbarChildren: [...(topbar?.children ?? [])].map((n) => n.textContent.trim()),
    bodyLabels: [...document.querySelectorAll('.topbar *')].map((n) => n.textContent.trim()).filter((t) => t && t.length < 60).slice(0, 10),
    myScenesAbove: myScenes && sceneGrid ? myScenes.compareDocumentPosition(sceneGrid) & Node.DOCUMENT_POSITION_FOLLOWING ? true : false : null,
    myScenesTop: myScenes?.getBoundingClientRect().top ?? null,
    gridTop: sceneGrid?.getBoundingClientRect().top ?? null,
    loopChecked: loopSwitch?.getAttribute('aria-checked'),
    loopRole: loopSwitch?.getAttribute('role'),
    aiPill: aiCard?.querySelector('.pill')?.textContent?.trim(),
    aiSegments: [...(aiCard?.querySelectorAll('.seg') ?? [])].map((b) => ({ text: b.textContent.trim(), active: b.classList.contains('active') })),
    aiSub: aiCard?.querySelector('.card-sub')?.textContent?.trim(),
    aiHint: aiCard?.querySelector('.field-hint')?.textContent?.trim()?.slice(0, 120),
    myScenesCount: myScenes?.querySelectorAll('.list-row').length ?? 0,
    badges: [...document.querySelectorAll('.scene-badge')].map((n) => n.textContent.trim()),
  };
})()`);
console.log('fun', JSON.stringify(probe, null, 2));
await shot('fun-dark');

await evaluate(`document.querySelector('[aria-label="Работать без таймаута"]')?.click(); true`);
await sleep(500);
const toggled = await evaluate(`(() => ({
  checked: document.querySelector('[aria-label="Работать без таймаута"]')?.getAttribute('aria-checked'),
  saved: localStorage.getItem('acc-fun-loop'),
  badges: [...document.querySelectorAll('.scene-badge')].map((n) => n.textContent.trim()),
}))()`);
console.log('toggled', JSON.stringify(toggled));
await evaluate(`document.querySelector('[aria-label="Работать без таймаута"]')?.click(); true`);

await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await sleep(600);
await shot('fun-mobile-dark');

const overflow = await evaluate(`(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}))()`);
console.log('mobile', JSON.stringify(overflow));
ws.close();

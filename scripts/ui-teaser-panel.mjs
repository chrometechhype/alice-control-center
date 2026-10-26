import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('shots/look', { recursive: true });

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

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: `${BASE}/settings?teaser=${Date.now()}` });
await sleep(2500);
await evaluate(`(() => {
  localStorage.setItem('acc-welcome-v2','done');
  const style = document.createElement('style');
  style.textContent = '.sidebar,.topbar,.page-head__actions{display:none!important}.shell{grid-template-columns:1fr!important}.main{height:100vh!important;overflow:hidden!important}.page{padding-top:24px!important}';
  document.head.appendChild(style);
  const ai = [...document.querySelectorAll('.page .card')].find((c) => c.textContent.includes('ИИ-генератор'));
  ai?.scrollIntoView({ block: 'center' });
  return true;
})()`);
await sleep(800);
const rect = await evaluate(`(() => {
  const page = document.querySelector('.page');
  const r = page.getBoundingClientRect();
  return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(1180, r.width), height: Math.min(940, window.innerHeight - r.y) };
})()`);
const png = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { ...rect, scale: 1 },
  captureBeyondViewport: false,
});
fs.writeFileSync('shots/look/teaser-panel.png', Buffer.from(png.data, 'base64'));
console.log(JSON.stringify(rect));
ws.close();

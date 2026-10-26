import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/settings?updates=${Date.now()}` });
await sleep(2500);
const probe = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.page .card')];
  const card = cards.find((c) => c.textContent.includes('Обновления'));
  const about = cards.find((c) => c.textContent.includes('О приложении'));
  card?.scrollIntoView({ block: 'center' });
  return {
    title: card?.querySelector('.card-title')?.textContent?.trim(),
    pill: card?.querySelector('.pill')?.textContent?.trim(),
    rows: [...(card?.querySelectorAll('.kv-row') ?? [])].map((r) => r.textContent.trim().replace(/\\s+/g, ' ')),
    buttons: [...(card?.querySelectorAll('button, a.btn') ?? [])].map((b) => b.textContent.trim()).filter(Boolean),
    aboutVersion: [...(about?.querySelectorAll('.kv-row') ?? [])].map((r) => r.textContent.trim())[0],
    socialLinks: [...(about?.querySelectorAll('.social-link') ?? [])].map((a) => ({ label: a.getAttribute('aria-label'), href: a.getAttribute('href') })),
    sidebarSocial: [...document.querySelectorAll('.sidebar .social-link')].map((a) => a.getAttribute('aria-label')),
    banner: Boolean(document.querySelector('.update-banner')),
  };
})()`);
await sleep(600);
console.log(JSON.stringify(probe, null, 2));
await shot('settings-updates-dark');

await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await sleep(600);
await evaluate(`document.querySelectorAll('.page .card').length && [...document.querySelectorAll('.page .card')].find((c) => c.textContent.includes('Обновления'))?.scrollIntoView({block:'center'}); true`);
await sleep(500);
await shot('settings-updates-mobile-dark');
ws.close();

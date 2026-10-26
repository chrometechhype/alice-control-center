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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await fetch(`${API}/api/settings`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ theme: 'dark' }),
});
await send('Page.navigate', { url: `${BASE}/settings?x=${Date.now()}` });
await sleep(1000);
await evaluate(`localStorage.setItem('acc-welcome-v2','done'); true`);
await send('Page.reload');
await sleep(3000);

const settingsProbe = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.page .card')];
  const ai = cards.find((c) => c.textContent.includes('ИИ-генератор'));
  const look = cards.find((c) => c.textContent.includes('Образ станции'));
  return {
    title: document.querySelector('.topbar-title strong')?.textContent?.trim(),
    aiTitle: ai?.querySelector('.card-title')?.textContent?.trim(),
    aiSub: ai?.querySelector('.card-sub')?.textContent?.trim(),
    aiPill: ai?.querySelector('.pill')?.textContent?.trim(),
    providers: [...(ai?.querySelectorAll('select option') ?? [])].map((o) => o.textContent.trim()),
    baseUrl: ai?.querySelector('input[type=url]')?.value,
    model: ai?.querySelector('input[type=text]')?.value,
    keyType: ai?.querySelector('input[type=password]')?.getAttribute('type'),
    buttons: [...(ai?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim()).filter(Boolean),
    lookPresent: Boolean(look),
    aiAboveLook: ai && look ? Boolean(ai.compareDocumentPosition(look) & Node.DOCUMENT_POSITION_FOLLOWING) : null,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
})()`);
console.log('settings', JSON.stringify(settingsProbe, null, 2));
await shot('settings-ai-dark');

await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
await sleep(600);
await shot('settings-ai-mobile-dark');

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/fun?x=${Date.now()}` });
await sleep(2500);
await evaluate(`(async () => {
  const m = await import('/src/lib/store.ts');
  const led = { available: true, kind: 'sysfs', details: { kind: 'sysfs', zones: [1, 2, 3] } };
  const off = { available: false, reason: 'демо-снимок' };
  m.store.status = { state: 'connected', transport: 'ssh', connectedAt: Date.now() };
  m.store.info = {
    hostname: 'Yandex-Lite-gen2-XXXX', modelRaw: 'Yandex Prune EVT2', modelGuess: 'Станция Лайт 2',
    firmware: '0.372.1.13', quasarVersion: '0.372.1.13', kernel: '4.9.113', arch: 'aarch64',
    os: 'Linux', cpuModel: 'Amlogic', cpuCores: 4, totalMemBytes: 2378 * 1024 * 1024,
    uptimeSec: 120, ip: '192.168.1.42', wifiRssi: -42, deviceId: 'DEMO', collectedAt: Date.now(),
  };
  m.store.capabilities = {
    system: { available: true }, sftp: off, sounds: off, led, bluetooth: off, logs: off,
    fastfetch: off, yam: off, adb: off, thermal: off, sensors: off, audio: off, framebuffer: off, yse: off,
  };
  m.store.metrics = [];
  return true;
})()`);
await sleep(900);
const funProbe = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.page .card')];
  const ai = cards.find((c) => c.textContent.includes('ИИ-генератор'));
  const loop = document.querySelector('[aria-label="Работать без таймаута"]');
  return {
    title: document.querySelector('.topbar-title strong')?.textContent?.trim(),
    cardTitles: cards.map((c) => c.querySelector('.card-title')?.textContent?.trim()).filter(Boolean),
    aiSub: ai?.querySelector('.card-sub')?.textContent?.trim(),
    aiPill: ai?.querySelector('.pill')?.textContent?.trim(),
    aiButtons: [...(ai?.querySelectorAll('button') ?? [])].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })).filter((b) => b.text),
    aiHint: ai?.querySelector('.field-hint')?.textContent?.trim()?.slice(0, 160),
    loopPresent: Boolean(loop),
    speedPresent: [...document.querySelectorAll('.card-title')].some((n) => n.textContent.includes('Скорость')),
    gridBelowMyScenes: (() => {
      const mine = cards.find((c) => c.textContent.includes('Мои сцены'));
      const grid = document.querySelector('.scene-grid');
      return mine && grid ? Boolean(mine.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    })(),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  };
})()`);
console.log('fun', JSON.stringify(funProbe, null, 2));
await shot('fun-ai-dark');
ws.close();

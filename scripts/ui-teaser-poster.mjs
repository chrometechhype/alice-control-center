import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(path.join(root, 'shots', 'look'), { recursive: true });

const now = Date.now();
const metrics = Array.from({ length: 72 }, (_, index) => {
  const wave = Math.sin(index / 6) * 8 + Math.sin(index / 2.7) * 3;
  const mem = 57 + Math.sin(index / 9) * 4 + Math.cos(index / 4) * 1.5;
  return {
    ts: now - (71 - index) * 5000,
    cpuPct: Math.max(2, Math.round(24 + wave)),
    memUsedBytes: Math.round((mem / 100) * 256 * 1024 * 1024),
    memTotalBytes: 256 * 1024 * 1024,
    memPct: Number(mem.toFixed(1)),
    tempC: Math.round((43 + Math.sin(index / 8) * 3) * 10) / 10,
    diskUsedBytes: 1.7 * 1024 * 1024 * 1024,
    diskTotalBytes: 4 * 1024 * 1024 * 1024,
    dataUsedBytes: 680 * 1024 * 1024,
    dataTotalBytes: 2 * 1024 * 1024 * 1024,
    load1: Number((0.42 + Math.sin(index / 5) * 0.12).toFixed(2)),
    uptimeSec: 262_400 + index * 5,
    wifiRssi: -47 - (index % 4),
  };
});

const info = {
  hostname: 'yandex-lite-2',
  modelRaw: 'Yandex Prune EVT2',
  modelGuess: 'Станция Лайт 2',
  firmware: '0.372.1.13',
  quasarVersion: '2.0.21',
  kernel: '4.9.113',
  arch: 'aarch64',
  os: 'Buildroot',
  cpuModel: 'Amlogic S905Y4',
  cpuCores: 4,
  totalMemBytes: 256 * 1024 * 1024,
  uptimeSec: 262_760,
  ip: '192.168.1.42',
  wifiRssi: -47,
  collectedAt: now,
};

const zones = ['led0', 'led1', 'led2'].map((prefix, index) => ({
  index,
  prefix,
  ring: index,
  red: `red${index}`,
  green: `green${index}`,
  blue: `blue${index}`,
}));

const capabilities = {
  system: { available: true },
  sftp: { available: false, reason: 'SFTP отключён на прошивке' },
  sounds: { available: true, details: { count: 46, categories: ['alarm', 'notification'], formats: ['ogg', 'wav'] } },
  led: { available: true, kind: 'sysfs', zones, defaultTriggers: ['led_ring_fb'] },
  bluetooth: {
    available: true,
    details: { adapter: 'hci0', powered: true, address: '00:1A:7D:DA:71:13' },
  },
  logs: { available: true, files: ['/var/log/messages'] },
  fastfetch: { available: true, path: '/usr/bin/fastfetch' },
  yam: { available: false },
  adb: { available: true, network: true },
  thermal: { available: true, zones: ['thermal_zone0'] },
  sensors: { available: true },
  audio: { available: true },
  framebuffer: { available: true },
  yse: { available: true },
};

const snapshot = {
  status: {
    state: 'connected',
    transport: 'ssh',
    host: '192.168.1.42',
    port: 2222,
    username: 'root',
    connectedAt: now - 3_600_000,
  },
  info,
  capabilities,
  warnings: [],
  metrics,
  lastSample: metrics.at(-1),
  config: {
    transport: 'ssh',
    host: '192.168.1.42',
    port: 2222,
    username: 'root',
    hasPassword: true,
    autoReconnect: true,
  },
};

const events = [
  { id: 'e1', ts: now - 42_000, level: 'success', module: 'led', operation: 'animation', result: 'ok', message: 'Сцена «Северное сияние» запущена' },
  { id: 'e2', ts: now - 180_000, level: 'info', module: 'system', operation: 'metrics', result: 'ok', message: 'Метрики обновлены' },
  { id: 'e3', ts: now - 420_000, level: 'success', module: 'sounds', operation: 'replace', result: 'ok', message: 'Системный звук заменён, оригинал сохранён' },
  { id: 'e4', ts: now - 900_000, level: 'info', module: 'bluetooth', operation: 'connect', result: 'ok', message: 'Bluetooth: подключён пульт' },
  { id: 'e5', ts: now - 1_500_000, level: 'success', module: 'backups', operation: 'create', result: 'ok', message: 'Бэкап конфигурации создан' },
];

const backups = [
  { id: 'b1', kind: 'config', title: 'Конфигурация Quasar', createdAt: now - 1_500_000, items: [{}, {}, {}, {}] },
  { id: 'b2', kind: 'sound', title: 'Оригинал alarm.ogg', createdAt: now - 3_600_000, items: [{}] },
];

const updates = {
  currentVersion: '0.2.0',
  latestVersion: '0.2.0',
  updateAvailable: false,
  canInstall: false,
  repo: 'chrometechhype/alice-control-center',
  releaseUrl: 'https://github.com/chrometechhype/alice-control-center/releases/tag/v0.2.0',
  notes: '',
  publishedAt: now - 86_400_000,
  checkedAt: now - 60_000,
  state: null,
};

const settings = {
  theme: 'dark',
  pollIntervalMs: 5000,
  lanAccess: false,
  autoConnect: true,
  lanAddresses: ['192.168.1.42'],
  lanTokenSet: false,
};

const mockData = {
  '/api/auth/status': { required: false, authenticated: true, lanEnabled: false },
  '/api/device': snapshot,
  '/api/settings': settings,
  '/api/audio': { volumePct: 42, volumeRaw: 42, max: 100, muted: false },
  '/api/events': { events, modules: ['led', 'system', 'sounds', 'bluetooth', 'backups'], total: events.length },
  '/api/backups': { backups, counts: { config: 1, sound: 1 } },
  '/api/updates': updates,
  '/api/system/metrics': { history: metrics, last: metrics.at(-1), error: null },
  '/api/led/presets': [],
  '/api/settings/ai': {
    provider: 'pollinations',
    baseUrl: 'https://text.pollinations.ai/openai',
    model: 'openai-fast',
    hasKey: false,
    configured: true,
    presets: [],
  },
};

const pages = await (await fetch(`${BROWSER}/json/list`)).json();
const page = pages.find((item) => item.type === 'page');
if (!page) throw new Error('Не найдена страница Chrome');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});

let id = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
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
    }, 30_000);
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    const data = ${JSON.stringify(mockData)};
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const raw = typeof input === 'string' ? input : input.url;
      const url = new URL(raw, location.origin);
      if (url.pathname.startsWith('/api/')) {
        const body = JSON.stringify({ ok: true, data: data[url.pathname] ?? {} });
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return realFetch(input, init);
    };
    class FakeSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      constructor() {
        super();
        setTimeout(() => {
          this.readyState = 3;
          this.dispatchEvent(new Event('close'));
        }, 120);
      }
      send() {}
      close() {
        this.readyState = 3;
      }
    }
    window.WebSocket = FakeSocket;
    try {
      localStorage.setItem('acc-welcome-v2', 'done');
      localStorage.setItem('acc-theme', 'dark');
      localStorage.setItem('acc-station-look', JSON.stringify({ color: 'green', clock: false }));
    } catch {}
  })();`,
});
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 1080,
  deviceScaleFactor: 2,
  mobile: false,
});
await send('Page.navigate', { url: `${BASE}/?teaser=${Date.now()}` });
await sleep(3200);
await evaluate(`(() => {
  const style = document.createElement('style');
  style.textContent = '.topbar-ws,.toasts,.welcome-scrim{display:none!important}';
  document.head.appendChild(style);
  document.querySelector('.page')?.scrollTo?.(0, 0);
  window.scrollTo(0, 0);
  return true;
})()`);
await sleep(900);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const screenshotPath = path.join(root, 'shots', 'look', 'teaser-dashboard.png');
fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
console.log(`Dashboard: ${path.relative(root, screenshotPath)}`);

ws.close();

function dataUri(file) {
  return `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(file).toString('base64')}`;
}

const poster = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { width: 1600px; height: 900px; margin: 0; overflow: hidden; }
  body {
    background: #f5efe4;
    color: #142019;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .poster { position: relative; width: 1600px; height: 900px; overflow: hidden; }
  .blob { position: absolute; border-radius: 50%; filter: blur(20px); opacity: .75; }
  .blob--green {
    width: 760px; height: 760px; left: -240px; top: -260px;
    background: radial-gradient(circle at 55% 55%, #8ee6b5, rgba(142,230,181,0));
  }
  .blob--violet {
    width: 720px; height: 720px; right: -220px; bottom: -320px;
    background: radial-gradient(circle at 45% 45%, #cbb8ff, rgba(203,184,255,0));
  }
  .blob--peach {
    width: 520px; height: 520px; right: 220px; top: -240px;
    background: radial-gradient(circle at 50% 50%, #ffd2b0, rgba(255,210,176,0));
  }
  .grain {
    position: absolute; inset: 0; opacity: .16; pointer-events: none;
    background-image: radial-gradient(rgba(20,32,25,.5) .7px, transparent .7px);
    background-size: 4px 4px;
  }
  .eyebrow {
    position: absolute; left: 1088px; top: 88px;
    font-size: 12px; font-weight: 700; letter-spacing: .22em; color: #2d7d58;
  }
  .version {
    position: absolute; right: 64px; top: 78px;
    padding: 7px 13px; border: 1px solid rgba(20,32,25,.18); border-radius: 999px;
    background: rgba(255,255,255,.55); font-size: 12px; font-weight: 650; color: #40544a;
  }
  h1 {
    position: absolute; left: 1084px; top: 116px; margin: 0;
    font-size: 90px; line-height: .91; letter-spacing: -.055em; font-weight: 760;
  }
  h1 span { color: #2e9e65; font-size: 58px; letter-spacing: -.045em; display: block; margin-top: 10px; }
  .lead {
    position: absolute; left: 1090px; top: 322px; width: 438px; margin: 0;
    font-size: 17px; line-height: 1.5; color: #46584e;
  }
  .chips {
    position: absolute; left: 1090px; top: 438px; width: 450px;
    display: flex; flex-wrap: wrap; gap: 8px;
  }
  .chips span {
    padding: 7px 12px; border-radius: 999px; background: rgba(255,255,255,.66);
    border: 1px solid rgba(20,32,25,.1); font-size: 12px; font-weight: 650; color: #33463b;
  }
  .chips span:first-child { background: #173b2b; color: #dff7e9; border-color: #173b2b; }
  .frame {
    position: absolute; left: 54px; top: 142px; width: 978px; height: 624px;
    border-radius: 28px; overflow: hidden; background: #120e0c;
    border: 1px solid rgba(255,255,255,.22);
    box-shadow: 0 50px 90px -36px rgba(23,49,35,.55), 0 18px 44px -26px rgba(0,0,0,.55);
    transform: perspective(1900px) rotateY(6.5deg) rotateX(1.2deg);
    transform-origin: 30% 50%;
  }
  .frame::after {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    box-shadow: inset 0 1px 0 rgba(255,255,255,.16);
  }
  .bar {
    height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 16px;
    background: #1d1714; border-bottom: 1px solid rgba(255,255,255,.07);
  }
  .bar i { width: 8px; height: 8px; border-radius: 50%; background: #4a403b; display: block; }
  .bar i:nth-child(1) { background: #ff6b5e; }
  .bar i:nth-child(2) { background: #ffc14d; }
  .bar i:nth-child(3) { background: #4ac97d; }
  .addr {
    flex: 1; margin-left: 10px; height: 22px; border-radius: 999px;
    background: rgba(255,255,255,.055); color: #9d928b; font-size: 10px;
    display: flex; align-items: center; justify-content: center; letter-spacing: .03em;
  }
  .frame img { display: block; width: 978px; height: auto; }
  .stations {
    position: absolute; left: 1078px; top: 564px; width: 468px;
    display: flex; align-items: flex-end; gap: 14px;
  }
  .station { flex: 1; text-align: center; }
  .bubble {
    width: 138px; height: 138px; margin: 0 auto; border-radius: 50%;
    background: #fff; display: grid; place-items: center; overflow: hidden;
    border: 1px solid rgba(20,32,25,.08);
    box-shadow: 0 22px 36px -22px rgba(23,49,35,.45), inset 0 -8px 18px rgba(20,32,25,.05);
  }
  .bubble img { width: 132px; height: 132px; object-fit: contain; }
  .station b { display: block; margin-top: 10px; font-size: 12px; color: #33463b; }
  .caption { position: absolute; left: 1088px; top: 758px; font-size: 11px; letter-spacing: .14em; color: #6b7c72; font-weight: 650; }
  .foot {
    position: absolute; left: 64px; right: 64px; bottom: 38px;
    display: flex; align-items: center; justify-content: space-between;
    padding-top: 18px; border-top: 1px solid rgba(20,32,25,.13);
    font-size: 12.5px; color: #46584e; font-weight: 600;
  }
  .foot-group { display: flex; align-items: center; gap: 18px; }
  .foot-item { display: flex; align-items: center; gap: 7px; }
  .foot svg { width: 16px; height: 16px; }
</style>
</head>
<body>
<div class="poster">
  <div class="blob blob--green"></div>
  <div class="blob blob--violet"></div>
  <div class="blob blob--peach"></div>
  <div class="grain"></div>

  <div class="eyebrow">ЛОКАЛЬНАЯ ПАНЕЛЬ · OPEN SOURCE</div>
  <div class="version">v0.2.0 · MIT</div>
  <h1>Alice<span>Control Center</span></h1>
  <p class="lead">Управление рутованной Яндекс Станцией с компьютера и телефона. SSH, LED, звуки, Bluetooth и обновления — в одном окне.</p>
  <div class="chips">
    <span>Vue 3</span><span>Node.js</span><span>SSH</span><span>Material You 3</span><span>Windows · macOS · Linux</span>
  </div>

  <div class="frame">
    <div class="bar"><i></i><i></i><i></i><span class="addr">127.0.0.1:8722</span></div>
    <img src="${dataUri(path.join(root, 'shots', 'look', 'teaser-dashboard.png'))}" alt="Alice Control Center">
  </div>

  <div class="stations">
    <div class="station"><div class="bubble"><img src="${dataUri(path.join(root, 'public', 'devices', 'lite2-green.webp'))}" alt=""></div><b>Лайт 2</b></div>
    <div class="station"><div class="bubble"><img src="${dataUri(path.join(root, 'public', 'devices', 'lite2-violet.webp'))}" alt=""></div><b>Лайт 2</b></div>
    <div class="station"><div class="bubble"><img src="${dataUri(path.join(root, 'public', 'devices', 'mini.webp'))}" alt=""></div><b>Мини</b></div>
  </div>
  <div class="caption">ОФИЦИАЛЬНЫЕ ОБРАЗЫ СТАНЦИЙ</div>

  <div class="foot">
    <div class="foot-group">
      <span class="foot-item"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.4-5.25 5.69.41.35.77 1.04.77 2.1 0 1.52-.01 2.75-.01 3.12 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>chrometechhype/alice-control-center</span>
      <span class="foot-item"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.94 4.3a1.5 1.5 0 0 0-1.53-.25L3.06 11.2c-1.4.54-1.38 1.33-.23 1.69l4.63 1.44 1.78 5.46c.2.57.37.79.73.79.35 0 .5-.16.7-.35l2.27-2.2 4.72 3.48c.87.48 1.5.23 1.72-.8l3.1-14.55a1.1 1.1 0 0 0-.54-1.86ZM9.05 14.55l10.1-6.36c.5-.3.96-.14.58.2l-8.67 7.82-.34 3.56-1.67-5.22Z"/></svg>@myloveiskeri</span>
    </div>
    <span>Панель не является официальным продуктом Яндекса</span>
  </div>
</div>
</body>
</html>`;

const posterPath = path.join(root, 'shots', 'look', 'teaser-poster.html');
fs.writeFileSync(posterPath, poster);
console.log(`Poster HTML: ${path.relative(root, posterPath)}`);

import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dataUri(relativePath) {
  const file = path.join(root, relativePath);
  return `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(file).toString('base64')}`;
}

const stations = [
  { image: 'public/devices/lite2-green.webp', title: 'Лайт 2', note: 'проверено', accent: true },
  { image: 'public/devices/lite.webp', title: 'Лайт', note: 'первая Лайт' },
  { image: 'public/devices/mini.webp', title: 'Мини 3', note: 'Мини' },
  { image: 'public/devices/mini-pro.webp', title: 'Мини 3 Про', note: 'Мини' },
  { image: 'public/devices/mini-clock.webp', title: 'Мини с часами', note: 'Мини' },
  { image: 'public/devices/mini-old.webp', title: 'Мини', note: 'первая Мини' },
  { image: 'public/devices/max.webp', title: 'Макс', note: 'Макс' },
  { image: 'public/devices/station2.webp', title: 'Станция 2', note: 'Станция' },
  { image: 'public/devices/station3.webp', title: 'Станция 3', note: 'Станция' },
  { image: 'public/devices/duo-max.webp', title: 'Дуо Макс', note: 'Станция' },
  { image: 'public/devices/midi.webp', title: 'Миди', note: 'Станция' },
  { image: 'public/devices/street.webp', title: 'Стрит', note: 'Станция' },
];

const cards = stations
  .map(
    (station) => `
      <article class="card${station.accent ? ' card--accent' : ''}">
        <div class="card-media"><img src="${dataUri(station.image)}" alt=""></div>
        <div class="card-title">${station.title}</div>
        <div class="card-note">${station.accent ? '<i></i>' : ''}${station.note}</div>
      </article>`,
  )
  .join('');

const cover = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { width: 1600px; height: 900px; margin: 0; overflow: hidden; }
  body {
    background: #07110c;
    color: #f1f8f3;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .cover { position: relative; width: 1600px; height: 900px; overflow: hidden; }
  .grid {
    position: absolute; inset: -20%;
    background-image:
      linear-gradient(rgba(255,255,255,.032) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.032) 1px, transparent 1px);
    background-size: 64px 64px;
    transform: perspective(900px) rotateX(58deg) translateY(220px) scale(1.4);
    mask-image: radial-gradient(circle at 68% 42%, rgba(0,0,0,.9), transparent 66%);
  }
  .glow { position: absolute; border-radius: 50%; }
  .glow--green {
    width: 1020px; height: 1020px; right: -260px; top: -260px;
    background: radial-gradient(circle at 50% 50%, rgba(82,222,143,.26), rgba(7,17,12,0) 66%);
  }
  .glow--violet {
    width: 760px; height: 760px; left: -320px; bottom: -360px;
    background: radial-gradient(circle at 50% 50%, rgba(139,110,255,.17), rgba(7,17,12,0) 68%);
  }
  .glow--peach {
    width: 560px; height: 560px; left: 340px; top: -380px;
    background: radial-gradient(circle at 50% 50%, rgba(255,163,94,.11), rgba(7,17,12,0) 68%);
  }

  .content { position: absolute; left: 80px; top: 92px; width: 610px; }
  .badge {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 8px 15px; border-radius: 999px;
    border: 1px solid rgba(123,227,169,.3);
    background: rgba(53,185,120,.1);
    color: #91e9b8; font-size: 12px; font-weight: 700; letter-spacing: .15em;
  }
  .badge i { width: 6px; height: 6px; border-radius: 50%; background: #63e39a; box-shadow: 0 0 12px #63e39a; }
  h1 {
    margin: 30px 0 0;
    font-size: 128px; line-height: .86; letter-spacing: -.065em; font-weight: 800;
  }
  h1 span {
    display: block; margin-top: 12px;
    font-size: 66px; line-height: .95; letter-spacing: -.055em;
    color: #71e6a7;
    text-shadow: 0 0 60px rgba(60,217,126,.22);
  }
  .sub {
    margin: 32px 0 0; width: 570px;
    font-size: 23px; line-height: 1.4; color: #b9cbbf; font-weight: 450;
  }
  .sub b { color: #e8f6ed; font-weight: 650; }
  .chips { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 28px; width: 580px; }
  .chips span {
    padding: 9px 14px; border-radius: 999px;
    background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.12);
    color: #dce9e0; font-size: 13px; font-weight: 650;
  }
  .chips span:first-child { background: #d9f8e6; border-color: #d9f8e6; color: #0e3a25; }

  .stats { display: flex; gap: 30px; margin-top: 40px; }
  .stat b {
    display: block; font-size: 40px; line-height: 1; letter-spacing: -.04em;
    font-weight: 760; color: #f1f8f3;
  }
  .stat b em { font-style: normal; color: #71e6a7; }
  .stat span {
    display: block; margin-top: 8px;
    font-size: 11px; letter-spacing: .13em; font-weight: 700; color: #7e998a;
    text-transform: uppercase;
  }

  .lineup {
    position: absolute; left: 742px; top: 62px; width: 800px;
  }
  .lineup-head {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 0 4px 16px;
  }
  .lineup-head b {
    font-size: 12px; letter-spacing: .17em; font-weight: 750; color: #8fb4a0;
    text-transform: uppercase;
  }
  .lineup-head span { font-size: 12px; color: #5f7d6d; font-weight: 650; letter-spacing: .05em; }
  .cards {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 13px;
  }
  .card {
    position: relative;
    height: 186px;
    border-radius: 26px;
    background: rgba(255,255,255,.042);
    border: 1px solid rgba(255,255,255,.085);
    display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
    padding: 10px 8px 16px;
    overflow: hidden;
  }
  .card::after {
    content: ""; position: absolute; inset: 0; border-radius: inherit;
    background: linear-gradient(180deg, rgba(255,255,255,.035), transparent 46%);
    pointer-events: none;
  }
  .card--accent {
    background: linear-gradient(180deg, rgba(53,185,120,.2), rgba(53,185,120,.055));
    border-color: rgba(105,231,158,.48);
    box-shadow: 0 22px 60px -30px rgba(53,185,120,.7), inset 0 1px 0 rgba(190,255,217,.2);
  }
  .card-media { flex: 1; width: 100%; display: grid; place-items: center; padding-top: 6px; }
  .card-media img {
    width: 122px; height: 122px; object-fit: contain;
    filter: drop-shadow(0 16px 20px rgba(0,0,0,.42));
  }
  .card--accent .card-media img { width: 132px; height: 132px; }
  .card-title {
    font-size: 13px; font-weight: 700; color: #eef8f1; letter-spacing: -.01em;
    white-space: nowrap;
  }
  .card-note {
    display: flex; align-items: center; gap: 5px;
    margin-top: 4px; font-size: 10px; font-weight: 650; color: #6e8a7a;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .card--accent .card-note { color: #86dda9; }
  .card-note i { width: 5px; height: 5px; border-radius: 50%; background: #63e39a; box-shadow: 0 0 8px #63e39a; }

  .version {
    position: absolute; right: 80px; top: 28px;
    color: #789184; font-size: 11px; letter-spacing: .14em; font-weight: 700;
  }
  .foot {
    position: absolute; left: 80px; right: 80px; bottom: 42px;
    display: flex; align-items: center; justify-content: space-between;
    color: #91a89a; font-size: 13px; font-weight: 600;
  }
  .foot-group { display: flex; align-items: center; gap: 22px; }
  .foot-item { display: flex; align-items: center; gap: 8px; }
  .foot svg { width: 17px; height: 17px; }
  .foot .accent { color: #71e6a7; }
</style>
</head>
<body>
<div class="cover">
  <div class="grid"></div>
  <div class="glow glow--green"></div>
  <div class="glow glow--violet"></div>
  <div class="glow glow--peach"></div>

  <div class="content">
    <div class="badge"><i></i>12 МОДЕЛЕЙ · OPEN SOURCE</div>
    <h1>Alice<span>Control Center</span></h1>
    <p class="sub">Одна панель для <b>всей линейки Яндекс Станций</b>.<br>Свет, звук, Bluetooth и обновления — локально.</p>
    <div class="chips">
      <span>Все станции</span><span>SSH</span><span>LED</span><span>Bluetooth</span><span>OpenAI</span>
    </div>
    <div class="stats">
      <div class="stat"><b>12</b><span>моделей</span></div>
      <div class="stat"><b><em>14</em></b><span>модулей</span></div>
      <div class="stat"><b>0</b><span>облака</span></div>
    </div>
  </div>

  <div class="lineup">
    <div class="lineup-head"><b>Вся линейка с Алисой</b><span>автоопределение модели</span></div>
    <div class="cards">${cards}</div>
  </div>

  <div class="version">v0.3.1 · MIT</div>

  <div class="foot">
    <div class="foot-group">
      <span class="foot-item"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.4-5.25 5.69.41.35.77 1.04.77 2.1 0 1.52-.01 2.75-.01 3.12 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z"/></svg>chrometechhype/alice-control-center</span>
      <span class="foot-item"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.94 4.3a1.5 1.5 0 0 0-1.53-.25L3.06 11.2c-1.4.54-1.38 1.33-.23 1.69l4.63 1.44 1.78 5.46c.2.57.37.79.73.79.35 0 .5-.16.7-.35l2.27-2.2 4.72 3.48c.87.48 1.5.23 1.72-.8l3.1-14.55a1.1 1.1 0 0 0-.54-1.86ZM9.05 14.55l10.1-6.36c.5-.3.96-.14.58.2l-8.67 7.82-.34 3.56-1.67-5.22Z"/></svg>@myloveiskeri</span>
    </div>
    <span class="accent">Windows · macOS · Linux</span>
  </div>
</div>
</body>
</html>`;

const htmlPath = path.join(root, 'shots', 'look', 'cover.html');
fs.writeFileSync(htmlPath, cover);

const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
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
await send('Emulation.setDeviceMetricsOverride', {
  width: 1600,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});
await send('Page.navigate', { url: pathToFileURL(htmlPath).href });
await sleep(1800);
await evaluate('document.fonts.ready.then(() => document.images.length)');
await sleep(600);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const buffer = Buffer.from(shot.data, 'base64');
const output = path.join(root, 'docs', 'cover.png');
fs.writeFileSync(output, buffer);
fs.copyFileSync(output, path.join(root, 'shots', 'look', 'cover.png'));
console.log(`Cover: ${path.relative(root, output)} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
ws.close();

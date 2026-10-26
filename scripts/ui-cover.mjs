import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dataUri(file) {
  return `data:image/${path.extname(file).slice(1).replace('jpg', 'jpeg')};base64,${fs.readFileSync(file).toString('base64')}`;
}

const cover = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { width: 1600px; height: 900px; margin: 0; overflow: hidden; }
  body {
    background: #08110d;
    color: #f1f8f3;
    font-family: "Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .cover { position: relative; width: 1600px; height: 900px; overflow: hidden; }
  .grid {
    position: absolute; inset: -20%;
    background-image:
      linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px);
    background-size: 64px 64px;
    transform: perspective(900px) rotateX(58deg) translateY(210px) scale(1.4);
    mask-image: radial-gradient(circle at 65% 45%, rgba(0,0,0,.9), transparent 68%);
  }
  .glow { position: absolute; border-radius: 50%; filter: blur(4px); }
  .glow--green {
    width: 940px; height: 940px; right: -120px; top: -70px;
    background: radial-gradient(circle at 50% 50%, rgba(82,222,143,.34), rgba(8,17,13,0) 66%);
  }
  .glow--violet {
    width: 780px; height: 780px; left: -300px; bottom: -330px;
    background: radial-gradient(circle at 50% 50%, rgba(139,110,255,.2), rgba(8,17,13,0) 68%);
  }
  .glow--peach {
    width: 520px; height: 520px; left: 300px; top: -340px;
    background: radial-gradient(circle at 50% 50%, rgba(255,163,94,.14), rgba(8,17,13,0) 68%);
  }
  .panel {
    position: absolute; right: -170px; bottom: -300px; width: 1320px;
    transform: rotate(-5.5deg);
    opacity: .36;
    filter: blur(.6px) saturate(.85);
    mask-image: linear-gradient(to top, transparent 2%, #000 34%, #000 72%, transparent 99%);
    border-radius: 30px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.16);
  }
  .panel img { display: block; width: 100%; }
  .content { position: absolute; left: 86px; top: 104px; width: 760px; }
  .badge {
    display: inline-flex; align-items: center; gap: 9px;
    padding: 8px 14px; border-radius: 999px;
    border: 1px solid rgba(123,227,169,.3);
    background: rgba(53,185,120,.1);
    color: #91e9b8; font-size: 12px; font-weight: 700; letter-spacing: .16em;
  }
  .badge i { width: 6px; height: 6px; border-radius: 50%; background: #63e39a; box-shadow: 0 0 12px #63e39a; }
  h1 {
    margin: 30px 0 0;
    font-size: 136px; line-height: .86; letter-spacing: -.065em; font-weight: 800;
  }
  h1 span {
    display: block; margin-top: 12px;
    font-size: 70px; line-height: .95; letter-spacing: -.055em;
    color: #71e6a7;
    text-shadow: 0 0 60px rgba(60,217,126,.24);
  }
  .sub {
    margin: 34px 0 0; width: 620px;
    font-size: 24px; line-height: 1.38; color: #b9cbbf; font-weight: 450;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 30px; width: 620px; }
  .chips span {
    padding: 9px 14px; border-radius: 999px;
    background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.12);
    color: #dce9e0; font-size: 13px; font-weight: 650;
  }
  .chips span:first-child { background: #d9f8e6; border-color: #d9f8e6; color: #0e3a25; }
  .stage { position: absolute; right: 48px; top: 86px; width: 690px; height: 690px; }
  .halo {
    position: absolute; left: 108px; top: 92px; width: 520px; height: 520px; border-radius: 50%;
    background: radial-gradient(circle at 50% 48%, rgba(129,246,178,.45), rgba(53,185,120,.16) 52%, rgba(8,17,13,0) 72%);
    filter: blur(10px);
  }
  .orb {
    position: absolute; border-radius: 50%; display: grid; place-items: center; overflow: hidden;
    background: #f8f7f2;
    box-shadow: 0 34px 80px -30px rgba(0,0,0,.85), inset 0 -16px 30px rgba(20,32,25,.08);
    border: 1px solid rgba(255,255,255,.7);
  }
  .orb img { width: 94%; height: 94%; object-fit: contain; }
  .orb--main { left: 108px; top: 92px; width: 520px; height: 520px; }
  .orb--violet { left: 22px; top: 366px; width: 210px; height: 210px; }
  .orb--violet img { width: 90%; height: 90%; }
  .orb--blue { right: 18px; top: 426px; width: 186px; height: 186px; }
  .orb--blue img { width: 90%; height: 90%; }
  .model {
    position: absolute; left: 178px; top: 650px; width: 380px; text-align: center;
    padding: 12px 20px 13px;
    border-radius: 20px;
    background: rgba(8,17,13,.72);
    border: 1px solid rgba(255,255,255,.11);
    backdrop-filter: blur(14px);
    color: #dcece2; font-size: 14px; font-weight: 650; letter-spacing: .02em;
  }
  .model small { display: block; margin-top: 4px; color: #82a894; font-size: 11px; letter-spacing: .13em; font-weight: 650; }
  .version {
    position: absolute; right: 86px; top: 54px;
    color: #8aa295; font-size: 12px; letter-spacing: .14em; font-weight: 700;
  }
  .foot {
    position: absolute; left: 86px; right: 86px; bottom: 48px;
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

  <div class="panel"><img src="${dataUri(path.join(root, 'shots', 'look', 'teaser-dashboard.png'))}" alt=""></div>

  <div class="content">
    <div class="badge"><i></i>OPEN SOURCE · SELF-HOSTED</div>
    <h1>Alice<span>Control Center</span></h1>
    <p class="sub">Панель управления рутованной Яндекс Станцией.<br>Свет, звук, Bluetooth и обновления — локально.</p>
    <div class="chips">
      <span>SSH</span><span>LED</span><span>Sound</span><span>Bluetooth</span><span>OpenAI-compatible</span>
    </div>
  </div>

  <div class="stage">
    <div class="halo"></div>
    <div class="orb orb--violet"><img src="${dataUri(path.join(root, 'public', 'devices', 'lite2-violet.webp'))}" alt=""></div>
    <div class="orb orb--blue"><img src="${dataUri(path.join(root, 'public', 'devices', 'lite2-blue-clock.webp'))}" alt=""></div>
    <div class="orb orb--main"><img src="${dataUri(path.join(root, 'public', 'devices', 'lite2-green.webp'))}" alt=""></div>
    <div class="model">Станция Лайт 2<small>ЗЕЛЁНАЯ · БЕЗ ЧАСОВ</small></div>
  </div>

  <div class="version">v0.2.0 · MIT</div>

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
await sleep(500);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const buffer = Buffer.from(shot.data, 'base64');
const output = path.join(root, 'docs', 'cover.png');
fs.writeFileSync(output, buffer);
fs.copyFileSync(output, path.join(root, 'shots', 'look', 'cover.png'));
console.log(`Cover: ${path.relative(root, output)} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
ws.close();

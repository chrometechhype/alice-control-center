import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8');
const svgData = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const html = `<!doctype html><html><head><style>
  html,body{margin:0;width:256px;height:256px;overflow:hidden;background:#101318}
  img{display:block;width:256px;height:256px}
</style></head><body><img src="${svgData}" alt=""></body></html>`;

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

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 256,
  height: 256,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
await new Promise((resolve) => setTimeout(resolve, 900));
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
ws.close();

const png = Buffer.from(shot.data, 'base64');
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header.writeUInt8(0, 6);
header.writeUInt8(0, 7);
header.writeUInt8(0, 8);
header.writeUInt8(0, 9);
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
const output = path.join(root, 'public', 'acc.ico');
fs.writeFileSync(output, Buffer.concat([header, png]));
console.log(`Icon: ${path.relative(root, output)} (${(png.length / 1024).toFixed(1)} KB PNG payload)`);

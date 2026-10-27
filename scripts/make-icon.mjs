import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseSvg = fs.readFileSync(path.join(root, 'public', 'favicon.svg'), 'utf8');

const variants = [
  { file: 'acc.ico', from: '#ff8a3d', to: '#ea5504' },
  { file: 'acc-on.ico', from: '#71e6a7', to: '#35b978' },
  { file: 'acc-off.ico', from: '#a7b3ad', to: '#5c6a63' },
  { file: 'acc-busy.ico', from: '#ffd166', to: '#e09a00' },
];

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

const sizes = [16, 32, 48, 256];

function buildIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    const dimension = image.size >= 256 ? 0 : image.size;
    header.writeUInt8(dimension, entry);
    header.writeUInt8(dimension, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

for (const variant of variants) {
  const svg = baseSvg.replaceAll('#ff8a3d', variant.from).replaceAll('#ea5504', variant.to);
  const svgData = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const images = [];

  for (const size of sizes) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: size,
      height: size,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const html = `<!doctype html><html><head><style>
      html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:#101318}
      img{display:block;width:${size}px;height:${size}px}
    </style></head><body><img src="${svgData}" alt=""></body></html>`;

    await send('Page.navigate', { url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}` });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    images.push({ size, png: Buffer.from(shot.data, 'base64') });
  }

  const output = path.join(root, 'public', variant.file);
  fs.writeFileSync(output, buildIco(images));
  console.log(`Icon: ${path.relative(root, output)} (${sizes.join(', ')})`);
}

ws.close();

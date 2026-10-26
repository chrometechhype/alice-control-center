import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
const posterFile = path.join(root, 'shots', 'look', 'teaser-poster.html');
await send('Page.navigate', { url: pathToFileURL(posterFile).href });
await sleep(1800);
await evaluate('document.fonts.ready.then(() => document.querySelectorAll("img").length)');
await sleep(500);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const buffer = Buffer.from(shot.data, 'base64');
const output = path.join(root, 'docs', 'teaser.png');
fs.writeFileSync(output, buffer);
fs.copyFileSync(output, path.join(root, 'shots', 'look', 'teaser-acc.png'));
console.log(`Teaser: ${path.relative(root, output)} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
ws.close();

import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const ROUTES = [
  ['dashboard', '/'],
  ['system', '/system'],
  ['sounds', '/sounds'],
  ['led', '/led'],
  ['bluetooth', '/bluetooth'],
  ['files', '/files'],
  ['terminal', '/terminal'],
  ['backups', '/backups'],
  ['automation', '/automation'],
  ['events', '/events'],
  ['plugins', '/plugins'],
  ['fun', '/fun'],
  ['settings', '/settings'],
  ['setup', '/setup'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const pages = await (await fetch(`${BROWSER}/json/list`)).json();
  const page = pages.find((item) => item.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
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
  return { ws, send, events };
}

async function main() {
  const { ws, send, events } = await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const results = [];
  for (const [name, path] of ROUTES) {
    events.length = 0;
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.navigate', { url: `${BASE}${path}?ui=${Date.now()}` });
    await sleep(name === 'sounds' ? 4200 : 2600);
    const probe = await send('Runtime.evaluate', {
      expression: `(() => ({
        url: location.href,
        title: document.title,
        h1: document.querySelector('h1')?.textContent?.trim() ?? null,
        header: document.querySelector('.topbar__title')?.textContent?.trim() ?? null,
        text: document.body.innerText.slice(0, 400),
        errors: [...document.querySelectorAll('.error-box, .alert--error, .empty--error')].map(e => e.textContent.trim()).slice(0, 3)
      }))()`,
      returnByValue: true,
    });
    const consoleIssues = events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params.exceptionDetails?.exception?.description ?? 'exception');
    const logIssues = events
      .filter((e) => e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level))
      .map((e) => `${e.params.entry.level}: ${e.params.entry.text}`);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`shots/ui/${name}.png`, Buffer.from(shot.data, 'base64'));
    results.push({
      name,
      path,
      ...probe.result.value,
      consoleIssues: consoleIssues.slice(0, 5),
      logIssues: logIssues.slice(0, 5),
    });
    console.log(`--- ${name} ${JSON.stringify(probe.result.value)}`);
    if (consoleIssues.length) console.log('  console:', consoleIssues.slice(0, 3));
    if (logIssues.length) console.log('  log:', logIssues.slice(0, 3));
  }

  // mobile pass
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  for (const [name, path] of [['dashboard', '/'], ['sounds', '/sounds'], ['settings', '/settings'], ['terminal', '/terminal']]) {
    await send('Page.navigate', { url: `${BASE}${path}?m=${Date.now()}` });
    await sleep(2600);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`shots/ui/m-${name}.png`, Buffer.from(shot.data, 'base64'));
  }

  fs.writeFileSync('shots/ui/summary.json', JSON.stringify(results, null, 2));
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const API = 'http://127.0.0.1:8722';
const OUT = 'shots/theme';
const ROUTES = [
  ['dashboard', '/'],
  ['system', '/system'],
  ['settings', '/settings'],
  ['setup', '/setup'],
  ['sounds', '/sounds'],
  ['terminal', '/terminal'],
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
    } else if (msg.method) events.push(msg);
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

async function setTheme(theme) {
  const res = await fetch(`${API}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme }),
  });
  if (!res.ok) throw new Error(`PATCH theme ${res.status}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const initial = await (await fetch(`${API}/api/settings`)).json();
  const original = initial?.data?.theme ?? 'system';
  const { ws, send, events } = await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const report = { original, shots: [], issues: [] };
  try {
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await send('Emulation.clearDeviceMetricsOverride');
      await send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const [name, path] of ROUTES) {
        events.length = 0;
        await send('Page.navigate', { url: `${BASE}${path}?t=${theme}-${Date.now()}` });
        await sleep(2800);
        const probe = await send('Runtime.evaluate', {
          expression: `(() => {
            const css = getComputedStyle(document.documentElement);
            const shell = document.querySelector('.app-shell');
            return {
              url: location.href,
              theme: document.documentElement.dataset.theme,
              bg: css.getPropertyValue('--bg').trim(),
              surface: css.getPropertyValue('--surface').trim(),
              text: css.getPropertyValue('--text').trim(),
              h1: document.querySelector('h1')?.textContent?.trim() ?? null,
              hero: document.querySelector('.hero h2')?.textContent?.trim() ?? null,
              portrait: !!document.querySelector('.device-portrait, .dp-frame, svg[class*=dp-]'),
              shellWidth: shell?.getBoundingClientRect().width ?? null,
              bodyScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth
            };
          })()`,
          returnByValue: true,
        });
        const exceptions = events
          .filter((e) => e.method === 'Runtime.exceptionThrown')
          .map((e) => e.params.exceptionDetails?.exception?.description ?? 'exception');
        const logs = events
          .filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
          .map((e) => e.params.entry.text);
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(`${OUT}/${theme}-${name}.png`, Buffer.from(shot.data, 'base64'));
        report.shots.push({ theme, name, ...probe.result.value });
        if (exceptions.length || logs.length) {
          report.issues.push({ theme, name, exceptions, logs });
        }
        console.log(theme, name, JSON.stringify(probe.result.value));
      }
    }

    await setTheme('system');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const scheme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: scheme }],
      });
      await send('Page.navigate', { url: `${BASE}/?sys=${scheme}-${Date.now()}` });
      await sleep(2800);
      const probe = await send('Runtime.evaluate', {
        expression: `document.documentElement.dataset.theme`,
        returnByValue: true,
      });
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(`${OUT}/system-${scheme}.png`, Buffer.from(shot.data, 'base64'));
      report.shots.push({ theme: 'system', name: `system-${scheme}`, resolved: probe.result.value });
      console.log('system', scheme, '->', probe.result.value);
    }
    await send('Emulation.setEmulatedMedia', { features: [] });

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        mobile: true,
      });
      for (const [name, path] of [['dashboard', '/'], ['settings', '/settings'], ['sounds', '/sounds']]) {
        await send('Page.navigate', { url: `${BASE}${path}?m=${theme}-${Date.now()}` });
        await sleep(2800);
        const overflow = await send('Runtime.evaluate', {
          expression: `document.documentElement.scrollWidth > document.documentElement.clientWidth`,
          returnByValue: true,
        });
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(`${OUT}/m-${theme}-${name}.png`, Buffer.from(shot.data, 'base64'));
        report.shots.push({ theme, name: `m-${name}`, overflow: overflow.result.value });
        if (overflow.result.value) report.issues.push({ theme, name: `m-${name}`, overflow: true });
      }
      await send('Emulation.clearDeviceMetricsOverride');
    }
  } finally {
    await setTheme(original);
    fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    ws.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import fs from 'node:fs';
import WebSocket from 'ws';

const BROWSER = 'http://127.0.0.1:9222';
const BASE = 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
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
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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
      }, 40000);
    });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return result.result.value;
  };
  const shot = async (name) => {
    const image = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(`shots/ui/${name}.png`, Buffer.from(image.data, 'base64'));
  };
  return { send, evaluate, shot };
}

const HELPERS = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byText = (sel, text) => [...document.querySelectorAll(sel)].find(el => el.textContent.includes(text));
const setValue = (el, value) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const toasts = () => [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
`;

async function main() {
  const { send, evaluate, shot } = await connect();
  await send('Page.enable');
  await send('Runtime.enable');
  const report = {};

  // Terminal
  await send('Page.navigate', { url: `${BASE}/terminal?test=1` });
  await sleep(2500);
  report.terminal = await evaluate(`(async () => { ${HELPERS}
    const row = byText('.list-row', 'Версия ядра');
    row?.click();
    await sleep(2600);
    return {
      clicked: Boolean(row),
      output: document.querySelector('.console-block pre')?.textContent?.trim() ?? null,
      head: document.querySelector('.console-block .console-head')?.textContent?.trim() ?? null,
      toasts: toasts()
    };
  })()`);
  await shot('terminal-run');

  // LED apply then restore
  await send('Page.navigate', { url: `${BASE}/led?test=1` });
  await sleep(2500);
  report.ledApply = await evaluate(`(async () => { ${HELPERS}
    const apply = byText('button', 'Применить цвета');
    apply?.click();
    await sleep(2400);
    return { clicked: Boolean(apply), toasts: toasts(), status: document.body.innerText.includes('Анимация') };
  })()`);
  await shot('led-applied');
  report.ledRestore = await evaluate(`(async () => { ${HELPERS}
    const restore = byText('button', 'Штатный режим');
    restore?.click();
    await sleep(2200);
    return { clicked: Boolean(restore), toasts: toasts() };
  })()`);

  // Backups create + delete
  await send('Page.navigate', { url: `${BASE}/backups?test=1` });
  await sleep(2500);
  report.backupCreate = await evaluate(`(async () => { ${HELPERS}
    byText('button', 'Бэкап конфигурации')?.click();
    await sleep(400);
    const box = document.querySelector('.modal input[type="checkbox"]');
    box?.click();
    await sleep(150);
    const create = byText('.modal button', 'Создать бэкап');
    create?.click();
    await sleep(5000);
    return {
      modalClosed: !document.querySelector('.modal'),
      toasts: toasts(),
      hasRow: document.body.innerText.includes('Конфигурация'),
      text: document.body.innerText.slice(-600)
    };
  })()`);
  await shot('backups-created');
  report.backupDelete = await evaluate(`(async () => { ${HELPERS}
    const del = document.querySelector('button[title="Удалить"]');
    del?.click();
    await sleep(400);
    const confirm = document.querySelector('.modal .btn--danger');
    confirm?.click();
    await sleep(2800);
    return { clicked: Boolean(del), confirmed: Boolean(confirm), toasts: toasts(), empty: document.body.innerText.includes('Бэкапов не найдено') };
  })()`);

  // Automation create + run + delete
  await send('Page.navigate', { url: `${BASE}/automation?test=1` });
  await sleep(2500);
  report.automationCreate = await evaluate(`(async () => { ${HELPERS}
    (byText('button', 'Новый сценарий') ?? byText('button', 'Создать сценарий'))?.click();
    await sleep(400);
    setValue(document.querySelector('#scenario-name'), 'Тест ACC');
    setValue(document.querySelector('#scenario-message'), 'Проверка Automation Studio');
    const create = byText('.modal button', 'Создать');
    create?.click();
    await sleep(2500);
    return { modalClosed: !document.querySelector('.modal'), toasts: toasts(), created: document.body.innerText.includes('Тест ACC') };
  })()`);
  await shot('automation-created');
  report.automationRun = await evaluate(`(async () => { ${HELPERS}
    const run = byText('button', 'Запустить');
    run?.click();
    await sleep(2500);
    return { clicked: Boolean(run), toasts: toasts(), text: document.body.innerText.slice(0, 700) };
  })()`);
  await shot('automation-run');
  report.automationDelete = await evaluate(`(async () => { ${HELPERS}
    const del = document.querySelector('button[title="Удалить"]');
    del?.click();
    await sleep(400);
    document.querySelector('.modal .btn--danger')?.click();
    await sleep(2500);
    return { empty: document.body.innerText.includes('Сценариев пока нет'), toasts: toasts() };
  })()`);

  // Settings token + QR
  await send('Page.navigate', { url: `${BASE}/settings?test=1` });
  await sleep(2500);
  report.settingsToken = await evaluate(`(async () => { ${HELPERS}
    document.querySelector('button[title="Показать токен"]')?.click();
    await sleep(1200);
    const text = document.body.innerText;
    return { hasToken: /[A-Za-z0-9]{24,}/.test(text), snippet: text.match(/[A-Za-z0-9]{24,}/)?.[0]?.slice(0, 6) ?? null };
  })()`);
  report.settingsQr = await evaluate(`(async () => { ${HELPERS}
    byText('button', 'Показать QR-код')?.click();
    await sleep(2000);
    const img = document.querySelector('img[alt="QR-код для доступа с телефона"]');
    return { hasImage: Boolean(img), srcLength: img?.src?.length ?? 0 };
  })()`);
  await shot('settings-qr');

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

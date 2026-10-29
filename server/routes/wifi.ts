import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { shQuote } from '../util.ts';
import {
  parseScanResults,
  parseWifiRead,
  removeWpaNetwork,
  upsertWpaNetwork,
  validateWifiInput,
  wifiReadCommand,
  type WifiConnectInput,
} from '../wifi.ts';

export const wifiRouter = Router();

function safeInterface(value: string): string {
  return /^[a-z0-9_.-]{1,16}$/i.test(value) ? value : 'wlan0';
}

async function readState() {
  const result = await connectionManager.stationRead((adapter) =>
    adapter.exec(wifiReadCommand(), { timeoutMs: 15_000, maxBytes: 160_000 }),
  );
  return parseWifiRead(result.stdout);
}

/** Writes the whole file through a here-document, keeping a one-time backup next to it. */
async function writeConfig(path: string, content: string): Promise<void> {
  const delimiter = `ACC_WPA_${Date.now().toString(36).toUpperCase()}`;
  const quoted = shQuote(path);
  const command = [
    `[ -f ${shQuote(`${path}.acc-bak`)} ] || cp ${quoted} ${shQuote(`${path}.acc-bak`)} 2>/dev/null || true`,
    `cat > ${quoted} <<'${delimiter}'`,
    content.replace(/\s+$/, ''),
    delimiter,
    `chmod 600 ${quoted} 2>/dev/null || true`,
    'echo acc-wifi-written',
  ].join('\n');
  const adapter = await connectionManager.awaitReady(9_000);
  const result = await adapter.exec(command, { timeoutMs: 12_000, maxBytes: 20_000 });
  if (result.code !== 0 || !result.stdout.includes('acc-wifi-written')) {
    throw new AccError(
      'WIFI_CONFIG_WRITE_FAILED',
      `Не удалось записать ${path}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
      502,
    );
  }
}

/** Reconfigure + reassociate + wait for COMPLETED, all inside one SSH command. */
async function reconfigureAndWait(iface: string): Promise<{ state: string; ip: string | null }> {
  const name = shQuote(safeInterface(iface));
  const script = [
    `wpa_cli -i ${name} reconfigure >/dev/null 2>&1 || true`,
    `wpa_cli -i ${name} reassociate >/dev/null 2>&1 || true`,
    'i=0',
    'while [ $i -lt 20 ]; do',
    `  st=$(wpa_cli -i ${name} status 2>/dev/null)`,
    '  case "$st" in *"wpa_state=COMPLETED"*) echo "$st"; exit 0;; esac',
    '  sleep 1',
    '  i=$((i+1))',
    'done',
    `wpa_cli -i ${name} status 2>&1`,
  ].join('\n');
  const adapter = await connectionManager.awaitReady(9_000);
  const result = await adapter.exec(script, { timeoutMs: 30_000, maxBytes: 40_000 });
  const text = result.stdout;
  const state = /wpa_state=(\S+)/.exec(text)?.[1] ?? 'UNKNOWN';
  const ip = /ip_address=(\S+)/.exec(text)?.[1] ?? null;
  return { state, ip };
}

wifiRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    const { status } = await readState();
    sendOk(res, status);
  }),
);

wifiRouter.post(
  '/scan',
  asyncRoute(async (_req, res) => {
    const { status } = await readState();
    if (!status.available) {
      throw new AccError(
        'WIFI_UNAVAILABLE',
        'На прошивке нет wpa_cli — сканирование эфира недоступно. Панель не выдумывает список сетей.',
        409,
      );
    }
    const name = shQuote(safeInterface(status.interface));
    const script = [
      `wpa_cli -i ${name} scan >/dev/null 2>&1 || true`,
      'sleep 4',
      `wpa_cli -i ${name} scan_results 2>&1`,
    ].join('\n');
    const adapter = await connectionManager.awaitReady(9_000);
    const result = await adapter.exec(script, { timeoutMs: 20_000, maxBytes: 200_000 });
    const networks = parseScanResults(result.stdout);
    eventLog.append({
      level: 'info',
      module: 'wifi',
      operation: 'scan',
      result: 'ok',
      message: `Wi-Fi: скан эфира нашёл ${networks.length} сетей`,
      details: { interface: status.interface },
    });
    sendOk(res, { networks, interface: status.interface });
  }),
);

const connectInput = z.object({
  ssid: z.string().min(1, 'Укажите имя сети').max(64, 'Имя сети слишком длинное'),
  password: z.string().max(128).optional(),
  security: z.enum(['open', 'wep', 'wpa', 'wpa2', 'wpa3', 'enterprise']).optional(),
  hidden: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

wifiRouter.post(
  '/connect',
  asyncRoute(async (req, res) => {
    const parsed = connectInput.safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_WIFI_INPUT', parsed.error.issues[0]?.message ?? 'Проверьте имя сети и пароль', 400);
    }
    const input: WifiConnectInput = parsed.data;
    validateWifiInput(input);
    if (input.security === 'enterprise') {
      throw new AccError(
        'WIFI_EAP_UNSUPPORTED',
        'Сети 802.1X требуют логин и сертификат — панель их пока не настраивает.',
        400,
      );
    }
    const { status, configText } = await readState();
    if (!status.configPath) {
      throw new AccError(
        'WIFI_CONFIG_MISSING',
        'На станции нет wpa_supplicant.conf — некуда записать сеть. Панель не трогает настройки наугад.',
        409,
      );
    }
    const next = upsertWpaNetwork(configText, input);
    await writeConfig(status.configPath, next);
    const after = await reconfigureAndWait(status.interface);
    const connected = after.state === 'COMPLETED';
    eventLog.append({
      level: connected ? 'success' : 'warn',
      module: 'wifi',
      operation: 'connect',
      result: connected ? 'ok' : 'error',
      message: connected
        ? `Wi-Fi: станция подключена к «${input.ssid}» без перезагрузки`
        : `Wi-Fi: сеть «${input.ssid}» записана, но wpa_supplicant ответил ${after.state}`,
      details: { ssid: input.ssid, interface: status.interface, config: status.configPath },
    });
    if (!connected) {
      throw new AccError(
        'WIFI_NOT_CONNECTED',
        `Сеть «${input.ssid}» записана в ${status.configPath}, wpa_cli reconfigure выполнен, но станция ответила ${after.state}. Проверьте пароль и дальность — файл уже обновлён.`,
        502,
      );
    }
    const state = await readState();
    sendOk(res, {
      connected: true,
      status: state.status,
      ip: after.ip,
      message: `Станция переключилась на «${input.ssid}» без перезагрузки`,
    });
  }),
);

wifiRouter.post(
  '/forget',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ ssid: z.string().min(1), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Удаление сети требует подтверждения', 400);
    }
    const ssid = parsed.data.ssid;
    const { status, configText } = await readState();
    if (!status.configPath) {
      throw new AccError('WIFI_CONFIG_MISSING', 'Файл wpa_supplicant.conf не найден', 409);
    }
    const next = removeWpaNetwork(configText, ssid);
    if (next === configText) {
      throw new AccError('WIFI_NETWORK_NOT_FOUND', `Сети «${ssid}» нет в конфиге`, 404);
    }
    await writeConfig(status.configPath, next);
    const after = await reconfigureAndWait(status.interface);
    eventLog.append({
      level: 'warn',
      module: 'wifi',
      operation: 'forget',
      result: 'ok',
      message: `Wi-Fi: сеть «${ssid}» удалена из конфига`,
      details: { ssid, state: after.state },
    });
    sendOk(res, { removed: ssid, state: after.state });
  }),
);

wifiRouter.post(
  '/disconnect',
  asyncRoute(async (_req, res) => {
    const { status } = await readState();
    const name = shQuote(safeInterface(status.interface));
    const adapter = await connectionManager.awaitReady(9_000);
    await adapter.exec(`wpa_cli -i ${name} disconnect 2>&1 || true`, { timeoutMs: 10_000, maxBytes: 20_000 });
    eventLog.append({
      level: 'warn',
      module: 'wifi',
      operation: 'disconnect',
      result: 'ok',
      message: 'Wi-Fi: wpa_cli disconnect — станция отключена от сети',
      details: { ssid: status.connected?.ssid ?? null },
    });
    sendOk(res, { disconnected: true });
  }),
);

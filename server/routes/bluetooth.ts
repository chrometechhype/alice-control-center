import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import {
  BT_CONNECTED_MARK,
  BT_DEVICES_MARK,
  BT_PAIRED_MARK,
  bluetoothPairedFilterWorks,
  explainBtFailure,
  parseBluetoothctlShow,
  parseBtBatch,
  type BtBatch,
} from '../parse.ts';

export const bluetoothRouter = Router();

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

interface BtDevice {
  address: string;
  name: string;
  connected: boolean;
  paired: boolean;
}

let scanUntil = 0;

function parseDeviceLines(text: string): BtDevice[] {
  const devices: BtDevice[] = [];
  for (const line of text.split('\n')) {
    const match = /^Device\s+([0-9A-F:]{17})\s+(.*)$/i.exec(line.trim());
    if (!match) continue;
    const address = match[1].toUpperCase();
    devices.push({
      address,
      name: match[2].trim() || address,
      connected: false,
      paired: true,
    });
  }
  return devices;
}

async function runBluetoothctl(args: string, timeoutMs = 20_000) {
  // Waiting for the reconnect ladder beats answering «не подключено» while the socket is already
  // being rebuilt — Bluetooth actions are deliberate and a second stall used to look like a failure.
  // A dropped socket never carried the command, so reading or issuing it again is safe.
  return connectionManager.stationRead((adapter) =>
    adapter.exec(`bluetoothctl ${args}`, { timeoutMs, maxBytes: 200_000 }),
  );
}

function isConnectedOutput(stdout: string): boolean {
  return /Connection successful|Connected: yes/i.test(stdout);
}

/** Bonded addresses only — `devices` also lists what the last scan left in the adapter cache. */
async function bondedAddresses(): Promise<Set<string>> {
  const result = await runBluetoothctl('devices Paired', 12_000).catch(() => null);
  if (!result || result.code !== 0) return new Set();
  return new Set(parseDeviceLines(result.stdout).map((device) => device.address));
}

interface BtBatchResult {
  parts: BtBatch;
  code: number | null;
  stderr: string;
  devices: Array<{ address: string; name: string; connected: boolean; paired: boolean }>;
}

/**
 * `show`, `devices`, `devices Paired` and `devices Connected` in one exec: every bluetoothctl call
 * is a fresh SSH channel, and the station is the weak link in this connection.
 *
 * A listed device is not necessarily bonded — `devices` also shows what a recent scan left in the
 * adapter cache — so `devices Paired` decides the badge. The panel used to claim «paired» for
 * everything, which is how a pairing the column had lost looked like a working one.
 */
async function readBtBatch(): Promise<BtBatchResult> {
  const batch = await runBluetoothctl(
    `show; echo ${BT_DEVICES_MARK}; devices;`
      + ` echo ${BT_PAIRED_MARK}; devices Paired;`
      + ` echo ${BT_CONNECTED_MARK}; devices Connected`,
    24_000,
  );
  const parts = parseBtBatch(batch.stdout);
  const bonded = new Set(parseDeviceLines(parts.paired).map((device) => device.address));
  const connected = new Set(parseDeviceLines(parts.connected).map((device) => device.address));
  const filterWorks = bluetoothPairedFilterWorks(parts);
  return {
    parts,
    code: batch.code,
    stderr: batch.stderr,
    devices: parseDeviceLines(parts.known).map((device) => ({
      ...device,
      connected: connected.has(device.address),
      paired: filterWorks ? bonded.has(device.address) : true,
    })),
  };
}

bluetoothRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    let capabilities = connectionManager.getCapabilities();
    if (!capabilities?.bluetooth.available) {
      // Capabilities are only known after a probe, so an offline column reads as «no adapter»
      // unless the connection is waited for first.
      await connectionManager.awaitReady(9_000);
      capabilities = connectionManager.getCapabilities();
      if (!capabilities?.bluetooth.available) {
        throw new AccError(
          'BLUETOOTH_UNAVAILABLE',
          capabilities?.bluetooth.reason || 'Bluetooth-адаптер не обнаружен на этой прошивке',
          409,
        );
      }
    }
    const batch = await readBtBatch();
    if (batch.code !== 0 && !batch.parts.show) {
      throw new AccError(
        'BLUETOOTHCTL_FAILED',
        explainBtFailure(`${batch.stderr} ${batch.parts.show}`, 'адаптер'),
        502,
      );
    }
    const controller = parseBluetoothctlShow(batch.parts.show);
    sendOk(res, {
      controller: {
        adapter: capabilities.bluetooth.details?.adapter ?? null,
        powered: controller.powered,
        name: controller.name,
        alias: controller.alias,
        address: controller.address ?? capabilities.bluetooth.details?.address ?? null,
        discoverable: controller.discoverable,
        pairable: controller.pairable,
      },
      devices: batch.devices,
      scanning: Date.now() < scanUntil,
      raw: batch.parts.show,
    });
  }),
);

/**
 * A scan is started detached on the station and its log is redirected: a `bluetoothctl scan on`
 * that holds the SSH channel for ten seconds was measured taking the transport down with it — the
 * journal shows the drop landing exactly when the second scan ended. The panel instead asks the
 * column to scan on its own and reads the device list back while the radio works.
 */
const SCAN_LOG = '/tmp/acc-scan.log';

async function execOnStation(command: string, timeoutMs = 20_000) {
  const adapter = await connectionManager.awaitReady(9_000);
  return adapter.exec(command, { timeoutMs, maxBytes: 200_000 });
}

bluetoothRouter.post(
  '/scan',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ seconds: z.number().int().min(5).max(20).default(10) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Некорректная длительность сканирования', 400);
    if (Date.now() < scanUntil) {
      throw new AccError('SCAN_IN_PROGRESS', 'Сканирование уже выполняется', 409);
    }
    const seconds = parsed.data.seconds;
    // The subshell exits at once, so the exec returns in a second instead of holding the channel.
    const started = await execOnStation(
      `( bluetoothctl --timeout ${seconds} scan on > ${SCAN_LOG} 2>&1 </dev/null & )`,
      15_000,
    );
    if (started.code !== 0) {
      throw new AccError(
        'BT_SCAN_FAILED',
        explainBtFailure(`${started.stderr} ${started.stdout}`, 'сканирование'),
        502,
      );
    }
    scanUntil = Date.now() + seconds * 1_000 + 1_500;
    const devices = (await readBtBatch()).devices;
    eventLog.append({
      level: 'info',
      module: 'bluetooth',
      operation: 'scan',
      result: 'ok',
      message: `Сканирование Bluetooth запущено на ${seconds} с, в списке пока ${devices.length}`,
      details: { seconds, until: scanUntil },
    });
    sendOk(res, { started: true, seconds, until: scanUntil, devices });
  }),
);

bluetoothRouter.post(
  '/connect',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ address: z.string().regex(MAC) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_ADDRESS', 'Некорректный MAC-адрес', 400);
    const address = parsed.data.address.toUpperCase();
    // A bonded device does not need pairing again, and re-pairing costs 30 seconds of a refused
    // exchange that looks like a hang.
    if (!(await bondedAddresses()).has(address)) {
      const pair = await runBluetoothctl(`pair ${address}`, 30_000).catch(() => null);
      if (pair && pair.code === 0) {
        eventLog.append({
          level: 'info',
          module: 'bluetooth',
          operation: 'pair',
          result: 'ok',
          message: `Bluetooth: устройство ${address} сопряжено`,
        });
      }
    }
    let result = await runBluetoothctl(`connect ${address}`, 30_000);
    if (!isConnectedOutput(result.stdout) && /not available/i.test(`${result.stderr}${result.stdout}`)) {
      // BlueZ drops the device object when a paired gadget stops being seen, and then refuses to
      // connect to «an address it doesn't know». One detached scan re-resolves it, so retry once.
      await execOnStation(
        `( bluetoothctl --timeout 5 scan on > ${SCAN_LOG} 2>&1 </dev/null & )`,
        12_000,
      ).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      result = await runBluetoothctl(`connect ${address}`, 30_000);
    }
    if (!isConnectedOutput(result.stdout)) {
      const raw = `${result.stderr.trim()} ${result.stdout.trim()}`.trim();
      eventLog.append({
        level: 'warn',
        module: 'bluetooth',
        operation: 'connect',
        result: 'error',
        message: `Bluetooth: подключение к ${address} не удалось`,
        details: { error: raw || 'bluetoothctl не подключил устройство' },
      });
      throw new AccError('BT_CONNECT_FAILED', explainBtFailure(raw, address), 502);
    }
    await runBluetoothctl(`trust ${address}`, 10_000).catch(() => undefined);
    eventLog.append({
      level: 'success',
      module: 'bluetooth',
      operation: 'connect',
      result: 'ok',
      message: `Bluetooth: подключено устройство ${address}`,
    });
    sendOk(res, { address, connected: true, output: result.stdout });
  }),
);

bluetoothRouter.post(
  '/disconnect',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ address: z.string().regex(MAC) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_ADDRESS', 'Некорректный MAC-адрес', 400);
    const address = parsed.data.address.toUpperCase();
    const result = await runBluetoothctl(`disconnect ${address}`, 20_000);
    if (result.code !== 0 && !/not available|Failed/i.test(result.stdout)) {
      throw new AccError(
        'BT_DISCONNECT_FAILED',
        explainBtFailure(`${result.stderr} ${result.stdout}`, address),
        502,
      );
    }
    eventLog.append({
      level: 'info',
      module: 'bluetooth',
      operation: 'disconnect',
      result: 'ok',
      message: `Bluetooth: отключено устройство ${address}`,
    });
    sendOk(res, { address, connected: false });
  }),
);

bluetoothRouter.post(
  '/forget',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ address: z.string().regex(MAC), confirm: z.literal(true) })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Удаление устройства требует подтверждения', 400);
    }
    const address = parsed.data.address.toUpperCase();
    await runBluetoothctl(`disconnect ${address}`, 20_000).catch(() => undefined);
    const result = await runBluetoothctl(`remove ${address}`, 15_000);
    if (result.code !== 0) {
      throw new AccError(
        'BT_REMOVE_FAILED',
        explainBtFailure(`${result.stderr} ${result.stdout}`, address),
        502,
      );
    }
    eventLog.append({
      level: 'warn',
      module: 'bluetooth',
      operation: 'forget',
      result: 'ok',
      message: `Bluetooth: устройство ${address} удалено из списка`,
    });
    sendOk(res, { removed: address });
  }),
);

bluetoothRouter.post(
  '/power',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ on: z.boolean(), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Переключение питания Bluetooth требует подтверждения', 400);
    }
    const result = await runBluetoothctl(`power ${parsed.data.on ? 'on' : 'off'}`, 12_000);
    if (result.code !== 0 || /Failed/i.test(result.stdout)) {
      throw new AccError(
        'BT_POWER_FAILED',
        result.stderr.trim() || 'Не удалось переключить питание адаптера',
        502,
      );
    }
    eventLog.append({
      level: 'warn',
      module: 'bluetooth',
      operation: 'power',
      result: 'ok',
      message: `Bluetooth-адаптер ${parsed.data.on ? 'включён' : 'выключен'} вручную`,
    });
    sendOk(res, { powered: parsed.data.on });
  }),
);
bluetoothRouter.post(
  '/discoverable',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ on: z.boolean(), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Режим поиска требует подтверждения', 400);
    }
    const on = parsed.data.on;
    const discoverable = await runBluetoothctl(`discoverable ${on ? 'on' : 'off'}`, 12_000);
    const pairable = await runBluetoothctl(`pairable ${on ? 'on' : 'off'}`, 12_000);
    if (
      discoverable.code !== 0 ||
      pairable.code !== 0 ||
      /Failed/i.test(`${discoverable.stdout}${pairable.stdout}`)
    ) {
      throw new AccError(
        'BT_DISCOVERABLE_FAILED',
        discoverable.stderr.trim() || pairable.stderr.trim() || 'Не удалось изменить режим поиска',
        502,
      );
    }
    eventLog.append({
      level: 'warn',
      module: 'bluetooth',
      operation: 'discoverable',
      result: 'ok',
      message: `Bluetooth: режим поиска ${on ? 'включён' : 'выключен'}`,
    });
    sendOk(res, { discoverable: on, pairable: on });
  }),
);

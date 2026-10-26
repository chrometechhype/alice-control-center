import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { parseBluetoothctlShow } from '../parse.ts';

export const bluetoothRouter = Router();

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

interface BtDevice {
  address: string;
  name: string;
  connected: boolean;
  paired: boolean;
}

let scanInFlight = false;

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
  const adapter = connectionManager.requireAdapter();
  return adapter.exec(`bluetoothctl ${args}`, { timeoutMs, maxBytes: 200_000 });
}

bluetoothRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    const capabilities = connectionManager.getCapabilities();
    if (!capabilities?.bluetooth.available) {
      throw new AccError('BLUETOOTH_UNAVAILABLE', 'Bluetooth-адаптер не обнаружен', 409);
    }
    const [showResult, devicesResult, connectedResult] = await Promise.all([
      runBluetoothctl('show', 10_000),
      runBluetoothctl('devices', 10_000),
      runBluetoothctl('devices Connected', 10_000),
    ]);
    if (showResult.code !== 0) {
      throw new AccError(
        'BLUETOOTHCTL_FAILED',
        showResult.stderr.trim() || 'bluetoothctl недоступен',
        502,
      );
    }
    const controller = parseBluetoothctlShow(showResult.stdout);
    const known = parseDeviceLines(devicesResult.stdout);
    const connectedAddresses = new Set(
      parseDeviceLines(connectedResult.stdout).map((device) => device.address),
    );
    const devices = known.map((device) => ({
      ...device,
      connected: connectedAddresses.has(device.address),
      paired: true,
    }));
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
      devices,
      scanning: scanInFlight,
      raw: showResult.stdout,
    });
  }),
);

bluetoothRouter.post(
  '/scan',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ seconds: z.number().int().min(5).max(20).default(10) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Некорректная длительность сканирования', 400);
    if (scanInFlight) throw new AccError('SCAN_IN_PROGRESS', 'Сканирование уже выполняется', 409);
    scanInFlight = true;
    try {
      await runBluetoothctl(`--timeout ${parsed.data.seconds} scan on`, (parsed.data.seconds + 5) * 1000);
      const devicesResult = await runBluetoothctl('devices', 10_000);
      const connectedResult = await runBluetoothctl('devices Connected', 10_000);
      const connectedAddresses = new Set(
        parseDeviceLines(connectedResult.stdout).map((device) => device.address),
      );
      const devices = parseDeviceLines(devicesResult.stdout).map((device) => ({
        ...device,
        connected: connectedAddresses.has(device.address),
        paired: false,
      }));
      eventLog.append({
        level: 'info',
        module: 'bluetooth',
        operation: 'scan',
        result: 'ok',
        message: `Сканирование Bluetooth завершено, устройств: ${devices.length}`,
        details: { seconds: parsed.data.seconds },
      });
      sendOk(res, { devices, scannedAt: Date.now() });
    } finally {
      scanInFlight = false;
    }
  }),
);

bluetoothRouter.post(
  '/connect',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ address: z.string().regex(MAC) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_ADDRESS', 'Некорректный MAC-адрес', 400);
    const address = parsed.data.address.toUpperCase();
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
    const result = await runBluetoothctl(`connect ${address}`, 30_000);
    const ok = /Connection successful|Connected: yes/i.test(result.stdout);
    if (!ok) {
      const message = result.stderr.trim() || result.stdout.trim().split('\n').at(-1) || 'Не удалось подключиться';
      eventLog.append({
        level: 'warn',
        module: 'bluetooth',
        operation: 'connect',
        result: 'error',
        message: `Bluetooth: подключение к ${address} не удалось`,
        details: { error: message },
      });
      throw new AccError('BT_CONNECT_FAILED', message, 502);
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
      throw new AccError('BT_DISCONNECT_FAILED', result.stderr.trim() || 'Не удалось отключить', 502);
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
      throw new AccError('BT_REMOVE_FAILED', result.stderr.trim() || 'Не удалось удалить устройство', 502);
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

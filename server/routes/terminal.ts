import { Router } from 'express';
import { z } from 'zod';
import { ACTION_READY_WAIT_MS, connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { commandPreview, isAllowlistedCommand } from '../security/commands.ts';

export const terminalRouter = Router();

const PRESETS: Array<{ group: string; items: Array<{ label: string; command: string }> }> = [
  {
    group: 'Система',
    items: [
      { label: 'Версия ядра', command: 'uname -a' },
      { label: 'Uptime', command: 'uptime' },
      { label: 'Кто я', command: 'id' },
      { label: 'Дата и время', command: 'date' },
      { label: 'Hostname', command: 'hostname' },
      { label: 'Загрузка CPU', command: 'cat /proc/loadavg' },
      { label: 'Версия Quasar', command: 'q version' },
      { label: 'Полная информация', command: 'q full-info' },
    ],
  },
  {
    group: 'Память и диски',
    items: [
      { label: 'Свободная память', command: 'free' },
      { label: 'Разделы', command: 'df -k' },
      { label: 'Монтирования', command: 'mount' },
      { label: 'Разметка MTD', command: 'cat /proc/mtd' },
      { label: 'Разделы блочных устройств', command: 'cat /proc/partitions' },
    ],
  },
  {
    group: 'Процессы',
    items: [
      { label: 'Список процессов', command: 'ps' },
      { label: 'Снимок top', command: 'top -b -n 1' },
      { label: 'Открытые порты', command: 'netstat -ln' },
      { label: 'Сетевые интерфейсы', command: 'ip addr' },
      { label: 'Wi-Fi', command: 'cat /proc/net/wireless' },
    ],
  },
  {
    group: 'Железо',
    items: [
      { label: 'Температура', command: 'cat /sys/class/thermal/thermal_zone0/temp' },
      { label: 'LED-зоны', command: 'ls /sys/class/leds' },
      { label: 'Bluetooth', command: 'hciconfig -a' },
      { label: 'Bluetoothctl', command: 'bluetoothctl show' },
      { label: 'USB-устройства', command: 'lsusb' },
      { label: 'Причина перезагрузки', command: 'cat /sys/class/aml_info/reboot_reason' },
      { label: 'Ядро: сообщения', command: 'dmesg' },
    ],
  },
];

terminalRouter.get(
  '/commands',
  asyncRoute(async (_req, res) => {
    sendOk(res, {
      presets: PRESETS,
      policy: {
        rawCommands: false,
        note: 'Разрешены только команды из белого списка. Произвольная shell-строка не передаётся.',
        blocked: ['перенаправление вывода', 'пайпы', 'подстановки', 'составные команды', 'запись на устройство'],
      },
    });
  }),
);

terminalRouter.post(
  '/exec',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ command: z.string().min(1).max(300) })
      .safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Команда не передана', 400);
    const command = parsed.data.command.trim();
    if (!isAllowlistedCommand(command)) {
      eventLog.append({
        level: 'warn',
        module: 'terminal',
        operation: 'command',
        result: 'error',
        message: `Команда отклонена белым списком: ${commandPreview(command)}`,
      });
      throw new AccError(
        'COMMAND_NOT_ALLOWED',
        'Команда не входит в белый список. Произвольные команды не выполняются.',
        403,
      );
    }
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const result = await adapter.exec(command, { timeoutMs: 20_000, maxBytes: 300_000 });
    eventLog.append({
      level: result.code === 0 ? 'info' : 'warn',
      module: 'terminal',
      operation: 'command',
      result: result.code === 0 ? 'ok' : 'error',
      message: `Команда: ${commandPreview(command)}`,
      details: { code: result.code, durationMs: result.durationMs },
    });
    sendOk(res, {
      command,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
  }),
);

import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { LOGS_ROOT } from '../security/paths.ts';
import { shQuote } from '../util.ts';

export const systemRouter = Router();

systemRouter.get(
  '/snapshot',
  asyncRoute(async (_req, res) => {
    sendOk(res, connectionManager.snapshot());
  }),
);

systemRouter.get(
  '/metrics',
  asyncRoute(async (_req, res) => {
    const service = connectionManager.getMetricsService();
    sendOk(res, {
      history: service.getHistory(),
      last: service.getLast(),
      error: service.getLastError(),
    });
  }),
);

systemRouter.post(
  '/refresh',
  asyncRoute(async (_req, res) => {
    const probe = await connectionManager.refreshProbe();
    sendOk(res, {
      info: probe.info,
      capabilities: probe.capabilities,
      warnings: probe.warnings,
    });
  }),
);

systemRouter.get(
  '/fastfetch/plan',
  asyncRoute(async (_req, res) => {
    const info = connectionManager.getInfo();
    const capabilities = connectionManager.getCapabilities();
    const available = capabilities?.fastfetch.available ?? false;
    sendOk(res, {
      available,
      path: capabilities?.fastfetch.details?.path ?? null,
      arch: info?.arch ?? null,
      steps: available
        ? []
        : [
            'Проверить архитектуру устройства (ожидается aarch64) и свободное место в /data',
            'Скачать статический бинарник fastfetch из contrib/bin репозитория yandex-station-extended',
            'Проверить SHA-256 и формат ELF перед загрузкой на устройство',
            'Загрузить в /data/opt/bin/fastfetch и выставить права на выполнение',
            'Проверить запуск и при необходимости добавить конфиг с логотипом',
          ],
      notes: [
        'Установка выполняется только после отдельного подтверждения.',
        'Бинарник для aarch64 не гарантирует запуск на конкретной прошивке.',
      ],
    });
  }),
);

systemRouter.post(
  '/fastfetch',
  asyncRoute(async (_req, res) => {
    const capabilities = connectionManager.getCapabilities();
    const path = capabilities?.fastfetch.details?.path;
    if (!capabilities?.fastfetch.available || typeof path !== 'string') {
      throw new AccError(
        'FASTFETCH_UNAVAILABLE',
        'Fastfetch не установлен на этой прошивке. Доступна штатная диагностика.',
        409,
      );
    }
    const adapter = connectionManager.requireAdapter();
    const result = await adapter.exec(`${shQuote(path)} --logo none`, {
      timeoutMs: 20_000,
      maxBytes: 500_000,
    });
    eventLog.append({
      level: result.code === 0 ? 'success' : 'error',
      module: 'system',
      operation: 'fastfetch',
      result: result.code === 0 ? 'ok' : 'error',
      message:
        result.code === 0 ? 'Fastfetch выполнен' : 'Fastfetch завершился с ошибкой',
      details: { code: result.code, stderr: result.stderr.slice(0, 500) },
    });
    if (result.code !== 0 && !result.stdout.trim()) {
      throw new AccError(
        'FASTFETCH_FAILED',
        result.stderr.trim() || `Fastfetch завершился с кодом ${result.code}`,
        502,
      );
    }
    sendOk(res, {
      output: result.stdout || result.stderr,
      code: result.code,
      durationMs: result.durationMs,
    });
  }),
);

systemRouter.get(
  '/processes',
  asyncRoute(async (_req, res) => {
    const adapter = connectionManager.requireAdapter();
    const result = await adapter.exec('ps', { timeoutMs: 10_000, maxBytes: 300_000 });
    const lines = result.stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean);
    sendOk(res, {
      lines,
      raw: result.stdout,
      updatedAt: Date.now(),
    });
  }),
);

systemRouter.get(
  '/logs',
  asyncRoute(async (req, res) => {
    const capabilities = connectionManager.getCapabilities();
    const files = (capabilities?.logs.details?.files as string[] | undefined) ?? [];
    const name = typeof req.query.file === 'string' ? req.query.file : '';
    if (!name || !files.includes(name)) {
      throw new AccError('LOG_NOT_ALLOWED', 'Этот лог не входит в список разрешённых', 403);
    }
    const adapter = connectionManager.requireAdapter();
    const remotePath = `${LOGS_ROOT}/${name}`;
    const result = await adapter.exec(`tail -c 200000 ${shQuote(remotePath)}`, {
      timeoutMs: 10_000,
      maxBytes: 250_000,
    });
    if (result.code !== 0) {
      throw new AccError('LOG_READ_FAILED', result.stderr || 'Не удалось прочитать лог', 502);
    }
    sendOk(res, { file: name, content: result.stdout, truncated: result.truncated });
  }),
);

const DIAGNOSTIC_COMMANDS: Array<{ label: string; command: string }> = [
  { label: 'Ядро и система', command: 'uname -a' },
  { label: 'Uptime', command: 'uptime' },
  { label: 'Файловые системы', command: 'df -k / /data' },
  { label: 'Память', command: 'cat /proc/meminfo' },
  { label: 'Load average', command: 'cat /proc/loadavg' },
  { label: 'Температура', command: 'cat /sys/class/thermal/thermal_zone0/temp' },
  { label: 'Причина перезагрузки', command: 'cat /sys/class/aml_info/reboot_reason' },
  { label: 'Процессы', command: 'ps' },
];

systemRouter.get(
  '/diagnostics',
  asyncRoute(async (_req, res) => {
    const adapter = connectionManager.requireAdapter();
    const results = await Promise.all(
      DIAGNOSTIC_COMMANDS.map(async (item) => {
        try {
          const result = await adapter.exec(item.command, { timeoutMs: 8000, maxBytes: 100_000 });
          return {
            label: item.label,
            command: item.command,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        } catch (error) {
          return {
            label: item.label,
            command: item.command,
            code: null,
            stdout: '',
            stderr: error instanceof Error ? error.message : 'Ошибка',
          };
        }
      }),
    );
    sendOk(res, { results, collectedAt: Date.now() });
  }),
);

systemRouter.post(
  '/install-fastfetch',
  asyncRoute(async (req, res) => {
    const confirm = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!confirm.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Установка требует явного подтверждения', 400);
    }
    throw new AccError(
      'NOT_IMPLEMENTED',
      'Автоматическая установка fastfetch не реализована без проверенного источника и хеша',
      501,
    );
  }),
);

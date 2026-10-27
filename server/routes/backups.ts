import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import type { BackupManifest } from '../../shared/types.ts';
import {
  createBackup,
  deleteBackup,
  getBackup,
  getBackupItemPath,
  listBackups,
  restoreBackup,
} from '../backups.ts';
import { ACTION_READY_WAIT_MS, connectionManager } from '../connection.ts';
import { remoteSha256 } from '../deviceOps.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { routeParam } from '../util.ts';

export const backupsRouter = Router();

const CONFIG_TARGETS = [
  '/system/vendor/quasar/quasar.cfg',
  '/system/vendor/quasar/launch.json',
  '/etc/asound.conf',
  '/etc/bluetooth/main.conf',
  '/data/quasar/devices.json',
  '/data/quasar/quasar_metricad.json',
];

backupsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    const backups = listBackups().filter((backup) => !kind || backup.kind === kind);
    sendOk(res, {
      backups,
      counts: backups.reduce<Record<string, number>>((acc, backup) => {
        acc[backup.kind] = (acc[backup.kind] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }),
);

backupsRouter.post(
  '/config',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ confirm: z.literal(true), note: z.string().max(300).optional() })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Бэкап конфигурации требует подтверждения', 400);
    }
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const sources: Array<{ targetPath: string; mode: string }> = [];
    for (const target of CONFIG_TARGETS) {
      try {
        const info = await adapter.stat(target);
        if (!info.isFile) continue;
        sources.push({ targetPath: target, mode: info.mode.toString(8).padStart(4, '0') });
      } catch {
        // файла нет на этой прошивке
      }
    }
    if (!sources.length) {
      throw new AccError('NOTHING_TO_BACKUP', 'Не найдено ни одного файла конфигурации', 400);
    }
    const manifest = await createBackup(
      adapter,
      'config',
      'Конфигурация Quasar',
      sources,
      parsed.data.note,
    );
    eventLog.append({
      level: 'success',
      module: 'backups',
      operation: 'config',
      result: 'ok',
      message: `Сохранено файлов конфигурации: ${manifest.items.length}`,
      details: { backupId: manifest.id, items: manifest.items.map((item) => item.targetPath) },
    });
    sendOk(res, manifest);
  }),
);

backupsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    sendOk(res, getBackup(routeParam(req.params.id)));
  }),
);

backupsRouter.get(
  '/:id/download/:index',
  asyncRoute(async (req, res) => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      throw new AccError('BAD_REQUEST', 'Некорректный номер файла', 400);
    }
    const { manifest, filePath, item } = getBackupItemPath(routeParam(req.params.id), index);
    const name = item.targetPath.split('/').pop() ?? 'file';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    res.setHeader('Content-Length', String(fs.statSync(filePath).size));
    fs.createReadStream(filePath).pipe(res);
    void manifest;
  }),
);

backupsRouter.get(
  '/:id/verify',
  asyncRoute(async (req, res) => {
    const manifest = getBackup(routeParam(req.params.id));
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const items = [];
    for (const item of manifest.items) {
      try {
        const actual = await remoteSha256(adapter, item.targetPath);
        items.push({
          targetPath: item.targetPath,
          expected: item.sha256,
          actual,
          ok: actual === item.sha256,
        });
      } catch (error) {
        items.push({
          targetPath: item.targetPath,
          expected: item.sha256,
          actual: null,
          ok: false,
          error: error instanceof Error ? error.message : 'Не удалось вычислить SHA-256',
        });
      }
    }
    sendOk(res, { backupId: manifest.id, items });
  }),
);

backupsRouter.post(
  '/:id/restore',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Восстановление требует подтверждения', 400);
    }
    const manifest = getBackup(routeParam(req.params.id));
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const result = await restoreBackup(adapter, manifest.id);
    const failed = result.restored.filter((item) => !item.ok);
    eventLog.append({
      level: failed.length ? 'warn' : 'success',
      module: 'backups',
      operation: 'restore',
      result: failed.length ? 'error' : 'ok',
      message: `Восстановление «${manifest.title}»: успешно ${result.restored.length - failed.length} из ${result.restored.length}`,
      details: { backupId: manifest.id, failed: failed.length },
    });
    sendOk(res, { backup: manifest, restored: result.restored });
  }),
);

backupsRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Удаление бэкапа требует подтверждения', 400);
    }
    const manifest = getBackup(routeParam(req.params.id));
    deleteBackup(manifest.id);
    eventLog.append({
      level: 'info',
      module: 'backups',
      operation: 'delete',
      result: 'ok',
      message: `Бэкап удалён: ${manifest.title}`,
      details: { backupId: manifest.id },
    });
    sendOk(res, { deleted: manifest.id } satisfies { deleted: string });
  }),
);

export type { BackupManifest };

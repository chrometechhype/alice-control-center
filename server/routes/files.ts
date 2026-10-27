import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { FileEntry, FileRoot } from '../../shared/types.ts';
import { ACTION_READY_WAIT_MS, connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { removeDeviceFile } from '../deviceOps.ts';
import {
  FILE_ROOTS,
  assertReadablePath,
  assertSafeUpload,
  assertWritablePath,
  isWithin,
} from '../security/paths.ts';
import { shQuote } from '../util.ts';

export const filesRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024, files: 1 },
  // Without this, a Cyrillic filename arrives as latin1 mojibake and is written to the station as-is.
  defParamCharset: 'utf8',
});

const TEXT_MAX_BYTES = 512 * 1024;
/** Which of the catalogued directories are on this station changes only when someone installs YAM. */
const ROOTS_CACHE_MS = 20_000;
let rootsCache: { at: number; value: FileRoot[] } | null = null;

filesRouter.get(
  '/roots',
  asyncRoute(async (_req, res) => {
    if (rootsCache && Date.now() - rootsCache.at < ROOTS_CACHE_MS) {
      return sendOk(res, { roots: rootsCache.value });
    }
    const adapter = connectionManager.getAdapter();
    let existing: Set<string> | null = null;
    if (adapter?.isConnected()) {
      const check = FILE_ROOTS.map(
        (root) => `[ -d ${shQuote(root.path)} ] && echo "EX ${root.path}" || echo "MISS ${root.path}"`,
      ).join('; ');
      const probe = await adapter
        .exec(check, { timeoutMs: 12_000, maxBytes: 20_000 })
        .catch(() => null);
      if (probe && probe.code === 0) {
        existing = new Set(
          probe.stdout
            .split('\n')
            .filter((line) => line.startsWith('EX '))
            .map((line) => line.slice(3).trim()),
        );
      }
    }
    const roots: FileRoot[] = FILE_ROOTS.map((root) => ({ ...root, exists: existing ? existing.has(root.path) : true }));
    if (existing) rootsCache = { at: Date.now(), value: roots };
    sendOk(res, { roots });
  }),
);

filesRouter.get(
  '/list',
  asyncRoute(async (req, res) => {
    const remotePath = assertReadablePath(req.query.path);
    const entries = await connectionManager.stationRead((adapter) => adapter.listDir(remotePath));
    const mapped: FileEntry[] = entries
      .filter((entry) => entry.name !== '.' && entry.name !== '..')
      .map((entry) => {
        const full = path.posix.join(remotePath, entry.name);
        return {
          path: full,
          name: entry.name,
          type: entry.isDirectory
            ? 'dir'
            : entry.isSymbolicLink
              ? 'link'
              : entry.isFile
                ? 'file'
                : 'other',
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          mode: entry.mode,
          writable: FILE_ROOTS.some((root) => root.writable && isWithin(root.path, full)),
        } satisfies FileEntry;
      })
      .sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (b.type === 'dir' && a.type !== 'dir') return 1;
        return a.name.localeCompare(b.name, 'ru');
      });
    sendOk(res, {
      path: remotePath,
      parent: path.posix.dirname(remotePath),
      entries: mapped,
    });
  }),
);

filesRouter.get(
  '/read',
  asyncRoute(async (req, res) => {
    const remotePath = assertReadablePath(req.query.path);
    const { info, data } = await connectionManager.stationRead(async (adapter) => {
      const info = await adapter.stat(remotePath);
      if (!info.isFile) throw new AccError('NOT_A_FILE', 'Это не файл', 400);
      if (info.size > TEXT_MAX_BYTES) {
        throw new AccError('FILE_TOO_LARGE', 'Файл больше 512 КБ — используйте скачивание', 413);
      }
      return { info, data: await adapter.readFile(remotePath, TEXT_MAX_BYTES) };
    });
    if (data.includes(0)) {
      throw new AccError('BINARY_FILE', 'Файл бинарный — предпросмотр недоступен', 415);
    }
    sendOk(res, {
      path: remotePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      content: data.toString('utf8'),
    });
  }),
);

filesRouter.get(
  '/download',
  asyncRoute(async (req, res) => {
    const remotePath = assertReadablePath(req.query.path);
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const info = await adapter.stat(remotePath);
    if (!info.isFile) throw new AccError('NOT_A_FILE', 'Скачивание доступно только для файлов', 400);
    if (info.size > 64 * 1024 * 1024) {
      throw new AccError('FILE_TOO_LARGE', 'Файл больше 64 МБ', 413);
    }
    const data = await adapter.readFile(remotePath, 64 * 1024 * 1024);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(remotePath))}`,
    );
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  }),
);

filesRouter.post(
  '/upload',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Не указан каталог назначения', 400);
    if (!req.file?.buffer.length) throw new AccError('FILE_REQUIRED', 'Файл не передан', 400);
    const directory = assertWritablePath(parsed.data.path);
    const name = path.posix.basename(req.file.originalname.replace(/\\/g, '/'));
    if (!name || name === '.' || name === '..') {
      throw new AccError('BAD_NAME', 'Некорректное имя файла', 400);
    }
    const target = assertWritablePath(path.posix.join(directory, name));
    assertSafeUpload(name, req.file.buffer);
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const info = await adapter.stat(directory);
    if (!info.isDirectory) throw new AccError('NOT_A_DIRECTORY', 'Цель не является каталогом', 400);
    await adapter.writeFile(target, req.file.buffer);
    eventLog.append({
      level: 'success',
      module: 'files',
      operation: 'upload',
      result: 'ok',
      message: `Загружен файл ${name}`,
      details: { path: target, size: req.file.buffer.length },
    });
    sendOk(res, { path: target, size: req.file.buffer.length });
  }),
);

filesRouter.post(
  '/mkdir',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Не указан путь', 400);
    const target = assertWritablePath(parsed.data.path);
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const result = await adapter.exec(`mkdir -p ${shQuote(target)}`, { timeoutMs: 8000 });
    if (result.code !== 0) {
      throw new AccError('MKDIR_FAILED', result.stderr.trim() || 'Не удалось создать каталог', 502);
    }
    sendOk(res, { path: target });
  }),
);

filesRouter.post(
  '/rename',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ from: z.string().min(1), to: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Нужны исходный и новый путь', 400);
    const from = assertWritablePath(parsed.data.from);
    const to = assertWritablePath(parsed.data.to);
    if (isWithin(from, to) || isWithin(to, from)) {
      throw new AccError('BAD_RENAME', 'Нельзя переместить каталог внутрь самого себя', 400);
    }
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const result = await adapter.exec(`mv ${shQuote(from)} ${shQuote(to)}`, { timeoutMs: 15_000 });
    if (result.code !== 0) {
      throw new AccError('RENAME_FAILED', result.stderr.trim() || 'Не удалось переименовать', 502);
    }
    eventLog.append({
      level: 'info',
      module: 'files',
      operation: 'rename',
      result: 'ok',
      message: 'Файл переименован',
      details: { from, to },
    });
    sendOk(res, { from, to });
  }),
);

filesRouter.post(
  '/delete',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ path: z.string().min(1), confirm: z.literal(true) })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Удаление требует подтверждения', 400);
    }
    const target = assertWritablePath(parsed.data.path);
    const root = FILE_ROOTS.find((item) => item.writable && isWithin(item.path, target));
    if (!root || target === root.path) {
      throw new AccError('BAD_PATH', 'Нельзя удалить корень разрешённого каталога', 400);
    }
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    await removeDeviceFile(adapter, target);
    eventLog.append({
      level: 'warn',
      module: 'files',
      operation: 'delete',
      result: 'ok',
      message: `Удалено: ${target}`,
    });
    sendOk(res, { deleted: target });
  }),
);

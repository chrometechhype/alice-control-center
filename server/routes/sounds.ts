import { createHash } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import type { SoundListing } from '../../shared/types.ts';
import { createBackup } from '../backups.ts';
import { connectionManager } from '../connection.ts';
import { remoteFreeBytes, remoteSha256, writeDeviceFile } from '../deviceOps.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { isSoundFile } from '../parse.ts';
import { assertSoundPath, SOUNDS_ROOT } from '../security/paths.ts';
import { looksLikeAudio, scanSounds, soundExt } from '../sounds.ts';
import { formatBytes } from '../util.ts';

export const soundsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
});

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

soundsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const adapter = connectionManager.requireAdapter();
    const listing: SoundListing = await scanSounds(adapter);
    sendOk(res, listing);
  }),
);

soundsRouter.get(
  '/file',
  asyncRoute(async (req, res) => {
    const remotePath = assertSoundPath(req.query.path);
    const adapter = connectionManager.requireAdapter();
    const info = await adapter.stat(remotePath);
    if (!info.isFile) throw new AccError('NOT_A_FILE', 'Это не файл', 400);
    if (info.size > 24 * 1024 * 1024) {
      throw new AccError('FILE_TOO_LARGE', 'Файл больше 24 МБ — предпросмотр недоступен', 413);
    }
    const data = await adapter.readFile(remotePath, 24 * 1024 * 1024);
    const ext = soundExt(remotePath);
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(data.length));
    res.setHeader(
      'Content-Disposition',
      `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.posix.basename(remotePath))}`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  }),
);

soundsRouter.post(
  '/replace',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        path: z.string().min(1),
        // multipart-поля приходят строками, поэтому принимаем и "true"
        confirm: z.union([z.literal(true), z.literal('true')]),
        note: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Замена звука требует явного подтверждения', 400);
    }
    const file = req.file;
    if (!file || !file.buffer.length) {
      throw new AccError('FILE_REQUIRED', 'Не передан аудиофайл', 400);
    }
    const remotePath = assertSoundPath(parsed.data.path);
    const adapter = connectionManager.requireAdapter();
    const info = await adapter.stat(remotePath);
    if (!info.isFile) throw new AccError('NOT_A_FILE', 'Цель замены не является файлом', 400);

    const ext = soundExt(remotePath);
    if (!isSoundFile(remotePath) || soundExt(file.originalname) !== ext) {
      throw new AccError(
        'FORMAT_MISMATCH',
        `Формат нового файла должен совпадать с целевым (.${ext})`,
        400,
      );
    }
    if (!looksLikeAudio(ext, file.buffer)) {
      throw new AccError('INVALID_AUDIO', 'Содержимое файла не похоже на заявленный аудиоформат', 415);
    }

    const free = await remoteFreeBytes(adapter, SOUNDS_ROOT);
    if (free && free.availableBytes < file.buffer.length + 1024 * 1024) {
      throw new AccError(
        'NOT_ENOUGH_SPACE',
        `На разделе ${free.mount} свободно ${formatBytes(free.availableBytes)} — недостаточно для замены`,
        507,
      );
    }

    const mode = Number.parseInt(info.mode.toString(8), 8);
    const backup = await createBackup(
      adapter,
      'sound',
      `Перед заменой ${path.posix.basename(remotePath)}`,
      [{ targetPath: remotePath, mode: info.mode.toString(8).padStart(4, '0') }],
      parsed.data.note ?? 'Автоматический бэкап перед заменой звука',
    );

    try {
      await writeDeviceFile(adapter, remotePath, file.buffer, mode || undefined);
      const sha256 = await remoteSha256(adapter, remotePath);
      const expected = createHash('sha256').update(file.buffer).digest('hex');
      if (sha256 !== expected) {
        throw new AccError(
          'VERIFY_FAILED',
          'Хеш файла на устройстве не совпал после записи. Верните оригинал из бэкапа.',
          502,
          { backupId: backup.id },
        );
      }

      eventLog.append({
        level: 'success',
        module: 'sounds',
        operation: 'replace',
        result: 'ok',
        message: `Звук заменён: ${path.posix.basename(remotePath)}`,
        details: { path: remotePath, size: file.buffer.length, backupId: backup.id, sha256 },
      });
      sendOk(res, {
        path: remotePath,
        size: file.buffer.length,
        sha256,
        backup,
      });
    } catch (error) {
      eventLog.append({
        level: 'error',
        module: 'sounds',
        operation: 'replace',
        result: 'error',
        message: `Замена не завершена: ${path.posix.basename(remotePath)}`,
        details: {
          path: remotePath,
          backupId: backup.id,
          error: error instanceof Error ? error.message : 'Неизвестная ошибка',
        },
      });
      throw error;
    }
  }),
);

soundsRouter.post(
  '/packs',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        category: z.string().max(64).optional(),
        title: z.string().max(120).optional(),
        confirm: z.literal(true),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Создание пака требует подтверждения', 400);
    }
    const adapter = connectionManager.requireAdapter();
    const listing = await scanSounds(adapter);
    const category = parsed.data.category && parsed.data.category !== 'all' ? parsed.data.category : null;
    const files = listing.files.filter((file) => !category || file.category === category);
    if (!files.length) {
      throw new AccError('NOTHING_TO_BACKUP', 'В выбранной категории нет звуков', 400);
    }
    if (files.length > 250) {
      throw new AccError('TOO_MANY_FILES', 'Слишком много файлов для одного пака', 400);
    }
    const title = parsed.data.title?.trim() || `Пак звуков: ${category ?? 'все категории'}`;
    const backup = await createBackup(
      adapter,
      'pack',
      title,
      files.map((file) => ({ targetPath: file.path })),
      category ? `Категория ${category}` : 'Полный набор системных звуков',
    );
    eventLog.append({
      level: 'success',
      module: 'sounds',
      operation: 'pack',
      result: 'ok',
      message: `Создан пак «${title}»: файлов ${files.length}`,
      details: { backupId: backup.id, category: category ?? 'all' },
    });
    sendOk(res, backup);
  }),
);

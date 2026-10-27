import { createHash } from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import type { SoundListing } from '../../shared/types.ts';
import { createBackup } from '../backups.ts';
import { ACTION_READY_WAIT_MS, connectionManager } from '../connection.ts';
import { removeDeviceFile, remoteFreeBytes, remoteSha256, writeDeviceFile } from '../deviceOps.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { isSoundFile } from '../parse.ts';
import {
  assertPlayableSoundPath,
  assertSoundPath,
  assertUserSoundPath,
  SOUNDS_ROOT,
  USER_SOUNDS_ROOT,
} from '../security/paths.ts';
import { looksLikeAudio, scanSounds, soundExt, toSoundFile } from '../sounds.ts';
import { formatBytes, shQuote } from '../util.ts';

export const soundsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  // Browsers put the Cyrillic filename on the wire as UTF-8; busboy's default latin1 read turns
  // «проверка.mp3» into «Ð¿ÑÐ¾Ð²ÐµÑÐºÐ°.mp3» before we ever see it.
  defParamCharset: 'utf8',
});

/**
 * Library names end up inside a shell command, so anything outside letters, digits and a few safe
 * separators is dropped rather than escaped — the name stays readable in the station's own browser.
 */
export function libraryFileName(input: string): string {
  const base = path.posix.basename(input.trim());
  const ext = soundExt(base);
  if (!isSoundFile(base)) {
    throw new AccError(
      'FORMAT_MISMATCH',
      'Библиотека принимает mp3, wav, ogg, opus, flac, m4a и aac',
      415,
    );
  }
  const stem = base.slice(0, base.length - ext.length - 1)
    .replace(/[^\p{L}\p{N} _()\-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stem) throw new AccError('BAD_NAME', 'Имя файла получилось пустым', 400);
  return `${stem.slice(0, 72)}.${ext}`;
}

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
    const adapter = await connectionManager.awaitReady();
    const listing: SoundListing = await scanSounds(adapter);
    // The library folder only appears after the first upload, so free space is measured one level
    // up — /data is the partition that actually runs out.
    const free = await remoteFreeBytes(adapter, path.posix.dirname(USER_SOUNDS_ROOT)).catch(() => null);
    sendOk(res, { ...listing, userFreeBytes: free?.availableBytes ?? null });
  }),
);

soundsRouter.get(
  '/file',
  asyncRoute(async (req, res) => {
    const remotePath = assertPlayableSoundPath(req.query.path);
    const adapter = await connectionManager.awaitReady();
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
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS);
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

/**
 * Publishes a sound into the panel's own library on the station. Unlike a system sound, a library
 * entry can be deleted again — the station's own files stay untouched.
 */
soundsRouter.post(
  '/publish',
  upload.single('file'),
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(90).optional(),
        confirm: z.union([z.literal(true), z.literal('true')]).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_REQUEST', 'Не удалось разобрать форму загрузки', 400);
    }
    const file = req.file;
    if (!file || !file.buffer.length) {
      throw new AccError('FILE_REQUIRED', 'Не передан аудиофайл', 400);
    }
    const name = libraryFileName(parsed.data.name ?? file.originalname);
    const ext = soundExt(name);
    if (!looksLikeAudio(ext, file.buffer)) {
      throw new AccError('INVALID_AUDIO', `Содержимое файла не похоже на .${ext}`, 415);
    }
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS);
    const target = `${USER_SOUNDS_ROOT}/${name}`;
    const exists = await adapter
      .exec(`[ -f ${shQuote(target)} ] && echo YES`, { timeoutMs: 10_000 })
      .then((result) => result.stdout.trim() === 'YES')
      .catch(() => false);
    if (exists && parsed.data.confirm !== true && parsed.data.confirm !== 'true') {
      throw new AccError(
        'ALREADY_PUBLISHED',
        `В библиотеке уже есть «${name}». Подтвердите замену или возьмите другое имя.`,
        409,
      );
    }
    const free = await remoteFreeBytes(adapter, path.posix.dirname(USER_SOUNDS_ROOT));
    if (free && free.availableBytes < file.buffer.length + 1024 * 1024) {
      throw new AccError(
        'NOT_ENOUGH_SPACE',
        `На разделе ${free.mount} свободно ${formatBytes(free.availableBytes)} — звук не поместится. `
          + 'Освободите место на станции или возьмите файл поменьше.',
        507,
      );
    }
    await adapter.exec(`mkdir -p ${shQuote(USER_SOUNDS_ROOT)}`, { timeoutMs: 10_000 });
    await writeDeviceFile(adapter, target, file.buffer, 0o644);
    const sha256 = await remoteSha256(adapter, target);
    const expected = createHash('sha256').update(file.buffer).digest('hex');
    if (sha256 !== expected) {
      await removeDeviceFile(adapter, target).catch(() => undefined);
      throw new AccError('VERIFY_FAILED', 'Хеш на станции не совпал — файл удалён, попробуйте ещё раз', 502);
    }
    eventLog.append({
      level: 'success',
      module: 'sounds',
      operation: 'publish',
      result: 'ok',
      message: `Опубликовано в библиотеке: ${name}`,
      details: { path: target, size: file.buffer.length, replaced: exists },
    });
    sendOk(res, toSoundFile(target, file.buffer.length, Date.now(), 'user'));
  }),
);

/** Only library sounds are deletable; system ones can be replaced but never removed. */
soundsRouter.post(
  '/delete',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ path: z.string().min(1), confirm: z.literal(true) })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Удаление звука требует подтверждения', 400);
    }
    const target = assertUserSoundPath(parsed.data.path);
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS);
    await removeDeviceFile(adapter, target);
    eventLog.append({
      level: 'warn',
      module: 'sounds',
      operation: 'delete',
      result: 'ok',
      message: `Удалено из библиотеки: ${path.posix.basename(target)}`,
      details: { path: target },
    });
    sendOk(res, { deleted: target });
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
    const adapter = await connectionManager.awaitReady();
    const listing = await scanSounds(adapter);
    const category = parsed.data.category && parsed.data.category !== 'all' ? parsed.data.category : null;
    const files = listing.files.filter(
      (file) => file.origin === 'system' && (!category || file.category === category),
    );
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

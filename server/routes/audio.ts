import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { parseAmixerMaster } from '../parse.ts';
import { clamp } from '../util.ts';

export const audioRouter = Router();

async function readMaster() {
  const adapter = connectionManager.requireAdapter();
  const result = await adapter.exec('amixer sget Master', { timeoutMs: 10_000, maxBytes: 40_000 });
  if (result.code !== 0) {
    throw new AccError(
      'AMIXER_FAILED',
      result.stderr.trim() || 'Не удалось прочитать громкость ALSA',
      502,
    );
  }
  return { ...parseAmixerMaster(result.stdout), raw: result.stdout };
}

audioRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    sendOk(res, await readMaster());
  }),
);

audioRouter.post(
  '/volume',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ percent: z.number().int().min(0).max(100) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_VOLUME', 'Громкость должна быть от 0 до 100%', 400);
    }
    const percent = clamp(parsed.data.percent, 0, 100);
    const adapter = connectionManager.requireAdapter();
    const result = await adapter.exec(`amixer sset Master ${percent}%`, {
      timeoutMs: 10_000,
      maxBytes: 40_000,
    });
    if (result.code !== 0) {
      throw new AccError('AMIXER_FAILED', result.stderr.trim() || 'Не удалось изменить громкость', 502);
    }
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'volume',
      result: 'ok',
      message: `Громкость установлена на ${percent}%`,
    });
    sendOk(res, await readMaster());
  }),
);

audioRouter.post(
  '/mute',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ muted: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Нужен параметр muted', 400);
    const adapter = connectionManager.requireAdapter();
    const result = await adapter.exec(`amixer sset Master ${parsed.data.muted ? 'mute' : 'unmute'}`, {
      timeoutMs: 10_000,
      maxBytes: 40_000,
    });
    if (result.code !== 0) {
      throw new AccError('AMIXER_FAILED', result.stderr.trim() || 'Не удалось переключить звук', 502);
    }
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'mute',
      result: 'ok',
      message: parsed.data.muted ? 'Звук выключен' : 'Звук включён',
    });
    sendOk(res, await readMaster());
  }),
);

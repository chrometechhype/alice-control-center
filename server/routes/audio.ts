import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { parseAmixerMaster } from '../parse.ts';
import { assertSoundPath } from '../security/paths.ts';
import { findPlayers, playDeviceFile, playTempAudio, synthesizeSpeech } from '../voice.ts';
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

/** What the station can actually play with — the UI asks before enabling the buttons. */
audioRouter.get(
  '/players',
  asyncRoute(async (_req, res) => {
    const adapter = connectionManager.requireAdapter();
    sendOk(res, { players: await findPlayers(adapter) });
  }),
);

/**
 * Plays a sound that already lives on the station. Nothing is written anywhere, so the clip never
 * ends up in the station's own library.
 */
audioRouter.post(
  '/play',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ path: z.string().min(1).max(500) }).strict().safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Нужен путь к звуку на станции', 400);
    const remotePath = assertSoundPath(parsed.data.path);
    const adapter = connectionManager.requireAdapter();
    const player = await playDeviceFile(adapter, remotePath);
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'play',
      result: 'ok',
      message: `Играем ${remotePath.split('/').pop() ?? 'звук'}`,
      details: { player, path: remotePath },
    });
    sendOk(res, { player, path: remotePath });
  }),
);

/**
 * Speaks a line through the configured AI server. The clip goes to /tmp, plays, and the same
 * remote command deletes it — the station keeps nothing.
 */
audioRouter.post(
  '/say',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(300) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_REQUEST', 'Текст для озвучки должен быть от 1 до 300 символов', 400);
    }
    // Check the station before spending a TTS request on it.
    const adapter = connectionManager.requireAdapter();
    const players = await findPlayers(adapter);
    if (!players.length) {
      throw new AccError(
        'NO_AUDIO_PLAYER',
        'На станции не нашлось плеера (aplay, paplay, ffplay, mpv, gstreamer) — озвучка невозможна.',
        502,
      );
    }
    const speech = await synthesizeSpeech(parsed.data.text);
    const player = await playTempAudio(adapter, speech.audio, speech.ext);
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'say',
      result: 'ok',
      message: `Озвучено: ${parsed.data.text.slice(0, 60)}`,
      details: { player, model: speech.model, voice: speech.voice, bytes: speech.audio.length },
    });
    sendOk(res, { player, model: speech.model, voice: speech.voice, bytes: speech.audio.length });
  }),
);

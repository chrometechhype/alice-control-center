import { Router } from 'express';
import { z } from 'zod';
import type { AudioState } from '../../shared/types.ts';
import { ACTION_READY_WAIT_MS, connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { parseAmixerMaster } from '../parse.ts';
import { speakWithAlice } from '../aliceVoice.ts';
import { assertPlayableSoundPath } from '../security/paths.ts';
import { findPlayers, playDeviceFile } from '../voice.ts';
import { percentToLevel, percentToRaw, rawToPercent } from '../volumeScale.ts';
import { clamp } from '../util.ts';

export const audioRouter = Router();

/** ALSA `Master` is the same control Alice's own `set_volume.sh` writes, so both stay in sync. */
async function readMaster(): Promise<AudioState> {
  const result = await connectionManager.stationRead((adapter) =>
    adapter.exec('amixer sget Master', { timeoutMs: 10_000, maxBytes: 40_000 }),
  );
  if (result.code !== 0) {
    throw new AccError(
      'AMIXER_FAILED',
      result.stderr.trim() || 'Не удалось прочитать громкость ALSA',
      502,
    );
  }
  const parsed = parseAmixerMaster(result.stdout);
  const scale = connectionManager.getInfo()?.volumeScale ?? null;
  const onAliceScale = scale && parsed.raw != null ? rawToPercent(scale, parsed.raw) : null;
  const volumePct = onAliceScale ?? parsed.volumePct;
  return {
    volumePct,
    levelStep: scale && volumePct != null ? percentToLevel(volumePct, scale) : null,
    level: parsed.raw,
    max: parsed.max,
    muted: parsed.muted,
    canMute: parsed.hasSwitch,
  };
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
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const scale = connectionManager.getInfo()?.volumeScale ?? null;
    const current = await readMaster();
    // Writing the register in quasar's units is what makes Alice agree with the slider: the same
    // raw value read back through her table returns the percentage the person just set.
    const raw = scale ? percentToRaw(scale, percent, current.max) : null;
    const result = await adapter.exec(
      `amixer sset Master ${raw != null ? raw : `${percent}%`}`,
      { timeoutMs: 10_000, maxBytes: 40_000 },
    );
    if (result.code !== 0) {
      throw new AccError('AMIXER_FAILED', result.stderr.trim() || 'Не удалось изменить громкость', 502);
    }
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'volume',
      result: 'ok',
      message: `Громкость установлена на ${percent}%${raw != null ? ` (регистр ${raw})` : ''}`,
    });
    sendOk(res, await readMaster());
  }),
);

audioRouter.post(
  '/mute',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ muted: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw new AccError('BAD_REQUEST', 'Нужен параметр muted', 400);
    if (!(await readMaster()).canMute) {
      throw new AccError(
        'MUTE_UNSUPPORTED',
        'У регулятора Master на этой станции нет переключателя mute — тишины добивайтесь громкостью 0%.',
        400,
      );
    }
    const adapter = await connectionManager.awaitReady();
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
    sendOk(res, { players: await connectionManager.stationRead((adapter) => findPlayers(adapter)) });
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
    const remotePath = assertPlayableSoundPath(parsed.data.path);
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const played = await playDeviceFile(adapter, remotePath);
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'play',
      result: 'ok',
      message: `Играем ${remotePath.split('/').pop() ?? 'звук'}`,
      details: { ...played, path: remotePath },
    });
    sendOk(res, { ...played, path: remotePath });
  }),
);

/**
 * Speaks a line with Alice's own voice. The phrase goes to the station's local speech capability
 * (`AliceCapability` / START_VOCALIZE), which synthesises it in Yandex's cloud and plays it through
 * the same TTS player Alice uses herself — no file, no third-party voice, nothing left behind.
 */
audioRouter.post(
  '/say',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({ text: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_REQUEST', 'Текст для озвучки должен быть от 1 до 2000 символов', 400);
    }
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const speech = await speakWithAlice(adapter, parsed.data.text);
    eventLog.append({
      level: 'info',
      module: 'audio',
      operation: 'say',
      result: 'ok',
      message: `Алиса сказала: ${parsed.data.text.slice(0, 60)}`,
      details: { engine: speech.engine, transport: speech.transport, durationMs: speech.durationMs },
    });
    sendOk(res, speech);
  }),
);

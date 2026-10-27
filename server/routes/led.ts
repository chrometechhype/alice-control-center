import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import type { LedPreset } from '../../shared/types.ts';
import { ACTION_READY_WAIT_MS, connectionManager } from '../connection.ts';
import { ledPresetsFile } from '../config.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { allLedsOff, applyColors, requireZones, zonesFromCapabilities } from '../ledControl.ts';
import { animationStatus, startAnimation, stopAnimation } from '../ledAnimation.ts';
import { newId, shQuote } from '../util.ts';

export const ledRouter = Router();

function parseApplyBody(body: unknown): number[][] {
  const schema = z.object({
    zones: z
      .array(z.tuple([z.number().int().min(0).max(255), z.number().int().min(0).max(255), z.number().int().min(0).max(255)]))
      .min(1)
      .max(32),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AccError('BAD_COLORS', 'Цвета должны быть массивами [R, G, B] от 0 до 255', 400);
  }
  return parsed.data.zones.map((zone) => [...zone]);
}

function loadPresets(): LedPreset[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledPresetsFile, 'utf8'));
    return Array.isArray(raw) ? (raw as LedPreset[]) : [];
  } catch {
    return [];
  }
}

function savePresets(presets: LedPreset[]): void {
  fs.writeFileSync(ledPresetsFile, JSON.stringify(presets, null, 2), { mode: 0o600 });
}

ledRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    const zones = zonesFromCapabilities();
    const script = [
      'for l in /sys/class/leds/*; do',
      '  n=${l##*/}',
      '  echo "$n|$(cat $l/trigger 2>/dev/null)|$(cat $l/brightness 2>/dev/null)"',
      'done',
    ].join('\n');
    const result = await connectionManager.stationRead((adapter) =>
      adapter.exec(script, { timeoutMs: 8000, maxBytes: 60_000 }),
    );
    const leds: Record<string, { trigger: string; value: number }> = {};
    for (const line of result.stdout.split('\n')) {
      const parts = line.trim().split('|');
      if (parts.length < 3) continue;
      const [name, triggerValue, brightnessValue] = parts;
      const active = /\[([^\]]+)\]/.exec(triggerValue)?.[1] ?? triggerValue.split(/\s+/)[0] ?? '';
      leds[name] = { trigger: active, value: Number(brightnessValue) || 0 };
    }
    sendOk(res, {
      available: zones.length > 0,
      zones: zones.map((zone) => ({
        ...zone,
        redValue: leds[zone.red]?.value ?? null,
        greenValue: leds[zone.green]?.value ?? null,
        blueValue: leds[zone.blue]?.value ?? null,
        trigger: leds[zone.red]?.trigger ?? null,
      })),
      animation: animationStatus(),
      presets: loadPresets(),
    });
  }),
);

ledRouter.post(
  '/apply',
  asyncRoute(async (req, res) => {
    const colors = parseApplyBody(req.body);
    await stopAnimation();
    await applyColors(colors);
    sendOk(res, { zones: colors, appliedAt: Date.now() });
  }),
);

ledRouter.post(
  '/off',
  asyncRoute(async (_req, res) => {
    await stopAnimation();
    await allLedsOff();
    sendOk(res, { off: true });
  }),
);

ledRouter.post(
  '/restore',
  asyncRoute(async (_req, res) => {
    await stopAnimation();
    const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
    const zones = requireZones();
    const lines: string[] = [];
    for (const zone of zones) {
      for (const device of [zone.red, zone.green, zone.blue]) {
        const base = `/sys/class/leds/${device}`;
        lines.push(`echo 0 > ${shQuote(`${base}/brightness`)}`);
        lines.push(`echo led_ring_fb > ${shQuote(`${base}/trigger`)}`);
      }
    }
    const result = await adapter.exec(lines.join('\n'), { timeoutMs: 8000 });
    if (result.code !== 0) {
      throw new AccError(
        'LED_WRITE_FAILED',
        result.stderr.trim() || 'Не удалось вернуть управление LED штатному демону',
        502,
      );
    }
    eventLog.append({
      level: 'info',
      module: 'led',
      operation: 'restore',
      result: 'ok',
      message: 'Управление LED возвращено штатному триггеру led_ring_fb',
    });
    sendOk(res, { restored: true });
  }),
);

ledRouter.post(
  '/animation',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        frames: z
          .array(
            z.array(
              z.tuple([
                z.number().int().min(0).max(255),
                z.number().int().min(0).max(255),
                z.number().int().min(0).max(255),
              ]),
            ),
          )
          .min(1)
          .max(240),
        fps: z.number().int().min(1).max(60).default(4),
        repeat: z.number().int().min(1).max(100).default(2),
        loop: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_ANIMATION', 'Кадры анимации должны содержать цвета [R, G, B]', 400);
    }
    const { frames, fps, loop } = parsed.data;
    const repeat = loop ? 0 : parsed.data.repeat;
    const state = await startAnimation({ frames, fps, repeat, loop });
    const seconds = state.durationMs ? state.durationMs / 1000 : 0;
    sendOk(res, {
      started: true,
      frames: frames.length,
      fps,
      repeat,
      loop,
      durationMs: state.durationMs ?? 0,
      message: loop
        ? 'Анимация крутится, пока не нажмёте «Стоп»'
        : `Проигрываем ${repeat}× за ${seconds.toFixed(1)} с`,
    });
  }),
);

ledRouter.post(
  '/animation/stop',
  asyncRoute(async (_req, res) => {
    await stopAnimation();
    sendOk(res, { stopped: true });
  }),
);

ledRouter.get(
  '/presets',
  asyncRoute(async (_req, res) => {
    sendOk(res, { presets: loadPresets() });
  }),
);

ledRouter.post(
  '/presets',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(60),
        frames: z
          .array(
            z.array(
              z.tuple([
                z.number().int().min(0).max(255),
                z.number().int().min(0).max(255),
                z.number().int().min(0).max(255),
              ]),
            ),
          )
          .min(1)
          .max(240),
        fps: z.number().int().min(1).max(60).default(4),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_PRESET', 'Некорректный пресет', 400);
    }
    const presets = loadPresets();
    const preset: LedPreset = {
      id: newId('led'),
      name: parsed.data.name,
      frames: parsed.data.frames,
      fps: parsed.data.fps,
      createdAt: Date.now(),
    };
    presets.unshift(preset);
    savePresets(presets.slice(0, 100));
    sendOk(res, preset);
  }),
);

ledRouter.delete(
  '/presets/:id',
  asyncRoute(async (req, res) => {
    const presets = loadPresets();
    const next = presets.filter((preset) => preset.id !== req.params.id);
    if (next.length === presets.length) {
      throw new AccError('PRESET_NOT_FOUND', 'Пресет не найден', 404);
    }
    savePresets(next);
    sendOk(res, { deleted: req.params.id });
  }),
);

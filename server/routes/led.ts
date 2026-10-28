import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import type { LedPreset } from '../../shared/types.ts';
import { connectionManager } from '../connection.ts';
import { ledPresetsFile } from '../config.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import {
  allLedsOff,
  applyColors,
  describeMismatches,
  ledPowerOn,
  restoreNative,
  zonesFromCapabilities,
} from '../ledControl.ts';
import { animationStatus, startAnimation, stopAnimation } from '../ledAnimation.ts';
import { ledState } from '../ledState.ts';
import { newId } from '../util.ts';

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
        /** A channel the firmware does not expose — the ring silently ignores it. */
        missing: [zone.red, zone.green, zone.blue].filter((device) => !(device in leds)),
      })),
      animation: animationStatus(),
      power: ledState(),
      presets: loadPresets(),
    });
  }),
);

ledRouter.post(
  '/apply',
  asyncRoute(async (req, res) => {
    const colors = parseApplyBody(req.body);
    await stopAnimation({ restore: false });
    const result = await applyColors(colors);
    sendOk(res, {
      zones: result.colors,
      appliedAt: Date.now(),
      mismatches: result.mismatches,
      warning: describeMismatches(result),
    });
  }),
);

ledRouter.post(
  '/off',
  asyncRoute(async (_req, res) => {
    await stopAnimation({ restore: false });
    await allLedsOff();
    sendOk(res, { off: true });
  }),
);

/**
 * «Включить» after «Выключить». Nothing in the ring itself remembers the colours, so the panel uses
 * the ones it wrote last; with no saved colours the honest restore is the native trigger.
 */
ledRouter.post(
  '/on',
  asyncRoute(async (_req, res) => {
    await stopAnimation({ restore: false });
    const outcome = await ledPowerOn();
    sendOk(res, {
      on: true,
      mode: outcome.mode,
      warning: outcome.result ? describeMismatches(outcome.result) : undefined,
      message:
        outcome.mode === 'colors'
          ? 'LED-кольцо включено: вернул последние цвета'
          : 'LED-кольцо включено: возвращено штатной индикации Алисы',
    });
  }),
);

/** Stop an effect and put the ring back where it was instead of leaving the last frame frozen. */
ledRouter.post(
  '/reset',
  asyncRoute(async (_req, res) => {
    const wasRunning = animationStatus().running;
    await stopAnimation();
    eventLog.append({
      level: 'info',
      module: 'led',
      operation: 'reset',
      result: 'ok',
      message: wasRunning
        ? 'LED-эффект остановлен, кольцо возвращено к цвету до анимации'
        : 'LED-кольцо сброшено к сохранённому состоянию',
    });
    sendOk(res, { reset: true, stopped: wasRunning, power: ledState() });
  }),
);

ledRouter.post(
  '/restore',
  asyncRoute(async (_req, res) => {
    await stopAnimation({ restore: false });
    await restoreNative();
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

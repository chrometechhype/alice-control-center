import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import type { LedPreset } from '../../shared/types.ts';
import { connectionManager } from '../connection.ts';
import { ledPresetsFile } from '../config.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { allLedsOff, applyColors, requireZones, zonesFromCapabilities } from '../ledControl.ts';
import { newId, shQuote } from '../util.ts';

export const ledRouter = Router();

const ANIMATION_SCRIPT = '/tmp/acc-led-anim.sh';
const ANIMATION_PID = '/tmp/acc-led-anim.pid';
const ANIMATION_STOP = '/tmp/acc-led-anim.stop';

let animationTimer: NodeJS.Timeout | null = null;
let animationToken = 0;
let animationState: {
  running: boolean;
  fps?: number;
  frames?: number;
  repeat?: number;
  loop?: boolean;
  durationMs?: number;
  startedAt?: number;
} = { running: false };

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

function clearAnimationTimer(): void {
  if (animationTimer) clearTimeout(animationTimer);
  animationTimer = null;
}

async function stopAnimation(): Promise<void> {
  animationToken += 1;
  clearAnimationTimer();
  animationState = { running: false };
  const adapter = connectionManager.getAdapter();
  if (!adapter?.isConnected()) return;
  await adapter
    .exec(
      `touch ${ANIMATION_STOP}; if [ -f ${ANIMATION_PID} ]; then kill "$(cat ${ANIMATION_PID})" 2>/dev/null; fi; rm -f ${ANIMATION_PID}`,
      { timeoutMs: 6000, maxBytes: 2000 },
    )
    .catch(() => undefined);
}

function buildAnimationScript(
  zones: Array<{ red: string; green: string; blue: string }>,
  frames: number[][][],
  fps: number,
  repeat: number,
): string {
  const frameUs = Math.max(1000, Math.round(1_000_000 / fps));
  const lines: string[] = [
    '#!/bin/sh',
    `PIDFILE=${ANIMATION_PID}`,
    `STOPFILE=${ANIMATION_STOP}`,
    'echo $$ > "$PIDFILE"',
    'rm -f "$STOPFILE"',
    "trap 'rm -f \"$PIDFILE\"' EXIT",
  ];
  for (const zone of zones) {
    for (const device of [zone.red, zone.green, zone.blue]) {
      lines.push(`printf 'none\\n' > /sys/class/leds/${device}/trigger 2>/dev/null`);
    }
  }
  lines.push('play() {');
  frames.forEach((frame) => {
    lines.push('  [ -f "$STOPFILE" ] && return 1');
    zones.forEach((zone, zoneIndex) => {
      const color = frame[zoneIndex % frame.length] ?? [0, 0, 0];
      lines.push(`  printf '%s\\n' ${color[0]} > /sys/class/leds/${zone.red}/brightness`);
      lines.push(`  printf '%s\\n' ${color[1]} > /sys/class/leds/${zone.green}/brightness`);
      lines.push(`  printf '%s\\n' ${color[2]} > /sys/class/leds/${zone.blue}/brightness`);
    });
    lines.push(`  usleep ${frameUs}`);
  });
  lines.push('  return 0', '}');
  if (repeat > 0) {
    lines.push(`i=0`, `while [ "$i" -lt ${repeat} ]; do`, '  play || break', '  i=$((i+1))', 'done');
  } else {
    lines.push('while :; do', '  play || break', 'done');
  }
  lines.push('rm -f "$PIDFILE"');
  return `${lines.join('\n')}\n`;
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
    const adapter = connectionManager.requireAdapter();
    const script = [
      'for l in /sys/class/leds/*; do',
      '  n=${l##*/}',
      '  echo "$n|$(cat $l/trigger 2>/dev/null)|$(cat $l/brightness 2>/dev/null)"',
      'done',
    ].join('\n');
    const result = await adapter.exec(script, { timeoutMs: 8000, maxBytes: 60_000 });
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
      animation: animationState,
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
    const zones = requireZones();
    const adapter = connectionManager.requireAdapter();
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
    const zones = requireZones();
    const adapter = connectionManager.requireAdapter();
    const frameMs = Math.round(1000 / fps);
    const total = frames.length * (loop ? 1 : repeat);
    const durationMs = total * frameMs;

    await stopAnimation();
    const token = ++animationToken;
    const script = buildAnimationScript(zones, frames, fps, repeat);
    await adapter.writeFile(ANIMATION_SCRIPT, Buffer.from(script, 'utf8'), 0o755);
    const launch = await adapter.exec(
      `rm -f ${ANIMATION_STOP}; nohup sh ${ANIMATION_SCRIPT} </dev/null >/tmp/acc-led-anim.log 2>&1 &`,
      { timeoutMs: 8000, maxBytes: 4000 },
    );
    if (launch.code !== 0) {
      throw new AccError(
        'LED_ANIMATION_FAILED',
        launch.stderr.trim() || 'Не удалось запустить анимацию на устройстве',
        502,
      );
    }
    animationState = {
      running: true,
      fps,
      frames: frames.length,
      repeat: loop ? undefined : repeat,
      loop,
      durationMs: loop ? undefined : durationMs,
      startedAt: Date.now(),
    };
    if (!loop) {
      animationTimer = setTimeout(() => {
        animationTimer = null;
        if (token === animationToken) animationState = { running: false };
      }, durationMs + 1500);
    }
    eventLog.append({
      level: 'info',
      module: 'led',
      operation: 'animation',
      result: 'ok',
      message: loop
        ? `Анимация LED запущена без ограничения времени: ${frames.length} кадров, ${fps} fps`
        : `Анимация LED запущена на устройстве: ${frames.length} кадров, ${fps} fps`,
      details: { fps, frames: frames.length, repeat, loop, durationMs: loop ? 0 : durationMs },
    });
    sendOk(res, {
      started: true,
      frames: frames.length,
      fps,
      repeat,
      loop,
      durationMs: loop ? 0 : durationMs,
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

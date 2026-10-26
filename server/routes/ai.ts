import { Router } from 'express';
import { z } from 'zod';
import { AI_PROVIDER_PRESETS } from '../../shared/types.ts';
import { callAi } from '../ai.ts';
import { loadAiConfig } from '../config.ts';
import { eventLog } from '../events.ts';
import { AccError } from '../errors.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { requireZones } from '../ledControl.ts';

export const aiRouter = Router();

const MAX_FRAMES = 32;

function parseScene(raw: string, zones: number, prompt: string): { name: string; fps: number; frames: number[][][] } {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const objectStart = cleaned.indexOf('{');
  const objectEnd = cleaned.lastIndexOf('}');
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  let parsed: unknown;
  try {
    if (objectStart >= 0 && objectEnd > objectStart) parsed = JSON.parse(cleaned.slice(objectStart, objectEnd + 1));
    else if (arrayStart >= 0 && arrayEnd > arrayStart) parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    else throw new Error('no json');
  } catch {
    throw new AccError('AI_BAD_RESPONSE', 'ИИ вернул не JSON. Попробуйте ещё раз или смените модель.', 502);
  }
  const object = Array.isArray(parsed) ? null : (parsed as { name?: unknown; fps?: unknown; frames?: unknown });
  const candidate = Array.isArray(parsed) ? parsed : object?.frames;
  if (!Array.isArray(candidate) || candidate.length < 2) {
    throw new AccError('AI_BAD_RESPONSE', 'В ответе ИИ нет кадров анимации. Попробуйте ещё раз.', 502);
  }
  if (candidate.length > MAX_FRAMES) candidate.length = MAX_FRAMES;
  const frames: number[][][] = [];
  for (const frame of candidate) {
    if (!Array.isArray(frame)) continue;
    const colors: number[][] = [];
    for (const color of frame) {
      if (!Array.isArray(color) || color.length < 3) continue;
      colors.push(
        color.slice(0, 3).map((value) => {
          const number = Number(value);
          return Number.isFinite(number) ? Math.min(255, Math.max(0, Math.round(number))) : 0;
        }),
      );
    }
    if (colors.length) frames.push(colors);
  }
  if (frames.length < 2) {
    throw new AccError('AI_BAD_RESPONSE', 'В ответе ИИ слишком мало корректных кадров.', 502);
  }
  const normalized = frames.map((frame) =>
    Array.from({ length: zones }, (_, index) => [...(frame[index % frame.length] ?? [0, 0, 0])]),
  );
  const rawFps = Number(object?.fps);
  const fps = Number.isFinite(rawFps) ? Math.min(60, Math.max(1, Math.round(rawFps))) : 20;
  const rawName = typeof object?.name === 'string' ? object.name.trim().replace(/\s+/g, ' ') : '';
  const name = (rawName || prompt).slice(0, 48);
  return { name, fps, frames: normalized };
}

aiRouter.post(
  '/scene',
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        prompt: z.string().trim().min(2).max(240),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_PROMPT', 'Опишите сцену текстом от 2 до 240 символов', 400);
    }
    const config = loadAiConfig();
    if (!config.baseUrl.trim() || !config.model.trim()) {
      throw new AccError(
        'AI_NOT_CONFIGURED',
        'ИИ не настроен. Откройте «Настройки» → «ИИ-генератор» и выберите провайдера.',
        409,
      );
    }
    const zones = requireZones().length;
    const prompt = parsed.data.prompt;
    const messages = [
      {
        role: 'system',
        content: [
          'You are a professional LED animation designer for a smart speaker with a circular RGB light ring.',
          `The ring has ${zones} independent zones, each color is RGB 0..255.`,
          'Create a high-quality, smooth and seamless loop for the user description.',
          'Choose FPS yourself based on the effect: 6-12 for slow gradients, 15-24 for smooth flow, 30-60 for fast flicker.',
          'Return ONLY valid JSON, no markdown, in this exact shape:',
          `{"name":"short Russian name up to 32 chars","fps":18,"frames":[[[r,g,b], ...exactly ${zones} colors], ...]}`,
          'Rules: 10-24 frames, integers 0..255, harmonious palette, first frame visible,',
          'no all-black frames, smooth loop from last frame back to first, no text inside JSON.',
        ].join(' '),
      },
      {
        role: 'user',
        content: `Описание сцены: ${prompt}`,
      },
    ];
    const result = await callAi(config, messages, {
      temperature: 0.85,
      maxTokens: 3000,
      timeoutMs: 90_000,
    });
    const scene = parseScene(result.content, zones, prompt);
    const preset = AI_PROVIDER_PRESETS.find((item) => item.id === config.provider);
    eventLog.append({
      level: 'info',
      module: 'fun',
      operation: 'ai-scene',
      result: 'ok',
      message: `ИИ создал сцену: ${scene.frames.length} кадров, ${scene.fps} fps`,
      details: {
        provider: config.provider,
        providerLabel: preset?.label ?? config.provider,
        model: config.model,
        frames: scene.frames.length,
        zones,
        fps: scene.fps,
        ms: result.elapsedMs,
      },
    });
    sendOk(res, {
      name: scene.name,
      fps: scene.fps,
      frames: scene.frames,
      provider: preset?.label ?? config.provider,
      model: result.model,
      elapsedMs: result.elapsedMs,
    });
  }),
);

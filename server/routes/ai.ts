import { Router } from 'express';
import { z } from 'zod';
import { AI_PROVIDER_PRESETS } from '../../shared/types.ts';
import { callAi } from '../ai.ts';
import { loadAiConfig } from '../config.ts';
import { eventLog } from '../events.ts';
import { AccError } from '../errors.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { requireZones } from '../ledControl.ts';
import {
  buildScene,
  sceneRepairPrompt,
  sceneSystemPrompt,
  type PreparedScene,
} from '../sceneDsl.ts';

export const aiRouter = Router();

const MAX_PIXELS_PER_FRAME = 64;

function isDark(scene: PreparedScene): boolean {
  return scene.frames.every((frame) =>
    frame.every((pixel) => pixel.every((value) => value < 12)),
  );
}

function validate(scene: PreparedScene, zones: number): string | null {
  if (!scene.frames.length) return 'в сцене нет кадров';
  if (scene.frames.some((frame) => frame.length !== zones)) return `каждый кадр должен содержать ровно ${zones} зон`;
  if (scene.frames.length > MAX_PIXELS_PER_FRAME * 2) return 'слишком много кадров';
  if (isDark(scene)) return 'сцена получилась полностью тёмной, сделай ярче';
  return null;
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
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: sceneSystemPrompt(zones) },
      { role: 'user', content: `Описание сцены: ${prompt}` },
    ];

    let scene: PreparedScene | null = null;
    let failure = '';
    let elapsedMs = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let content = '';
      failure = '';
      try {
        const result = await callAi(config, messages, {
          temperature: attempt === 0 ? 0.7 : 0.2,
          maxTokens: 1600,
          timeoutMs: 75_000,
          jsonMode: true,
        });
        elapsedMs += result.elapsedMs;
        content = result.content;
      } catch (error) {
        // Reasoning models spend the whole budget on thinking and answer with an empty message.
        // That is worth one repair round instead of a hard failure.
        if (!(error instanceof AccError) || error.code !== 'AI_BAD_RESPONSE') throw error;
        failure = 'ИИ прислал пустой ответ';
      }
      try {
        scene = buildScene(content, zones, prompt);
      } catch (error) {
        failure = error instanceof AccError ? error.message : 'ИИ прислал нечитаемый ответ';
        scene = null;
      }
      const problem = scene ? validate(scene, zones) : null;
      if (scene && !problem) break;
      if (!scene && !failure) failure = 'ИИ не прислал JSON со сценой';
      if (problem) failure = problem;
      scene = null;
      messages.push(
        { role: 'assistant', content: content.slice(0, 600) },
        { role: 'user', content: sceneRepairPrompt(failure) },
      );
    }

    if (!scene) {
      throw new AccError(
        'AI_BAD_SCENE',
        `${failure || 'ИИ не смог собрать сцену'}. Модель ${config.model} не справляется — попробуйте другую или упростите описание.`,
        502,
      );
    }

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
        ms: elapsedMs,
      },
    });
    sendOk(res, {
      name: scene.name,
      fps: scene.fps,
      frames: scene.frames,
      provider: preset?.label ?? config.provider,
      model: config.model,
      elapsedMs,
    });
  }),
);

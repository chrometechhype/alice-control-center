import { Router } from 'express';
import { z } from 'zod';
import { AI_PROVIDER_PRESETS, type AiConfig } from '../../shared/types.ts';
import { callAi } from '../ai.ts';
import { connectionManager } from '../connection.ts';
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
import {
  buildScenario,
  describeStep,
  scenarioRepairPrompt,
  scenarioSystemPrompt,
  type PreparedScenario,
} from '../scenarioDsl.ts';

export const aiRouter = Router();

const MAX_PIXELS_PER_FRAME = 64;

function isDark(scene: PreparedScene): boolean {
  return scene.frames.every((frame) =>
    frame.every((pixel) => pixel.every((value) => value < 12)),
  );
}

function sceneProblem(scene: PreparedScene, zones: number): string | null {
  if (!scene.frames.length) return 'в сцене нет кадров';
  if (scene.frames.some((frame) => frame.length !== zones)) return `каждый кадр должен содержать ровно ${zones} зон`;
  if (scene.frames.length > MAX_PIXELS_PER_FRAME * 2) return 'слишком много кадров';
  if (isDark(scene)) return 'сцена получилась полностью тёмной, сделай ярче';
  return null;
}

interface Interpretation<T> {
  value: T | null;
  failure: string;
}

/**
 * One call is never enough: reasoning models answer empty, cut the JSON in half or ignore the
 * schema. So every answer is interpreted, and a rejected one buys a single repair round that quotes
 * the exact reason back to the model.
 */
async function generateWithRepair<T>(
  config: AiConfig,
  messages: Array<{ role: string; content: string }>,
  interpret: (content: string) => Interpretation<T>,
  repairPrompt: (reason: string) => string,
  failCode: string,
): Promise<{ value: T; elapsedMs: number }> {
  let elapsedMs = 0;
  let failure = 'ИИ не прислал JSON';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let content = '';
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
    const outcome = interpret(content);
    if (outcome.value) return { value: outcome.value, elapsedMs };
    failure = outcome.failure || 'ИИ не прислал JSON';
    messages.push(
      { role: 'assistant', content: content.slice(0, 600) },
      { role: 'user', content: repairPrompt(failure) },
    );
  }
  throw new AccError(
    failCode,
    `${failure}. Модель ${config.model} не справляется — попробуйте другую или упростите описание.`,
    502,
  );
}

function requireAiConfig(): AiConfig {
  const config = loadAiConfig();
  if (!config.baseUrl.trim() || !config.model.trim()) {
    throw new AccError(
      'AI_NOT_CONFIGURED',
      'ИИ не настроен. Откройте «Настройки» → «ИИ-генератор» и выберите провайдера.',
      409,
    );
  }
  return config;
}

function readPrompt(body: unknown): string {
  const parsed = z
    .object({
      prompt: z.string().trim().min(2).max(240),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success) {
    throw new AccError('BAD_PROMPT', 'Опишите запрос текстом от 2 до 240 символов', 400);
  }
  return parsed.data.prompt;
}

function providerLabel(config: AiConfig): string {
  return AI_PROVIDER_PRESETS.find((item) => item.id === config.provider)?.label ?? config.provider;
}

/**
 * The zone count lives on the station, so an offline column has to read as «колонка не подключена»
 * instead of the capability error «на этой модели не обнаружены LED-зоны».
 */
async function requireRingZones(): Promise<number> {
  await connectionManager.awaitReady(8_000);
  return requireZones().length;
}

aiRouter.post(
  '/scene',
  asyncRoute(async (req, res) => {
    const config = requireAiConfig();
    const zones = await requireRingZones();
    const prompt = readPrompt(req.body);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: sceneSystemPrompt(zones) },
      { role: 'user', content: `Описание сцены: ${prompt}` },
    ];

    const { value: scene, elapsedMs } = await generateWithRepair<PreparedScene>(
      config,
      messages,
      (content) => {
        try {
          const built = buildScene(content, zones, prompt);
          if (!built) return { value: null, failure: 'ИИ не прислал JSON со сценой' };
          const problem = sceneProblem(built, zones);
          return problem ? { value: null, failure: problem } : { value: built, failure: '' };
        } catch (error) {
          return {
            value: null,
            failure: error instanceof AccError ? error.message : 'ИИ прислал нечитаемый ответ',
          };
        }
      },
      sceneRepairPrompt,
      'AI_BAD_SCENE',
    );

    eventLog.append({
      level: 'info',
      module: 'fun',
      operation: 'ai-scene',
      result: 'ok',
      message: `ИИ создал сцену: ${scene.frames.length} кадров, ${scene.fps} fps`,
      details: {
        provider: config.provider,
        providerLabel: providerLabel(config),
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
      provider: providerLabel(config),
      model: config.model,
      elapsedMs,
    });
  }),
);

aiRouter.post(
  '/scenario',
  asyncRoute(async (req, res) => {
    const config = requireAiConfig();
    const zones = await requireRingZones();
    const prompt = readPrompt(req.body);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: scenarioSystemPrompt(zones) },
      { role: 'user', content: `Описание сценария: ${prompt}` },
    ];

    const { value: scenario, elapsedMs } = await generateWithRepair<PreparedScenario>(
      config,
      messages,
      (content) => {
        try {
          const built = buildScenario(content, prompt);
          if (!built) return { value: null, failure: 'ИИ не прислал JSON со сценарием' };
          return { value: built, failure: '' };
        } catch (error) {
          return {
            value: null,
            failure: error instanceof AccError ? error.message : 'ИИ прислал нечитаемый ответ',
          };
        }
      },
      scenarioRepairPrompt,
      'AI_BAD_SCENARIO',
    );

    eventLog.append({
      level: 'info',
      module: 'fun',
      operation: 'ai-scenario',
      result: 'ok',
      message: `ИИ создал сценарий «${scenario.name}»: ${scenario.steps.map(describeStep).join(' → ')}`,
      details: {
        provider: config.provider,
        providerLabel: providerLabel(config),
        model: config.model,
        steps: scenario.steps.length,
        ms: elapsedMs,
      },
    });
    sendOk(res, {
      name: scenario.name,
      trigger: scenario.trigger,
      steps: scenario.steps,
      provider: providerLabel(config),
      model: config.model,
      elapsedMs,
    });
  }),
);

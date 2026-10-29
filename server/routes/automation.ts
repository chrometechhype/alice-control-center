import { Router } from 'express';
import { z } from 'zod';
import type { AutomationScenario } from '../../shared/types.ts';
import { loadScenarios, runScenario, saveScenarios } from '../automation.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { stepSchema } from '../scenarioDsl.ts';
import { assertPlayableSoundPath } from '../security/paths.ts';
import { newId, routeParam } from '../util.ts';

export const automationRouter = Router();

const scenarioInput = z.object({
  name: z.string().trim().min(1, 'Укажите название сценария').max(80, 'Название длиннее 80 символов'),
  enabled: z.boolean().default(true),
  trigger: z.enum(['device.connect', 'device.disconnect', 'metrics', 'app.start'], {
    error: 'Неизвестный триггер события',
  }),
  condition: z
    .object({
      metric: z.enum(['cpuPct', 'memPct', 'tempC'], { error: 'Метрика должна быть CPU, память или температура' }),
      op: z.enum(['>', '<'], { error: 'Условие — «больше» или «меньше»' }),
      value: z.number({ error: 'Порог должен быть числом' }).min(-50, 'Порог меньше -50').max(200, 'Порог больше 200'),
    })
    .optional(),
  cooldownSec: z
    .number({ error: 'Cooldown — целое число секунд' })
    .int('Cooldown — целое число секунд')
    .min(5, 'Cooldown короче 5 секунд не имеет смысла')
    .max(86_400, 'Cooldown длиннее суток')
    .default(60),
  steps: z.array(stepSchema).min(1, 'В сценарии нет шагов').max(32, 'В сценарии не больше 32 шагов'),
});

function validateSteps(steps: AutomationScenario['steps']): void {
  steps.forEach((step, index) => {
    if (step.kind === 'sound') assertPlayableSoundPath(step.path);
    if (step.parallelWith == null) return;
    if (step.parallelWith < 1 || step.parallelWith >= index + 1) {
      throw new AccError(
        'BAD_PARALLEL_STEP',
        `Шаг ${index + 1}: одновременно можно стартовать только с предыдущим шагом (1–${index})`,
        400,
      );
    }
  });
}

automationRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    sendOk(res, {
      scenarios: loadScenarios(),
      triggers: [
        { value: 'device.connect', label: 'Устройство подключено' },
        { value: 'device.disconnect', label: 'Устройство отключено' },
        { value: 'metrics', label: 'Показатель метрик' },
        { value: 'app.start', label: 'Запуск ACC' },
      ],
    });
  }),
);

automationRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const parsed = scenarioInput.safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_SCENARIO', `Сценарий не подходит: ${parsed.error.issues[0]?.message ?? 'проверьте шаги'}`, 400);
    }
    if (parsed.data.trigger === 'metrics' && !parsed.data.condition) {
      throw new AccError('CONDITION_REQUIRED', 'Для триггера по метрикам нужно условие', 400);
    }
    validateSteps(parsed.data.steps);
    const scenario: AutomationScenario = {
      id: newId('scn'),
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      trigger: parsed.data.trigger,
      condition: parsed.data.condition,
      cooldownSec: parsed.data.cooldownSec,
      steps: parsed.data.steps,
    };
    const scenarios = loadScenarios();
    if (scenarios.length >= 50) {
      throw new AccError('TOO_MANY_SCENARIOS', 'Достигнут лимит в 50 сценариев', 400);
    }
    scenarios.unshift(scenario);
    saveScenarios(scenarios);
    eventLog.append({
      level: 'info',
      module: 'automation',
      operation: 'create',
      result: 'ok',
      message: `Создан сценарий «${scenario.name}»`,
      details: { scenarioId: scenario.id },
    });
    sendOk(res, scenario);
  }),
);

automationRouter.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const parsed = scenarioInput.safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('BAD_SCENARIO', `Сценарий не подходит: ${parsed.error.issues[0]?.message ?? 'проверьте шаги'}`, 400);
    }
    const scenarios = loadScenarios();
    const index = scenarios.findIndex((scenario) => scenario.id === routeParam(req.params.id));
    if (index < 0) throw new AccError('SCENARIO_NOT_FOUND', 'Сценарий не найден', 404);
    validateSteps(parsed.data.steps);
    const previous = scenarios[index];
    scenarios[index] = {
      ...previous,
      ...parsed.data,
      id: previous.id,
      lastRunAt: previous.lastRunAt,
      lastResult: previous.lastResult,
    };
    saveScenarios(scenarios);
    sendOk(res, scenarios[index]);
  }),
);

automationRouter.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const scenarios = loadScenarios();
    const next = scenarios.filter((scenario) => scenario.id !== routeParam(req.params.id));
    if (next.length === scenarios.length) {
      throw new AccError('SCENARIO_NOT_FOUND', 'Сценарий не найден', 404);
    }
    saveScenarios(next);
    sendOk(res, { deleted: routeParam(req.params.id) });
  }),
);

automationRouter.post(
  '/:id/run',
  asyncRoute(async (req, res) => {
    const scenario = await runScenario(routeParam(req.params.id), 'manual');
    sendOk(res, scenario);
  }),
);

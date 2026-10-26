import { Router } from 'express';
import { z } from 'zod';
import type { AutomationScenario } from '../../shared/types.ts';
import { loadScenarios, runScenario, saveScenarios } from '../automation.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { newId, routeParam } from '../util.ts';

export const automationRouter = Router();

const scenarioInput = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  trigger: z.enum(['device.connect', 'device.disconnect', 'metrics', 'app.start']),
  condition: z
    .object({
      metric: z.enum(['cpuPct', 'memPct', 'tempC']),
      op: z.enum(['>', '<']),
      value: z.number().min(-50).max(200),
    })
    .optional(),
  cooldownSec: z.number().int().min(5).max(86_400).default(60),
  action: z.object({
    type: z.enum(['notify', 'diagnostic', 'ledPreset']),
    value: z.string().max(120).optional(),
  }),
});

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
    if (!parsed.success) throw new AccError('BAD_SCENARIO', 'Некорректный сценарий', 400);
    if (parsed.data.trigger === 'metrics' && !parsed.data.condition) {
      throw new AccError('CONDITION_REQUIRED', 'Для триггера по метрикам нужно условие', 400);
    }
    if (parsed.data.action.type === 'ledPreset' && !parsed.data.action.value) {
      throw new AccError('PRESET_REQUIRED', 'Выберите LED-пресет', 400);
    }
    const scenario: AutomationScenario = {
      id: newId('scn'),
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      trigger: parsed.data.trigger,
      condition: parsed.data.condition,
      cooldownSec: parsed.data.cooldownSec,
      action: parsed.data.action,
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
    if (!parsed.success) throw new AccError('BAD_SCENARIO', 'Некорректный сценарий', 400);
    const scenarios = loadScenarios();
    const index = scenarios.findIndex((scenario) => scenario.id === routeParam(req.params.id));
    if (index < 0) throw new AccError('SCENARIO_NOT_FOUND', 'Сценарий не найден', 404);
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

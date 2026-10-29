import { Router } from 'express';
import { z } from 'zod';
import {
  AUTOMATION_METRICS,
  SCENARIO_TRIGGERS,
  type AutomationCondition,
  type AutomationScenario,
  type ScenarioTriggerConfig,
  type ScenarioTriggerType,
} from '../../shared/types.ts';
import { loadScenarios, runScenario, saveScenarios } from '../automation.ts';
import { AccError } from '../errors.ts';
import { eventLog } from '../events.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { stepSchema } from '../scenarioDsl.ts';
import { assertPlayableSoundPath } from '../security/paths.ts';
import { newId, routeParam } from '../util.ts';

export const automationRouter = Router();

const conditionSchema = z.object({
  metric: z.enum(AUTOMATION_METRICS, { error: 'Неизвестная метрика' }),
  op: z.enum(['>', '<'], { error: 'Условие — «больше» или «меньше»' }),
  value: z.number({ error: 'Порог должен быть числом' }).min(-500, 'Порог меньше -500').max(500, 'Порог больше 500'),
});

const triggerConfigSchema = z
  .object({
    condition: conditionSchema.optional(),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время должно быть в формате ЧЧ:ММ')
      .optional(),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7, 'В неделе семь дней').optional(),
    everyMinutes: z.number().int('Интервал — целое число минут').min(1, 'Интервал короче минуты').max(1440, 'Интервал длиннее суток').optional(),
    volume: z
      .object({
        op: z.enum(['>', '<']),
        percent: z.number().int('Громкость — целое число').min(0, 'Громкость ниже 0%').max(100, 'Громкость выше 100%'),
      })
      .optional(),
    wifi: z
      .object({
        event: z.enum(['connected', 'disconnected', 'changed']),
        ssid: z.string().trim().max(64, 'SSID длиннее 64 символов').optional(),
      })
      .optional(),
    bluetooth: z
      .object({
        event: z.enum(['connected', 'disconnected']),
        match: z.string().trim().max(64, 'Имя или MAC длиннее 64 символов').optional(),
      })
      .optional(),
    scenarioId: z.string().trim().max(40).optional(),
    onSuccessOnly: z.boolean().optional(),
  })
  .strict();

const scenarioInput = z.object({
  name: z.string().trim().min(1, 'Укажите название сценария').max(80, 'Название длиннее 80 символов'),
  enabled: z.boolean().default(true),
  trigger: z.enum(SCENARIO_TRIGGERS, { error: 'Неизвестный триггер события' }),
  triggerConfig: triggerConfigSchema.optional(),
  // Scenarios created by older builds send the metric threshold here.
  condition: conditionSchema.optional(),
  cooldownSec: z
    .number({ error: 'Cooldown — целое число секунд' })
    .int('Cooldown — целое число секунд')
    .min(5, 'Cooldown короче 5 секунд не имеет смысла')
    .max(86_400, 'Cooldown длиннее суток')
    .default(60),
  steps: z.array(stepSchema).min(1, 'В сценарии нет шагов').max(32, 'В сценарии не больше 32 шагов'),
});

const TRIGGER_CATALOG: Array<{ value: ScenarioTriggerType; label: string; group: string; hint: string }> = [
  {
    value: 'manual',
    label: 'Только вручную',
    group: 'Ручной запуск',
    hint: 'Ничего не запускает само — сценарий работает по кнопке «Запустить» или из терминала.',
  },
  {
    value: 'app.start',
    label: 'Запуск панели',
    group: 'Панель',
    hint: 'Сразу после старта ACC. Сценарии с шагами на станции ждут подключения, а не падают.',
  },
  {
    value: 'update.available',
    label: 'Вышло обновление',
    group: 'Панель',
    hint: 'Когда проверка обновлений впервые увидела новую версию — один раз, а не каждый опрос.',
  },
  {
    value: 'device.connect',
    label: 'Станция подключилась',
    group: 'Станция',
    hint: 'Появилось SSH-соединение: после старта панели, переподключения или возврата станции в сеть.',
  },
  {
    value: 'device.disconnect',
    label: 'Станция отключилась',
    group: 'Станция',
    hint: 'Соединение со станцией пропало. Сценарий выполнится, когда связь ещё недоступна, — шаги на станции отвалятся.',
  },
  {
    value: 'station.reboot',
    label: 'Станция перезагрузилась',
    group: 'Станция',
    hint: 'Uptime станции уменьшился — колонка действительно перезагрузилась, а не просто моргнула сеть.',
  },
  {
    value: 'metrics',
    label: 'Порог метрики',
    group: 'Показатели',
    hint: 'CPU, память, температура, свободное место в /data, load average или уровень Wi-Fi.',
  },
  {
    value: 'volume',
    label: 'Громкость пересекла порог',
    group: 'Показатели',
    hint: 'Срабатывает на переходе через порог, а не каждый опрос: «стало громче 80%» или «тише 20%».',
  },
  {
    value: 'wifi',
    label: 'Wi-Fi сеть',
    group: 'Сеть',
    hint: 'Станция подключилась к сети, потеряла её или переключилась на другую. SSID можно оставить пустым.',
  },
  {
    value: 'bluetooth',
    label: 'Bluetooth-устройство',
    group: 'Сеть',
    hint: 'К станции подключилось или отключилось устройство. Совпадение по MAC или имени, пусто — любое.',
  },
  {
    value: 'schedule',
    label: 'Расписание',
    group: 'Время',
    hint: 'Определённое время и дни недели по часам панели. Одна минута — один запуск.',
  },
  {
    value: 'interval',
    label: 'Каждый интервал',
    group: 'Время',
    hint: 'Повторяется каждые N минут, пока панель запущена. Отсчёт начинается при запуске, а не с прошлого выполнения.',
  },
  {
    value: 'scenario.done',
    label: 'После другого сценария',
    group: 'Сценарии',
    hint: 'Цепочка: запускается, когда выбранный сценарий завершился. Глубина цепочки ограничена четырьмя.',
  },
];

function normalizeTrigger(
  trigger: ScenarioTriggerType,
  config: ScenarioTriggerConfig | undefined,
  legacy: AutomationCondition | undefined,
): { triggerConfig?: ScenarioTriggerConfig; condition?: AutomationCondition } {
  if (trigger !== 'metrics') return { triggerConfig: config };
  const condition = config?.condition ?? legacy;
  return { condition, triggerConfig: { ...config, condition } };
}

function validateTrigger(
  trigger: ScenarioTriggerType,
  config: ScenarioTriggerConfig | undefined,
  scenarioId: string | null,
): void {
  const require = (present: unknown, message: string): void => {
    if (!present) throw new AccError('TRIGGER_CONFIG_REQUIRED', message, 400);
  };
  switch (trigger) {
    case 'metrics':
      require(config?.condition, 'Для порога метрики нужно выбрать метрику и значение');
      return;
    case 'schedule':
      require(config?.time, 'Для расписания укажите время ЧЧ:ММ');
      require(config?.weekdays?.length, 'Выберите хотя бы один день недели');
      return;
    case 'interval':
      require(config?.everyMinutes, 'Для интервала укажите число минут');
      return;
    case 'volume':
      require(config?.volume, 'Укажите порог громкости');
      return;
    case 'wifi':
      require(config?.wifi, 'Укажите событие Wi-Fi');
      return;
    case 'bluetooth':
      require(config?.bluetooth, 'Укажите событие Bluetooth');
      return;
    case 'scenario.done': {
      require(config?.scenarioId, 'Выберите сценарий, после которого запускаться');
      if (config?.scenarioId === scenarioId) {
        throw new AccError('TRIGGER_CONFIG_INVALID', 'Сценарий не может запускать сам себя', 400);
      }
      const chain = loadScenarios();
      if (!chain.some((scenario) => scenario.id === config?.scenarioId)) {
        throw new AccError('TRIGGER_CONFIG_INVALID', 'Сценарий-предшественник не найден', 400);
      }
      // Two scenarios waiting on each other would keep handing the baton back and forth.
      let cursor = chain.find((scenario) => scenario.id === config?.scenarioId);
      for (let hop = 0; hop < 16 && cursor?.trigger === 'scenario.done'; hop += 1) {
        if (cursor.triggerConfig?.scenarioId === scenarioId) {
          throw new AccError('TRIGGER_CONFIG_INVALID', 'Получилась замкнутая цепочка сценариев', 400);
        }
        const nextId = cursor.triggerConfig?.scenarioId;
        cursor = chain.find((scenario) => scenario.id === nextId);
      }
      return;
    }
    default:
      return;
  }
}

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
      triggers: TRIGGER_CATALOG,
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
    if (parsed.data.trigger === 'metrics' && !parsed.data.condition && !parsed.data.triggerConfig?.condition) {
      throw new AccError('CONDITION_REQUIRED', 'Для триггера по метрикам нужно условие', 400);
    }
    validateTrigger(parsed.data.trigger, parsed.data.triggerConfig, null);
    validateSteps(parsed.data.steps);
    const { triggerConfig, condition } = normalizeTrigger(
      parsed.data.trigger,
      parsed.data.triggerConfig,
      parsed.data.condition,
    );
    const scenario: AutomationScenario = {
      id: newId('scn'),
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      trigger: parsed.data.trigger,
      triggerConfig,
      condition,
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
    const previous = scenarios[index];
    if (parsed.data.trigger === 'metrics' && !parsed.data.condition && !parsed.data.triggerConfig?.condition) {
      throw new AccError('CONDITION_REQUIRED', 'Для триггера по метрикам нужно условие', 400);
    }
    validateTrigger(parsed.data.trigger, parsed.data.triggerConfig, previous.id);
    validateSteps(parsed.data.steps);
    const { triggerConfig, condition } = normalizeTrigger(
      parsed.data.trigger,
      parsed.data.triggerConfig,
      parsed.data.condition,
    );
    scenarios[index] = {
      id: previous.id,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      trigger: parsed.data.trigger,
      triggerConfig,
      condition,
      cooldownSec: parsed.data.cooldownSec,
      steps: parsed.data.steps,
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

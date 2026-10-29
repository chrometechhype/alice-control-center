import { z } from 'zod';
import { SCENE_EFFECTS, type ScenarioStep, type ScenarioTriggerType } from '../shared/types.ts';
import { AccError } from './errors.ts';
import { extractJsonObject, parseSceneIntent } from './sceneDsl.ts';

/**
 * A scenario is a short script the station performs: lights move, Alice speaks, the journal gets a
 * line. The model only writes the script — the panel expands LED recipes into pixels at run time, so
 * the same scenario looks right on a ring with any number of zones.
 */

const HEX = /^#?[0-9a-f]{3}$|^#?[0-9a-f]{6}$/i;

const EFFECT_NAMES = SCENE_EFFECTS.join(', ');

const sayStep = z.object({
  kind: z.literal('say'),
  text: z.string().trim().min(1, 'Текст озвучки не может быть пустым').max(2000, 'Фраза длиннее 2000 символов'),
});
const soundStep = z.object({
  kind: z.literal('sound'),
  path: z.string().trim().min(1, 'Нужен путь к звуку на станции').max(500, 'Путь длиннее 500 символов'),
});
const ledStep = z.object({
  kind: z.literal('led'),
  effect: z.enum(SCENE_EFFECTS, { error: `Движение кольца должно быть одним из: ${EFFECT_NAMES}` }),
  colors: z
    .array(z.string().trim().regex(HEX, 'Нужен HEX вроде #ff2d2d'))
    .min(1, 'Укажите хотя бы один цвет')
    .max(6, 'Хватит и шести цветов'),
  fps: z.number({ error: 'Кадров в секунду — число' }).finite().int('Кадров в секунду — целое число').min(1, 'Минимум 1 fps').max(60, 'Максимум 60 fps'),
  seconds: z
    .number({ error: 'Длительность — число в секундах' })
    .finite()
    .min(0.2, 'Шаг короче 0,2 секунды не выйдет')
    .max(120, 'Шаг длиннее двух минут — это не анимация'),
  intensity: z.number({ error: 'Яркость — число' }).finite().min(0.1, 'Яркость меньше 0,1').max(1, 'Яркость больше 1').default(0.9),
  reverse: z.boolean().default(false),
});
const pauseStep = z.object({
  kind: z.literal('pause'),
  seconds: z
    .number({ error: 'Пауза — число в секундах' })
    .finite()
    .min(0.1, 'Пауза короче 0,1 секунды')
    .max(120, 'Пауза длиннее двух минут'),
});
const notifyStep = z.object({
  kind: z.literal('notify'),
  text: z.string().trim().min(1, 'Что записать в журнал?').max(200, 'Строка в журнале длиннее 200 символов'),
});
const diagnosticStep = z.object({ kind: z.literal('diagnostic') });

const parallelWith = z
  .number({ error: 'Номер шага для одновременного запуска — число' })
  .int('Номер шага для одновременного запуска — целое число')
  .min(1, 'Номер шага начинается с 1')
  .max(32, 'В сценарии не больше 32 шагов')
  .optional();

/** Everything the editor and the API accept. */
export const stepSchema = z.discriminatedUnion('kind', [
  sayStep.extend({ parallelWith }),
  soundStep.extend({ parallelWith }),
  ledStep.extend({ parallelWith }),
  pauseStep.extend({ parallelWith }),
  notifyStep.extend({ parallelWith }),
  diagnosticStep.extend({ parallelWith }),
], { error: 'Шаг должен быть одного типа: say, sound, led, pause, notify или diagnostic' });

/** A ring show and its sound are one signal, so the model has to be able to say "start together". */
const generatedStepSchema = z.discriminatedUnion('kind', [
  sayStep.extend({ parallelWith }),
  ledStep.extend({ parallelWith }),
  pauseStep.extend({ parallelWith }),
  notifyStep.extend({ parallelWith }),
], {
  error: `ИИ может предлагать только шаги say, led, pause и notify`,
});

/** Triggers that need no extra parameters, so the model can pick them without inventing settings. */
export const AI_TRIGGERS = [
  'manual',
  'app.start',
  'device.connect',
  'device.disconnect',
  'station.reboot',
  'update.available',
] as const;

const RawScenarioSchema = z.object({
  name: z.string().trim().min(1, 'Название не может быть пустым').max(60, 'Название длиннее 60 символов'),
  /** Absent when the description names no moment — the editor then keeps its own choice. */
  trigger: z.enum(AI_TRIGGERS, { error: 'Такой триггер ИИ выбирать не может' }).optional(),
  steps: z.array(generatedStepSchema).min(1, 'В сценарии нет шагов').max(6, 'Больше шести шагов ИИ не выдаёт'),
});

export const SCENARIO_EXAMPLE =
  '{"name":"Авария","trigger":"device.connect","steps":[{"kind":"led","effect":"pulse","colors":["#ff2d2d"],"fps":26,"seconds":4},{"kind":"say","text":"Авария. Ошибка системы.","parallelWith":1}]}';

export function scenarioSystemPrompt(zones: number): string {
  return [
    'You write short automation scripts for a smart speaker and answer with ONE JSON object only.',
    `The speaker has a light ring with ${zones} zones and can talk through text-to-speech.`,
    'Exact JSON shape (no markdown, no comments, no extra keys):',
    SCENARIO_EXAMPLE,
    'Hard rules — a violated rule means the answer is wrong even if it looks reasonable:',
    '- The user description is the brief. Every colour, motion, tempo and spoken word in it must appear in your script.',
    '- "мигает/пульсирует" -> led effect "pulse". "бежит/крутится" -> "sweep". "дышит" -> "breathe". "искрит" -> "sparkle". "волны" -> "ripple". "ровно горит" -> "solid". "градиент/переливается" -> "gradient".',
    `led "effect" values you may use: ${SCENE_EFFECTS.join(', ')}. Nothing else.`,
    '- "say" is what the speaker says out loud. If the user writes the words («алиса говорит "ошибка"»), use exactly those words, repeated as many times as the user asked. Keep one say step under 200 characters.',
    '- Write "say" the way a person should be heard: capital start, commas between repeated words, a period at the end («Ошибка, ошибка, ошибка.»). Do not change the words themselves.',
    '- "notify" writes a line into the panel journal and is never spoken. Use it only when the user says «запиши в журнал», «уведоми» or «сообщи в журнал»; the words to be heard go in "say".',
    '- "parallelWith" is the 1-based number of an EARLIER step that must start in the same moment. A ring show and the words/sound that belong to it are one signal: put the led step first and give the say step "parallelWith" pointing at it, otherwise the words wait until the whole show is over. Use a plain sequence (no parallelWith) only when the user says "сначала … потом …".',
    '- A step order is the timeline. Use "pause" between steps only when the user asks for a pause.',
    '- Never use "sound" or "diagnostic": the user can only add those by hand.',
    '- led "colors" is 1..6 HEX strings like "#ff2d2d". "fps" is 4..40, "seconds" is 0.5..20 for the whole show.',
    '- "trigger" is optional and only from this list: ' +
      `${AI_TRIGGERS.join(', ')}. ` +
      'Set it only when the description names the moment: «когда колонка подключилась» -> device.connect, «пропала связь» -> device.disconnect, «при запуске панели» -> app.start, «вышло обновление» -> update.available, «колонка перезагрузилась» -> station.reboot, «по кнопке/вручную» -> manual. If the description names no moment, omit "trigger" entirely — never invent a schedule, metric or time.',
    '- Do not add steps the user did not ask for. Do not explain anything.',
    '- The example only shows the shape; write your own name, steps and values.',
    'Before answering, check silently: one object, keys only from the schema, "parallelWith" numbers lower than their own step, "colors" lowercase HEX with "#", "fps" and "seconds" inside the limits.',
    'Answer with JSON only. No markdown fences, no text before or after. Your very first character must be "{" and your very last must be "}".',
  ].join('\n');
}

export function scenarioRepairPrompt(reason: string): string {
  return [
    `Твой предыдущий ответ не подошёл: ${reason}`,
    'Ответь ровно одним JSON-объектом со скриптом, без пояснений.',
    SCENARIO_EXAMPLE,
  ].join('\n');
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'сценарий'}: ${issue.message}` : 'неизвестная ошибка';
}

/**
 * Words the person typed win over the model wherever they are decisive, exactly like in the scene
 * generator. Applied only to a single LED step: «сначала красным, потом зелёным» is already a plan
 * the model was told to follow, and one global colour would ruin it.
 */
function obeyIntent(steps: ScenarioStep[], prompt: string): ScenarioStep[] {
  const ledSteps = steps.filter((step) => step.kind === 'led');
  if (ledSteps.length !== 1) return steps;
  const intent = parseSceneIntent(prompt);
  if (!intent.colors.length && !intent.effect && !intent.speed) return steps;
  return steps.map((step) =>
    step.kind !== 'led'
      ? step
      : {
          ...step,
          colors: intent.colors.length ? intent.colors : step.colors,
          effect: intent.effect ?? step.effect,
          fps: intent.speed === 'fast' ? Math.max(step.fps, 24) : intent.speed === 'slow' ? Math.min(step.fps, 8) : step.fps,
        },
  );
}

export interface PreparedScenario {
  name: string;
  /** Absent when the model named no moment; the editor keeps its own trigger then. */
  trigger?: ScenarioTriggerType;
  steps: ScenarioStep[];
}

/** A link may only point at a step that already exists, otherwise it would start in the past. */
function fixParallelLinks<T extends { parallelWith?: number }>(steps: T[]): T[] {
  return steps.map((step, index) =>
    step.parallelWith != null && (step.parallelWith < 1 || step.parallelWith > index)
      ? { ...step, parallelWith: undefined }
      : step,
  );
}

/** Returns null when the answer holds no object at all, so the caller can retry with a correction. */
export function buildScenario(raw: string, prompt: string): PreparedScenario | null {
  const object = extractJsonObject(raw);
  if (!object) return null;
  const parsed = RawScenarioSchema.safeParse(object);
  if (!parsed.success) {
    throw new AccError(
      'AI_BAD_SCENARIO',
      `ИИ прислал сценарий не по схеме — ${describeIssue(parsed.error)}`,
      502,
    );
  }
  const name = parsed.data.name.slice(0, 60);
  const steps: ScenarioStep[] = parsed.data.steps.map((step) =>
    step.kind === 'led' ? { ...step, seconds: Math.min(20, step.seconds) } : step,
  );
  const trigger: ScenarioTriggerType | undefined = parsed.data.trigger;
  return { name, trigger, steps: fixParallelLinks(obeyIntent(steps, prompt)) };
}

/** Human-readable one-liner for the UI and the journal. */
export function describeStep(step: ScenarioStep): string {
  switch (step.kind) {
    case 'say':
      return `Сказать «${step.text}»`;
    case 'sound':
      return `Играть ${step.path.split('/').pop() ?? step.path}`;
    case 'led':
      return `Кольцо: ${step.effect}, ${step.seconds} с`;
    case 'pause':
      return `Пауза ${step.seconds} с`;
    case 'notify':
      return `В журнал: ${step.text}`;
    case 'diagnostic':
      return 'Собрать диагностику';
    default:
      return 'Шаг';
  }
}

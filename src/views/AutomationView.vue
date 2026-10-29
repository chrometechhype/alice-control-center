<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  AudioLines,
  Bell,
  Check,
  Clock,
  Info,
  Lightbulb,
  LoaderCircle,
  Mic,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Timer,
  Trash2,
  Workflow,
  X,
  Zap,
} from '@lucide/vue';
import type {
  AutomationCondition,
  AutomationMetric,
  AutomationScenario,
  SceneEffect,
  ScenarioStep,
  ScenarioStepKind,
  ScenarioTriggerConfig,
  ScenarioTriggerType,
  SoundFile,
} from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import OfflineState from '@/components/OfflineState.vue';
import { api, errorMessage } from '@/lib/api';
import { formatRelative, pluralRu } from '@/lib/format';
import { everConnected, isConnected, pushToast } from '@/lib/store';

interface TriggerInfo {
  value: ScenarioTriggerType;
  label: string;
  group: string;
  hint: string;
}

/** Flat so every field can be v-model'd; turned into a real step on save. */
interface StepDraft {
  kind: ScenarioStepKind;
  text: string;
  path: string;
  effect: SceneEffect;
  colors: string;
  fps: number;
  seconds: number;
  /** 1-based number of an earlier step to start in the same tick. */
  parallelWith: number | null;
}

const MAX_STEPS = 32;

/** Every trigger's parameters live side by side, so switching the trigger keeps what was typed. */
interface FormState {
  name: string;
  enabled: boolean;
  trigger: ScenarioTriggerType;
  cooldownSec: number;
  steps: StepDraft[];
  metric: AutomationMetric;
  op: AutomationCondition['op'];
  value: number;
  time: string;
  weekdays: number[];
  everyMinutes: number;
  volumeOp: AutomationCondition['op'];
  volumePercent: number;
  wifiEvent: NonNullable<ScenarioTriggerConfig['wifi']>['event'];
  wifiSsid: string;
  bluetoothEvent: NonNullable<ScenarioTriggerConfig['bluetooth']>['event'];
  bluetoothMatch: string;
  chainId: string;
  chainSuccessOnly: boolean;
}

const WEEKDAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 7, label: 'Вс' },
];

const METRICS: Array<{ value: AutomationMetric; label: string; unit: string }> = [
  { value: 'cpuPct', label: 'CPU', unit: '%' },
  { value: 'memPct', label: 'Память', unit: '%' },
  { value: 'tempC', label: 'Температура', unit: '°C' },
  { value: 'dataFreePct', label: 'Свободно в /data', unit: '%' },
  { value: 'load1', label: 'Load average', unit: '' },
  { value: 'wifiRssi', label: 'Уровень Wi-Fi', unit: 'дБм' },
];

const WIFI_EVENTS: Array<{ value: NonNullable<ScenarioTriggerConfig['wifi']>['event']; label: string }> = [
  { value: 'connected', label: 'подключилась к сети' },
  { value: 'disconnected', label: 'потеряла сеть' },
  { value: 'changed', label: 'переключилась на другую сеть' },
];

const BLUETOOTH_EVENTS: Array<{ value: NonNullable<ScenarioTriggerConfig['bluetooth']>['event']; label: string }> = [
  { value: 'connected', label: 'устройство подключилось' },
  { value: 'disconnected', label: 'устройство отключилось' },
];

const EFFECTS: Array<{ value: SceneEffect; label: string }> = [
  { value: 'pulse', label: 'мигает целиком' },
  { value: 'breathe', label: 'дышит двумя цветами' },
  { value: 'sweep', label: 'бежит по кругу' },
  { value: 'chase', label: 'одна точка бежит' },
  { value: 'sparkle', label: 'искрит' },
  { value: 'ripple', label: 'волны' },
  { value: 'gradient', label: 'градиент стоит' },
  { value: 'solid', label: 'горит ровно' },
];

const STEP_KINDS: Array<{ value: ScenarioStepKind; label: string }> = [
  { value: 'led', label: 'Кольцо' },
  { value: 'say', label: 'Сказать текстом' },
  { value: 'sound', label: 'Играть звук' },
  { value: 'pause', label: 'Пауза' },
  { value: 'notify', label: 'Запись в журнал' },
  { value: 'diagnostic', label: 'Собрать диагностику' },
];

const STEP_ICONS: Record<ScenarioStepKind, typeof Activity> = {
  led: Lightbulb,
  say: Mic,
  sound: AudioLines,
  pause: Timer,
  notify: Bell,
  diagnostic: Activity,
};

const scenarios = ref<AutomationScenario[]>([]);
const triggers = ref<TriggerInfo[]>([]);
const sounds = ref<SoundFile[]>([]);
const loading = ref(false);
const error = ref('');
const runningId = ref('');
const deleteTarget = ref<AutomationScenario | null>(null);
const deleting = ref(false);

const modalOpen = ref(false);
const editingId = ref('');
const saving = ref(false);
const formError = ref('');
const aiPrompt = ref('');
const generating = ref(false);

const form = reactive<FormState>({
  name: '',
  enabled: true,
  trigger: 'device.connect',
  cooldownSec: 60,
  steps: [],
  metric: 'cpuPct',
  op: '>',
  value: 80,
  time: '08:00',
  weekdays: [1, 2, 3, 4, 5],
  everyMinutes: 60,
  volumeOp: '>',
  volumePercent: 80,
  wifiEvent: 'disconnected',
  wifiSsid: '',
  bluetoothEvent: 'connected',
  bluetoothMatch: '',
  chainId: '',
  chainSuccessOnly: false,
});

const enabledCount = computed(() => scenarios.value.filter((scenario) => scenario.enabled).length);
const stepCount = computed(() => scenarios.value.reduce((total, scenario) => total + scenario.steps.length, 0));
const lastRun = computed(() => {
  const stamps = scenarios.value.map((scenario) => scenario.lastRunAt ?? 0).filter(Boolean);
  return stamps.length ? Math.max(...stamps) : null;
});

const triggerLabels = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {};
  for (const item of triggers.value) result[item.value] = item.label;
  return result;
});

/** The dropdown is long, so the options are grouped: Панель, Станция, Показатели, Сеть, Время… */
const triggerGroups = computed(() => {
  const groups = new Map<string, TriggerInfo[]>();
  for (const item of triggers.value) {
    const list = groups.get(item.group);
    if (list) list.push(item);
    else groups.set(item.group, [item]);
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
});

const activeTriggerHint = computed(
  () => triggers.value.find((item) => item.value === form.trigger)?.hint ?? '',
);

/** A scenario can only chain to a scenario that already exists and is not itself. */
const chainOptions = computed(() =>
  scenarios.value.filter((scenario) => scenario.id !== editingId.value),
);

function toggleWeekday(day: number, checked: boolean): void {
  const rest = form.weekdays.filter((item) => item !== day);
  form.weekdays = checked ? [...rest, day].sort((left, right) => left - right) : rest;
}

function emptyStep(kind: ScenarioStepKind): StepDraft {
  return {
    kind,
    text: '',
    path: '',
    effect: 'pulse',
    colors: '#ff2d2d',
    fps: 16,
    seconds: kind === 'pause' ? 1 : 4,
    parallelWith: null,
  };
}

function stepToDraft(step: ScenarioStep): StepDraft {
  switch (step.kind) {
    case 'led':
      return {
        ...emptyStep('led'),
        effect: step.effect,
        colors: step.colors.join(' '),
        fps: step.fps,
        seconds: step.seconds,
        parallelWith: step.parallelWith ?? null,
      };
    case 'say':
      return { ...emptyStep('say'), text: step.text, parallelWith: step.parallelWith ?? null };
    case 'sound':
      return { ...emptyStep('sound'), path: step.path, parallelWith: step.parallelWith ?? null };
    case 'pause':
      return { ...emptyStep('pause'), seconds: step.seconds, parallelWith: step.parallelWith ?? null };
    case 'notify':
      return { ...emptyStep('notify'), text: step.text, parallelWith: step.parallelWith ?? null };
    default:
      return { ...emptyStep('diagnostic'), parallelWith: step.parallelWith ?? null };
  }
}

function draftToStep(draft: StepDraft, index?: number): ScenarioStep {
  const step = stepBody(draft);
  // A step may only start together with an earlier step; the number is 1-based in the UI.
  const link = draft.parallelWith;
  if (index == null || link == null || link < 1 || link > index) return step;
  return { ...step, parallelWith: link };
}

function stepBody(draft: StepDraft): ScenarioStep {
  switch (draft.kind) {
    case 'led':
      return {
        kind: 'led',
        effect: draft.effect,
        colors: draft.colors.trim().split(/[\s,]+/).filter(Boolean).slice(0, 6),
        fps: Math.min(60, Math.max(1, Math.round(Number(draft.fps) || 16))),
        seconds: Math.min(120, Math.max(0.2, Number(draft.seconds) || 4)),
      };
    case 'say':
      return { kind: 'say', text: draft.text.trim().slice(0, 300) };
    case 'sound':
      return { kind: 'sound', path: draft.path };
    case 'pause':
      return { kind: 'pause', seconds: Math.min(120, Math.max(0.1, Number(draft.seconds) || 1)) };
    case 'notify':
      return { kind: 'notify', text: draft.text.trim().slice(0, 200) || 'событие' };
    default:
      return { kind: 'diagnostic' };
  }
}

function stepText(step: ScenarioStep): string {
  switch (step.kind) {
    case 'led':
      return `${EFFECTS.find((item) => item.value === step.effect)?.label ?? step.effect} · ${step.colors.join(' ')} · ${step.seconds} с`;
    case 'say':
      return `«${step.text}»`;
    case 'sound':
      return sounds.value.find((item) => item.path === step.path)?.name ?? step.path.split('/').pop() ?? 'звук';
    case 'pause':
      return `пауза ${step.seconds} с`;
    case 'notify':
      return step.text;
    default:
      return 'диагностика';
  }
}

function stepSummary(draft: StepDraft): string {
  const link = draft.parallelWith ? `⇉ одновременно с шагом ${draft.parallelWith} · ` : '';
  return `${link}${stepText(draftToStep(draft))}`;
}

function scenarioSummary(scenario: AutomationScenario): string {
  return (
    scenario.steps
      .map((step) => `${stepText(step)}${step.parallelWith ? ` ⇉ с шагом ${step.parallelWith}` : ''}`)
      .join(' → ') || 'нет шагов'
  );
}

function metricLabel(metric: AutomationMetric): string {
  return METRICS.find((item) => item.value === metric)?.label ?? metric;
}

function metricUnit(metric: AutomationMetric): string {
  return METRICS.find((item) => item.value === metric)?.unit ?? '';
}

function conditionText(condition: AutomationCondition | undefined): string {
  if (!condition) return 'без условия';
  return `${metricLabel(condition.metric)} ${condition.op} ${condition.value}${metricUnit(condition.metric)}`;
}

function weekdaysText(days: number[] | undefined): string {
  if (!days?.length || days.length === 7) return 'каждый день';
  return days
    .slice()
    .sort((left, right) => left - right)
    .map((day) => WEEKDAYS.find((item) => item.value === day)?.label ?? day)
    .join(', ');
}

/** What makes this scenario fire, in one short line under its name. */
function triggerDetail(scenario: AutomationScenario): string {
  const config = scenario.triggerConfig;
  switch (scenario.trigger) {
    case 'metrics':
      return conditionText(config?.condition ?? scenario.condition);
    case 'schedule':
      return `${config?.time ?? '—'} · ${weekdaysText(config?.weekdays)}`;
    case 'interval':
      return `каждые ${config?.everyMinutes ?? '—'} мин`;
    case 'volume':
      return config?.volume
        ? `громкость ${config.volume.op === '>' ? 'выше' : 'ниже'} ${config.volume.percent}%`
        : 'без порога';
    case 'wifi': {
      if (!config?.wifi) return 'без события';
      const event = WIFI_EVENTS.find((item) => item.value === config.wifi?.event)?.label ?? config.wifi.event;
      return config.wifi.ssid ? `${event}: ${config.wifi.ssid}` : event;
    }
    case 'bluetooth': {
      if (!config?.bluetooth) return 'без события';
      const event =
        BLUETOOTH_EVENTS.find((item) => item.value === config.bluetooth?.event)?.label ?? config.bluetooth.event;
      return config.bluetooth.match ? `${event}: ${config.bluetooth.match}` : event;
    }
    case 'scenario.done': {
      const name = scenarios.value.find((item) => item.id === config?.scenarioId)?.name;
      return name ? `после «${name}»` : 'сценарий не выбран';
    }
    default:
      return triggers.value.find((item) => item.value === scenario.trigger)?.hint ?? '';
  }
}

function triggerTitle(scenario: AutomationScenario): string {
  return triggers.value.find((item) => item.value === scenario.trigger)?.hint ?? '';
}

function scenarioIcon(scenario: AutomationScenario) {
  const kinds = new Set(scenario.steps.map((step) => step.kind));
  if (kinds.size > 1) return Workflow;
  const kind = scenario.steps[0]?.kind;
  return kind ? STEP_ICONS[kind] : Info;
}

async function load(showToast = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<{ scenarios: AutomationScenario[]; triggers: TriggerInfo[] }>('/automation');
    scenarios.value = result.scenarios;
    triggers.value = result.triggers;
    if (showToast) pushToast('ok', 'Сценарии обновлены');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

/** The station scan behind this list is slow, so it runs once — when a step actually needs a sound. */
async function ensureSounds(): Promise<void> {
  if (sounds.value.length) return;
  try {
    const library = await api.get<{ files: SoundFile[] }>('/sounds');
    sounds.value = library.files.filter((file) => file.playable).slice(0, 400);
  } catch {
    sounds.value = [];
  }
}

function resetForm(): void {
  Object.assign(form, {
    name: '',
    enabled: true,
    trigger: 'device.connect',
    cooldownSec: 60,
    steps: [emptyStep('led')],
    metric: 'cpuPct',
    op: '>',
    value: 80,
    time: '08:00',
    weekdays: [1, 2, 3, 4, 5],
    everyMinutes: 60,
    volumeOp: '>',
    volumePercent: 80,
    wifiEvent: 'disconnected',
    wifiSsid: '',
    bluetoothEvent: 'connected',
    bluetoothMatch: '',
    chainId: '',
    chainSuccessOnly: false,
  } satisfies FormState);
  formError.value = '';
}

function openCreate(): void {
  editingId.value = '';
  resetForm();
  modalOpen.value = true;
}

function openEdit(scenario: AutomationScenario): void {
  editingId.value = scenario.id;
  const config = scenario.triggerConfig ?? {};
  const condition = config.condition ?? scenario.condition;
  Object.assign(form, {
    name: scenario.name,
    enabled: scenario.enabled,
    trigger: scenario.trigger,
    cooldownSec: scenario.cooldownSec,
    steps: scenario.steps.map(stepToDraft),
    metric: condition?.metric ?? 'cpuPct',
    op: condition?.op ?? '>',
    value: condition?.value ?? 80,
    time: config.time ?? '08:00',
    weekdays: config.weekdays?.length ? [...config.weekdays] : [1, 2, 3, 4, 5],
    everyMinutes: config.everyMinutes ?? 60,
    volumeOp: config.volume?.op ?? '>',
    volumePercent: config.volume?.percent ?? 80,
    wifiEvent: config.wifi?.event ?? 'disconnected',
    wifiSsid: config.wifi?.ssid ?? '',
    bluetoothEvent: config.bluetooth?.event ?? 'connected',
    bluetoothMatch: config.bluetooth?.match ?? '',
    chainId: config.scenarioId ?? '',
    chainSuccessOnly: config.onSuccessOnly ?? false,
  } satisfies FormState);
  if (scenario.steps.some((step) => step.kind === 'sound')) void ensureSounds();
  formError.value = '';
  modalOpen.value = true;
}

function addStep(kind: ScenarioStepKind): void {
  if (form.steps.length >= MAX_STEPS) {
    formError.value = `В сценарии не больше ${MAX_STEPS} шагов`;
    return;
  }
  form.steps.push(emptyStep(kind));
  if (kind === 'sound') void ensureSounds();
}

/** After removing or reordering, a link must still point at an earlier step that exists. */
function fixParallelLinks(): void {
  form.steps.forEach((step, index) => {
    if (step.parallelWith != null && (step.parallelWith < 1 || step.parallelWith > index)) {
      step.parallelWith = null;
    }
  });
}

function removeStep(index: number): void {
  form.steps.splice(index, 1);
  fixParallelLinks();
}

function moveStep(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= form.steps.length) return;
  const steps = form.steps;
  const from = steps[index];
  const to = steps[target];
  if (!from || !to) return;
  steps[index] = to;
  steps[target] = from;
  fixParallelLinks();
}

async function generate(): Promise<void> {
  const prompt = aiPrompt.value.trim();
  if (prompt.length < 4) {
    formError.value = 'Опишите сценарий хотя бы четырьмя символами';
    return;
  }
  generating.value = true;
  formError.value = '';
  try {
    const result = await api.post<{ name: string; steps: ScenarioStep[] }>('/ai/scenario', { prompt });
    if (!form.name.trim()) form.name = result.name;
    form.steps = result.steps.map(stepToDraft);
    pushToast('ok', `ИИ собрал сценарий: ${pluralRu(result.steps.length, ['шаг', 'шага', 'шагов'])}`);
  } catch (caught) {
    formError.value = errorMessage(caught);
  } finally {
    generating.value = false;
  }
}

/** Turns the flat form into the config the server validates; empty triggers send nothing. */
function buildTriggerConfig(): ScenarioTriggerConfig | undefined {
  switch (form.trigger) {
    case 'metrics':
      return { condition: { metric: form.metric, op: form.op, value: Number(form.value) } };
    case 'schedule':
      return { time: form.time, weekdays: [...form.weekdays].sort((left, right) => left - right) };
    case 'interval':
      return { everyMinutes: Math.round(Number(form.everyMinutes) || 60) };
    case 'volume':
      return { volume: { op: form.volumeOp, percent: Math.round(Number(form.volumePercent) || 0) } };
    case 'wifi':
      return { wifi: { event: form.wifiEvent, ssid: form.wifiSsid.trim() || undefined } };
    case 'bluetooth':
      return { bluetooth: { event: form.bluetoothEvent, match: form.bluetoothMatch.trim() || undefined } };
    case 'scenario.done':
      return { scenarioId: form.chainId, onSuccessOnly: form.chainSuccessOnly };
    default:
      return undefined;
  }
}

function validateTriggerForm(): string | null {
  switch (form.trigger) {
    case 'metrics':
      if (!Number.isFinite(Number(form.value))) return 'Укажите числовой порог условия';
      return null;
    case 'schedule':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return 'Время расписания — ЧЧ:ММ, например 08:30';
      if (!form.weekdays.length) return 'Выберите хотя бы один день недели';
      return null;
    case 'interval':
      if (!Number.isFinite(Number(form.everyMinutes)) || Number(form.everyMinutes) < 1) {
        return 'Интервал — целое число минут, не меньше минуты';
      }
      return null;
    case 'volume':
      if (!Number.isFinite(Number(form.volumePercent))) return 'Укажите порог громкости в процентах';
      return null;
    case 'scenario.done':
      if (!form.chainId) return 'Выберите сценарий, после которого запускаться';
      return null;
    default:
      return null;
  }
}

function validateForm(): string | null {
  if (!form.name.trim()) return 'Укажите название сценария';
  const triggerProblem = validateTriggerForm();
  if (triggerProblem) return triggerProblem;
  if (!form.steps.length) return 'Добавьте хотя бы один шаг';
  for (const [index, step] of form.steps.entries()) {
    if (step.parallelWith != null && (step.parallelWith < 1 || step.parallelWith > index)) {
      return index === 0
        ? 'Шаг 1 — первый в сценарии: одновременно стартовать не с чем'
        : `Шаг ${index + 1}: одновременно можно стартовать только с шагом 1–${index}`;
    }
    const draft = draftToStep(step);
    if (draft.kind === 'say' && !draft.text) return `Шаг ${index + 1}: пустой текст для озвучки`;
    if (draft.kind === 'sound' && !draft.path) return `Шаг ${index + 1}: выберите звук`;
    if (draft.kind === 'led') {
      if (!draft.colors.length) return `Шаг ${index + 1}: укажите цвета через пробел, например #ff2d2d`;
      if (draft.colors.some((color) => !/^#?[0-9a-f]{3}$|^#?[0-9a-f]{6}$/i.test(color))) {
        return `Шаг ${index + 1}: цвет должен быть HEX вроде #ff2d2d`;
      }
    }
  }
  return null;
}

async function save(): Promise<void> {
  const problem = validateForm();
  if (problem) {
    formError.value = problem;
    return;
  }
  saving.value = true;
  formError.value = '';
  const payload = {
    name: form.name.trim(),
    enabled: form.enabled,
    trigger: form.trigger,
    triggerConfig: buildTriggerConfig(),
    cooldownSec: Math.max(5, Number(form.cooldownSec) || 60),
    steps: form.steps.map((step, index) => draftToStep(step, index)),
  };
  try {
    if (editingId.value) {
      await api.put(`/automation/${encodeURIComponent(editingId.value)}`, payload);
      pushToast('ok', 'Сценарий обновлён');
    } else {
      await api.post('/automation', payload);
      pushToast('ok', 'Сценарий создан');
    }
    modalOpen.value = false;
    await load();
  } catch (caught) {
    formError.value = errorMessage(caught);
  } finally {
    saving.value = false;
  }
}

async function toggle(scenario: AutomationScenario): Promise<void> {
  try {
    await api.put(`/automation/${encodeURIComponent(scenario.id)}`, {
      name: scenario.name,
      enabled: !scenario.enabled,
      trigger: scenario.trigger,
      triggerConfig: scenario.triggerConfig,
      condition: scenario.condition,
      cooldownSec: scenario.cooldownSec,
      steps: scenario.steps,
    });
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  }
}

async function runNow(scenario: AutomationScenario): Promise<void> {
  runningId.value = scenario.id;
  try {
    const updated = await api.post<AutomationScenario>(
      `/automation/${encodeURIComponent(scenario.id)}/run`,
    );
    const index = scenarios.value.findIndex((item) => item.id === updated.id);
    if (index >= 0) scenarios.value[index] = updated;
    // A step that throws is journalled into lastResult with this prefix, not as an HTTP error.
    const failed = (updated.lastResult ?? '').startsWith('Ошибка');
    pushToast(failed ? 'error' : 'ok', updated.lastResult || 'Сценарий выполнен');
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    runningId.value = '';
  }
}

async function remove(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  try {
    await api.delete(`/automation/${encodeURIComponent(target.id)}`);
    deleteTarget.value = null;
    pushToast('info', `Сценарий «${target.name}» удалён`);
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  if (isConnected.value) void load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Automation Studio</h1>
        <p>
          Сценарий — это несколько шагов подряд: кольцо мигает, колонка говорит, в журнал падает
          запись. Триггеров тринадцать: подключение и отключение станции, перезагрузка, обновление,
          пороги метрик, громкость, Wi-Fi, Bluetooth, расписание, интервал и цепочка из другого
          сценария.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="loading" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
        <button class="btn btn--primary" :disabled="!isConnected" @click="openCreate">
          <Plus :size="15" />
          Новый сценарий
        </button>
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Automation Studio управляет сценариями на backend и реагирует на события колонки." />

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="grid grid-3">
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Сценариев</span><Workflow :size="15" class="muted" /></div>
          <div class="stat-value">{{ scenarios.length }}</div>
          <div class="stat-foot"><span>Включено: {{ enabledCount }}</span><span class="mono">max 50</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Последний запуск</span><Clock :size="15" class="muted" /></div>
          <div class="stat-value" style="font-size: 20px">{{ lastRun ? formatRelative(lastRun) : '—' }}</div>
          <div class="stat-foot"><span>По реальному событию или вручную</span><span class="mono">log</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Шагов</span><Zap :size="15" class="muted" /></div>
          <div class="stat-value">{{ stepCount }}</div>
          <div class="stat-foot"><span>Свет, голос, журнал — по порядку</span><span class="mono">steps</span></div>
        </div>
      </div>

      <article class="card card--flush">
        <div class="file-toolbar">
          <div class="card-title" style="flex: 1"><Workflow :size="15" /> Сценарии</div>
          <span class="pill pill--muted">{{ enabledCount }} активно</span>
        </div>

        <div v-if="loading && !scenarios.length" class="empty" style="padding: 34px">
          <LoaderCircle :size="20" class="spin" />
          <p>Читаем сценарии…</p>
        </div>

        <EmptyState
          v-else-if="!scenarios.length"
          title="Сценариев пока нет"
          text="Нажмите «Новый сценарий» и опишите, что должна сделать колонка — ИИ соберёт шаги, останется проверить и сохранить."
        >
          <template #icon><Workflow :size="22" /></template>
          <button class="btn btn--primary mt-12" @click="openCreate">
            <Sparkles :size="15" />
            Придумать сценарий
          </button>
        </EmptyState>

        <div v-else class="list">
          <div v-for="scenario in scenarios" :key="scenario.id" class="list-row">
            <button
              type="button"
              class="switch"
              :class="{ on: scenario.enabled }"
              :aria-label="scenario.enabled ? 'Выключить сценарий' : 'Включить сценарий'"
              @click="toggle(scenario)"
            />
            <div class="empty-icon" style="width: 38px; height: 38px; border-radius: 11px; flex: none">
              <component :is="scenarioIcon(scenario)" :size="16" />
            </div>
            <div class="list-main">
              <div class="list-title truncate">{{ scenario.name }}</div>
              <div class="list-meta">
                <span class="pill pill--muted" :title="triggerTitle(scenario)">{{ triggerLabels[scenario.trigger] || scenario.trigger }}</span>
                <span class="truncate">{{ triggerDetail(scenario) }}</span>
              </div>
              <div class="list-meta">
                <span class="truncate">{{ scenarioSummary(scenario) }}</span>
              </div>
              <div class="list-meta">
                <span>cooldown {{ scenario.cooldownSec }} с</span>
                <span v-if="scenario.lastRunAt">· запуск {{ formatRelative(scenario.lastRunAt) }}</span>
                <span v-if="scenario.lastResult" class="truncate">· {{ scenario.lastResult }}</span>
              </div>
            </div>
            <div class="row" style="gap: 4px">
              <button
                class="btn btn--soft btn--sm"
                :disabled="Boolean(runningId)"
                @click="runNow(scenario)"
              >
                <LoaderCircle v-if="runningId === scenario.id" :size="14" class="spin" />
                <Play v-else :size="14" />
                Запустить
              </button>
              <button class="btn btn--ghost btn--icon btn--sm" title="Изменить" @click="openEdit(scenario)">
                <Pencil :size="14" />
              </button>
              <button class="btn btn--ghost btn--icon btn--sm" title="Удалить" @click="deleteTarget = scenario">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
      </article>

      <article class="card card--soft">
        <div class="card-title"><Check :size="15" /> Что сценарии не делают</div>
        <ul class="check-list mt-12">
          <li><Check :size="14" /><span>Не перезапускают станцию и не вызывают reboot.</span></li>
          <li><Check :size="14" /><span>Не устанавливают пакеты и не скачивают бинарники.</span></li>
          <li><Check :size="14" /><span>Диагностика выполняет только фиксированный набор команд.</span></li>
          <li><Check :size="14" /><span>Озвучка говорит голосом Алисы и не попадает в библиотеку станции.</span></li>
        </ul>
      </article>
    </template>

    <Modal
      :open="modalOpen"
      wide
      :title="editingId ? 'Изменить сценарий' : 'Новый сценарий'"
      subtitle="До 32 шагов подряд; шаг можно привязать к предыдущему и стартовать вместе с ним"
      @close="modalOpen = false"
    >
      <div class="stack" style="gap: 14px">
        <div class="card card--soft">
          <div class="card-title"><Sparkles :size="15" /> Собрать из описания</div>
          <div class="row mt-12" style="gap: 8px; align-items: flex-end; flex-wrap: wrap">
            <div class="field" style="flex: 1; min-width: 240px">
              <label for="scenario-ai">Что должна сделать колонка</label>
              <input
                id="scenario-ai"
                v-model="aiPrompt"
                class="input"
                maxlength="240"
                placeholder="Например: кольцо мигает красным, а Алиса говорит «ошибка, ошибка, ошибка»"
              />
            </div>
            <button class="btn btn--primary" :disabled="generating" @click="generate">
              <LoaderCircle v-if="generating" :size="15" class="spin" />
              <Sparkles v-else :size="15" />
              {{ generating ? 'Думаю…' : 'Сгенерировать' }}
            </button>
          </div>
          <p class="field-hint mt-12">Цвета, движение и темп из вашего описания важнее фантазии модели.</p>
        </div>

        <div class="form-grid">
          <div class="field span-2">
            <label for="scenario-name">Название</label>
            <input id="scenario-name" v-model="form.name" class="input" maxlength="80" placeholder="Например: Авария — красное кольцо и голос" />
          </div>
          <div class="field">
            <label for="scenario-trigger">Триггер</label>
            <select id="scenario-trigger" v-model="form.trigger" class="select">
              <optgroup v-for="group in triggerGroups" :key="group.group" :label="group.group">
                <option v-for="item in group.items" :key="item.value" :value="item.value">{{ item.label }}</option>
              </optgroup>
            </select>
          </div>
          <div class="field">
            <label for="scenario-cooldown">Cooldown, секунд</label>
            <input id="scenario-cooldown" v-model.number="form.cooldownSec" class="input" type="number" min="5" max="86400" />
          </div>

          <div v-if="activeTriggerHint" class="span-2 field-hint" style="margin: -4px 0 0">
            {{ activeTriggerHint }}
          </div>

          <template v-if="form.trigger === 'metrics'">
            <div class="field">
              <label for="scenario-metric">Метрика</label>
              <select id="scenario-metric" v-model="form.metric" class="select">
                <option v-for="item in METRICS" :key="item.value" :value="item.value">
                  {{ item.label }}{{ item.unit ? `, ${item.unit}` : '' }}
                </option>
              </select>
            </div>
            <div class="field">
              <label>Условие</label>
              <div class="row" style="gap: 8px">
                <select v-model="form.op" class="select" style="width: 96px" aria-label="Сравнение">
                  <option value=">">больше</option>
                  <option value="<">меньше</option>
                </select>
                <input v-model.number="form.value" class="input" type="number" min="-500" max="500" step="1" aria-label="Порог" />
              </div>
            </div>
          </template>

          <template v-else-if="form.trigger === 'schedule'">
            <div class="field">
              <label for="scenario-time">Время</label>
              <input id="scenario-time" v-model="form.time" class="input" type="time" />
            </div>
            <div class="field">
              <label>Дни недели</label>
              <div class="row" style="gap: 4px; flex-wrap: wrap">
                <label v-for="day in WEEKDAYS" :key="day.value" class="check" style="gap: 4px">
                  <input
                    type="checkbox"
                    :checked="form.weekdays.includes(day.value)"
                    @change="toggleWeekday(day.value, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>{{ day.label }}</span>
                </label>
              </div>
            </div>
          </template>

          <template v-else-if="form.trigger === 'interval'">
            <div class="field">
              <label for="scenario-interval">Повторять каждые, минут</label>
              <input id="scenario-interval" v-model.number="form.everyMinutes" class="input" type="number" min="1" max="1440" />
            </div>
          </template>

          <template v-else-if="form.trigger === 'volume'">
            <div class="field">
              <label for="scenario-volume">Громкость пересекает</label>
              <div class="row" style="gap: 8px">
                <select v-model="form.volumeOp" class="select" style="width: 130px" aria-label="Направление">
                  <option value=">">вверх через</option>
                  <option value="<">вниз через</option>
                </select>
                <input id="scenario-volume" v-model.number="form.volumePercent" class="input" type="number" min="0" max="100" aria-label="Порог громкости, %" />
                <span class="muted">%</span>
              </div>
            </div>
          </template>

          <template v-else-if="form.trigger === 'wifi'">
            <div class="field">
              <label for="scenario-wifi-event">Событие</label>
              <select id="scenario-wifi-event" v-model="form.wifiEvent" class="select">
                <option v-for="item in WIFI_EVENTS" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </div>
            <div class="field">
              <label for="scenario-wifi-ssid">SSID (пусто — любая сеть)</label>
              <input id="scenario-wifi-ssid" v-model="form.wifiSsid" class="input" maxlength="64" placeholder="Например: Home" />
            </div>
          </template>

          <template v-else-if="form.trigger === 'bluetooth'">
            <div class="field">
              <label for="scenario-bt-event">Событие</label>
              <select id="scenario-bt-event" v-model="form.bluetoothEvent" class="select">
                <option v-for="item in BLUETOOTH_EVENTS" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </div>
            <div class="field">
              <label for="scenario-bt-match">Имя или MAC (пусто — любое устройство)</label>
              <input id="scenario-bt-match" v-model="form.bluetoothMatch" class="input" maxlength="64" placeholder="Например: iPhone" />
            </div>
          </template>

          <template v-else-if="form.trigger === 'scenario.done'">
            <div class="field">
              <label for="scenario-chain">Запускаться после</label>
              <select id="scenario-chain" v-model="form.chainId" class="select">
                <option value="">Выберите сценарий</option>
                <option v-for="item in chainOptions" :key="item.id" :value="item.id">{{ item.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Условие цепочки</label>
              <label class="check" style="gap: 6px">
                <input v-model="form.chainSuccessOnly" type="checkbox" />
                <span>Только если предыдущий завершился без ошибки</span>
              </label>
            </div>
          </template>
        </div>

        <div class="card card--flush">
          <div class="file-toolbar">
            <div class="card-title" style="flex: 1"><Zap :size="15" /> Шаги сценария</div>
            <span class="pill pill--muted">{{ form.steps.length }} / {{ MAX_STEPS }}</span>
          </div>
          <div v-if="!form.steps.length" class="empty" style="padding: 22px">
            <p>Шагов нет. Добавьте шаг или доверьте это ИИ.</p>
          </div>
          <div v-else class="list">
            <div v-for="(step, index) in form.steps" :key="index" class="list-row">
              <div class="empty-icon" style="width: 34px; height: 34px; border-radius: 10px; flex: none">
                <component :is="STEP_ICONS[step.kind]" :size="15" />
              </div>
              <div class="list-main">
                <div class="row" style="gap: 8px; flex-wrap: wrap">
                  <select v-model="step.kind" class="select" style="width: 172px" aria-label="Тип шага">
                    <option v-for="kind in STEP_KINDS" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
                  </select>

                  <template v-if="step.kind === 'led'">
                    <select v-model="step.effect" class="select" style="width: 190px" aria-label="Движение кольца">
                      <option v-for="effect in EFFECTS" :key="effect.value" :value="effect.value">{{ effect.label }}</option>
                    </select>
                    <input v-model="step.colors" class="input" style="width: 160px" placeholder="#ff2d2d #7f5af0" aria-label="Цвета" />
                    <input v-model.number="step.fps" class="input" style="width: 84px" type="number" min="1" max="60" aria-label="Кадров в секунду" />
                    <input v-model.number="step.seconds" class="input" style="width: 84px" type="number" min="0.2" max="120" step="0.5" aria-label="Длительность" />
                  </template>

                  <input
                    v-else-if="step.kind === 'say'"
                    v-model="step.text"
                    class="input"
                    style="flex: 1; min-width: 150px"
                    maxlength="300"
                    placeholder="Текст, который произнесёт колонка"
                    aria-label="Текст озвучки"
                  />

                  <select
                    v-else-if="step.kind === 'sound'"
                    v-model="step.path"
                    class="select"
                    style="flex: 1; min-width: 150px"
                    aria-label="Звук"
                  >
                    <option value="">Выберите звук</option>
                    <option v-for="file in sounds" :key="file.path" :value="file.path">{{ file.name }}</option>
                  </select>

                  <input
                    v-else-if="step.kind === 'pause'"
                    v-model.number="step.seconds"
                    class="input"
                    style="width: 96px"
                    type="number"
                    min="0.1"
                    max="120"
                    step="0.5"
                    aria-label="Пауза, секунд"
                  />

                  <input
                    v-else-if="step.kind === 'notify'"
                    v-model="step.text"
                    class="input"
                    style="flex: 1; min-width: 150px"
                    maxlength="200"
                    placeholder="Строка в Event Center"
                    aria-label="Текст журнала"
                  />

                  <span v-else class="muted">{{ stepSummary(step) }}</span>
                </div>
                <div class="list-meta" style="align-items: center; gap: 8px">
                  <span>{{ stepSummary(step) }}</span>
                  <span v-if="index > 0" class="row" style="gap: 6px; align-items: center">
                    <label class="muted" :for="`step-parallel-${index}`" style="font-size: 11.5px">
                      одновременно с шагом
                    </label>
                    <select
                      :id="`step-parallel-${index}`"
                      v-model.number="step.parallelWith"
                      class="select"
                      style="width: 92px"
                      aria-label="Стартовать одновременно с шагом"
                    >
                      <option :value="null">—</option>
                      <option v-for="n in index" :key="n" :value="n">{{ n }}</option>
                    </select>
                  </span>
                </div>
              </div>
              <div class="row" style="gap: 4px">
                <button class="btn btn--ghost btn--icon btn--sm" title="Выше" :disabled="index === 0" @click="moveStep(index, -1)">
                  <ArrowUp :size="14" />
                </button>
                <button
                  class="btn btn--ghost btn--icon btn--sm"
                  title="Ниже"
                  :disabled="index === form.steps.length - 1"
                  @click="moveStep(index, 1)"
                >
                  <ArrowDown :size="14" />
                </button>
                <button class="btn btn--ghost btn--icon btn--sm" title="Убрать шаг" @click="removeStep(index)">
                  <X :size="14" />
                </button>
              </div>
            </div>
          </div>
          <div class="row mt-12" style="gap: 6px; flex-wrap: wrap; padding: 0 14px 14px">
            <button v-for="kind in STEP_KINDS" :key="kind.value" class="btn btn--soft btn--sm" @click="addStep(kind.value)">
              <Plus :size="13" />
              {{ kind.label }}
            </button>
          </div>
        </div>

        <label class="check">
          <input v-model="form.enabled" type="checkbox" />
          <span>Сценарий включён и может срабатывать по событиям</span>
        </label>

        <div v-if="formError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ formError }}</div>
        </div>

        <div class="alert alert--info">
          <Info :size="15" />
          <div>
            «Одновременно с шагом N» запускает шаг в тот же момент, что и шаг N, — без задержки
            между кольцом и голосом. Связать можно только с предыдущим шагом. Сценарий хранится в
            data/scenarios.json. Кольцо описано рецептом (цвета и движение), а не пикселями — на
            станции с другим числом зон оно растянется само. Озвучка говорит штатным голосом Алисы
            через саму станцию и не зависит от ИИ-провайдера.
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="saving" @click="modalOpen = false">Отмена</button>
        <button class="btn btn--primary" :disabled="saving" @click="save">
          <LoaderCircle v-if="saving" :size="15" class="spin" />
          <Pencil v-else-if="editingId" :size="15" />
          <Plus v-else :size="15" />
          {{ editingId ? 'Сохранить' : 'Создать' }}
        </button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="Удалить сценарий?"
      :message="deleteTarget ? `Сценарий «${deleteTarget.name}» и его история последнего запуска будут удалены с backend.` : ''"
      confirm-label="Удалить"
      :busy="deleting"
      @confirm="remove"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

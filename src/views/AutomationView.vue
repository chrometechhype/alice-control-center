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
  AutomationScenario,
  SceneEffect,
  ScenarioStep,
  ScenarioStepKind,
  SoundFile,
} from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import { api, errorMessage } from '@/lib/api';
import { formatRelative, pluralRu } from '@/lib/format';
import { everConnected, isConnected, pushToast } from '@/lib/store';

interface TriggerInfo {
  value: AutomationScenario['trigger'];
  label: string;
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
}

interface FormState {
  name: string;
  enabled: boolean;
  trigger: AutomationScenario['trigger'];
  metric: AutomationCondition['metric'];
  op: AutomationCondition['op'];
  value: number;
  cooldownSec: number;
  steps: StepDraft[];
}

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
  metric: 'cpuPct',
  op: '>',
  value: 80,
  cooldownSec: 60,
  steps: [],
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

function emptyStep(kind: ScenarioStepKind): StepDraft {
  return { kind, text: '', path: '', effect: 'pulse', colors: '#ff2d2d', fps: 16, seconds: kind === 'pause' ? 1 : 4 };
}

function stepToDraft(step: ScenarioStep): StepDraft {
  switch (step.kind) {
    case 'led':
      return { ...emptyStep('led'), effect: step.effect, colors: step.colors.join(' '), fps: step.fps, seconds: step.seconds };
    case 'say':
      return { ...emptyStep('say'), text: step.text };
    case 'sound':
      return { ...emptyStep('sound'), path: step.path };
    case 'pause':
      return { ...emptyStep('pause'), seconds: step.seconds };
    case 'notify':
      return { ...emptyStep('notify'), text: step.text };
    default:
      return emptyStep('diagnostic');
  }
}

function draftToStep(draft: StepDraft): ScenarioStep {
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
  return stepText(draftToStep(draft));
}

function scenarioSummary(scenario: AutomationScenario): string {
  return scenario.steps.map(stepText).join(' → ') || 'нет шагов';
}

function conditionLabel(scenario: AutomationScenario): string {
  const condition = scenario.condition;
  if (!condition) return 'без условия';
  const metric = condition.metric === 'cpuPct' ? 'CPU' : condition.metric === 'memPct' ? 'RAM' : 'Температура';
  return `${metric} ${condition.op} ${condition.value}`;
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
    metric: 'cpuPct',
    op: '>',
    value: 80,
    cooldownSec: 60,
    steps: [emptyStep('led')],
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
  Object.assign(form, {
    name: scenario.name,
    enabled: scenario.enabled,
    trigger: scenario.trigger,
    metric: scenario.condition?.metric ?? 'cpuPct',
    op: scenario.condition?.op ?? '>',
    value: scenario.condition?.value ?? 80,
    cooldownSec: scenario.cooldownSec,
    steps: scenario.steps.map(stepToDraft),
  } satisfies FormState);
  if (scenario.steps.some((step) => step.kind === 'sound')) void ensureSounds();
  formError.value = '';
  modalOpen.value = true;
}

function addStep(kind: ScenarioStepKind): void {
  if (form.steps.length >= 8) {
    formError.value = 'Больше восьми шагов сценарий не помещается';
    return;
  }
  form.steps.push(emptyStep(kind));
  if (kind === 'sound') void ensureSounds();
}

function removeStep(index: number): void {
  form.steps.splice(index, 1);
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

function validateForm(): string | null {
  if (!form.name.trim()) return 'Укажите название сценария';
  if (form.trigger === 'metrics' && !Number.isFinite(Number(form.value))) return 'Укажите числовой порог условия';
  if (!form.steps.length) return 'Добавьте хотя бы один шаг';
  for (const [index, step] of form.steps.entries()) {
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
    condition:
      form.trigger === 'metrics'
        ? { metric: form.metric, op: form.op, value: Number(form.value) }
        : undefined,
    cooldownSec: Math.max(5, Number(form.cooldownSec) || 60),
    steps: form.steps.map(draftToStep),
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
      condition: scenario.trigger === 'metrics' ? scenario.condition : undefined,
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
          запись. Запускаются только по реальным событиям — подключение, отключение, метрики, старт ACC.
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

    <div v-if="!everConnected" class="card">
      <EmptyState title="Колонка не отвечает" text="Панель ещё не связалась с колонкой в этой сессии. Automation Studio управляет сценариями на backend и реагирует на события колонки. Откройте «Мастер подключения» или подождите — панель сама пробует снова.">
        <template #icon><Workflow :size="22" /></template>
      </EmptyState>
    </div>

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
                <span class="pill pill--muted">{{ triggerLabels[scenario.trigger] || scenario.trigger }}</span>
                <span v-if="scenario.trigger === 'metrics'" class="pill pill--muted">{{ conditionLabel(scenario) }}</span>
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
          <li><Check :size="14" /><span>Озвучка играет один раз и не попадает в библиотеку станции.</span></li>
        </ul>
      </article>
    </template>

    <Modal
      :open="modalOpen"
      wide
      :title="editingId ? 'Изменить сценарий' : 'Новый сценарий'"
      subtitle="Шаги выполняются по порядку: свет, голос, журнал"
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
              <option v-for="item in triggers" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </div>
          <div class="field">
            <label for="scenario-cooldown">Cooldown, секунд</label>
            <input id="scenario-cooldown" v-model.number="form.cooldownSec" class="input" type="number" min="5" max="86400" />
          </div>

          <template v-if="form.trigger === 'metrics'">
            <div class="field">
              <label for="scenario-metric">Метрика</label>
              <select id="scenario-metric" v-model="form.metric" class="select">
                <option value="cpuPct">CPU, %</option>
                <option value="memPct">Память, %</option>
                <option value="tempC">Температура, °C</option>
              </select>
            </div>
            <div class="field">
              <label>Условие</label>
              <div class="row" style="gap: 8px">
                <select v-model="form.op" class="select" style="width: 96px">
                  <option value=">">больше</option>
                  <option value="<">меньше</option>
                </select>
                <input v-model.number="form.value" class="input" type="number" min="-50" max="200" step="1" />
              </div>
            </div>
          </template>
        </div>

        <div class="card card--flush">
          <div class="file-toolbar">
            <div class="card-title" style="flex: 1"><Zap :size="15" /> Шаги сценария</div>
            <span class="pill pill--muted">{{ form.steps.length }} / 8</span>
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
                <div class="list-meta">
                  <span>{{ stepSummary(step) }}</span>
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
            Сценарий хранится в data/scenarios.json. Кольцо описано рецептом (цвета и движение), а не
            пикселями — на станции с другим числом зон оно растянется само. Озвучка говорит голосом
            ИИ-провайдера, а если у него нет <span class="mono">/audio/speech</span> — голосом Windows.
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

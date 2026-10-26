<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Activity,
  AlertTriangle,
  Check,
  Clock,
  Info,
  Lightbulb,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  Workflow,
  Zap,
} from '@lucide/vue';
import type {
  AutomationAction,
  AutomationCondition,
  AutomationScenario,
  LedPreset,
} from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import { api, errorMessage } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { isConnected, pushToast } from '@/lib/store';

interface TriggerInfo {
  value: AutomationScenario['trigger'];
  label: string;
}

interface FormState {
  name: string;
  enabled: boolean;
  trigger: AutomationScenario['trigger'];
  metric: AutomationCondition['metric'];
  op: AutomationCondition['op'];
  value: number;
  cooldownSec: number;
  actionType: AutomationAction['type'];
  actionValue: string;
}

const scenarios = ref<AutomationScenario[]>([]);
const triggers = ref<TriggerInfo[]>([]);
const ledPresets = ref<LedPreset[]>([]);
const loading = ref(false);
const error = ref('');
const runningId = ref('');
const deleteTarget = ref<AutomationScenario | null>(null);
const deleting = ref(false);

const modalOpen = ref(false);
const editingId = ref('');
const saving = ref(false);
const formError = ref('');

const form = reactive<FormState>({
  name: '',
  enabled: true,
  trigger: 'device.connect',
  metric: 'cpuPct',
  op: '>',
  value: 80,
  cooldownSec: 60,
  actionType: 'notify',
  actionValue: '',
});

const enabledCount = computed(() => scenarios.value.filter((scenario) => scenario.enabled).length);
const lastRun = computed(() => {
  const stamps = scenarios.value.map((scenario) => scenario.lastRunAt ?? 0).filter(Boolean);
  return stamps.length ? Math.max(...stamps) : null;
});

const triggerLabels = computed<Record<string, string>>(() => {
  const result: Record<string, string> = {
    'device.connect': 'Устройство подключено',
    'device.disconnect': 'Устройство отключено',
    metrics: 'Показатель метрик',
    'app.start': 'Запуск ACC',
  };
  for (const item of triggers.value) result[item.value] = item.label;
  return result;
});

function actionLabel(scenario: AutomationScenario): string {
  if (scenario.action.type === 'notify') return `Уведомление: ${scenario.action.value || 'событие'}`;
  if (scenario.action.type === 'diagnostic') return 'Диагностика устройства';
  const preset = ledPresets.value.find((item) => item.id === scenario.action.value);
  return `LED-пресет: ${preset?.name || scenario.action.value || '—'}`;
}

function conditionLabel(scenario: AutomationScenario): string {
  const condition = scenario.condition;
  if (!condition) return 'без условия';
  const metric =
    condition.metric === 'cpuPct' ? 'CPU' : condition.metric === 'memPct' ? 'RAM' : 'Температура';
  return `${metric} ${condition.op} ${condition.value}`;
}

function actionIcon(type: AutomationAction['type']) {
  if (type === 'diagnostic') return Activity;
  if (type === 'ledPreset') return Lightbulb;
  return Info;
}

async function load(showToast = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<{ scenarios: AutomationScenario[]; triggers: TriggerInfo[] }>('/automation');
    scenarios.value = result.scenarios;
    triggers.value = result.triggers;
    try {
      const presets = await api.get<{ presets: LedPreset[] }>('/led/presets');
      ledPresets.value = presets.presets;
    } catch {
      ledPresets.value = [];
    }
    if (showToast) pushToast('ok', 'Сценарии обновлены');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = '';
  Object.assign(form, {
    name: '',
    enabled: true,
    trigger: 'device.connect',
    metric: 'cpuPct',
    op: '>',
    value: 80,
    cooldownSec: 60,
    actionType: 'notify',
    actionValue: '',
  } satisfies FormState);
  formError.value = '';
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
    actionType: scenario.action.type,
    actionValue: scenario.action.value ?? '',
  } satisfies FormState);
  formError.value = '';
  modalOpen.value = true;
}

function buildPayload() {
  const action: AutomationAction =
    form.actionType === 'diagnostic'
      ? { type: 'diagnostic' }
      : { type: form.actionType, value: form.actionValue.trim() };
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    trigger: form.trigger,
    condition:
      form.trigger === 'metrics'
        ? { metric: form.metric, op: form.op, value: Number(form.value) }
        : undefined,
    cooldownSec: Math.max(5, Number(form.cooldownSec) || 60),
    action,
  };
}

async function save(): Promise<void> {
  if (!form.name.trim()) {
    formError.value = 'Укажите название сценария';
    return;
  }
  if (form.trigger === 'metrics' && !Number.isFinite(Number(form.value))) {
    formError.value = 'Укажите числовой порог условия';
    return;
  }
  if (form.actionType === 'ledPreset' && !form.actionValue) {
    formError.value = 'Выберите LED-пресет';
    return;
  }
  saving.value = true;
  formError.value = '';
  try {
    const payload = buildPayload();
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
      action: scenario.action,
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
    pushToast('ok', updated.lastResult || 'Сценарий выполнен');
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
          Сценарии запускаются только по реальным событиям: подключение, отключение, метрики и старт
          ACC. Никаких таймеров-фантазий и фоновых демонов.
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

    <div v-if="!isConnected" class="card">
      <EmptyState title="Устройство не подключено" text="Automation Studio управляет сценариями на backend и реагирует на события колонки.">
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
          <div class="stat-top"><span class="stat-label">LED-пресетов</span><Lightbulb :size="15" class="muted" /></div>
          <div class="stat-value">{{ ledPresets.length }}</div>
          <div class="stat-foot"><span>Для действий с кольцом</span><span class="mono">led</span></div>
        </div>
      </div>

      <div class="alert alert--info">
        <Zap :size="16" />
        <div>
          Триггеры: подключение и отключение устройства, порог CPU/RAM/температуры, запуск ACC.
          Между запусками действует cooldown, чтобы сценарий не срабатывал лавиной.
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
          text="Создайте первый сценарий: например, уведомление в журнал при подключении к колонке."
        >
          <template #icon><Workflow :size="22" /></template>
          <button class="btn btn--primary mt-12" @click="openCreate">
            <Plus :size="15" />
            Создать сценарий
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
              <component :is="actionIcon(scenario.action.type)" :size="16" />
            </div>
            <div class="list-main">
              <div class="list-title truncate">{{ scenario.name }}</div>
              <div class="list-meta">
                <span class="pill pill--muted">{{ triggerLabels[scenario.trigger] || scenario.trigger }}</span>
                <span v-if="scenario.trigger === 'metrics'" class="pill pill--muted">{{ conditionLabel(scenario) }}</span>
                <span>{{ actionLabel(scenario) }}</span>
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
          <li><Check :size="14" /><span>Уведомления пишутся в Event Center, а не в сторонние сервисы.</span></li>
        </ul>
      </article>
    </template>

    <Modal
      :open="modalOpen"
      wide
      :title="editingId ? 'Изменить сценарий' : 'Новый сценарий'"
      subtitle="Только реальные события и безопасные действия"
      @close="modalOpen = false"
    >
      <div class="stack" style="gap: 14px">
        <div class="form-grid">
          <div class="field span-2">
            <label for="scenario-name">Название</label>
            <input id="scenario-name" v-model="form.name" class="input" maxlength="80" placeholder="Например: Сообщить о подключении" />
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
                <select v-model="form.op" class="select" style="width: 72px">
                  <option value=">">больше</option>
                  <option value="<">меньше</option>
                </select>
                <input v-model.number="form.value" class="input" type="number" min="-50" max="200" step="1" />
              </div>
            </div>
          </template>

          <div class="field">
            <label for="scenario-action">Действие</label>
            <select id="scenario-action" v-model="form.actionType" class="select">
              <option value="notify">Уведомление в журнал</option>
              <option value="diagnostic">Диагностика устройства</option>
              <option value="ledPreset">Применить LED-пресет</option>
            </select>
          </div>

          <div v-if="form.actionType === 'notify'" class="field">
            <label for="scenario-message">Текст уведомления</label>
            <input id="scenario-message" v-model="form.actionValue" class="input" maxlength="120" placeholder="Например: Колонка снова на связи" />
          </div>

          <div v-if="form.actionType === 'ledPreset'" class="field">
            <label for="scenario-preset">LED-пресет</label>
            <select id="scenario-preset" v-model="form.actionValue" class="select">
              <option value="">Выберите пресет</option>
              <option v-for="preset in ledPresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
            </select>
          </div>

          <label class="check span-2">
            <input v-model="form.enabled" type="checkbox" />
            <span>Сценарий включён и может срабатывать по событиям</span>
          </label>
        </div>

        <div v-if="form.actionType === 'ledPreset' && !ledPresets.length" class="alert alert--warn">
          <AlertTriangle :size="15" />
          <div>
            Нет сохранённых LED-пресетов. Создайте их в
            <RouterLink to="/led">LED Studio</RouterLink>, затем вернитесь сюда.
          </div>
        </div>

        <div v-if="formError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ formError }}</div>
        </div>

        <div class="alert alert--info">
          <Info :size="15" />
          <div>Сценарий хранится в data/scenarios.json. Запуск по триггеру проверяет cooldown и не выполняется параллельно сам с собой.</div>
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

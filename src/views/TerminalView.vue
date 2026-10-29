<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Check,
  Copy,
  Info,
  LoaderCircle,
  Play,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
} from '@lucide/vue';
import EmptyState from '@/components/EmptyState.vue';
import OfflineState from '@/components/OfflineState.vue';
import { api, errorMessage } from '@/lib/api';
import { formatDuration, formatTime } from '@/lib/format';
import { everConnected, isConnected, pushToast } from '@/lib/store';

interface CommandPreset {
  group: string;
  items: Array<{ label: string; command: string }>;
}

interface TerminalPolicy {
  rawCommands: boolean;
  note: string;
  blocked: string[];
}

interface ExecResult {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  ts: number;
}

const presets = ref<CommandPreset[]>([]);
const policy = ref<TerminalPolicy | null>(null);
const loading = ref(false);
const running = ref(false);
const error = ref('');
const query = ref('');
const group = ref('all');
const command = ref('');
const history = ref<ExecResult[]>([]);

const groups = computed(() => presets.value.map((preset) => preset.group));
const allCommands = computed(() => presets.value.flatMap((preset) => preset.items));
const visibleGroups = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return presets.value
    .filter((preset) => group.value === 'all' || preset.group === group.value)
    .map((preset) => ({
      ...preset,
      items: preset.items.filter(
        (item) =>
          !needle ||
          item.label.toLowerCase().includes(needle) ||
          item.command.toLowerCase().includes(needle),
      ),
    }))
    .filter((preset) => preset.items.length);
});

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<{ presets: CommandPreset[]; policy: TerminalPolicy }>('/terminal/commands');
    presets.value = result.presets;
    policy.value = result.policy;
    if (!command.value && result.presets[0]?.items[0]) {
      command.value = result.presets[0].items[0].command;
    }
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function run(value?: string): Promise<void> {
  const target = (value ?? command.value).trim();
  if (!target || running.value) return;
  command.value = target;
  running.value = true;
  error.value = '';
  try {
    const result = await api.post<Omit<ExecResult, 'ts'>>('/terminal/exec', { command: target });
    history.value.unshift({ ...result, ts: Date.now() });
    if (history.value.length > 12) history.value.length = 12;
    if (result.code !== 0) {
      pushToast('info', `Команда завершилась с кодом ${result.code}`);
    }
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    running.value = false;
  }
}

async function copyResult(item: ExecResult): Promise<void> {
  const text = [item.stdout, item.stderr].filter(Boolean).join('\n');
  try {
    await navigator.clipboard.writeText(text || `(команда завершилась с кодом ${item.code})`);
    pushToast('ok', 'Вывод скопирован');
  } catch {
    pushToast('error', 'Буфер обмена недоступен');
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
        <h1>Терминал</h1>
        <p>
          Только команды из белого списка backend. Произвольная shell-строка, пайпы и
          перенаправления не передаются на устройство.
        </p>
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Терминал выполняет команды на реальной колонке." />

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div v-if="policy" class="alert alert--info">
        <ShieldCheck :size="16" />
        <div>
          <strong>{{ policy.rawCommands ? 'Произвольные команды разрешены' : 'Произвольные root-команды отключены' }}.</strong>
          {{ policy.note }}
          <span class="chip-grid mt-8">
            <span v-for="item in policy.blocked" :key="item" class="pill pill--muted">{{ item }}</span>
          </span>
        </div>
      </div>

      <div class="split">
        <div class="stack">
          <article class="card">
            <div class="card-head">
              <div class="card-title"><SquareTerminal :size="15" /> Команда</div>
              <span class="pill pill--muted mono">allowlist</span>
            </div>
            <div class="row" style="gap: 8px">
              <input
                v-model="command"
                class="input mono"
                list="terminal-commands"
                maxlength="300"
                placeholder="Введите команду из списка…"
                :disabled="running"
                @keydown.enter="run()"
              />
              <button class="btn btn--primary" :disabled="running || !command.trim()" @click="run()">
                <LoaderCircle v-if="running" :size="15" class="spin" />
                <Play v-else :size="15" />
                Запуск
              </button>
            </div>
            <datalist id="terminal-commands">
              <option v-for="item in allCommands" :key="item.command" :value="item.command">{{ item.label }}</option>
            </datalist>
            <div class="field-hint mt-8">
              Команда должна точно совпадать с элементом белого списка. Иначе backend вернёт 403 и запишет событие в журнал.
            </div>
          </article>

          <article v-if="loading && !presets.length" class="card">
            <div class="empty" style="padding: 30px">
              <LoaderCircle :size="20" class="spin" />
              <p>Загружаем белый список…</p>
            </div>
          </article>

          <article v-else class="card card--flush">
            <div class="file-toolbar">
              <div class="search" style="flex: 1; min-width: 140px">
                <Search :size="14" />
                <input v-model="query" class="input" placeholder="Поиск по командам…" />
              </div>
              <select v-model="group" class="select" style="width: 158px">
                <option value="all">Все группы · {{ allCommands.length }}</option>
                <option v-for="name in groups" :key="name" :value="name">
                  {{ name }} · {{ presets.find((item) => item.group === name)?.items.length ?? 0 }}
                </option>
              </select>
              <span class="pill pill--muted">{{ visibleGroups.reduce((sum, item) => sum + item.items.length, 0) }}</span>
            </div>
            <div class="list scroll-pane">
              <div v-for="preset in visibleGroups" :key="preset.group">
                <div class="section-title" style="padding: 12px 16px 6px">{{ preset.group }}</div>
                <button
                  v-for="item in preset.items"
                  :key="item.command"
                  type="button"
                  class="list-row"
                  style="width: 100%; border: none; background: none; text-align: left; cursor: pointer"
                  :disabled="running"
                  @click="run(item.command)"
                >
                  <SquareTerminal :size="15" class="file-icon" />
                  <div class="list-main">
                    <div class="list-title">{{ item.label }}</div>
                    <div class="list-meta mono">{{ item.command }}</div>
                  </div>
                  <Play :size="14" class="muted" />
                </button>
              </div>
            </div>
            <EmptyState
              v-if="!visibleGroups.length"
              compact
              title="Команды не найдены"
              text="Измените поисковый запрос или выберите другую группу."
            >
              <template #icon><Search :size="20" /></template>
            </EmptyState>
          </article>
        </div>

        <aside class="stack">
          <article class="card card--flush">
            <div class="file-toolbar">
              <div class="card-title" style="flex: 1"><SquareTerminal :size="15" /> Вывод</div>
              <button class="btn btn--ghost btn--icon btn--sm" title="Очистить вывод" :disabled="!history.length" @click="history = []">
                <Trash2 :size="14" />
              </button>
            </div>
            <div style="padding: 12px 14px">
              <div class="console console--pane">
                <div v-if="!history.length" style="color: #8b98aa">
                  Вывод появится здесь. Выберите команду слева или нажмите «Запуск».
                </div>
                <div v-for="item in history" :key="`${item.ts}-${item.command}`" class="console-block">
                  <div class="console-head">
                    <span>$ {{ item.command }}</span>
                    <span class="spacer" />
                    <span :class="item.code === 0 ? 'ok' : 'err'">exit {{ item.code }}</span>
                    <span>{{ formatDuration(item.durationMs) }}</span>
                    <span>{{ formatTime(item.ts) }}</span>
                    <button
                      type="button"
                      class="btn btn--ghost btn--icon btn--sm"
                      style="color: #9aa7b8"
                      title="Скопировать вывод"
                      @click="copyResult(item)"
                    >
                      <Copy :size="13" />
                    </button>
                  </div>
                  <pre v-if="item.stdout" class="script-block">{{ item.stdout }}</pre>
                  <pre v-if="item.stderr" class="script-block err">{{ item.stderr }}</pre>
                  <div v-if="item.timedOut" class="err">Команда прервана по таймауту.</div>
                  <div v-if="item.truncated" class="err">Вывод обрезан из-за ограничения размера.</div>
                  <div v-if="!item.stdout && !item.stderr" style="color: #8b98aa">(пустой вывод)</div>
                </div>
              </div>
            </div>
          </article>

          <article class="card card--soft">
            <div class="card-title"><Info :size="15" /> Безопасность</div>
            <ul class="check-list mt-12">
              <li><Check :size="14" /><span>Команда проверяется по белому списку до запуска.</span></li>
              <li><Check :size="14" /><span>Таймаут — 20 секунд, вывод ограничен 300 КБ.</span></li>
              <li><Check :size="14" /><span>Каждый запуск попадает в Event Center.</span></li>
              <li><Info :size="14" /><span>Сырые root-команды через HTTP не выполняются.</span></li>
            </ul>
          </article>
        </aside>
      </div>
    </template>
  </div>
</template>

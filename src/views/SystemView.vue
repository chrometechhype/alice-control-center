<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Activity,
  AlertTriangle,
  Check,
  Cpu,
  FileText,
  HardDrive,
  Info,
  LoaderCircle,
  MemoryStick,
  RefreshCw,
  Server,
  ShieldCheck,
  SquareTerminal,
  Thermometer,
  Wrench,
} from '@lucide/vue';
import OfflineState from '@/components/OfflineState.vue';
import { api, errorMessage } from '@/lib/api';
import { everConnected, isConnected, pushToast, refreshProbe, store } from '@/lib/store';
import {
  formatBytes,
  formatNumber,
  formatPct,
  formatRelative,
  formatTemp,
  formatUptime,
} from '@/lib/format';

type Tab = 'overview' | 'caps' | 'diagnostics' | 'processes' | 'logs' | 'fastfetch';

interface DiagnosticItem {
  label: string;
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

interface DiagnosticsResult {
  results: DiagnosticItem[];
  collectedAt: number;
}

interface ProcessResult {
  lines: string[];
  raw: string;
  updatedAt: number;
}

interface LogsResult {
  file: string;
  content: string;
  truncated: boolean;
}

interface FastfetchPlan {
  available: boolean;
  path: string | null;
  arch: string | null;
  steps: string[];
  notes: string[];
}

interface FastfetchResult {
  output: string;
  code: number;
  durationMs: number;
}

const tab = ref<Tab>('overview');
const busy = ref(false);
const error = ref('');
const diagnostics = ref<DiagnosticsResult | null>(null);
const processes = ref<ProcessResult | null>(null);
const logFiles = computed(() => {
  const files = store.capabilities?.logs.details?.files;
  return Array.isArray(files) ? files.filter((item): item is string => typeof item === 'string') : [];
});
const selectedLog = ref('');
const logContent = ref<LogsResult | null>(null);
const plan = ref<FastfetchPlan | null>(null);
const fastfetch = ref<FastfetchResult | null>(null);

const sample = computed(() => store.lastSample);
const info = computed(() => store.info);
const caps = computed(() => store.capabilities);

const diskPct = computed(() => {
  const used = sample.value?.diskUsedBytes;
  const total = sample.value?.diskTotalBytes;
  if (used == null || !total) return null;
  return (used / total) * 100;
});

const dataPct = computed(() => {
  const used = sample.value?.dataUsedBytes;
  const total = sample.value?.dataTotalBytes;
  if (used == null || !total) return null;
  return (used / total) * 100;
});

const thermalZones = computed(() => {
  const zones = caps.value?.thermal.details?.zones;
  return Array.isArray(zones) ? zones.filter((item): item is string => typeof item === 'string') : [];
});

interface CapabilityRow {
  label: string;
  available: boolean;
  detail: string;
}

const capabilityRows = computed<CapabilityRow[]>(() => {
  const current = caps.value;
  if (!current) return [];
  const ledZones = current.led.details?.zones;
  const ledCount = Array.isArray(ledZones) ? ledZones.length : 0;
  const logCount = logFiles.value.length;
  return [
    {
      label: 'Система',
      available: current.system.available,
      detail: current.system.available ? 'Команды диагностики разрешены' : current.system.reason || 'Недоступно',
    },
    {
      label: 'SFTP',
      available: current.sftp.available,
      detail: current.sftp.available ? 'Штатная подсистема SFTP' : current.sftp.reason || 'Работа через shell-канал',
    },
    {
      label: 'Звуки',
      available: current.sounds.available,
      detail: current.sounds.available
        ? `${current.sounds.details?.count ?? 0} файлов · ${current.sounds.details?.categories?.length ?? 0} категорий`
        : current.sounds.reason || 'Недоступно',
    },
    {
      label: 'LED',
      available: current.led.available,
      detail: current.led.available
        ? `${ledCount} зон · ${String(current.led.details?.kind ?? 'sysfs')}`
        : current.led.reason || 'Недоступно',
    },
    {
      label: 'Bluetooth',
      available: current.bluetooth.available,
      detail: current.bluetooth.available
        ? `${String(current.bluetooth.details?.adapter ?? 'адаптер')} · ${String(current.bluetooth.details?.tool ?? 'bluetoothctl')}`
        : current.bluetooth.reason || 'Недоступно',
    },
    {
      label: 'Логи',
      available: current.logs.available,
      detail: current.logs.available ? `${logCount} разрешённых файлов` : current.logs.reason || 'Недоступно',
    },
    {
      label: 'Fastfetch',
      available: current.fastfetch.available,
      detail: current.fastfetch.available
        ? String(current.fastfetch.details?.path ?? 'установлен')
        : 'Не установлен · доступна штатная диагностика',
    },
    {
      label: 'YAM',
      available: current.yam.available,
      detail: current.yam.available
        ? `Порт ${String(current.yam.details?.port ?? 8099)} · ${current.yam.details?.running ? 'запущен' : 'остановлен'}`
        : 'Не установлен · ACC не ставит автоматически',
    },
    {
      label: 'ADB',
      available: current.adb.available,
      detail: current.adb.available
        ? `Сеть: ${current.adb.details?.network ? 'включена' : 'выключена'}`
        : 'ADB не обнаружен',
    },
    {
      label: 'Термозоны',
      available: current.thermal.available,
      detail: current.thermal.available ? `${thermalZones.value.length} зон` : 'Недоступно',
    },
    {
      label: 'Датчики (IIO)',
      available: current.sensors.available,
      detail: current.sensors.available ? 'Обнаружены IIO-сенсоры' : current.sensors.reason || 'Нет IIO-сенсоров',
    },
    {
      label: 'Аудио (ALSA)',
      available: current.audio.available,
      detail: current.audio.available ? 'amixer Master доступен' : current.audio.reason || 'Недоступно',
    },
    {
      label: 'Framebuffer',
      available: current.framebuffer.available,
      detail: current.framebuffer.available ? 'Дисплейный буфер доступен' : current.framebuffer.reason || 'Нет /dev/fb0',
    },
    {
      label: 'yse',
      available: current.yse.available,
      detail: current.yse.available
        ? String(current.yse.details?.path ?? 'установлен')
        : 'Менеджер пакетов не найден',
    },
  ];
});

async function loadDiagnostics(): Promise<void> {
  if (!isConnected.value) return;
  busy.value = true;
  error.value = '';
  try {
    diagnostics.value = await api.get<DiagnosticsResult>('/system/diagnostics');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function loadProcesses(): Promise<void> {
  if (!isConnected.value) return;
  busy.value = true;
  error.value = '';
  try {
    processes.value = await api.get<ProcessResult>('/system/processes');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function loadLog(): Promise<void> {
  if (!selectedLog.value) return;
  busy.value = true;
  error.value = '';
  try {
    logContent.value = await api.get<LogsResult>(
      `/system/logs?file=${encodeURIComponent(selectedLog.value)}`,
    );
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function loadPlan(): Promise<void> {
  try {
    plan.value = await api.get<FastfetchPlan>('/system/fastfetch/plan');
  } catch {
    plan.value = null;
  }
}

async function runFastfetch(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    fastfetch.value = await api.post<FastfetchResult>('/system/fastfetch');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function refresh(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await refreshProbe();
    pushToast('ok', 'Данные устройства обновлены');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

function selectTab(next: Tab): void {
  tab.value = next;
  error.value = '';
  if (next === 'diagnostics' && !diagnostics.value) void loadDiagnostics();
  if (next === 'processes' && !processes.value) void loadProcesses();
  if (next === 'logs' && !selectedLog.value && logFiles.value.length) {
    selectedLog.value = logFiles.value[0];
    void loadLog();
  }
  if (next === 'fastfetch' && !plan.value) void loadPlan();
}

onMounted(() => {
  void loadPlan();
  if (logFiles.value.length) selectedLog.value = logFiles.value[0];
  if (isConnected.value) {
    void loadDiagnostics();
    void loadProcesses();
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Системный монитор</h1>
        <p>Реальные данные с колонки: железо, возможности прошивки, диагностика, процессы и разрешённые логи.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="busy || !isConnected" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: busy }" />
          Обновить
        </button>
        <RouterLink to="/terminal" class="btn btn--soft">
          <SquareTerminal :size="15" />
          Терминал
        </RouterLink>
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Системный монитор работает только по данным с колонки." />

    <template v-else>
      <div class="tabs">
        <button class="tab" :class="{ active: tab === 'overview' }" @click="selectTab('overview')">Обзор</button>
        <button class="tab" :class="{ active: tab === 'caps' }" @click="selectTab('caps')">Возможности</button>
        <button class="tab" :class="{ active: tab === 'diagnostics' }" @click="selectTab('diagnostics')">Диагностика</button>
        <button class="tab" :class="{ active: tab === 'processes' }" @click="selectTab('processes')">Процессы</button>
        <button class="tab" :class="{ active: tab === 'logs' }" @click="selectTab('logs')">Логи</button>
        <button class="tab" :class="{ active: tab === 'fastfetch' }" @click="selectTab('fastfetch')">Fastfetch</button>
      </div>

      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <template v-if="tab === 'overview'">
        <div class="split">
          <article class="card">
            <div class="card-head">
              <div class="card-title"><Server :size="15" /> Паспорт устройства</div>
              <span class="pill pill--ok"><Check :size="12" /> SSH</span>
            </div>
            <div class="kv">
              <div class="kv-row"><span class="kv-key">Модель</span><span class="kv-value">{{ info?.modelGuess || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Сырое имя</span><span class="kv-value mono">{{ info?.modelRaw?.replace(/\0/g, '').trim() || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Hostname</span><span class="kv-value mono">{{ info?.hostname || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Device ID</span><span class="kv-value mono">{{ info?.deviceId || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Прошивка</span><span class="kv-value mono">{{ info?.firmware || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Quasar</span><span class="kv-value mono">{{ info?.quasarVersion || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">ОС</span><span class="kv-value">{{ info?.os || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Ядро</span><span class="kv-value mono">{{ info?.kernel || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Архитектура</span><span class="kv-value mono">{{ info?.arch || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">CPU</span><span class="kv-value">{{ info?.cpuModel || '—' }} · {{ info?.cpuCores ?? '—' }} ядра</span></div>
              <div class="kv-row"><span class="kv-key">Память</span><span class="kv-value">{{ formatBytes(info?.totalMemBytes) }}</span></div>
              <div class="kv-row"><span class="kv-key">IP</span><span class="kv-value mono">{{ info?.ip || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Wi-Fi RSSI</span><span class="kv-value mono">{{ sample?.wifiRssi != null ? `${sample.wifiRssi} dBm` : '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">Uptime</span><span class="kv-value">{{ formatUptime(sample?.uptimeSec ?? info?.uptimeSec) }}</span></div>
              <div class="kv-row"><span class="kv-key">Собрано</span><span class="kv-value">{{ formatRelative(info?.collectedAt) }}</span></div>
            </div>
          </article>

          <div class="stack">
            <article class="card">
              <div class="card-title"><Activity :size="15" /> Сейчас</div>
              <div class="stack mt-12" style="gap: 12px">
                <div>
                  <div class="row"><Cpu :size="14" /><span class="soft">CPU</span><span class="spacer" /><strong>{{ formatPct(sample?.cpuPct) }}</strong></div>
                  <div class="bar mt-8"><span :style="{ width: `${Math.min(100, sample?.cpuPct ?? 0)}%` }" /></div>
                </div>
                <div>
                  <div class="row"><MemoryStick :size="14" /><span class="soft">RAM</span><span class="spacer" /><strong>{{ formatPct(sample?.memPct) }}</strong></div>
                  <div class="bar mt-8"><span :style="{ width: `${Math.min(100, sample?.memPct ?? 0)}%` }" /></div>
                  <div class="field-hint mt-8">{{ formatBytes(sample?.memUsedBytes) }} из {{ formatBytes(sample?.memTotalBytes) }}</div>
                </div>
                <div>
                  <div class="row"><Thermometer :size="14" /><span class="soft">Температура</span><span class="spacer" /><strong>{{ formatTemp(sample?.tempC) }}</strong></div>
                </div>
                <div>
                  <div class="row"><Activity :size="14" /><span class="soft">Load average</span><span class="spacer" /><strong class="mono">{{ sample?.load1 != null ? formatNumber(sample.load1, 2) : '—' }}</strong></div>
                </div>
              </div>
            </article>

            <article class="card">
              <div class="card-title"><HardDrive :size="15" /> Накопители</div>
              <div class="stack mt-12" style="gap: 12px">
                <div>
                  <div class="row"><span class="soft">Корневая ФС</span><span class="spacer" /><span class="mono">{{ diskPct != null ? formatPct(diskPct) : '—' }}</span></div>
                  <div class="bar mt-8" :class="{ 'bar--red': (diskPct ?? 0) > 85 }">
                    <span :style="{ width: `${Math.min(100, diskPct ?? 0)}%` }" />
                  </div>
                  <div class="field-hint mt-8">{{ formatBytes(sample?.diskUsedBytes) }} / {{ formatBytes(sample?.diskTotalBytes) }}</div>
                </div>
                <div>
                  <div class="row"><span class="soft">/data</span><span class="spacer" /><span class="mono">{{ dataPct != null ? formatPct(dataPct) : '—' }}</span></div>
                  <div class="bar mt-8"><span :style="{ width: `${Math.min(100, dataPct ?? 0)}%` }" /></div>
                  <div class="field-hint mt-8">{{ formatBytes(sample?.dataUsedBytes) }} / {{ formatBytes(sample?.dataTotalBytes) }}</div>
                </div>
              </div>
            </article>

            <article v-if="store.warnings.length" class="card card--soft">
              <div class="card-title"><AlertTriangle :size="15" /> Что панель не может</div>
              <div class="stack mt-12" style="gap: 8px">
                <div v-for="warning in store.warnings" :key="warning" class="field-hint warn-hint">
                  {{ warning }}
                </div>
              </div>
            </article>
          </div>
        </div>
      </template>

      <article v-else-if="tab === 'caps'" class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><ShieldCheck :size="15" /> Реальные возможности</div>
            <div class="card-sub">Определены probe-скриптом при подключении. «Недоступно» означает отсутствие функции на этой прошивке.</div>
          </div>
          <button class="btn btn--sm" :disabled="busy" @click="refresh">
            <RefreshCw :size="14" :class="{ spin: busy }" />
            Перепроверить
          </button>
        </div>
        <div class="cap-grid">
          <div v-for="row in capabilityRows" :key="row.label" class="cap-card">
            <div class="row">
              <h4>{{ row.label }}</h4>
              <span class="spacer" />
              <span class="pill" :class="row.available ? 'pill--ok' : 'pill--muted'">
                {{ row.available ? 'Доступно' : 'Недоступно' }}
              </span>
            </div>
            <p>{{ row.detail }}</p>
          </div>
        </div>
        <div v-if="thermalZones.length" class="alert alert--info mt-16">
          <Info :size="15" />
          <div>Термозоны: <span class="mono">{{ thermalZones.join(', ') }}</span></div>
        </div>
      </article>

      <article v-else-if="tab === 'diagnostics'" class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Wrench :size="15" /> Диагностика</div>
            <div class="card-sub">Только разрешённые read-only команды. Каждая выполняется отдельно.</div>
          </div>
          <button class="btn btn--sm" :disabled="busy" @click="loadDiagnostics">
            <RefreshCw :size="14" :class="{ spin: busy }" />
            Выполнить
          </button>
        </div>
        <div v-if="busy && !diagnostics" class="empty" style="padding: 30px">
          <LoaderCircle :size="20" class="spin" />
          <p>Собираем диагностику…</p>
        </div>
        <div v-else-if="diagnostics" class="stack" style="gap: 10px">
          <div v-for="item in diagnostics.results" :key="item.command" class="card card--soft">
            <details>
              <summary style="cursor: pointer; display: flex; align-items: center; gap: 10px">
                <strong style="font-size: 12.5px">{{ item.label }}</strong>
                <span class="code-inline">{{ item.command }}</span>
                <span class="spacer" />
                <span class="pill" :class="item.code === 0 ? 'pill--ok' : 'pill--warn'">
                  код {{ item.code ?? 'ошибка' }}
                </span>
              </summary>
              <pre class="console mt-12">{{ item.stdout || item.stderr || 'Пустой вывод' }}</pre>
            </details>
          </div>
          <div class="field-hint">Собрано {{ formatRelative(diagnostics.collectedAt) }}</div>
        </div>
      </article>

      <article v-else-if="tab === 'processes'" class="card">
        <div class="card-head">
          <div class="card-title"><Activity :size="15" /> Процессы</div>
          <button class="btn btn--sm" :disabled="busy" @click="loadProcesses">
            <RefreshCw :size="14" :class="{ spin: busy }" />
            Обновить
          </button>
        </div>
        <pre v-if="processes" class="console">{{ processes.raw }}</pre>
        <div v-else class="empty" style="padding: 26px">
          <LoaderCircle v-if="busy" :size="20" class="spin" />
          <p>{{ busy ? 'Читаем список процессов…' : 'Нажмите «Обновить», чтобы прочитать ps.' }}</p>
        </div>
      </article>

      <article v-else-if="tab === 'logs'" class="card">
        <div class="card-head">
          <div class="card-title"><FileText :size="15" /> Разрешённые логи</div>
          <span class="pill pill--muted">{{ logFiles.length }} файлов</span>
        </div>
        <div v-if="!logFiles.length" class="empty" style="padding: 26px">
          <FileText :size="20" />
          <p>На этой прошивке разрешённые логи не обнаружены.</p>
        </div>
        <template v-else>
          <div class="toolbar mb-8">
            <select v-model="selectedLog" class="select" style="max-width: 320px" @change="loadLog">
              <option v-for="file in logFiles" :key="file" :value="file">{{ file }}</option>
            </select>
            <button class="btn btn--sm" :disabled="busy || !selectedLog" @click="loadLog">
              <RefreshCw :size="14" :class="{ spin: busy }" />
              Прочитать
            </button>
            <span v-if="logContent?.truncated" class="pill pill--warn">Вывод обрезан</span>
          </div>
          <pre v-if="logContent" class="console">{{ logContent.content || 'Файл пуст' }}</pre>
          <div v-else class="empty" style="padding: 26px"><p>Выберите файл и нажмите «Прочитать».</p></div>
        </template>
      </article>

      <article v-else class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Wrench :size="15" /> Fastfetch</div>
            <div class="card-sub">Внешний бинарник не скачивается и не устанавливается автоматически.</div>
          </div>
          <span v-if="plan" class="pill" :class="plan.available ? 'pill--ok' : 'pill--muted'">
            {{ plan.available ? 'Установлен' : 'Не установлен' }}
          </span>
        </div>
        <div v-if="plan?.available" class="stack" style="gap: 12px">
          <div class="kv">
            <div class="kv-row"><span class="kv-key">Путь</span><span class="kv-value mono">{{ plan.path || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Архитектура</span><span class="kv-value mono">{{ plan.arch || '—' }}</span></div>
          </div>
          <button class="btn btn--primary" :disabled="busy" @click="runFastfetch">
            <LoaderCircle v-if="busy" :size="15" class="spin" />
            <Wrench v-else :size="15" />
            Запустить fastfetch
          </button>
          <pre v-if="fastfetch" class="console">{{ fastfetch.output }}</pre>
        </div>
        <div v-else-if="plan" class="stack" style="gap: 12px">
          <div class="alert alert--warn">
            <AlertTriangle :size="15" />
            <div>Fastfetch не установлен. ACC не скачивает случайные бинарники и не запускает их на колонке.</div>
          </div>
          <div class="section-title">Как установить вручную (вне ACC)</div>
          <ol class="info-list" style="padding-left: 18px; list-style: decimal">
            <li v-for="item in plan.steps" :key="item" style="margin-left: 6px">{{ item }}</li>
          </ol>
          <div class="stack" style="gap: 6px">
            <div v-for="note in plan.notes" :key="note" class="field-hint">• {{ note }}</div>
          </div>
        </div>
        <div v-else class="empty" style="padding: 26px">
          <LoaderCircle :size="20" class="spin" />
          <p>Проверяем наличие fastfetch…</p>
        </div>
      </article>
    </template>
  </div>
</template>

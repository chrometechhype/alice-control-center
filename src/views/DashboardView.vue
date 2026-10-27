<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Activity,
  AlertTriangle,
  Archive,
  AudioLines,
  Check,
  Cpu,
  FolderOpen,
  HardDrive,
  Info,
  Lightbulb,
  MemoryStick,
  RefreshCw,
  ShieldCheck,
  Signal,
  SquareTerminal,
  Thermometer,
  Volume2,
  VolumeX,
  Workflow,
  X,
  Zap,
} from '@lucide/vue';
import Sparkline from '@/components/Sparkline.vue';
import EmptyState from '@/components/EmptyState.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import StatusPill from '@/components/StatusPill.vue';
import DevicePortrait from '@/components/DevicePortrait.vue';
import { detectDeviceVisual } from '@/lib/deviceVisual';
import { api, errorMessage } from '@/lib/api';
import {
  isConnected,
  pushToast,
  reconnectDevice,
  refreshBackups,
  refreshProbe,
  store,
} from '@/lib/store';
import {
  clamp,
  formatBytes,
  formatNumber,
  formatPct,
  formatRelative,
  formatRssi,
  formatTemp,
  formatTime,
  formatUptime,
  kindLabel,
} from '@/lib/format';

interface AudioState {
  volumePct: number | null;
  volumeRaw: number | null;
  max: number | null;
  muted: boolean | null;
}

const sample = computed(() => store.lastSample);
const info = computed(() => store.info);
const visual = computed(() => detectDeviceVisual(store.info));
const heroTitle = computed(() => (isConnected.value ? visual.value.label : 'Колонка не подключена'));
const history = computed(() => store.metrics);
const ledAvailable = computed(() => Boolean(store.capabilities?.led.available));
const recentEvents = computed(() => store.events.slice(0, 8));
const lastBackups = computed(() => store.backups.slice(0, 3));

const cpuValues = computed(() => history.value.map((item) => item.cpuPct));
const memValues = computed(() => history.value.map((item) => item.memPct));
const tempValues = computed(() => history.value.map((item) => item.tempC));
const wifiValues = computed(() => history.value.map((item) => item.wifiRssi ?? null));

const CHART = { width: 760, height: 216, left: 38, right: 12, top: 14, bottom: 26 };

function linePath(values: Array<number | null | undefined>): string {
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  let path = '';
  let drawing = false;
  values.forEach((value, index) => {
    if (value == null || !Number.isFinite(value)) {
      drawing = false;
      return;
    }
    const x = CHART.left + (values.length > 1 ? (index / (values.length - 1)) * plotWidth : plotWidth / 2);
    const y = CHART.top + (1 - clamp(value, 0, 100) / 100) * plotHeight;
    path += `${drawing ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    drawing = true;
  });
  return path;
}

const cpuPath = computed(() => linePath(cpuValues.value));
const memPath = computed(() => linePath(memValues.value));
const gridLines = computed(() =>
  [0, 25, 50, 75, 100].map((value) => ({
    value,
    y:
      CHART.top +
      (1 - value / 100) * (CHART.height - CHART.top - CHART.bottom),
  })),
);
const chartFrom = computed(() =>
  history.value.length ? formatTime(history.value[0].ts) : '—',
);
const chartTo = computed(() =>
  history.value.length ? formatTime(history.value[history.value.length - 1].ts) : '—',
);
const chartEmpty = computed(() => history.value.length < 2);

const audio = ref<AudioState | null>(null);
const volume = ref(50);
const audioBusy = ref(false);

async function loadAudio(): Promise<void> {
  if (!isConnected.value) return;
  try {
    const state = await api.get<AudioState>('/audio');
    audio.value = state;
    if (state.volumePct != null) volume.value = state.volumePct;
  } catch {
    audio.value = null;
  }
}

async function applyVolume(): Promise<void> {
  if (!isConnected.value) return;
  audioBusy.value = true;
  try {
    const state = await api.post<AudioState>('/audio/volume', { percent: volume.value });
    audio.value = state;
    if (state.volumePct != null) volume.value = state.volumePct;
    pushToast('ok', `Громкость: ${volume.value}%`);
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    audioBusy.value = false;
  }
}

async function toggleMute(): Promise<void> {
  if (!isConnected.value) return;
  audioBusy.value = true;
  try {
    const next = !(audio.value?.muted ?? false);
    const state = await api.post<AudioState>('/audio/mute', { muted: next });
    audio.value = state;
    pushToast('info', next ? 'Звук выключен' : 'Звук включён');
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    audioBusy.value = false;
  }
}

async function quickLed(): Promise<void> {
  const hex = visual.value.accent.replace('#', '');
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  try {
    await api.post('/led/apply', {
      zones: [rgb, rgb, rgb],
    });
    pushToast('ok', 'LED переведены в цвет станции');
  } catch (error) {
    pushToast('error', errorMessage(error));
  }
}

const backupDialog = ref(false);
const backupBusy = ref(false);

async function createConfigBackup(): Promise<void> {
  backupBusy.value = true;
  try {
    const manifest = await api.post<{ id: string; items: unknown[] }>('/backups/config', {
      confirm: true,
      note: 'Бэкап из обзора ACC',
    });
    await refreshBackups();
    backupDialog.value = false;
    pushToast('ok', `Бэкап конфигурации создан (${manifest.items.length} файлов)`);
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    backupBusy.value = false;
  }
}

const probeBusy = ref(false);

async function refresh(): Promise<void> {
  probeBusy.value = true;
  try {
    await refreshProbe();
    pushToast('ok', 'Данные обновлены');
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    probeBusy.value = false;
  }
}

const reconnectBusy = ref(false);

async function reconnect(): Promise<void> {
  reconnectBusy.value = true;
  try {
    await reconnectDevice();
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    reconnectBusy.value = false;
  }
}

function eventIcon(level: string) {
  if (level === 'success') return Check;
  if (level === 'warn') return AlertTriangle;
  if (level === 'error') return X;
  return Info;
}

onMounted(() => {
  void loadAudio();
  void refreshBackups().catch(() => undefined);
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Обзор</h1>
        <p>Живое состояние колонки, метрики и быстрые действия. Данные приходят с backend по WebSocket.</p>
      </div>
    </div>

    <section class="hero">
      <div class="hero-main">
        <h2>{{ heroTitle }}</h2>
        <div v-if="isConnected && info?.modelRaw" class="hero-model">
          <span class="hero-model__raw">{{ info.modelRaw.replace(/\0/g, '').trim() }}</span>
        </div>
        <p v-if="!isConnected" class="hero-desc">
          {{ store.status.lastError || 'Укажите адрес SSH и пароль в мастере подключения. Backend по умолчанию слушает только 127.0.0.1.' }}
        </p>
        <div class="hero-actions">
          <button v-if="isConnected" class="btn btn--soft" :disabled="probeBusy" @click="refresh">
            <RefreshCw :size="15" :class="{ spin: probeBusy }" />
            Перечитать устройство
          </button>
          <RouterLink v-if="isConnected" to="/system" class="btn">
            <Activity :size="15" />
            Диагностика
          </RouterLink>
          <button v-else class="btn btn--primary" :disabled="reconnectBusy" @click="reconnect">
            <Zap :size="15" :class="{ spin: reconnectBusy }" />
            Повторить подключение
          </button>
        </div>
      </div>
      <div class="hero-art">
        <DevicePortrait :info="info" size="lg" :muted="!isConnected" />
      </div>
    </section>

    <template v-if="isConnected">
      <div class="grid grid-4">
        <article class="card stat">
          <div class="stat-top">
            <span class="stat-label">CPU</span>
            <span class="pill pill--muted"><Cpu :size="13" /></span>
          </div>
          <div class="stat-value">{{ formatPct(sample?.cpuPct) }}</div>
          <Sparkline :values="cpuValues" tone="primary" />
          <div class="stat-foot">
            <span>{{ info?.cpuCores ?? '—' }} ядра · {{ info?.cpuModel || 'CPU' }}</span>
            <span class="mono">{{ sample?.load1 != null ? `load ${formatNumber(sample.load1, 2)}` : 'load —' }}</span>
          </div>
        </article>

        <article class="card stat">
          <div class="stat-top">
            <span class="stat-label">Память</span>
            <span class="pill pill--muted"><MemoryStick :size="13" /></span>
          </div>
          <div class="stat-value">
            {{ formatPct(sample?.memPct) }}
            <small>{{ formatBytes(sample?.memUsedBytes) }}</small>
          </div>
          <Sparkline :values="memValues" tone="violet" />
          <div class="stat-foot">
            <span>Всего {{ formatBytes(sample?.memTotalBytes ?? info?.totalMemBytes) }}</span>
            <span class="mono">RAM</span>
          </div>
        </article>

        <article class="card stat">
          <div class="stat-top">
            <span class="stat-label">Температура</span>
            <span class="pill pill--muted"><Thermometer :size="13" /></span>
          </div>
          <div class="stat-value">{{ formatTemp(sample?.tempC) }}</div>
          <Sparkline :values="tempValues" tone="red" :max="100" />
          <div class="stat-foot">
            <span>Термозона SoC</span>
            <span class="mono">thermal</span>
          </div>
        </article>

        <article class="card stat">
          <div class="stat-top">
            <span class="stat-label">Wi-Fi</span>
            <span class="pill pill--muted"><Signal :size="13" /></span>
          </div>
          <div class="stat-value">{{ formatRssi(sample?.wifiRssi) }}</div>
          <Sparkline :values="wifiValues" tone="green" :min="-100" :max="0" />
          <div class="stat-foot">
            <span>{{ info?.ip || 'IP неизвестен' }}</span>
            <span class="mono">RSSI</span>
          </div>
        </article>
      </div>

      <div class="split">
        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Activity :size="15" /> Динамика метрик</div>
              <div class="card-sub">Последние {{ history.length }} точек · опрос каждые {{ Math.round((store.settings?.pollIntervalMs ?? 5000) / 1000) }} с</div>
            </div>
            <div class="chart-legend">
              <span><i class="legend-dot" style="background: var(--primary)" /> CPU</span>
              <span><i class="legend-dot" style="background: var(--violet)" /> RAM</span>
            </div>
          </div>
          <div v-if="chartEmpty" class="empty" style="padding: 26px 12px">
            <Activity :size="22" />
            <p>Накопите несколько измерений — история появится через пару циклов опроса.</p>
          </div>
          <template v-else>
            <svg
              class="metric-chart"
              :viewBox="`0 0 ${CHART.width} ${CHART.height}`"
              preserveAspectRatio="none"
              role="img"
              aria-label="График CPU и памяти"
            >
              <g>
                <line
                  v-for="line in gridLines"
                  :key="line.value"
                  :x1="CHART.left"
                  :x2="CHART.width - CHART.right"
                  :y1="line.y"
                  :y2="line.y"
                  class="chart-grid"
                />
                <text
                  v-for="line in gridLines"
                  :key="`label-${line.value}`"
                  :x="CHART.left - 8"
                  :y="line.y + 3"
                  text-anchor="end"
                  class="chart-axis"
                >
                  {{ line.value }}
                </text>
              </g>
              <path :d="memPath" class="chart-line chart-line--violet" />
              <path :d="cpuPath" class="chart-line chart-line--primary" />
              <text :x="CHART.left" :y="CHART.height - 8" class="chart-axis">{{ chartFrom }}</text>
              <text :x="CHART.width - CHART.right" :y="CHART.height - 8" text-anchor="end" class="chart-axis">
                {{ chartTo }}
              </text>
            </svg>
          </template>
        </article>

        <article class="card">
          <div class="card-head">
            <div class="card-title"><HardDrive :size="15" /> Устройство</div>
            <StatusPill :state="store.status.state" />
          </div>
          <div class="kv">
            <div class="kv-row"><span class="kv-key">Hostname</span><span class="kv-value mono">{{ info?.hostname || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Модель</span><span class="kv-value">{{ info?.modelGuess || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Device ID</span><span class="kv-value mono">{{ info?.deviceId || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Прошивка</span><span class="kv-value mono">{{ info?.firmware || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Quasar</span><span class="kv-value mono">{{ info?.quasarVersion || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Ядро</span><span class="kv-value mono">{{ info?.kernel || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Архитектура</span><span class="kv-value mono">{{ info?.arch || '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Диск</span><span class="kv-value">{{ sample?.diskTotalBytes ? `${formatBytes(sample.diskUsedBytes)} / ${formatBytes(sample.diskTotalBytes)}` : '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">/data</span><span class="kv-value">{{ sample?.dataTotalBytes ? `${formatBytes(sample.dataUsedBytes)} / ${formatBytes(sample.dataTotalBytes)}` : '—' }}</span></div>
            <div class="kv-row"><span class="kv-key">Uptime</span><span class="kv-value">{{ formatUptime(sample?.uptimeSec ?? info?.uptimeSec) }}</span></div>
          </div>
          <div v-if="store.warnings.length" class="stack mt-12" style="gap: 8px">
            <div v-for="warning in store.warnings" :key="warning" class="alert alert--warn">
              <AlertTriangle :size="15" />
              <div>{{ warning }}</div>
            </div>
          </div>
        </article>
      </div>

      <div class="split">
        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Zap :size="15" /> Быстрые действия</div>
              <div class="card-sub">Громкость ALSA и переходы в модули</div>
            </div>
            <span class="pill pill--muted">{{ audio?.volumePct != null ? `${audio.volumePct}%` : 'ALSA' }}</span>
          </div>

          <div class="audio-box">
            <button
              type="button"
              class="btn btn--icon"
              :disabled="audioBusy"
              :title="audio?.muted ? 'Включить звук' : 'Выключить звук'"
              @click="toggleMute"
            >
              <VolumeX v-if="audio?.muted" :size="16" />
              <Volume2 v-else :size="16" />
            </button>
            <input
              v-model.number="volume"
              type="range"
              min="0"
              max="100"
              step="1"
              class="range"
              :disabled="audioBusy"
              @change="applyVolume"
            />
            <span class="mono nowrap">{{ volume }}%</span>
          </div>
          <div v-if="audio?.muted" class="field-hint mt-8">Звук выключен на устройстве.</div>

          <div class="actions-grid mt-16">
            <RouterLink to="/sounds" class="action-tile">
              <AudioLines :size="17" />
              <span>Sound Studio</span>
              <small>{{ store.capabilities?.sounds.details?.count ?? 0 }} файлов</small>
            </RouterLink>
            <button v-if="ledAvailable" type="button" class="action-tile" @click="quickLed">
              <Lightbulb :size="17" />
              <span>LED в цвет станции</span>
              <small>3 зоны</small>
            </button>
            <RouterLink to="/files" class="action-tile">
              <FolderOpen :size="17" />
              <span>Файлы</span>
              <small>Разрешённые каталоги</small>
            </RouterLink>
            <RouterLink to="/terminal" class="action-tile">
              <SquareTerminal :size="17" />
              <span>Терминал</span>
              <small>Белый список</small>
            </RouterLink>
            <RouterLink to="/automation" class="action-tile">
              <Workflow :size="17" />
              <span>Сценарии</span>
              <small>Реальные события</small>
            </RouterLink>
          </div>
        </article>

        <article class="card card--flush">
          <div class="card-head" style="padding: 18px 20px 0; margin-bottom: 10px">
            <div class="card-title"><Activity :size="15" /> Последние события</div>
            <RouterLink to="/events" class="btn btn--ghost btn--sm">Все события</RouterLink>
          </div>
          <div v-if="recentEvents.length" class="list">
            <div v-for="event in recentEvents" :key="event.id" class="event-row">
              <span class="event-level" :class="`event-level--${event.level}`">
                <component :is="eventIcon(event.level)" :size="13" />
              </span>
              <div class="list-main">
                <div class="list-title">{{ event.message }}</div>
                <div class="list-meta">{{ event.module }} · {{ event.operation }} · {{ formatRelative(event.ts) }}</div>
              </div>
            </div>
          </div>
          <EmptyState v-else title="Журнал пуст" text="События появятся после подключения и первых действий." />
        </article>
      </div>

      <div class="grid grid-2">
        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Archive :size="15" /> Бэкапы</div>
              <div class="card-sub">Хранятся на этом компьютере в data/backups</div>
            </div>
            <RouterLink to="/backups" class="btn btn--ghost btn--sm">Открыть</RouterLink>
          </div>
          <div v-if="lastBackups.length" class="list" style="margin: 0 -20px -18px">
            <div v-for="backup in lastBackups" :key="backup.id" class="list-row">
              <span class="event-level event-level--info"><Archive :size="13" /></span>
              <div class="list-main">
                <div class="list-title">{{ backup.title }}</div>
                <div class="list-meta">{{ kindLabel(backup.kind) }} · {{ backup.items.length }} файлов · {{ formatRelative(backup.createdAt) }}</div>
              </div>
            </div>
          </div>
          <div v-else class="empty" style="padding: 18px">
            <Archive :size="20" />
            <p>Резервных копий пока нет. Сохраните конфигурацию Quasar перед изменениями.</p>
          </div>
          <button class="btn btn--soft mt-12" @click="backupDialog = true">
            <Archive :size="15" />
            Бэкап конфигурации
          </button>
        </article>

        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><ShieldCheck :size="15" /> Безопасность</div>
              <div class="card-sub">Правила, которые backend соблюдает всегда</div>
            </div>
            <span class="pill" :class="store.settings?.lanAccess ? 'pill--warn' : 'pill--ok'">
              {{ store.settings?.lanAccess ? 'LAN включён' : 'Только localhost' }}
            </span>
          </div>
          <div class="stack" style="gap: 8px">
            <div class="alert">
              <ShieldCheck :size="15" />
              <div>
                Backend слушает {{ store.settings?.lanAccess ? '0.0.0.0 и требует токен для удалённых запросов' : 'только 127.0.0.1 — с телефона панель недоступна' }}.
              </div>
            </div>
            <div class="alert">
              <ShieldCheck :size="15" />
              <div>Пароль SSH хранится в data/config.json (0600) и никогда не отдаётся frontend.</div>
            </div>
            <div class="alert alert--info">
              <Info :size="15" />
              <div>Опасные операции требуют подтверждения, а команды терминала ограничены белым списком.</div>
            </div>
          </div>
          <RouterLink to="/settings" class="btn mt-12">
            Настройки доступа
          </RouterLink>
        </article>
      </div>
    </template>

    <article v-else class="card">
      <EmptyState
        title="Нет активного подключения"
        text="Проверьте, что колонка включена и SSH доступен по локальной сети. Backend не перезапускает станцию автоматически."
      >
        <template #icon><ShieldCheck :size="22" /></template>
        <div class="btn-row mt-12">
          <button class="btn btn--primary" :disabled="reconnectBusy" @click="reconnect">
            <RefreshCw :size="15" :class="{ spin: reconnectBusy }" />
            Повторить подключение
          </button>
          <RouterLink to="/setup" class="btn">Открыть мастер</RouterLink>
        </div>
      </EmptyState>
      <div v-if="store.status.lastError" class="alert alert--error mt-12">
        <AlertTriangle :size="16" />
        <div>{{ store.status.lastError }}</div>
      </div>
    </article>

    <ConfirmDialog
      :open="backupDialog"
      title="Бэкап конфигурации"
      message="Будут прочитаны ключевые файлы Quasar и конфигурации Bluetooth/ALSA. Файлы сохранятся на этом компьютере, запись на устройство не выполняется."
      confirm-label="Создать бэкап"
      :danger="false"
      :busy="backupBusy"
      @cancel="backupDialog = false"
      @confirm="createConfigBackup"
    />
  </div>
</template>

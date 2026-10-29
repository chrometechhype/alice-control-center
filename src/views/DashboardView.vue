<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  Activity,
  AlertTriangle,
  Archive,
  AudioLines,
  Check,
  ChevronRight,
  Copy,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  GitFork,
  HardDrive,
  Info,
  Lightbulb,
  MemoryStick,
  Package,
  RefreshCw,
  ShieldCheck,
  Signal,
  SquareTerminal,
  Star,
  Thermometer,
  Users,
  Volume2,
  Wifi,
  Workflow,
  X,
  Zap,
} from '@lucide/vue';
import type { WifiStatus } from '@shared/types';
import Sparkline from '@/components/Sparkline.vue';
import EmptyState from '@/components/EmptyState.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import DevicePortrait from '@/components/DevicePortrait.vue';
import VolumeControl from '@/components/VolumeControl.vue';
import { detectDeviceVisual } from '@/lib/deviceVisual';
import { api, errorMessage } from '@/lib/api';
import { everConnected, isConnected, loadInsights, loadPresence, pushToast, reconnectDevice, refreshBackups, refreshProbe, store } from '@/lib/store';
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

const sample = computed(() => store.lastSample);
const info = computed(() => store.info);
const visual = computed(() => detectDeviceVisual(store.info));
const heroTitle = computed(() => {
  if (isConnected.value) return visual.value.label;
  if (store.status.state === 'reconnecting') return 'Колонка не отвечает';
  if (store.status.state === 'connecting') return 'Подключаемся к колонке';
  return 'Колонка не подключена';
});
/** «Не подключена» is wrong while the panel is already retrying a known address — say what is happening. */
const heroDesc = computed(() => {
  if (isConnected.value) return null;
  const status = store.status;
  if (status.state === 'reconnecting' || status.state === 'connecting') {
    const stability = status.stability;
    if (stability && stability.mode !== 'stable') {
      const every = Math.round(stability.pollIntervalMs / 1000);
      return `Панель ищет колонку в сети и не мешает ей: обрывов за 3 мин — ${stability.drops}, опрос раз в ${every} с.`;
    }
    return 'Панель ищет колонку в сети и подключится сама, как только та ответит. Обычно это её перезагрузка или новый адрес по DHCP.';
  }
  if (status.lastError) return status.lastError;
  if (!everConnected.value) {
    return 'Укажите адрес SSH и пароль в мастере подключения. Backend по умолчанию слушает только 127.0.0.1.';
  }
  return 'Колонка не отвечает. Проверьте, что она включена и доступна по локальной сети.';
});
const history = computed(() => store.metrics);
const ledAvailable = computed(() => Boolean(store.capabilities?.led.available));
const recentEvents = computed(() => store.events.slice(0, 6));
const lastBackups = computed(() => store.backups.slice(0, 3));
const soundCount = computed(() => store.capabilities?.sounds.details?.count ?? 0);

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

const wifi = ref<WifiStatus | null>(null);
const wifiRevealed = ref(false);
const wifiBusy = ref(false);
const wifiPsk = computed(() => wifi.value?.connected?.psk ?? null);

async function loadWifi(): Promise<void> {
  if (!isConnected.value) return;
  wifiBusy.value = true;
  try {
    wifi.value = await api.get<WifiStatus>('/wifi/status', 25_000);
  } catch {
    // Wi-Fi — дополнение к обзору: если станция не отдала wpa_cli, карточка честно скажет «нет данных».
    wifi.value = null;
  } finally {
    wifiBusy.value = false;
  }
}

async function copyWifiPassword(): Promise<void> {
  if (!wifiPsk.value) return;
  try {
    await navigator.clipboard.writeText(wifiPsk.value);
    pushToast('ok', 'Пароль Wi-Fi скопирован');
  } catch {
    pushToast('error', 'Браузер не дал доступ к буферу — раскройте пароль и скопируйте вручную');
  }
}

async function refresh(): Promise<void> {
  probeBusy.value = true;
  try {
    await refreshProbe();
    void loadWifi();
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
  void refreshBackups().catch(() => undefined);
  void loadInsights();
  void loadPresence();
});

const insightsBusy = ref(false);

async function reloadInsights(): Promise<void> {
  insightsBusy.value = true;
  try {
    await Promise.all([loadInsights(true), loadPresence()]);
  } finally {
    insightsBusy.value = false;
  }
}

const countFormat = new Intl.NumberFormat('ru-RU');

function formatCount(value: number): string {
  return countFormat.format(value);
}

watch(
  isConnected,
  (connectedNow) => {
    if (connectedNow) void loadWifi();
    else wifi.value = null;
  },
  { immediate: true },
);
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
        <p v-if="heroDesc" class="hero-desc">{{ heroDesc }}</p>
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
          <RouterLink v-if="!isConnected" to="/setup" class="btn">Открыть мастер</RouterLink>
        </div>
      </div>
      <div class="hero-art">
        <DevicePortrait :info="info" size="lg" :muted="!isConnected" />
      </div>
    </section>

    <div v-if="!isConnected && store.status.lastError" class="alert alert--error">
      <AlertTriangle :size="16" />
      <div>{{ store.status.lastError }}</div>
    </div>

    <section v-if="store.insights" class="owner-strip" aria-label="Статистика репозитория">
      <span class="owner-strip__item">
        <Download :size="15" />
        <strong>{{ formatCount(store.insights.totalDownloads) }}</strong>
        скачиваний
      </span>
      <span v-if="store.insights.latest" class="owner-strip__item">
        <Package :size="15" />
        <strong>{{ formatCount(store.insights.latest.downloads) }}</strong>
        у {{ store.insights.latest.version }}
      </span>
      <span v-if="store.presence.online != null" class="owner-strip__item" :title="`Запущенные панели с включённой галочкой «Участвовать в статистике», за последние ${Math.round(store.presence.windowSec / 60)} минут`">
        <Users :size="15" />
        <strong>{{ formatCount(store.presence.online) }}</strong>
        в сети
      </span>
      <span class="owner-strip__item">
        <Star :size="15" />
        {{ formatCount(store.insights.stars) }}
      </span>
      <span class="owner-strip__item">
        <GitFork :size="15" />
        {{ formatCount(store.insights.forks) }}
      </span>
      <span class="owner-strip__note">обновлено {{ formatRelative(store.insights.checkedAt) }}</span>
      <button
        type="button"
        class="btn btn--ghost btn--icon btn--sm"
        title="Обновить цифры"
        :disabled="insightsBusy"
        @click="reloadInsights"
      >
        <RefreshCw :size="14" :class="{ spin: insightsBusy }" />
      </button>
    </section>

    <template v-if="isConnected">
      <div class="ov">
        <article class="card stat ov-3">
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

        <article class="card stat ov-3">
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

        <article class="card stat ov-3">
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

        <article class="card stat ov-3">
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

        <article class="card ov-12 volume-card">
          <div class="card-head">
            <div class="card-title"><Volume2 :size="15" /> Громкость</div>
            <span v-if="store.audio.state?.volumePct != null" class="pill pill--muted">
              {{ store.audio.state.volumePct }}%
            </span>
          </div>
          <div class="volume-card__control">
            <VolumeControl />
          </div>
        </article>

        <article class="card ov-12 wifi-card">
          <div class="wifi-card__net">
            <div class="stat-top">
              <span class="stat-label">Сеть Wi-Fi</span>
              <span class="pill" :class="wifi?.connected ? 'pill--ok' : 'pill--muted'">
                {{ wifi?.connected ? 'подключено' : wifiBusy ? 'читаем…' : 'нет данных' }}
              </span>
            </div>
            <div class="wifi-card__ssid">
              <Wifi :size="18" class="muted" />
              <strong>{{ wifi?.connected?.ssid ?? '—' }}</strong>
            </div>
            <div class="stat-foot">
              <span class="mono">{{ wifi?.connected?.ip ?? info?.ip ?? 'IP неизвестен' }}</span>
              <span v-if="wifi?.connected?.keyMgmt" class="pill pill--muted">{{ wifi.connected.keyMgmt }}</span>
              <span v-if="wifi?.connected?.freq" class="mono">{{ wifi.connected.freq }} МГц</span>
            </div>
          </div>

          <div class="wifi-card__psk">
            <div class="stat-top">
              <span class="stat-label">Пароль</span>
            </div>
            <div class="wifi-card__value mono">
              {{ wifiPsk ? (wifiRevealed ? wifiPsk : '••••••••') : '—' }}
            </div>
            <div class="stat-foot">
              <span class="truncate" style="max-width: 220px">
                {{ wifi?.configPath ?? '/bkupgrade/data/wpa_supplicant.conf' }}
              </span>
              <span v-if="wifiPsk" class="row" style="gap: 2px">
                <button
                  type="button"
                  class="btn btn--ghost btn--icon btn--sm"
                  :title="wifiRevealed ? 'Скрыть пароль' : 'Показать пароль'"
                  @click="wifiRevealed = !wifiRevealed"
                >
                  <EyeOff v-if="wifiRevealed" :size="14" />
                  <Eye v-else :size="14" />
                </button>
                <button type="button" class="btn btn--ghost btn--icon btn--sm" title="Скопировать пароль" @click="copyWifiPassword">
                  <Copy :size="14" />
                </button>
              </span>
            </div>
          </div>

          <div class="wifi-card__actions">
            <RouterLink to="/wifi" class="btn btn--soft btn--sm">
              <Wifi :size="14" />
              Управление Wi-Fi
            </RouterLink>
            <button class="btn btn--ghost btn--icon btn--sm" :disabled="wifiBusy" title="Перечитать Wi-Fi" @click="loadWifi">
              <RefreshCw :size="14" :class="{ spin: wifiBusy }" />
            </button>
          </div>
        </article>

        <article class="card ov-8">
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

        <article class="card card--flush ov-4 quick-card">
          <nav class="quick-list" aria-label="Быстрые переходы">
            <RouterLink to="/sounds" class="quick-row">
              <span class="quick-row__icon"><AudioLines :size="16" /></span>
              <span class="quick-row__main">
                <strong>Sound Studio</strong>
                <small>{{ soundCount }} звуков на станции</small>
              </span>
              <ChevronRight :size="16" class="quick-row__arrow" />
            </RouterLink>
            <button v-if="ledAvailable" type="button" class="quick-row" @click="quickLed">
              <span class="quick-row__icon"><Lightbulb :size="16" /></span>
              <span class="quick-row__main">
                <strong>LED в цвет станции</strong>
                <small>3 зоны одним нажатием</small>
              </span>
              <ChevronRight :size="16" class="quick-row__arrow" />
            </button>
            <RouterLink to="/files" class="quick-row">
              <span class="quick-row__icon"><FolderOpen :size="16" /></span>
              <span class="quick-row__main">
                <strong>Файлы станции</strong>
                <small>Разрешённые каталоги</small>
              </span>
              <ChevronRight :size="16" class="quick-row__arrow" />
            </RouterLink>
            <RouterLink to="/automation" class="quick-row">
              <span class="quick-row__icon"><Workflow :size="16" /></span>
              <span class="quick-row__main">
                <strong>Сценарии</strong>
                <small>Реальные события</small>
              </span>
              <ChevronRight :size="16" class="quick-row__arrow" />
            </RouterLink>
            <RouterLink to="/terminal" class="quick-row">
              <span class="quick-row__icon"><SquareTerminal :size="16" /></span>
              <span class="quick-row__main">
                <strong>Терминал</strong>
                <small>Белый список команд</small>
              </span>
              <ChevronRight :size="16" class="quick-row__arrow" />
            </RouterLink>
          </nav>
        </article>

        <article class="card ov-4">
          <div class="card-head">
            <div class="card-title"><HardDrive :size="15" /> Устройство</div>
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
        </article>

        <article class="card card--flush ov-8">
          <div class="card-head" style="padding: 18px 20px 0; margin-bottom: 10px">
            <div class="card-title"><Activity :size="15" /> Последние события</div>
            <RouterLink to="/events" class="btn btn--ghost btn--sm">Все события</RouterLink>
          </div>
          <div v-if="store.warnings.length" class="alert alert--warn" style="margin: 0 20px 10px">
            <AlertTriangle :size="15" />
            <div>{{ store.warnings[0] }}</div>
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

        <article class="card ov-6">
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

        <article class="card ov-6">
          <div class="card-head">
            <div>
              <div class="card-title"><ShieldCheck :size="15" /> Безопасность</div>
              <div class="card-sub">Правила, которые backend соблюдает всегда</div>
            </div>
            <span class="pill" :class="store.settings?.lanAccess ? 'pill--warn' : 'pill--ok'">
              {{ store.settings?.lanAccess ? 'LAN включён' : 'Только localhost' }}
            </span>
          </div>
          <div class="kv">
            <div class="kv-row">
              <span class="kv-key">Backend</span>
              <span class="kv-value">{{ store.settings?.lanAccess ? '0.0.0.0 + токен' : 'только 127.0.0.1' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Пароль SSH</span>
              <span class="kv-value">в config.json (0600)</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Опасные операции</span>
              <span class="kv-value">подтверждение + белый список</span>
            </div>
          </div>
          <RouterLink to="/settings" class="btn mt-12">
            Настройки доступа
          </RouterLink>
        </article>
      </div>
    </template>

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

<style scoped>
.owner-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 18px;
  padding: 8px 14px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-2);
  color: var(--muted);
  font-size: 12.5px;
}

.owner-strip__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}

.owner-strip__item strong {
  color: var(--text);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.owner-strip__note {
  margin-left: auto;
  font-size: 11.5px;
}

.ov {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 14px;
  /* Карточки остаются по высоте содержимого: растянутая карточка с пустым низом — это то самое
     «пустое место», на которое жаловался обзор. */
  align-items: start;
}

.ov > .ov-3 {
  grid-column: span 3;
}
.ov > .ov-4 {
  grid-column: span 4;
}
.ov > .ov-6 {
  grid-column: span 6;
}
.ov > .ov-8 {
  grid-column: span 8;
}
.ov > .ov-12 {
  grid-column: span 12;
}

.volume-card {
  display: grid;
  grid-template-columns: minmax(0, 232px) minmax(0, 1fr);
  align-items: center;
  gap: 10px 28px;
}

.volume-card .card-head {
  margin-bottom: 0;
}

.volume-card__control :deep(.volume) {
  gap: 14px;
}

.wifi-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 28px;
}

.wifi-card__ssid {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 4px 0 6px;
  font-size: 19px;
}

.wifi-card__ssid strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}

.wifi-card__value {
  margin: 4px 0 6px;
  font-size: 17px;
  letter-spacing: 0.04em;
}

.wifi-card__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.quick-card {
  padding: 6px 8px;
}

.quick-list {
  display: grid;
  gap: 2px;
}

.quick-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.18s var(--ease), transform 0.18s var(--ease);
}

.quick-row:hover {
  background: var(--surface-2);
}

.quick-row:active {
  transform: scale(0.99);
}

.quick-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: 11px;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  color: var(--primary);
}

.quick-row__main {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.quick-row__main strong {
  font-size: 13.5px;
  font-weight: 600;
}

.quick-row__main small {
  font-size: 11.5px;
  color: var(--muted);
}

.quick-row__arrow {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--muted);
}

@media (max-width: 1180px) {
  .ov > .ov-3 {
    grid-column: span 6;
  }
  .ov > .ov-8,
  .ov > .ov-4,
  .ov > .ov-6 {
    grid-column: span 12;
  }
}

@media (max-width: 760px) {
  .volume-card {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 12px;
  }

  .wifi-card {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }
}

@media (max-width: 620px) {
  .ov {
    gap: 10px;
  }

  .ov > .ov-3 {
    grid-column: span 12;
  }
}
</style>

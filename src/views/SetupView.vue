<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  AlertTriangle,
  ArrowRight,
  AudioLines,
  Bluetooth,
  Check,
  Download,
  Info,
  Lightbulb,
  LoaderCircle,
  Plug,
  Radar,
  RefreshCw,
  Server,
  ShieldCheck,
  Wrench,
} from '@lucide/vue';
import type { Capabilities, ConnectionSnapshot, DeviceInfo, ToolCheck } from '@shared/types';
import DevicePortrait from '@/components/DevicePortrait.vue';
import { detectDeviceVisual } from '@/lib/deviceVisual';
import { api, errorMessage } from '@/lib/api';
import { applySnapshot, isConnected, pushToast, store } from '@/lib/store';
import { formatBytes, formatRssi, formatUptime } from '@/lib/format';

interface ToolRow extends ToolCheck {}

interface AdbRow {
  serial: string;
  state: string;
  model: string | null;
}

interface ToolsResult {
  tools: ToolRow[];
  adbDevices: AdbRow[];
  adbError?: string;
}

interface ProbePayload {
  info: DeviceInfo | null;
  capabilities: Capabilities | null;
  warnings: string[];
}

interface FoundHost {
  ip: string;
  port: number;
  banner: string;
  mac?: string;
  name?: string;
  source: 'mdns' | 'tcp' | 'arp';
}

interface DiscoverResult {
  subnets: string[];
  hosts: FoundHost[];
}

const router = useRouter();
const step = ref(1);
const tools = ref<ToolsResult | null>(null);
const toolsLoading = ref(false);
const toolsError = ref('');
const installing = ref('');
const probe = ref<ProbePayload | null>(null);
const probeVisual = computed(() => detectDeviceVisual(probe.value?.info));
const busy = ref(false);
const error = ref('');
const showPassword = ref(false);
const found = ref<DiscoverResult | null>(null);
const finding = ref(false);
const foundError = ref('');

const form = reactive({
  host: '',
  port: 2222,
  username: 'root',
  password: '',
  privateKeyPath: '',
  autoReconnect: true,
});

const steps = [
  { id: 1, label: 'Инструменты' },
  { id: 2, label: 'SSH' },
  { id: 3, label: 'Возможности' },
  { id: 4, label: 'Итог' },
];

const hasSshKey = computed(() => form.privateKeyPath.trim().length > 0);
const capabilityRows = computed(() => {
  const caps = probe.value?.capabilities;
  if (!caps) return [];
  const ledZones = caps.led.details?.zones as unknown[] | undefined;
  return [
    {
      label: 'Система',
      icon: Server,
      ok: caps.system.available,
      text: caps.system.available ? 'Диагностика доступна' : caps.system.reason || 'Недоступно',
    },
    {
      label: 'Звуки',
      icon: AudioLines,
      ok: caps.sounds.available,
      text: caps.sounds.available
        ? `${caps.sounds.details?.count ?? 0} файлов в /system/vendor/quasar/sounds`
        : caps.sounds.reason || 'Недоступно',
    },
    {
      label: 'LED',
      icon: Lightbulb,
      ok: caps.led.available,
      text: caps.led.available
        ? `${ledZones?.length ?? 0} зон · ${caps.led.details?.kind ?? 'sysfs'}`
        : caps.led.reason || 'Недоступно',
    },
    {
      label: 'Bluetooth',
      icon: Bluetooth,
      ok: caps.bluetooth.available,
      text: caps.bluetooth.available
        ? `${caps.bluetooth.details?.tool ?? 'bluetoothctl'} · ${caps.bluetooth.details?.adapter ?? 'адаптер'}`
        : caps.bluetooth.reason || 'Недоступно',
    },
    {
      label: 'Файлы (SFTP)',
      icon: Plug,
      ok: caps.sftp.available,
      text: caps.sftp.available
        ? 'SFTP-подсистема доступна'
        : caps.sftp.reason || 'Файлы передаются по shell-каналу SSH',
    },
    {
      label: 'Fastfetch',
      icon: Wrench,
      ok: caps.fastfetch.available,
      text: caps.fastfetch.available
        ? String(caps.fastfetch.details?.path ?? 'установлен')
        : 'Не установлен — доступна штатная диагностика',
    },
    {
      label: 'YAM',
      icon: ShieldCheck,
      ok: caps.yam.available,
      text: caps.yam.available
        ? `Порт ${caps.yam.details?.port ?? 8099}`
        : 'Не установлен. ACC не ставит сторонние пакеты автоматически',
    },
  ];
});

function buildPayload(): Record<string, unknown> {
  return {
    host: form.host.trim(),
    port: Number(form.port) || 2222,
    username: form.username.trim() || 'root',
    autoReconnect: form.autoReconnect,
    ...(form.password ? { password: form.password } : {}),
    ...(form.privateKeyPath.trim() ? { privateKeyPath: form.privateKeyPath.trim() } : {}),
  };
}

async function loadTools(): Promise<void> {
  toolsLoading.value = true;
  toolsError.value = '';
  try {
    tools.value = await api.get<ToolsResult>('/connection/tools');
  } catch (caught) {
    toolsError.value = errorMessage(caught);
  } finally {
    toolsLoading.value = false;
  }
}

const TOOL_KEY: Record<string, string> = { ADB: 'adb', ffmpeg: 'ffmpeg', OpenSSH: 'ssh' };

/** One click instead of hunting a ZIP, unpacking it and editing PATH. */
async function installTool(tool: ToolRow): Promise<void> {
  const key = TOOL_KEY[tool.name];
  if (!key) return;
  installing.value = key;
  toolsError.value = '';
  try {
    await api.post('/connection/tools/install', { name: key }, 240_000);
    await loadTools();
  } catch (caught) {
    toolsError.value = errorMessage(caught);
  } finally {
    installing.value = '';
  }
}

async function discover(): Promise<void> {
  finding.value = true;
  foundError.value = '';
  try {
    found.value = await api.post<DiscoverResult>('/connection/discover', {}, 25_000);
  } catch (caught) {
    foundError.value = errorMessage(caught);
  } finally {
    finding.value = false;
  }
}

function adopt(host: FoundHost): void {
  form.host = host.ip;
  form.port = host.port;
  error.value = '';
  pushToast('info', `Адрес ${host.ip}:${host.port} подставлен — введите пароль SSH`);
}

async function testConnection(): Promise<void> {
  error.value = '';
  if (!form.host.trim()) {
    error.value = 'Укажите адрес колонки';
    return;
  }
  if (!form.password && !hasSshKey.value) {
    error.value = 'Введите пароль SSH или укажите путь к приватному ключу';
    return;
  }
  busy.value = true;
  try {
    probe.value = await api.post<ProbePayload>('/connection/test', buildPayload());
    step.value = 3;
    pushToast('ok', 'SSH-проверка пройдена');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function connect(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const snapshot = await api.post<ConnectionSnapshot>('/connection/connect', buildPayload());
    applySnapshot(snapshot);
    pushToast('ok', 'Подключение сохранено и установлено');
    await router.push('/');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

function next(): void {
  if (step.value < 4) step.value += 1;
}

function back(): void {
  error.value = '';
  if (step.value > 1) step.value -= 1;
}

function goto(target: number): void {
  step.value = target;
}

onMounted(() => {
  form.host = store.status.host ?? '';
  form.port = store.status.port ?? 2222;
  form.username = store.status.username ?? 'root';
  if (isConnected.value && store.info) {
    probe.value = {
      info: store.info,
      capabilities: store.capabilities,
      warnings: store.warnings,
    };
    step.value = 4;
  }
  void loadTools();
});

watch(step, (value) => {
  if (value === 2 && !form.host.trim() && !found.value && !finding.value) void discover();
});
</script>

<template>
  <div class="page">
    <div class="setup" style="max-width: none; padding: 0">
      <div class="setup-head">
        <div>
          <h1 style="font-size: 24px; font-weight: 740; letter-spacing: -0.025em">Мастер подключения</h1>
          <p class="muted" style="font-size: 12.5px; margin-top: 5px">
            Проверка инструментов, SSH-доступ и реальные возможности прошивки. Ничего не устанавливается автоматически.
          </p>
        </div>
        <span class="pill" :class="isConnected ? 'pill--ok' : 'pill--warn'">
          <span class="dot" :class="{ 'dot--live': isConnected }" />
          {{ isConnected ? 'Устройство на связи' : 'Нет подключения' }}
        </span>
      </div>

      <div class="steps">
        <button
          v-for="item in steps"
          :key="item.id"
          type="button"
          class="step"
          :class="{ active: step === item.id, done: step > item.id }"
          style="cursor: pointer"
          @click="goto(item.id)"
        >
          <span class="step-num"><Check v-if="step > item.id" :size="11" /><template v-else>{{ item.id }}</template></span>
          {{ item.label }}
        </button>
      </div>

      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="setup-grid">
        <div class="stack">
          <article v-if="step === 1" class="card">
            <div class="card-head">
              <div>
                <div class="card-title"><Wrench :size="15" /> Шаг 1. Инструменты на компьютере</div>
                <div class="card-sub">ADB не обязателен: рабочее подключение выполняется по SSH.</div>
              </div>
              <button class="btn btn--sm" :disabled="toolsLoading" @click="loadTools">
                <RefreshCw :size="14" :class="{ spin: toolsLoading }" />
                Проверить
              </button>
            </div>
            <div v-if="toolsError" class="alert alert--error">
              <AlertTriangle :size="15" />
              <div>{{ toolsError }}</div>
            </div>
            <div v-else-if="toolsLoading && !tools" class="empty" style="padding: 24px">
              <LoaderCircle :size="20" class="spin" />
              <p>Проверяем PATH и версии инструментов…</p>
            </div>
            <div v-else-if="tools" class="stack" style="gap: 10px">
              <div v-for="tool in tools.tools" :key="tool.name" class="list-row" style="border: 1px solid var(--line); border-radius: 12px">
                <span class="event-level" :class="tool.available ? 'event-level--success' : 'event-level--warn'">
                  <Check v-if="tool.available" :size="13" />
                  <AlertTriangle v-else :size="13" />
                </span>
                <div class="list-main">
                  <div class="list-title">{{ tool.name }}</div>
                  <div class="list-meta">{{ tool.version || tool.note || 'Без описания' }}</div>
                </div>
                <button
                  v-if="!tool.available && tool.canInstall"
                  class="btn btn--sm"
                  :disabled="Boolean(installing)"
                  @click="installTool(tool)"
                >
                  <LoaderCircle v-if="installing === TOOL_KEY[tool.name]" :size="14" class="spin" />
                  <Download v-else :size="14" />
                  {{ installing === TOOL_KEY[tool.name] ? 'Скачиваем…' : 'Скачать' }}
                </button>
                <span v-else class="pill" :class="tool.available ? 'pill--ok' : 'pill--warn'">
                  {{ tool.available ? 'Готово' : 'Нет' }}
                </span>
              </div>
              <div v-if="tools.adbDevices.length" class="alert alert--info">
                <Info :size="15" />
                <div>
                  ADB видит устройств: {{ tools.adbDevices.length }}
                  <span class="mono">({{ tools.adbDevices.map((device) => device.serial).join(', ') }})</span>
                </div>
              </div>
              <div v-else-if="tools.adbError" class="alert alert--warn">
                <AlertTriangle :size="15" />
                <div>{{ tools.adbError }}</div>
              </div>
            </div>
          </article>

          <article v-else-if="step === 2" class="card">
            <div class="card-head">
              <div>
                <div class="card-title"><Plug :size="15" /> Шаг 2. Параметры SSH</div>
                <div class="card-sub">Пароль уходит только на локальный backend и не появляется в frontend-сборке.</div>
              </div>
            </div>

            <div class="discover">
              <div class="row">
                <button type="button" class="btn btn--soft btn--sm" :disabled="finding" @click="discover">
                  <LoaderCircle v-if="finding" :size="14" class="spin" />
                  <Radar v-else :size="14" />
                  {{ finding ? 'Ищем колонку…' : 'Найти колонку в сети' }}
                </button>
                <span class="spacer" />
                <span v-if="found && !finding" class="muted" style="font-size: 11.5px">
                  {{ found.hosts.length ? `Найдено SSH-серверов: ${found.hosts.length}` : 'SSH-серверов не найдено' }}
                  · {{ found.subnets.join(', ') }}
                </span>
              </div>
              <div v-if="foundError" class="alert alert--warn mt-8">
                <AlertTriangle :size="15" />
                <div>{{ foundError }} Поиск доступен на том компьютере, где запущен backend.</div>
              </div>
              <div v-if="finding" class="empty" style="padding: 18px">
                <LoaderCircle :size="18" class="spin" />
                <p>Опрашиваем локальную сеть — обычно 3–7 секунд.</p>
              </div>
              <div v-else-if="found?.hosts.length" class="stack mt-8" style="gap: 8px">
                <button
                  v-for="host in found.hosts"
                  :key="`${host.ip}:${host.port}`"
                  type="button"
                  class="list-row discover-row"
                  :class="{ 'discover-row--active': form.host === host.ip && form.port === host.port }"
                  @click="adopt(host)"
                >
                  <span class="event-level event-level--success"><Check :size="13" /></span>
                  <div class="list-main">
                    <div class="list-title mono">{{ host.ip }}:{{ host.port }}</div>
                    <div class="list-meta">{{ host.banner }}{{ host.mac ? ` · ${host.mac}` : '' }}</div>
                  </div>
                  <span class="pill pill--muted">{{ host.source === 'mdns' ? 'mDNS' : 'порт открыт' }}</span>
                </button>
                <span class="field-hint">
                  Нажмите на адрес — он подставится в форму. Точную модель панель назовёт после проверки пароля.
                </span>
              </div>
            </div>

            <form class="stack mt-12" style="gap: 14px" @submit.prevent="testConnection">
              <div class="form-grid">
                <div class="field span-2">
                  <label for="setup-host">Адрес колонки</label>
                  <input id="setup-host" v-model="form.host" class="input" placeholder="192.168.1.100" autocomplete="off" />
                </div>
                <div class="field">
                  <label for="setup-port">SSH-порт</label>
                  <input id="setup-port" v-model.number="form.port" class="input" type="number" min="1" max="65535" />
                </div>
                <div class="field">
                  <label for="setup-user">Пользователь</label>
                  <input id="setup-user" v-model="form.username" class="input" autocomplete="username" />
                </div>
                <div class="field span-2">
                  <label for="setup-pass">Пароль SSH</label>
                  <div class="input-group">
                    <input
                      id="setup-pass"
                      v-model="form.password"
                      class="input"
                      :type="showPassword ? 'text' : 'password'"
                      autocomplete="current-password"
                      placeholder="Оставьте пустым, если подключаетесь по ключу"
                    />
                    <button type="button" class="btn" @click="showPassword = !showPassword">
                      {{ showPassword ? 'Скрыть' : 'Показать' }}
                    </button>
                  </div>
                  <span class="field-hint">
                    При повторном подключении к тому же адресу пустое поле означает «использовать сохранённый пароль».
                  </span>
                </div>
                <div class="field span-2">
                  <label for="setup-key">Приватный SSH-ключ (необязательно)</label>
                  <input
                    id="setup-key"
                    v-model="form.privateKeyPath"
                    class="input"
                    placeholder="C:\Users\...\.ssh\id_ed25519"
                    autocomplete="off"
                  />
                  <span class="field-hint">Путь читается backend с диска. Ключ не копируется в проект.</span>
                </div>
              </div>
              <label class="check">
                <input v-model="form.autoReconnect" type="checkbox" />
                <span>Автоматически переподключаться при потере связи (до 5 попыток)</span>
              </label>
              <div class="btn-row">
                <button type="submit" class="btn btn--primary" :disabled="busy">
                  <LoaderCircle v-if="busy" :size="15" class="spin" />
                  <Plug v-else :size="15" />
                  Проверить подключение
                </button>
                <button type="button" class="btn" :disabled="busy" @click="back">Назад</button>
              </div>
            </form>
          </article>

          <article v-else-if="step === 3" class="card">
            <div class="card-head">
              <div>
                <div class="card-title"><ShieldCheck :size="15" /> Шаг 3. Проверка возможностей</div>
                <div class="card-sub">Показываем только то, что реально ответило на устройстве.</div>
              </div>
              <span class="pill pill--ok"><Check :size="12" /> SSH работает</span>
            </div>
            <div v-if="!probe" class="alert alert--warn">
              <AlertTriangle :size="15" />
              <div>Сначала выполните SSH-проверку на шаге 2.</div>
            </div>
            <div v-else class="stack" style="gap: 14px">
              <div class="setup-device">
                <DevicePortrait :info="probe.info" size="md" />
                <div class="setup-device__text">
                  <span class="eyebrow">Образ определён автоматически</span>
                  <strong>{{ probeVisual.label }}</strong>
                  <span>{{ probeVisual.tagline }} · {{ probe.info?.modelRaw || 'модель по SSH' }}</span>
                </div>
              </div>
              <div class="kv">
                <div class="kv-row"><span class="kv-key">Модель</span><span class="kv-value">{{ probe.info?.modelGuess || '—' }}</span></div>
                <div class="kv-row"><span class="kv-key">Hostname</span><span class="kv-value mono">{{ probe.info?.hostname || '—' }}</span></div>
                <div class="kv-row"><span class="kv-key">Прошивка</span><span class="kv-value mono">{{ probe.info?.firmware || '—' }}</span></div>
                <div class="kv-row"><span class="kv-key">Ядро</span><span class="kv-value mono">{{ probe.info?.kernel || '—' }}</span></div>
                <div class="kv-row"><span class="kv-key">Архитектура</span><span class="kv-value mono">{{ probe.info?.arch || '—' }}</span></div>
                <div class="kv-row"><span class="kv-key">Память</span><span class="kv-value">{{ formatBytes(probe.info?.totalMemBytes) }}</span></div>
                <div class="kv-row"><span class="kv-key">IP / RSSI</span><span class="kv-value mono">{{ probe.info?.ip || '—' }} · {{ formatRssi(probe.info?.wifiRssi) }}</span></div>
                <div class="kv-row"><span class="kv-key">Uptime</span><span class="kv-value">{{ formatUptime(probe.info?.uptimeSec) }}</span></div>
                <div class="kv-row"><span class="kv-key">Device ID</span><span class="kv-value mono">{{ probe.info?.deviceId || '—' }}</span></div>
              </div>
              <div class="cap-grid">
                <div v-for="row in capabilityRows" :key="row.label" class="cap-card">
                  <div class="row">
                    <component :is="row.icon" :size="15" style="color: var(--primary)" />
                    <h4>{{ row.label }}</h4>
                    <span class="spacer" />
                    <span class="pill" :class="row.ok ? 'pill--ok' : 'pill--muted'">{{ row.ok ? 'Есть' : 'Нет' }}</span>
                  </div>
                  <p>{{ row.text }}</p>
                </div>
              </div>
              <div v-if="probe.warnings.length" class="stack" style="gap: 8px">
                <div v-for="warning in probe.warnings" :key="warning" class="alert alert--warn">
                  <AlertTriangle :size="15" />
                  <div>{{ warning }}</div>
                </div>
              </div>
              <div class="btn-row">
                <button type="button" class="btn btn--primary" @click="next">
                  К итогу
                  <ArrowRight :size="15" />
                </button>
                <button type="button" class="btn" @click="back">Назад</button>
              </div>
            </div>
          </article>

          <article v-else class="card">
            <div class="card-head">
              <div>
                <div class="card-title"><Check :size="15" /> Шаг 4. Итог</div>
                <div class="card-sub">Подключение будет сохранено в data/config.json с правами 0600.</div>
              </div>
            </div>
            <div class="stack" style="gap: 14px">
              <div class="kv">
                <div class="kv-row"><span class="kv-key">Адрес</span><span class="kv-value mono">{{ form.host || store.status.host || '—' }}:{{ form.port || store.status.port || 2222 }}</span></div>
                <div class="kv-row"><span class="kv-key">Пользователь</span><span class="kv-value mono">{{ form.username || 'root' }}</span></div>
                <div class="kv-row"><span class="kv-key">Способ</span><span class="kv-value">{{ hasSshKey ? 'Приватный ключ' : form.password ? 'Пароль SSH' : 'Сохранённые данные' }}</span></div>
                <div class="kv-row"><span class="kv-key">Устройство</span><span class="kv-value">{{ probe?.info?.modelGuess || store.info?.modelGuess || 'будет определено' }}</span></div>
                <div class="kv-row"><span class="kv-key">Автопереподключение</span><span class="kv-value">{{ form.autoReconnect ? 'включено' : 'выключено' }}</span></div>
              </div>
              <div class="alert alert--info">
                <Info :size="15" />
                <div>
                  ACC не публикует SSH/ADB в интернет, не перезапускает станцию автоматически и не устанавливает бинарники без проверенного источника.
                </div>
              </div>
              <div v-if="probe?.warnings.length" class="stack" style="gap: 8px">
                <div v-for="warning in probe.warnings" :key="warning" class="alert alert--warn">
                  <AlertTriangle :size="15" />
                  <div>{{ warning }}</div>
                </div>
              </div>
              <div class="btn-row">
                <button type="button" class="btn btn--primary btn--lg" :disabled="busy" @click="connect">
                  <LoaderCircle v-if="busy" :size="16" class="spin" />
                  <Plug v-else :size="16" />
                  Подключиться и сохранить
                </button>
                <button type="button" class="btn btn--lg" :disabled="busy" @click="back">Назад</button>
              </div>
            </div>
          </article>
        </div>

        <aside class="stack">
          <article class="card card--soft">
            <div class="card-title"><Info :size="15" /> Что потребуется</div>
            <ul class="check-list mt-12">
              <li><Check :size="14" /><span>Колонка включена и в той же локальной сети</span></li>
              <li><Check :size="14" /><span>SSH root на порту 2222 (или вашем порту)</span></li>
              <li><Check :size="14" /><span>Пароль либо приватный SSH-ключ</span></li>
              <li><Check :size="14" /><span>Ничего не нужно устанавливать на саму колонку</span></li>
            </ul>
          </article>
          <article class="card">
            <div class="card-title"><ShieldCheck :size="15" /> Безопасность</div>
            <div class="stack mt-12" style="gap: 8px">
              <div class="alert">
                <ShieldCheck :size="15" />
                <div>Backend слушает только 127.0.0.1, пока LAN-доступ не включён явно в настройках.</div>
              </div>
              <div class="alert">
                <ShieldCheck :size="15" />
                <div>Пароль не сохраняется в исходниках и не отдаётся в браузер.</div>
              </div>
              <div class="alert">
                <ShieldCheck :size="15" />
                <div>Опасные операции требуют подтверждения и журналируются.</div>
              </div>
            </div>
          </article>
          <article class="card card--soft">
            <div class="card-title"><Info :size="15" /> Если SSH не отвечает</div>
            <ul class="info-list mt-12">
              <li class="info-line"><Info :size="14" /><span>Проверьте IP колонки в приложении роутера или в интерфейсе Яндекс Станции.</span></li>
              <li class="info-line"><Info :size="14" /><span>Убедитесь, что root-доступ уже получен и SSH-сервер запущен на самой колонке.</span></li>
              <li class="info-line"><Info :size="14" /><span>Не открывайте порт 2222 в интернет — только локальная сеть.</span></li>
            </ul>
          </article>
        </aside>
      </div>
    </div>
  </div>
</template>

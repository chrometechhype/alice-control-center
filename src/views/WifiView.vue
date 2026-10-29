<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  Info,
  LoaderCircle,
  Lock,
  RefreshCw,
  Signal,
  Trash2,
  Unplug,
  Wifi,
  WifiOff,
} from '@lucide/vue';
import type { WifiConfigNetwork, WifiScanEntry, WifiSecurity, WifiStatus } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import OfflineState from '@/components/OfflineState.vue';
import Modal from '@/components/Modal.vue';
import { api, errorMessage } from '@/lib/api';
import { everConnected, isConnected, pushToast } from '@/lib/store';

const SECURITY_LABEL: Record<WifiSecurity, string> = {
  open: 'открытая',
  wep: 'WEP',
  wpa: 'WPA',
  wpa2: 'WPA2',
  wpa3: 'WPA3',
  enterprise: '802.1X',
};

const status = ref<WifiStatus | null>(null);
const scanned = ref<WifiScanEntry[]>([]);
const loading = ref(false);
const scanning = ref(false);
const error = ref('');
const reveal = ref(false);
const connectOpen = ref(false);
const target = ref<WifiScanEntry | null>(null);
const password = ref('');
const showPassword = ref(false);
const connecting = ref(false);
const forgetTarget = ref<WifiConfigNetwork | null>(null);
const forgetting = ref(false);
const disconnecting = ref(false);

const connected = computed(() => status.value?.connected ?? null);
const networks = computed(() => status.value?.networks ?? []);
const available = computed(() => Boolean(status.value?.available));
const hiddenFromScan = computed(() => {
  const seen = new Set(scanned.value.map((entry) => entry.ssid));
  return networks.value.filter((network) => !seen.has(network.ssid));
});

async function load(showToast = false): Promise<void> {
  if (!isConnected.value) return;
  loading.value = true;
  error.value = '';
  try {
    status.value = await api.get<WifiStatus>('/wifi/status');
    if (showToast) pushToast('ok', 'Состояние Wi-Fi обновлено');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function scan(): Promise<void> {
  if (scanning.value) return;
  scanning.value = true;
  error.value = '';
  try {
    const result = await api.post<{ networks: WifiScanEntry[] }>('/wifi/scan', {}, 30_000);
    scanned.value = result.networks;
    pushToast(
      result.networks.length ? 'ok' : 'info',
      result.networks.length
        ? `Найдено сетей: ${result.networks.length}`
        : 'Скан прошёл, но видимых сетей нет — проверьте, что Wi-Fi включён',
    );
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    scanning.value = false;
  }
}

function savedForKey(ssid: string): WifiConfigNetwork | null {
  return networks.value.find((network) => network.ssid === ssid) ?? null;
}

function openConnect(entry: WifiScanEntry): void {
  const saved = savedForKey(entry.ssid);
  target.value = entry;
  password.value = saved?.psk ?? '';
  showPassword.value = false;
  connectOpen.value = true;
}

function openManual(): void {
  target.value = { ssid: '', bssid: '', freq: null, signal: null, security: 'wpa2', hidden: true };
  password.value = '';
  showPassword.value = false;
  connectOpen.value = true;
}

async function submitConnect(): Promise<void> {
  const entry = target.value;
  if (!entry) return;
  const ssid = entry.ssid.trim();
  if (!ssid) {
    pushToast('error', 'Укажите имя сети');
    return;
  }
  connecting.value = true;
  try {
    await api.post<{ message: string }>(
      '/wifi/connect',
      {
        ssid,
        password: password.value,
        security: entry.security,
        hidden: entry.hidden || undefined,
        priority: 5,
      },
      45_000,
    );
    connectOpen.value = false;
    pushToast('ok', `Станция переключилась на «${ssid}»`);
    await load();
  } catch (caught) {
    const message = errorMessage(caught);
    pushToast('error', message);
    error.value = message;
    await load();
  } finally {
    connecting.value = false;
  }
}

async function forget(): Promise<void> {
  const network = forgetTarget.value;
  if (!network) return;
  forgetting.value = true;
  try {
    await api.post('/wifi/forget', { ssid: network.ssid, confirm: true }, 45_000);
    forgetTarget.value = null;
    pushToast('info', `Сеть «${network.ssid}» удалена из wpa_supplicant.conf`);
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    forgetting.value = false;
  }
}

async function disconnect(): Promise<void> {
  disconnecting.value = true;
  try {
    await api.post('/wifi/disconnect');
    pushToast('info', 'Станция отключена от Wi-Fi');
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    disconnecting.value = false;
  }
}

async function copyPassword(): Promise<void> {
  const psk = connected.value?.psk;
  if (!psk) return;
  try {
    await navigator.clipboard.writeText(psk);
    pushToast('ok', 'Пароль скопирован');
  } catch {
    pushToast('error', 'Браузер не дал доступ к буферу — откройте пароль и скопируйте вручную');
  }
}

function signalLabel(signal: number | null): string {
  if (signal == null) return '—';
  if (signal >= -55) return 'отлично';
  if (signal >= -67) return 'хорошо';
  if (signal >= -75) return 'слабо';
  return 'едва ловится';
}

function signalTone(signal: number | null): string {
  if (signal == null) return 'pill--muted';
  if (signal >= -67) return 'pill--ok';
  if (signal >= -75) return 'pill--warn';
  return 'pill--muted';
}

onMounted(() => {
  if (isConnected.value) void load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Wi-Fi</h1>
        <p>
          Работает через <span class="code-inline">wpa_cli</span> и
          <span class="code-inline">/bkupgrade/data/wpa_supplicant.conf</span>: панель дописывает сеть в
          файл и вызывает <span class="code-inline">reconfigure</span> — станция переключается без
          перезагрузки. NetworkManager на прошивке нет.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn btn--primary" :disabled="scanning || !available" @click="scan">
          <LoaderCircle v-if="scanning" :size="15" class="spin" />
          <Signal v-else :size="15" />
          {{ scanning ? 'Сканируем эфир…' : 'Сканировать' }}
        </button>
        <button class="btn" :disabled="loading" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Wi-Fi настраивается на самой станции." />

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="grid grid-3">
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Сеть</span><Wifi :size="15" class="muted" /></div>
          <div class="stat-value" style="font-size: 19px">{{ connected?.ssid ?? 'не подключена' }}</div>
          <div class="stat-foot">
            <span class="mono">{{ connected?.ip ?? status?.state ?? '—' }}</span>
            <span v-if="connected?.keyMgmt" class="pill pill--muted">{{ connected.keyMgmt }}</span>
          </div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Пароль сети</span><Lock :size="15" class="muted" /></div>
          <div class="stat-value mono" style="font-size: 16px">
            {{ connected?.psk ? (reveal ? connected.psk : '••••••••') : '—' }}
          </div>
          <div class="stat-foot">
            <span>{{ connected?.psk ? 'из wpa_supplicant.conf' : 'сеть без пароля или нет связи' }}</span>
            <span v-if="connected?.psk" class="row" style="gap: 2px">
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                :title="reveal ? 'Скрыть пароль' : 'Показать пароль'"
                @click="reveal = !reveal"
              >
                <EyeOff v-if="reveal" :size="14" />
                <Eye v-else :size="14" />
              </button>
              <button type="button" class="btn btn--ghost btn--icon btn--sm" title="Скопировать пароль" @click="copyPassword">
                <Copy :size="14" />
              </button>
            </span>
          </div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Интерфейс</span><Signal :size="15" class="muted" /></div>
          <div class="stat-value mono" style="font-size: 18px">{{ status?.interface ?? '—' }}</div>
          <div class="stat-foot">
            <span class="truncate mono" style="max-width: 170px">{{ status?.configPath ?? 'конфиг не найден' }}</span>
            <span class="pill" :class="status?.available ? 'pill--ok' : 'pill--warn'">
              {{ status?.available ? 'wpa_cli' : 'нет wpa_cli' }}
            </span>
          </div>
        </div>
      </div>

      <article class="card card--flush">
        <div class="file-toolbar">
          <div class="card-title" style="flex: 1"><Signal :size="15" /> Найденные сети</div>
          <button class="btn btn--soft btn--sm" @click="openManual">
            <Lock :size="13" />
            Скрытая сеть
          </button>
        </div>

        <div v-if="scanning" class="empty" style="padding: 30px">
          <LoaderCircle :size="20" class="spin" />
          <p>Станция сканирует эфир, это занимает несколько секунд…</p>
        </div>

        <EmptyState
          v-else-if="!scanned.length"
          compact
          title="Список пуст"
          text="Нажмите «Сканировать» — панель попросит wpa_cli просканировать эфир и покажет только то, что реально ответило."
        >
          <template #icon><Wifi :size="20" /></template>
        </EmptyState>

        <div v-else class="list">
          <div v-for="entry in scanned" :key="entry.bssid || entry.ssid" class="list-row">
            <div class="empty-icon" style="width: 38px; height: 38px; border-radius: 11px; flex: none">
              <Lock v-if="entry.security !== 'open'" :size="16" />
              <Wifi v-else :size="16" />
            </div>
            <div class="list-main">
              <div class="list-title truncate">{{ entry.ssid }}</div>
              <div class="list-meta">
                <span class="pill pill--muted">{{ SECURITY_LABEL[entry.security] }}</span>
                <span class="pill" :class="signalTone(entry.signal)">
                  {{ entry.signal ?? '—' }} dBm · {{ signalLabel(entry.signal) }}
                </span>
                <span v-if="savedForKey(entry.ssid)" class="pill pill--ok">уже сохранена</span>
              </div>
            </div>
            <button class="btn btn--soft btn--sm" @click="openConnect(entry)">
              <Wifi :size="14" />
              Подключить
            </button>
          </div>
        </div>
      </article>

      <article class="card card--flush">
        <div class="file-toolbar">
          <div class="card-title" style="flex: 1"><Lock :size="15" /> Сохранённые сети</div>
          <span class="pill pill--muted">{{ networks.length }}</span>
          <button v-if="connected" class="btn btn--ghost btn--sm" :disabled="disconnecting" @click="disconnect">
            <LoaderCircle v-if="disconnecting" :size="14" class="spin" />
            <Unplug v-else :size="14" />
            Отключиться
          </button>
        </div>

        <EmptyState
          v-if="!networks.length"
          compact
          title="Сетей в конфиге нет"
          text="wpa_supplicant.conf не содержит ни одного network={…}. Добавьте сеть сканированием или вручную."
        >
          <template #icon><WifiOff :size="20" /></template>
        </EmptyState>

        <div v-else class="list">
          <div v-for="network in networks" :key="network.id" class="list-row">
            <div class="empty-icon" style="width: 38px; height: 38px; border-radius: 11px; flex: none">
              <Check v-if="network.ssid === connected?.ssid" :size="16" />
              <Wifi v-else :size="16" />
            </div>
            <div class="list-main">
              <div class="list-title truncate">{{ network.ssid || '(без имени)' }}</div>
              <div class="list-meta">
                <span v-if="network.ssid === connected?.ssid" class="pill pill--ok">текущая</span>
                <span class="mono">{{ network.psk ? 'psk задан' : 'без пароля' }}</span>
                <span v-if="network.keyMgmt" class="pill pill--muted">{{ network.keyMgmt }}</span>
                <span v-if="network.hidden" class="pill pill--muted">скрытая</span>
                <span v-if="network.disabled" class="pill pill--warn">отключена</span>
              </div>
            </div>
            <button class="btn btn--ghost btn--icon btn--sm" title="Удалить сеть" @click="forgetTarget = network">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>

        <div v-if="status?.configPath" class="muted" style="padding: 12px 16px; font-size: 11.5px">
          Файл: <span class="mono">{{ status.configPath }}</span> · резервная копия
          <span class="mono">{{ status.configPath }}.acc-bak</span> создаётся при первой записи.
        </div>
      </article>

      <div v-if="hiddenFromScan.length" class="alert alert--info">
        <Info :size="15" />
        <div>
          Сохранённые, но не найденные сейчас: {{ hiddenFromScan.map((item) => item.ssid).join(', ') }}.
          Станция может быть вне зоны или сеть скрытая.
        </div>
      </div>
    </template>

    <Modal
      :open="connectOpen"
      :title="target?.ssid ? `Подключить «${target.ssid}»` : 'Скрытая сеть'"
      subtitle="Панель допишет сеть в wpa_supplicant.conf и применит её через wpa_cli reconfigure"
      @close="connectOpen = false"
    >
      <div class="stack" style="gap: 14px">
        <div v-if="!target?.ssid" class="field">
          <label for="wifi-ssid">Имя сети (SSID)</label>
          <input id="wifi-ssid" v-model="target!.ssid" class="input" maxlength="32" placeholder="Например: Home" />
        </div>
        <div class="field">
          <label for="wifi-psk">Пароль</label>
          <div class="row" style="gap: 8px">
            <input
              id="wifi-psk"
              v-model="password"
              class="input"
              :type="showPassword ? 'text' : 'password'"
              autocomplete="off"
              placeholder="От 8 до 63 символов или 64 hex"
            />
            <button
              type="button"
              class="btn btn--ghost btn--icon"
              :title="showPassword ? 'Скрыть пароль' : 'Показать пароль'"
              @click="showPassword = !showPassword"
            >
              <EyeOff v-if="showPassword" :size="15" />
              <Eye v-else :size="15" />
            </button>
          </div>
          <p class="field-hint">
            Пароль не уходит никуда, кроме самой станции: он пишется в
            <span class="mono">/bkupgrade/data/wpa_supplicant.conf</span>.
          </p>
        </div>
        <div v-if="target?.security === 'open'" class="alert alert--warn">
          <AlertTriangle :size="15" />
          <div>Это открытая сеть: пароль не нужен, трафик не шифруется.</div>
        </div>
        <div class="alert alert--info">
          <Info :size="15" />
          <div>
            Если сеть недоступна, станция останется с прежним конфигом в файле — панель честно
            покажет, что ответил wpa_supplicant, вместо «подключено».
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="connecting" @click="connectOpen = false">Отмена</button>
        <button class="btn btn--primary" :disabled="connecting" @click="submitConnect">
          <LoaderCircle v-if="connecting" :size="15" class="spin" />
          <Wifi v-else :size="15" />
          {{ connecting ? 'Переключаем…' : 'Подключить' }}
        </button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="Boolean(forgetTarget)"
      title="Удалить сеть?"
      :message="forgetTarget
        ? `Сеть «${forgetTarget.ssid}» будет удалена из wpa_supplicant.conf. ${forgetTarget.ssid === connected?.ssid ? 'Это текущая сеть — станция потеряет связь с роутером до подключения к другой.' : ''}`
        : ''"
      confirm-label="Удалить"
      :busy="forgetting"
      @confirm="forget"
      @cancel="forgetTarget = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, type Component } from 'vue';
import { RouterLink } from 'vue-router';
import {
  AlertTriangle,
  ArrowUpCircle,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Palette,
  QrCode,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Sun,
  Wand2,
  Wifi,
} from '@lucide/vue';
import type { AiProviderId, AppSettings, PublicAiSettings, PublicConnectionConfig, ThemeMode } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import DevicePortrait from '@/components/DevicePortrait.vue';
import UpdateNotes from '@/components/UpdateNotes.vue';
import {
  detectDeviceVisual,
  LITE2_COLORS,
  resetStationLook,
  resetStationModel,
  STATION_MODEL_GROUPS,
  setStationLook,
  setStationModel,
  stationLook,
  stationModel,
  type Lite2Color,
  type StationKind,
} from '@/lib/deviceVisual';
import { api, errorMessage } from '@/lib/api';
import { formatBytes } from '@/lib/format';
import {
  isConnected,
  logout,
  pushToast,
  refreshSettings,
  store,
  updateSettings,
} from '@/lib/store';
import { openWelcome } from '@/lib/welcome';
import { installUpdate, loadUpdates, releaseDateLabel, updateStore } from '@/lib/updates';

interface ConnectionInfo {
  config: PublicConnectionConfig | null;
}

interface PhoneAddress {
  address: string;
  interface: string;
  netmask: string;
  kind: 'wifi' | 'ethernet' | 'other';
  reachesStation: boolean;
}

interface PhoneAccess {
  port: number;
  lanAccess: boolean;
  listeningOn: string;
  stationHost: string | null;
  addresses: PhoneAddress[];
  best: string | null;
  firewall: { supported: boolean; ruleExists: boolean; category: string | null; detail: string };
}

const saving = ref(false);
const error = ref('');
const conn = ref<PublicConnectionConfig | null>(null);
const connLoading = ref(false);

const token = ref('');
const tokenVisible = ref(false);
const tokenLoading = ref(false);
const tokenError = ref('');

const qr = ref<{ dataUrl: string | null; url: string | null } | null>(null);
const qrLoading = ref(false);
const qrError = ref('');

const phone = ref<PhoneAccess | null>(null);
const phoneLoading = ref(false);
const phoneError = ref('');
const chosenAddress = ref('');
const firewallBusy = ref(false);
const firewallConfirm = ref(false);

const panelUrl = computed(() => {
  const address = chosenAddress.value || phone.value?.best;
  return address ? `http://${address}:${phone.value?.port ?? 8722}/` : '';
});

async function loadPhoneAccess(): Promise<void> {
  if (phoneLoading.value) return;
  phoneLoading.value = true;
  phoneError.value = '';
  try {
    const result = await api.get<PhoneAccess>('/settings/phone-access', 20_000);
    phone.value = result;
    if (!chosenAddress.value) chosenAddress.value = result.best ?? '';
  } catch (caught) {
    phoneError.value = errorMessage(caught);
  } finally {
    phoneLoading.value = false;
  }
}

async function chooseAddress(address: string): Promise<void> {
  chosenAddress.value = address;
  qr.value = null;
  await loadQr();
}

async function applyFirewallRule(): Promise<void> {
  firewallConfirm.value = false;
  firewallBusy.value = true;
  try {
    const result = await api.post<PhoneAccess['firewall']>('/settings/firewall', {}, 130_000);
    if (phone.value) phone.value = { ...phone.value, firewall: result };
    pushToast(result.ruleExists ? 'ok' : 'info', result.ruleExists ? 'Правило брандмауэра создано' : 'Правило не появилось — подтвердите запрос UAC');
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    firewallBusy.value = false;
  }
}

const lanTarget = ref<boolean | null>(null);
const rotateOpen = ref(false);
const rotating = ref(false);

const ai = ref<PublicAiSettings | null>(null);
const aiLoading = ref(false);
const aiSaving = ref(false);
const aiTesting = ref(false);
const aiError = ref('');
const aiProvider = ref<AiProviderId>('custom');
const aiBaseUrl = ref('');
const aiModel = ref('');
const aiApiKey = ref('');
const aiTestReply = ref('');
const aiPreset = computed(() => ai.value?.presets.find((item) => item.id === aiProvider.value) ?? null);
const aiKeyRequired = computed(() => Boolean(aiPreset.value?.requiresKey) && !ai.value?.hasKey);

const updateConfirm = ref(false);
const releaseDate = computed(releaseDateLabel);
const updateCheckedLabel = computed(() => {
  const ts = updateStore.info?.checkedAt;
  return ts ? new Date(ts).toLocaleString('ru-RU') : 'ещё не проверялось';
});

async function checkUpdates(): Promise<void> {
  await loadUpdates(true);
  if (updateStore.error) pushToast('error', updateStore.error);
  else if (updateStore.info?.checkError) pushToast('error', updateStore.info.checkError);
  else if (updateStore.info?.updateAvailable) pushToast('info', `Доступна версия ${updateStore.info.latestVersion}`);
  else pushToast('ok', `Установлена актуальная версия (${updateStore.info?.currentVersion ?? '—'})`);
}

async function applyUpdate(): Promise<void> {
  updateConfirm.value = false;
  await installUpdate();
  if (updateStore.error) pushToast('error', updateStore.error);
}

const settings = computed(() => store.settings);
const themeMode = computed<ThemeMode>(() => settings.value?.theme ?? store.themeMode);
const lanEnabled = computed(() => Boolean(settings.value?.lanAccess));
const visual = computed(() => detectDeviceVisual(store.info));
const canCustomize = computed(() => visual.value.kind === 'lite2');

function chooseColor(color: Lite2Color): void {
  setStationLook({ color });
}

function onModelChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  setStationModel(value === 'auto' ? 'auto' : (value as StationKind));
}

function chooseClock(clock: boolean): void {
  setStationLook({ clock });
}

function resetLook(): void {
  resetStationLook();
  resetStationModel();
  pushToast('info', 'Вид станции сброшен к стандартному');
}

async function loadAiSettings(): Promise<void> {
  aiLoading.value = true;
  aiError.value = '';
  try {
    const result = await api.get<PublicAiSettings>('/settings/ai');
    ai.value = result;
    aiProvider.value = result.provider;
    aiBaseUrl.value = result.baseUrl;
    aiModel.value = result.model;
  } catch (caught) {
    aiError.value = errorMessage(caught);
  } finally {
    aiLoading.value = false;
  }
}

function chooseAiProvider(id: AiProviderId): void {
  aiProvider.value = id;
  const preset = ai.value?.presets.find((item) => item.id === id);
  if (preset) {
    aiBaseUrl.value = preset.baseUrl;
    aiModel.value = preset.model;
  }
  aiApiKey.value = '';
  aiTestReply.value = '';
  aiError.value = '';
}

async function saveAi(): Promise<void> {
  if (aiSaving.value) return;
  aiSaving.value = true;
  aiError.value = '';
  try {
    const body = {
      provider: aiProvider.value,
      baseUrl: aiBaseUrl.value.trim(),
      model: aiModel.value.trim(),
      ...(aiApiKey.value.trim() ? { apiKey: aiApiKey.value.trim() } : {}),
    };
    const result = await api.put<PublicAiSettings>('/settings/ai', body);
    ai.value = result;
    aiProvider.value = result.provider;
    aiBaseUrl.value = result.baseUrl;
    aiModel.value = result.model;
    aiApiKey.value = '';
    aiTestReply.value = '';
    pushToast('ok', 'Настройки ИИ сохранены');
  } catch (caught) {
    aiError.value = errorMessage(caught);
    pushToast('error', aiError.value);
  } finally {
    aiSaving.value = false;
  }
}

async function testAi(): Promise<void> {
  if (aiTesting.value) return;
  aiTesting.value = true;
  aiError.value = '';
  aiTestReply.value = '';
  try {
    const result = await api.post<{ reply: string; model: string; elapsedMs: number }>(
      '/settings/ai/test',
      {},
      60_000,
    );
    aiTestReply.value = `${result.model} · ${Math.round(result.elapsedMs / 1000)} с · «${result.reply}»`;
    pushToast('ok', 'ИИ ответил');
  } catch (caught) {
    aiError.value = errorMessage(caught);
    pushToast('error', aiError.value);
  } finally {
    aiTesting.value = false;
  }
}

async function clearAiKey(): Promise<void> {
  aiSaving.value = true;
  aiError.value = '';
  try {
    const result = await api.put<PublicAiSettings>('/settings/ai', {
      provider: aiProvider.value,
      baseUrl: aiBaseUrl.value.trim(),
      model: aiModel.value.trim(),
      clearKey: true,
    });
    ai.value = result;
    aiApiKey.value = '';
    pushToast('info', 'Сохранённый ключ удалён');
  } catch (caught) {
    aiError.value = errorMessage(caught);
    pushToast('error', aiError.value);
  } finally {
    aiSaving.value = false;
  }
}
const panelHost = typeof window === 'undefined' ? '—' : window.location.host;

async function loadConnectionInfo(): Promise<void> {
  connLoading.value = true;
  try {
    const result = await api.get<ConnectionInfo>('/connection/status');
    conn.value = result.config;
  } catch {
    conn.value = null;
  } finally {
    connLoading.value = false;
  }
}

async function saveSetting(patch: Partial<AppSettings>, toast = 'Настройки сохранены'): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    await updateSettings(patch);
    pushToast('ok', toast);
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    saving.value = false;
  }
}

function onAiProviderChange(event: Event): void {
  chooseAiProvider((event.target as HTMLSelectElement).value as AiProviderId);
}

const themeOptions: Array<{ value: ThemeMode; label: string; icon: Component }> = [
  { value: 'light', label: 'Светлая', icon: Sun },
  { value: 'dark', label: 'Тёмная', icon: Moon },
  { value: 'system', label: 'Системная', icon: Monitor },
];

function chooseTheme(mode: ThemeMode): void {
  if (mode === themeMode.value) return;
  const label =
    mode === 'light' ? 'Светлая тема включена' : mode === 'dark' ? 'Тёмная тема включена' : 'Тема следует за системной';
  void saveSetting({ theme: mode }, label);
}

function onPollChange(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  if (Number.isFinite(value)) void saveSetting({ pollIntervalMs: value });
}

function askLan(next: boolean): void {
  lanTarget.value = next;
}

async function applyLan(): Promise<void> {
  const next = lanTarget.value;
  if (next === null) return;
  lanTarget.value = null;
  await saveSetting(
    { lanAccess: next },
    next
      ? 'LAN-доступ включён. Перезапустите backend, чтобы он начал слушать сетевой адрес.'
      : 'LAN-доступ отключён',
  );
  if (next) {
    tokenError.value = '';
    await loadToken();
  }
}

async function loadToken(): Promise<void> {
  if (tokenLoading.value) return;
  tokenLoading.value = true;
  tokenError.value = '';
  try {
    const result = await api.get<{ token: string; lanAddresses: string[]; port: number }>('/settings/token');
    token.value = result.token;
  } catch (caught) {
    tokenError.value = errorMessage(caught);
  } finally {
    tokenLoading.value = false;
  }
}

async function toggleToken(): Promise<void> {
  if (tokenVisible.value) {
    tokenVisible.value = false;
    return;
  }
  if (!token.value) await loadToken();
  tokenVisible.value = Boolean(token.value);
}

async function copyToken(): Promise<void> {
  if (!token.value) await loadToken();
  if (!token.value) return;
  try {
    await navigator.clipboard.writeText(token.value);
    pushToast('ok', 'Токен скопирован');
  } catch {
    pushToast('error', 'Буфер обмена недоступен — скопируйте токен вручную');
  }
}

async function copyPanelUrl(): Promise<void> {
  if (!panelUrl.value) return;
  try {
    await navigator.clipboard.writeText(panelUrl.value);
    pushToast('ok', 'Адрес панели скопирован');
  } catch {
    pushToast('error', 'Буфер обмена недоступен — скопируйте адрес вручную');
  }
}

async function loadQr(): Promise<void> {
  if (qrLoading.value) return;
  if (qr.value) {
    qr.value = null;
    return;
  }
  qrLoading.value = true;
  qrError.value = '';
  try {
    const query = chosenAddress.value
      ? `?address=${encodeURIComponent(chosenAddress.value)}`
      : phone.value?.stationHost
        ? `?station=${encodeURIComponent(phone.value.stationHost)}`
        : '';
    qr.value = await api.get<{ dataUrl: string | null; url: string | null }>(`/settings/lan-qr${query}`);
    if (!qr.value.dataUrl) {
      qrError.value = 'Не найден сетевой IPv4-адрес компьютера.';
    }
  } catch (caught) {
    qrError.value = errorMessage(caught);
  } finally {
    qrLoading.value = false;
  }
}

async function rotateToken(): Promise<void> {
  rotating.value = true;
  try {
    const result = await api.post<{ token: string }>('/settings/token/rotate');
    token.value = result.token;
    tokenVisible.value = true;
    rotateOpen.value = false;
    pushToast('info', 'Токен перевыпущен. Старые сессии больше не действуют.');
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    rotating.value = false;
  }
}

async function signOut(): Promise<void> {
  await logout();
}

onMounted(() => {
  void (async () => {
    await Promise.allSettled([refreshSettings(), loadConnectionInfo(), loadAiSettings(), loadUpdates(false)]);
    if (store.settings?.lanAccess) void loadPhoneAccess();
  })();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Настройки</h1>
        <p>
          Тема, подключение, доступ с телефона и сервер ИИ для Fun Lab. Секреты хранятся только на
          backend: фронтенд не получает ни пароль колонки, ни API-ключ.
        </p>
      </div>
      <div class="page-head__actions">
        <RouterLink to="/setup" class="btn">
          <Server :size="15" />
          Мастер подключения
        </RouterLink>
      </div>
    </div>

    <div v-if="error" class="alert alert--error">
      <AlertTriangle :size="16" />
      <div>{{ error }}</div>
    </div>

    <div class="split split--balanced">
      <div class="stack">
        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Server :size="15" /> Подключение к станции</div>
              <div class="card-sub">Пароль и ключи не отображаются в интерфейсе</div>
            </div>
            <span class="pill" :class="isConnected ? 'pill--ok' : 'pill--muted'">
              {{ isConnected ? 'подключено' : 'нет связи' }}
            </span>
          </div>

          <div v-if="connLoading" class="empty" style="padding: 24px">
            <LoaderCircle :size="18" class="spin" />
            <p>Читаем параметры подключения…</p>
          </div>

          <div v-else-if="conn" class="kv">
            <div class="kv-row"><span class="kv-key">Хост</span><span class="kv-value mono">{{ conn.host }}</span></div>
            <div class="kv-row"><span class="kv-key">Порт</span><span class="kv-value mono">{{ conn.port }}</span></div>
            <div class="kv-row"><span class="kv-key">Пользователь</span><span class="kv-value mono">{{ conn.username }}</span></div>
            <div class="kv-row"><span class="kv-key">Транспорт</span><span class="kv-value mono">{{ conn.transport }}</span></div>
            <div class="kv-row">
              <span class="kv-key">Пароль</span>
              <span class="kv-value">{{ conn.hasPassword ? 'сохранён на backend' : 'не задан' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">SSH-ключ</span>
              <span class="kv-value mono">{{ conn.privateKeyPath || 'не используется' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Автопереподключение</span>
              <span class="kv-value">{{ conn.autoReconnect ? 'включено' : 'выключено' }}</span>
            </div>
          </div>

          <div v-else class="alert alert--warn">
            <AlertTriangle :size="15" />
            <div>Параметры подключения ещё не сохранены. Откройте мастер подключения.</div>
          </div>

          <div class="toolbar mt-12">
            <RouterLink to="/setup" class="btn btn--primary">
              <KeyRound :size="15" />
              Изменить подключение
            </RouterLink>
            <button class="btn" :disabled="connLoading" @click="loadConnectionInfo">
              <RefreshCw :size="15" :class="{ spin: connLoading }" />
              Обновить
            </button>
          </div>
        </article>

        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Wifi :size="15" /> Доступ с телефона</div>
              <div class="card-sub">По умолчанию backend слушает только 127.0.0.1</div>
            </div>
            <span class="pill" :class="lanEnabled ? 'pill--warn' : 'pill--muted'">
              {{ lanEnabled ? 'LAN включён' : 'только localhost' }}
            </span>
          </div>

          <div class="setting-row">
            <div class="setting-row__text">
              <strong>Разрешить доступ по локальной сети</strong>
              <span>
                Включается явно. После включения все запросы требуют токен доступа; backend начнёт
                слушать сетевой адрес после перезапуска. Токен даёт полный доступ — кому он известен,
                тот управляет станцией наравне с этим компьютером.
              </span>
            </div>
            <div class="setting-row__control">
              <button
                type="button"
                class="switch"
                :class="{ on: lanEnabled }"
                :disabled="saving || !settings"
                aria-label="Переключить LAN-доступ"
                @click="askLan(!lanEnabled)"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-row__text">
              <strong>Токен доступа</strong>
              <span>Один на панель: с ним любое устройство в сети получает полный доступ.</span>
            </div>
            <div class="setting-row__control">
              <span class="code-inline" style="min-width: 118px; text-align: center">
                {{ tokenVisible && token ? token : token ? '••••••••••••' : 'не загружен' }}
              </span>
              <button
                class="btn btn--ghost btn--icon btn--sm"
                :title="tokenVisible ? 'Скрыть токен' : 'Показать токен'"
                :disabled="tokenLoading"
                @click="toggleToken"
              >
                <LoaderCircle v-if="tokenLoading" :size="14" class="spin" />
                <EyeOff v-else-if="tokenVisible" :size="14" />
                <Eye v-else :size="14" />
              </button>
              <button class="btn btn--ghost btn--icon btn--sm" title="Скопировать токен" @click="copyToken">
                <Copy :size="14" />
              </button>
              <button class="btn btn--ghost btn--icon btn--sm" title="Перевыпустить токен" @click="rotateOpen = true">
                <RefreshCw :size="14" />
              </button>
            </div>
          </div>

          <div v-if="tokenError" class="alert alert--warn mt-8">
            <AlertTriangle :size="15" />
            <div>{{ tokenError }}</div>
          </div>

          <template v-if="lanEnabled">
            <div class="row mt-12">
              <button class="btn btn--soft btn--sm" :disabled="phoneLoading" @click="loadPhoneAccess">
                <LoaderCircle v-if="phoneLoading" :size="14" class="spin" />
                <Smartphone v-else :size="14" />
                Проверить сеть для телефона
              </button>
              <span class="spacer" />
              <span v-if="phone" class="pill" :class="phone.listeningOn === '0.0.0.0' ? 'pill--ok' : 'pill--warn'">
                {{ phone.listeningOn === '0.0.0.0' ? 'слушает сеть' : 'слушает только 127.0.0.1' }}
              </span>
            </div>

            <div v-if="phoneError" class="alert alert--warn mt-8">
              <AlertTriangle :size="15" />
              <div>{{ phoneError }}</div>
            </div>

            <div v-if="phone && !phone.addresses.length" class="alert alert--warn mt-8">
              <AlertTriangle :size="15" />
              <div>
                У компьютера нет адреса в обычной локальной /24-сети. Проверьте, что Wi-Fi подключён и
                адаптер не в режим «общедоступная сеть по VPN».
              </div>
            </div>

            <div v-if="phone?.addresses.length" class="kv mt-12">
              <div
                v-for="entry in phone.addresses"
                :key="entry.address"
                class="kv-row"
                :class="{ 'kv-row--active': entry.address === (chosenAddress || phone.best) }"
              >
                <span class="kv-key">
                  {{ entry.interface }}
                  <span v-if="entry.reachesStation" class="pill pill--ok" style="margin-left: 6px">сеть колонки</span>
                </span>
                <button
                  type="button"
                  class="kv-value mono kv-link"
                  :title="`Показать QR для ${entry.address}`"
                  @click="chooseAddress(entry.address)"
                >
                  http://{{ entry.address }}:{{ phone.port }}/
                </button>
              </div>
            </div>

            <div v-if="phone?.firewall.supported && !phone.firewall.ruleExists" class="alert alert--warn mt-8">
              <ShieldCheck :size="15" />
              <div>
                Брандмауэр Windows скорее всего блокирует входящие подключения к порту
                {{ phone.port }}{{ phone.firewall.category ? ` (сеть помечена как «${phone.firewall.category}»)` : '' }}.
                Без разрешения телефон откроет адрес, но страница останется грузиться вечно.
              </div>
            </div>

            <div class="toolbar mt-8">
              <button
                v-if="phone?.firewall.supported && !phone.firewall.ruleExists"
                class="btn"
                :disabled="firewallBusy"
                @click="firewallConfirm = true"
              >
                <LoaderCircle v-if="firewallBusy" :size="15" class="spin" />
                <ShieldCheck v-else :size="15" />
                Разрешить порт в брандмауэре
              </button>
              <span v-else-if="phone?.firewall.ruleExists" class="muted" style="font-size: 11.5px">
                Правило брандмауэра для порта {{ phone.port }} уже создано.
              </span>
              <button class="btn btn--ghost btn--sm" :disabled="!panelUrl" @click="copyPanelUrl">
                <Copy :size="14" />
                Скопировать адрес
              </button>
            </div>

            <div class="alert alert--info mt-12">
              <Info :size="15" />
              <div>
                <strong>Если Wi-Fi раздаёт сам телефон.</strong> Телефон, ноутбук и колонка сидят в одной сети
                телефона, поэтому адрес берите из списка выше — тот, что помечен «сеть колонки». На телефоне
                откройте его в браузере и введите токен. Роутер при этом не нужен, интернет на телефоне может
                быть мобильным. Не включайте на телефоне «изолированный режим» — он запрещает устройствам
                видеть друг друга.
              </div>
            </div>
          </template>

          <div class="toolbar mt-12">
            <button class="btn btn--soft" :disabled="qrLoading" @click="loadQr">
              <LoaderCircle v-if="qrLoading" :size="15" class="spin" />
              <QrCode v-else :size="15" />
              {{ qr ? 'Скрыть QR-код' : 'Показать QR-код' }}
            </button>
            <span class="muted" style="font-size: 11.5px">QR открывает панель, но токен всё равно нужно ввести.</span>
          </div>

          <div v-if="qrError" class="alert alert--warn mt-8">
            <AlertTriangle :size="15" />
            <div>{{ qrError }}</div>
          </div>

          <div v-if="qr?.dataUrl" class="mt-12" style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap">
            <img :src="qr.dataUrl" alt="QR-код для доступа с телефона" style="width: 180px; height: 180px; border-radius: 14px; border: 1px solid var(--line); background: #fff; padding: 8px" />
            <div class="stack" style="gap: 6px">
              <span class="section-title">Адрес для телефона</span>
              <span class="code-inline">{{ qr.url }}</span>
              <span class="muted" style="font-size: 11.5px">Телефон должен быть в той же Wi-Fi-сети, что и компьютер.</span>
            </div>
          </div>

          <div class="alert alert--warn mt-12">
            <Smartphone :size="15" />
            <div>
              Не публикуйте порт backend в интернет и не включайте проброс. LAN-доступ предназначен
              только для доверенной домашней сети.
            </div>
          </div>
        </article>

        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Wand2 :size="15" /> ИИ-генератор</div>
              <div class="card-sub">Fun Lab и сценарии используют выбранный OpenAI-совместимый сервер</div>
            </div>
            <span class="pill" :class="ai?.configured ? 'pill--ok' : 'pill--muted'">
              {{ ai?.configured ? 'готов' : 'не настроен' }}
            </span>
          </div>

          <div v-if="aiLoading" class="muted mt-12" style="font-size: 12px">
            <LoaderCircle :size="13" class="spin" /> Читаем настройки…
          </div>

          <div v-else class="form-grid mt-12">
            <div class="row-wrap" style="gap: 12px">
              <label class="field" style="flex: 1; min-width: 220px">
                <span class="field-label">Провайдер</span>
                <select class="select" :value="aiProvider" :disabled="aiSaving" @change="onAiProviderChange">
                  <option v-for="preset in ai?.presets ?? []" :key="preset.id" :value="preset.id">
                    {{ preset.label }}
                  </option>
                </select>
              </label>
              <label class="field" style="flex: 1.4; min-width: 240px">
                <span class="field-label">Base URL</span>
                <input
                  v-model="aiBaseUrl"
                  class="input"
                  type="url"
                  spellcheck="false"
                  placeholder="https://api.example.com/v1"
                  :disabled="aiSaving"
                />
              </label>
            </div>

            <label class="field">
              <span class="field-label">Модель</span>
              <input
                v-model="aiModel"
                class="input"
                type="text"
                spellcheck="false"
                placeholder="gpt-4o-mini"
                :disabled="aiSaving"
              />
            </label>

            <label class="field">
              <span class="field-label">API-ключ</span>
              <input
                v-model="aiApiKey"
                class="input"
                type="password"
                autocomplete="off"
                :placeholder="
                  ai?.hasKey
                    ? 'Ключ сохранён — оставьте поле пустым'
                    : aiPreset?.requiresKey
                      ? 'Обязателен для этого провайдера'
                      : 'Необязательно'
                "
                :disabled="aiSaving"
              />
            </label>

            <p v-if="aiPreset?.note" class="field-hint">{{ aiPreset.note }}</p>
            <p class="field-hint">
              Ключ хранится только в <span class="mono">data/config.json</span> на backend и никогда
              не отдаётся во frontend. Подходит любой сервер с endpoint
              <span class="mono">/chat/completions</span>. Озвучка текста идёт голосом самой Алисы
              через станцию и этот сервер не использует.
            </p>

            <div v-if="aiError" class="alert alert--error">
              <AlertTriangle :size="15" />
              <div>{{ aiError }}</div>
            </div>
            <div v-if="aiTestReply" class="alert alert--info">
              <Check :size="15" />
              <div>ИИ отвечает: {{ aiTestReply }}</div>
            </div>
            <div v-if="aiKeyRequired" class="alert alert--warn">
              <AlertTriangle :size="15" />
              <div>Для выбранного провайдера нужен API-ключ. Сохраните настройки вместе с ключом.</div>
            </div>

            <div class="row-wrap" style="gap: 10px">
              <button
                type="button"
                class="btn btn--primary"
                :disabled="aiSaving || !aiBaseUrl.trim() || !aiModel.trim()"
                @click="saveAi"
              >
                <LoaderCircle v-if="aiSaving" :size="15" class="spin" />
                <Check v-else :size="15" />
                Сохранить
              </button>
              <button
                type="button"
                class="btn btn--soft"
                :disabled="aiTesting || !ai?.configured"
                @click="testAi"
              >
                <LoaderCircle v-if="aiTesting" :size="15" class="spin" />
                <Wand2 v-else :size="15" />
                {{ aiTesting ? 'Проверяем…' : 'Проверить' }}
              </button>
              <button
                v-if="ai?.hasKey"
                type="button"
                class="btn btn--ghost btn--sm"
                :disabled="aiSaving"
                @click="clearAiKey"
              >
                Удалить ключ
              </button>
            </div>
          </div>
        </article>

      </div>

      <aside class="stack">
        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><ArrowUpCircle :size="15" /> Обновления</div>
              <div class="card-sub">Релизы GitHub проверяются по SHA-256</div>
            </div>
            <span
              class="pill"
              :class="
                updateStore.info?.updateAvailable
                  ? 'pill--primary'
                  : updateStore.error || updateStore.info?.checkError
                    ? 'pill--warn'
                    : 'pill--ok'
              "
            >
              {{
                updateStore.restarting
                  ? 'перезапуск'
                  : updateStore.info?.updateAvailable
                    ? 'есть новая'
                    : updateStore.error || updateStore.info?.checkError
                      ? 'нет связи'
                      : 'актуально'
              }}
            </span>
          </div>

          <div class="kv mt-12">
            <div class="kv-row">
              <span class="kv-key">Установлено</span>
              <span class="kv-value mono">{{ updateStore.info?.currentVersion ?? '—' }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Последняя</span>
              <span class="kv-value mono">
                {{ updateStore.info?.latestVersion ?? '—' }}
                <span v-if="updateStore.info?.publishedAt" class="muted">· {{ releaseDate }}</span>
              </span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Размер архива</span>
              <span class="kv-value mono">{{ formatBytes(updateStore.info?.assetSizeBytes) }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Проверено</span>
              <span class="kv-value">{{ updateCheckedLabel }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">Репозиторий</span>
              <a
                class="kv-value mono"
                :href="`https://github.com/${updateStore.info?.repo ?? 'chrometechhype/alice-control-center'}`"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ updateStore.info?.repo ?? 'chrometechhype/alice-control-center' }}
              </a>
            </div>
          </div>

          <div v-if="updateStore.restarting" class="alert alert--info mt-12">
            <LoaderCircle :size="15" class="spin" />
            <div>{{ updateStore.progress }}</div>
          </div>
          <UpdateNotes v-else-if="updateStore.info?.updateAvailable" class="mt-12" />
          <div v-else-if="updateStore.info?.checkError" class="alert alert--warn mt-12">
            <AlertTriangle :size="15" />
            <div>
              {{ updateStore.info.checkError }}
              <div class="mt-8">
                <a
                  :href="`https://github.com/${updateStore.info?.repo ?? 'chrometechhype/alice-control-center'}/releases/latest`"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть страницу релизов
                </a>
              </div>
            </div>
          </div>
          <div v-else-if="updateStore.info?.reason" class="alert alert--warn mt-12">
            <AlertTriangle :size="15" />
            <div>{{ updateStore.info.reason }}</div>
          </div>

          <div class="toolbar mt-12">
            <button class="btn btn--soft" :disabled="updateStore.loading || updateStore.restarting" @click="checkUpdates">
              <LoaderCircle v-if="updateStore.loading" :size="15" class="spin" />
              <RefreshCw v-else :size="15" />
              Проверить обновления
            </button>
            <button
              v-if="updateStore.info?.updateAvailable"
              class="btn btn--primary"
              :disabled="updateStore.installing || !updateStore.info.canInstall"
              @click="updateConfirm = true"
            >
              <LoaderCircle v-if="updateStore.installing" :size="15" class="spin" />
              <Download v-else :size="15" />
              Установить {{ updateStore.info.latestVersion }}
            </button>
          </div>
        </article>

        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Palette :size="15" /> Интерфейс</div>
              <div class="card-sub">Оформление и частота обновления метрик</div>
            </div>
            <span v-if="saving" class="pill pill--muted"><LoaderCircle :size="12" class="spin" /> сохраняем</span>
          </div>

          <div class="setting-row">
            <div class="setting-row__text">
              <strong>Тема оформления</strong>
              <span>Светлая, тёмная или как в системе.</span>
            </div>
            <div class="segmented segmented--fill" role="group" aria-label="Тема оформления">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                class="seg"
                :class="{ active: themeMode === option.value }"
                :disabled="saving || !settings"
                @click="chooseTheme(option.value)"
              >
                <component :is="option.icon" :size="15" />
                {{ option.label }}
              </button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-row__text">
              <strong>Интервал опроса</strong>
              <span>Как часто backend читает метрики с колонки. Быстрее — больше нагрузки на SSH.</span>
            </div>
            <div class="setting-row__control">
              <select
                class="select"
                style="width: 130px"
                :value="settings?.pollIntervalMs ?? 5000"
                :disabled="saving || !settings"
                @change="onPollChange"
              >
                <option :value="2000">2 секунды</option>
                <option :value="5000">5 секунд</option>
                <option :value="10000">10 секунд</option>
                <option :value="30000">30 секунд</option>
                <option :value="60000">60 секунд</option>
              </select>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-row__text">
              <strong>Подключаться при запуске</strong>
              <span>Автоматически восстанавливать SSH-соединение при старте backend.</span>
            </div>
            <div class="setting-row__control">
              <button
                type="button"
                class="switch"
                :class="{ on: settings?.autoConnect }"
                :disabled="saving || !settings"
                aria-label="Автоподключение при запуске"
                @click="saveSetting({ autoConnect: !settings?.autoConnect })"
              />
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-row__text">
              <strong>Приветствие</strong>
              <span>Короткое знакомство с панелью, станцией и контактом автора.</span>
            </div>
            <div class="setting-row__control">
              <button type="button" class="btn btn--soft btn--sm" @click="openWelcome">
                <Eye :size="14" />
                Показать
              </button>
            </div>
          </div>
        </article>

        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><Palette :size="15" /> Образ станции</div>
              <div class="card-sub">Как ваша колонка выглядит в панели</div>
            </div>
            <span class="pill pill--muted">{{ visual.label }}</span>
          </div>

          <div class="look">
            <div class="look__preview">
              <DevicePortrait :info="store.info" size="md" />
            </div>

            <div class="look__body">
              <div class="look__head">
                <strong>{{ visual.label }}</strong>
                <span>{{ visual.tagline }}</span>
              </div>

              <div class="look__label">Модель станции</div>
              <select
                class="select"
                :value="stationModel"
                aria-label="Модель станции"
                @change="onModelChange"
              >
                <option value="auto">Определить автоматически</option>
                <optgroup v-for="group in STATION_MODEL_GROUPS" :key="group.title" :label="group.title">
                  <option v-for="model in group.models" :key="model.kind" :value="model.kind">
                    {{ model.label }}
                  </option>
                </optgroup>
              </select>
              <p class="field-hint">
                Панель читает модель по SSH, но считывается она не на каждой прошивке — поэтому её
                можно выбрать руками. От выбора зависят только образ колонки и акцент: ни одна
                функция не включается и не выключается.
              </p>

              <template v-if="canCustomize">
                <div class="look__label">Цвет корпуса</div>
                <div class="look__swatches" role="group" aria-label="Цвет корпуса станции">
                  <button
                    v-for="color in LITE2_COLORS"
                    :key="color.id"
                    type="button"
                    class="look__swatch"
                    :class="{ active: stationLook.color === color.id }"
                    :style="{ '--swatch': color.hex }"
                    :title="color.label"
                    :aria-label="color.label"
                    :aria-pressed="stationLook.color === color.id"
                    @click="chooseColor(color.id)"
                  >
                    <Check v-if="stationLook.color === color.id" :size="13" />
                  </button>
                </div>

                <div class="look__controls">
                  <div class="segmented" role="group" aria-label="Часы на корпусе">
                    <button
                      type="button"
                      class="seg"
                      :class="{ active: !stationLook.clock }"
                      @click="chooseClock(false)"
                    >
                      Без часов
                    </button>
                    <button
                      type="button"
                      class="seg"
                      :class="{ active: stationLook.clock }"
                      @click="chooseClock(true)"
                    >
                      С часами
                    </button>
                  </div>
                  <button type="button" class="btn btn--ghost btn--sm" @click="resetLook">
                    <RefreshCw :size="14" />
                    Сбросить
                  </button>
                </div>

                <p class="field-hint">
                  Наклейки и другие детали не отображаются. Выбор сохраняется в этом браузере и не
                  меняет настройки колонки.
                </p>
              </template>

              <p v-else class="field-hint">
                Для этой модели показывается официальное изображение. Настроить вид можно для Станции
                Лайт 2.
              </p>
            </div>
          </div>
        </article>

        <article class="card">
          <div class="card-head">
            <div>
              <div class="card-title"><ShieldCheck :size="15" /> Доступ и безопасность</div>
              <div class="card-sub">Сессия панели и правила, которые backend соблюдает всегда</div>
            </div>
            <span class="pill" :class="store.auth.required ? 'pill--warn' : 'pill--ok'">
              {{ store.auth.required ? 'LAN + токен' : 'локальный' }}
            </span>
          </div>
          <div class="kv">
            <div class="kv-row"><span class="kv-key">Токен задан</span><span class="kv-value">{{ settings?.lanTokenSet ? 'да' : 'нет' }}</span></div>
            <div class="kv-row"><span class="kv-key">WebSocket</span><span class="kv-value">{{ store.wsState }}</span></div>
            <div class="kv-row"><span class="kv-key">Адрес панели</span><span class="kv-value mono">{{ panelHost }}</span></div>
          </div>
          <button v-if="store.auth.required" class="btn btn--danger w-full mt-12" @click="signOut">
            <LogOut :size="15" />
            Выйти из панели
          </button>
          <p v-else class="field-hint mt-8">Локальная сессия не требует токена. При включении LAN появится вход по токену.</p>
          <ul class="check-list mt-12">
            <li><Check :size="14" /><span>Пароли не хранятся в исходниках и не отдаются фронтенду.</span></li>
            <li><Check :size="14" /><span>LAN-доступ включается явно и требует авторизацию.</span></li>
            <li><Check :size="14" /><span>Все опасные операции требуют подтверждения.</span></li>
          </ul>
          <div class="alert alert--warn mt-12">
            <Info :size="15" />
            <div>
              Не публикуйте root-доступ, SSH или ADB в открытый интернет. Во внешнюю сеть уходят
              только запрос к вашему ИИ-серверу и проверка релизов на GitHub.
            </div>
          </div>
        </article>
      </aside>
    </div>

    <ConfirmDialog
      :open="lanTarget !== null"
      :title="lanTarget ? 'Включить доступ по локальной сети?' : 'Отключить LAN-доступ?'"
      :message="lanTarget
        ? 'Backend начнёт принимать подключения с других устройств после перезапуска. Все запросы потребуют токен. Используйте только доверенную домашнюю сеть.'
        : 'Удалённые устройства потеряют доступ к панели. Локальный доступ с этого компьютера останется.'"
      :confirm-label="lanTarget ? 'Включить LAN' : 'Отключить LAN'"
      :busy="saving"
      @confirm="applyLan"
      @cancel="lanTarget = null"
    />

    <ConfirmDialog
      :open="rotateOpen"
      title="Перевыпустить токен?"
      message="Старый токен перестанет действовать. Все устройства, где он был сохранён, потребуют повторный вход."
      confirm-label="Перевыпустить"
      :busy="rotating"
      @confirm="rotateToken"
      @cancel="rotateOpen = false"
    />

    <ConfirmDialog
      :open="firewallConfirm"
      title="Разрешить порт в брандмауэре?"
      :message="`Windows покажет запрос повышения прав и добавит входящее правило для TCP-порта ${phone?.port ?? 8722} только для частной сети. Сетевой профиль «общедоступный» правило не затрагивает.`"
      confirm-label="Вызвать запрос UAC"
      :danger="false"
      :busy="firewallBusy"
      @confirm="applyFirewallRule"
      @cancel="firewallConfirm = false"
    />

    <ConfirmDialog
      :open="updateConfirm"
      title="Установить обновление?"
      :message="`Панель обновится до ${updateStore.info?.latestVersion ?? ''} и перезапустится. Файлы в data/ сохранятся. Архив будет проверен по SHA-256.`"
      confirm-label="Скачать и установить"
      :danger="false"
      :busy="updateStore.installing"
      @confirm="applyUpdate"
      @cancel="updateConfirm = false"
    >
      <UpdateNotes />
    </ConfirmDialog>
  </div>
</template>

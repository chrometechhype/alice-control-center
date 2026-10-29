<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Bluetooth,
  BluetoothConnected,
  BluetoothOff,
  BluetoothSearching,
  Info,
  Link2,
  LoaderCircle,
  Power,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
  Unplug,
} from '@lucide/vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import OfflineState from '@/components/OfflineState.vue';
import { api, errorMessage } from '@/lib/api';
import { everConnected, isConnected, pushToast, store } from '@/lib/store';

interface BtController {
  adapter: string | null;
  powered: boolean | null;
  name: string | null;
  alias: string | null;
  address: string | null;
  discoverable: boolean | null;
  pairable: boolean | null;
}

interface BtDevice {
  address: string;
  name: string;
  connected: boolean;
  paired: boolean;
}

interface BtStatus {
  controller: BtController;
  devices: BtDevice[];
  scanning: boolean;
  raw: string;
}

const status = ref<BtStatus | null>(null);
const loading = ref(false);
const scanning = ref(false);
const busyAddress = ref('');
const error = ref('');
const scanSeconds = ref(10);
const rawOpen = ref(false);
const forgetTarget = ref<BtDevice | null>(null);
const powerTarget = ref<boolean | null>(null);
const powerBusy = ref(false);
const discoverableTarget = ref<boolean | null>(null);
const discoverableBusy = ref(false);

const btCap = computed(() => store.capabilities?.bluetooth);
const available = computed(() => Boolean(btCap.value?.available));
const devices = computed(() => status.value?.devices ?? []);
const connectedDevices = computed(() => devices.value.filter((device) => device.connected));
const bondedCount = computed(() => devices.value.filter((device) => device.paired).length);
const controller = computed(() => status.value?.controller ?? null);

const controllerName = computed(
  () =>
    controller.value?.alias ||
    controller.value?.name ||
    String(btCap.value?.details?.adapter ?? 'Bluetooth'),
);

async function load(showToast = false): Promise<void> {
  if (!available.value) return;
  loading.value = true;
  error.value = '';
  try {
    status.value = await api.get<BtStatus>('/bluetooth/status');
    if (showToast) pushToast('ok', 'Состояние Bluetooth обновлено');
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
    const result = await api.post<{ until: number; seconds: number }>('/bluetooth/scan', {
      seconds: scanSeconds.value,
    });
    // The column scans on its own; the panel keeps reading the list so devices appear as they answer.
    while (Date.now() < result.until) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await load();
    }
    await load();
    pushToast('ok', `Сканирование завершено: найдено ${devices.value.length}`);
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    scanning.value = false;
  }
}

async function connect(device: BtDevice): Promise<void> {
  busyAddress.value = device.address;
  error.value = '';
  try {
    await api.post('/bluetooth/connect', { address: device.address });
    pushToast('ok', `Подключено: ${device.name}`);
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busyAddress.value = '';
  }
}

async function disconnect(device: BtDevice): Promise<void> {
  busyAddress.value = device.address;
  error.value = '';
  try {
    await api.post('/bluetooth/disconnect', { address: device.address });
    pushToast('info', `Отключено: ${device.name}`);
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busyAddress.value = '';
  }
}

async function forget(): Promise<void> {
  const target = forgetTarget.value;
  if (!target) return;
  busyAddress.value = target.address;
  try {
    await api.post('/bluetooth/forget', { address: target.address, confirm: true });
    forgetTarget.value = null;
    pushToast('info', `Устройство ${target.name} удалено из списка`);
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    busyAddress.value = '';
  }
}

async function togglePower(): Promise<void> {
  if (powerTarget.value === null) return;
  const on = powerTarget.value;
  powerBusy.value = true;
  try {
    await api.post('/bluetooth/power', { on, confirm: true });
    powerTarget.value = null;
    pushToast('info', on ? 'Bluetooth-адаптер включён' : 'Bluetooth-адаптер выключен');
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    powerBusy.value = false;
  }
}

async function toggleDiscoverable(): Promise<void> {
  if (discoverableTarget.value === null) return;
  const on = discoverableTarget.value;
  discoverableBusy.value = true;
  try {
    await api.post('/bluetooth/discoverable', { on, confirm: true });
    discoverableTarget.value = null;
    pushToast('ok', on ? 'Станция видна для подключения с телефона' : 'Режим поиска выключен');
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    discoverableBusy.value = false;
  }
}

onMounted(() => {
  if (available.value) void load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Bluetooth</h1>
        <p>
          Реальный адаптер колонки через <span class="code-inline">bluetoothctl</span>. ACC сопрягает
          устройства без ручного PIN и не устанавливает Bluetooth-демоны.
        </p>
      </div>
      <div class="page-head__actions">
        <select v-model.number="scanSeconds" class="select" style="width: 118px" :disabled="scanning || !available">
          <option :value="5">5 секунд</option>
          <option :value="10">10 секунд</option>
          <option :value="15">15 секунд</option>
          <option :value="20">20 секунд</option>
        </select>
        <button class="btn btn--primary" :disabled="scanning || !available" @click="scan">
          <LoaderCircle v-if="scanning" :size="15" class="spin" />
          <BluetoothSearching v-else :size="15" />
          {{ scanning ? 'Сканируем…' : 'Сканировать' }}
        </button>
        <button class="btn" :disabled="loading || !available" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
        <button
          v-if="controller?.powered !== null"
          class="btn btn--soft"
          :disabled="!available"
          @click="powerTarget = !controller?.powered"
        >
          <Power :size="15" />
          {{ controller?.powered ? 'Выключить' : 'Включить' }}
        </button>
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Bluetooth Manager управляет адаптером самой колонки." />

    <div v-else-if="!available" class="card">
      <EmptyState
        title="Bluetooth недоступен"
        :text="btCap?.reason || 'Адаптер или bluetoothctl не обнаружены на этой прошивке.'"
      >
        <template #icon><BluetoothOff :size="22" /></template>
      </EmptyState>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="grid grid-3">
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Адаптер</span><Bluetooth :size="15" class="muted" /></div>
          <div class="stat-value" style="font-size: 19px">{{ controllerName }}</div>
          <div class="stat-foot">
            <span class="mono">{{ controller?.address || controller?.adapter || '—' }}</span>
            <span class="pill" :class="controller?.powered ? 'pill--ok' : 'pill--muted'">
              {{ controller?.powered === null ? 'неизвестно' : controller?.powered ? 'включён' : 'выключен' }}
            </span>
          </div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Устройств в списке</span><Link2 :size="15" class="muted" /></div>
          <div class="stat-value">{{ devices.length }}</div>
          <div class="stat-foot"><span>Сопряжено навсегда</span><span class="mono">{{ bondedCount }}</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Подключено</span><BluetoothConnected :size="15" class="muted" /></div>
          <div class="stat-value">{{ connectedDevices.length }}</div>
          <div class="stat-foot"><span>Активные соединения</span><span class="mono">live</span></div>
        </div>
      </div>

      <div class="split">
        <article class="card card--flush">
          <div class="file-toolbar">
            <div class="card-title" style="flex: 1"><Bluetooth :size="15" /> Устройства</div>
            <button v-if="status?.raw" class="btn btn--ghost btn--sm" @click="rawOpen = !rawOpen">
              {{ rawOpen ? 'Скрыть bluetoothctl show' : 'Показать bluetoothctl show' }}
            </button>
          </div>

          <div v-if="loading && !status" class="empty" style="padding: 34px">
            <LoaderCircle :size="20" class="spin" />
            <p>Читаем состояние адаптера…</p>
          </div>

          <EmptyState
            v-else-if="!devices.length"
            compact
            title="Устройств не найдено"
            text="Запустите сканирование. ACC покажет только устройства, которые вернул bluetoothctl."
          >
            <template #icon><BluetoothSearching :size="20" /></template>
          </EmptyState>

          <div v-else class="list scroll-pane">
            <div v-for="device in devices" :key="device.address" class="bt-device">
              <div class="bt-icon" :class="{ connected: device.connected }">
                <BluetoothConnected v-if="device.connected" :size="17" />
                <Bluetooth v-else :size="17" />
              </div>
              <div class="list-main">
                <div class="list-title truncate">{{ device.name }}</div>
                <div class="list-meta">
                  <span class="mono">{{ device.address }}</span>
                  <span v-if="device.paired" class="pill pill--muted">сопряжено</span>
                  <span v-else class="pill pill--warn">только в кэше поиска</span>
                  <span v-if="device.connected" class="pill pill--ok">подключено</span>
                </div>
              </div>
              <div class="row" style="gap: 4px">
                <button
                  v-if="!device.connected"
                  class="btn btn--soft btn--sm"
                  :disabled="Boolean(busyAddress) || controller?.powered === false"
                  @click="connect(device)"
                >
                  <LoaderCircle v-if="busyAddress === device.address" :size="14" class="spin" />
                  <Link2 v-else :size="14" />
                  {{ device.paired ? 'Подключить' : 'Сопрячь и подключить' }}
                </button>
                <button
                  v-else
                  class="btn btn--sm"
                  :disabled="Boolean(busyAddress)"
                  @click="disconnect(device)"
                >
                  <LoaderCircle v-if="busyAddress === device.address" :size="14" class="spin" />
                  <Unplug v-else :size="14" />
                  Отключить
                </button>
                <button
                  class="btn btn--ghost btn--icon btn--sm"
                  title="Удалить из списка"
                  :disabled="Boolean(busyAddress)"
                  @click="forgetTarget = device"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </div>

          <div v-if="rawOpen && status?.raw" style="padding: 0 16px 16px">
            <pre class="console" style="max-height: 260px">{{ status.raw }}</pre>
          </div>
        </article>

        <aside class="stack">
          <article class="card">
            <div class="card-head">
              <div>
                <div class="card-title"><Smartphone :size="15" /> Подключение телефона</div>
                <div class="card-sub">Станция как Bluetooth-устройство</div>
              </div>
              <span class="pill" :class="controller?.discoverable ? 'pill--ok' : 'pill--muted'">
                {{ controller?.discoverable ? 'видна' : 'скрыта' }}
              </span>
            </div>
            <p class="field-hint">
              Включите поиск, затем выберите <strong>{{ controllerName }}</strong> в Bluetooth-списке
              телефона. Сопряжение подтверждается на телефоне, PIN в панель вводить не нужно.
            </p>
            <div class="kv mt-12">
              <div class="kv-row"><span class="kv-key">Имя</span><span class="kv-value">{{ controllerName }}</span></div>
              <div class="kv-row"><span class="kv-key">Адрес</span><span class="kv-value mono">{{ controller?.address || '—' }}</span></div>
              <div class="kv-row"><span class="kv-key">В поиске</span><span class="kv-value">{{ controller?.discoverable === null ? '—' : controller?.discoverable ? 'да' : 'нет' }}</span></div>
              <div class="kv-row"><span class="kv-key">Сопряжение</span><span class="kv-value">{{ controller?.pairable === null ? '—' : controller?.pairable ? 'разрешено' : 'запрещено' }}</span></div>
              <div class="kv-row"><span class="kv-key">Адаптер</span><span class="kv-value mono">{{ controller?.adapter || '—' }}</span></div>
            </div>
            <button
              class="btn btn--soft mt-12"
              :disabled="discoverableBusy || controller?.powered === false"
              @click="discoverableTarget = !controller?.discoverable"
            >
              <LoaderCircle v-if="discoverableBusy" :size="15" class="spin" />
              <BluetoothSearching v-else :size="15" />
              {{ controller?.discoverable ? 'Скрыть станцию' : 'Разрешить поиск' }}
            </button>
            <p class="field-hint">
              Режим остаётся включённым, пока вы его не выключите. Для безопасности не оставляйте
              станцию видимой в общественных сетях.
            </p>
          </article>

          <article class="card card--soft">
            <div class="card-title"><ShieldCheck :size="15" /> Ограничения</div>
            <ul class="check-list mt-12">
              <li><Info :size="14" /><span>Сканирование ограничено 20 секундами.</span></li>
              <li><Info :size="14" /><span>Ручной PIN не вводится: подтверждение происходит на телефоне или устройстве.</span></li>
              <li><Info :size="14" /><span>Выключение адаптера требует подтверждения.</span></li>
            </ul>
            <div class="alert alert--warn mt-12">
              <AlertTriangle :size="15" />
              <div>Отключение Bluetooth может прервать работу пульта или приложения колонки.</div>
            </div>
          </article>
        </aside>
      </div>
    </template>

    <ConfirmDialog
      :open="Boolean(forgetTarget)"
      title="Удалить устройство?"
      :message="forgetTarget ? `Устройство «${forgetTarget.name}» (${forgetTarget.address}) будет удалено из списка Bluetooth. Для повторного подключения потребуется сопряжение заново.` : ''"
      confirm-label="Удалить"
      :busy="Boolean(busyAddress)"
      @confirm="forget"
      @cancel="forgetTarget = null"
    />

    <ConfirmDialog
      :open="discoverableTarget !== null"
      :title="discoverableTarget ? 'Разрешить поиск станции?' : 'Скрыть станцию?'"
      :message="discoverableTarget
        ? 'Станция станет видна nearby-устройствам и будет принимать сопряжение. Включайте только в доверенной сети и выключайте после подключения.'
        : 'Другие устройства больше не увидят станцию при поиске. Уже подключённые устройства останутся на связи.'"
      :confirm-label="discoverableTarget ? 'Разрешить поиск' : 'Скрыть станцию'"
      :danger="false"
      :busy="discoverableBusy"
      @confirm="toggleDiscoverable"
      @cancel="discoverableTarget = null"
    />

    <ConfirmDialog
      :open="powerTarget !== null"
      :title="powerTarget ? 'Включить Bluetooth?' : 'Выключить Bluetooth?'"
      :message="powerTarget
        ? 'Адаптер будет включён вручную. ACC не перезапускает Bluetooth-демоны.'
        : 'Адаптер будет выключен. Подключённые устройства потеряют связь, пульт и приложение могут перестать работать.'"
      :confirm-label="powerTarget ? 'Включить' : 'Выключить'"
      :busy="powerBusy"
      @confirm="togglePower"
      @cancel="powerTarget = null"
    />
  </div>
</template>

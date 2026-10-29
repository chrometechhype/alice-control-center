<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Check,
  ExternalLink,
  HardDrive,
  Info,
  LoaderCircle,
  Package,
  RefreshCw,
  Server,
  ShieldCheck,
} from '@lucide/vue';
import OfflineState from '@/components/OfflineState.vue';
import { api, errorMessage } from '@/lib/api';
import { everConnected, isConnected, pushToast } from '@/lib/store';

interface YamStatus {
  installed: boolean;
  running: boolean;
  port: number;
  webUrl: string | null;
  note: string;
  documentation: string;
  registry: string;
}

interface YseStatus {
  installed: boolean;
  path: string | null;
  note: string;
}

interface PluginsInfo {
  yam: YamStatus;
  yse: YseStatus;
  installationsEnabled: boolean;
  reason: string;
}

const info = ref<PluginsInfo | null>(null);
const loading = ref(false);
const error = ref('');

const installedCount = computed(() => {
  if (!info.value) return 0;
  return Number(info.value.yam.installed) + Number(info.value.yse.installed);
});

async function load(showToast = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    info.value = await api.get<PluginsInfo>('/plugins');
    if (showToast) pushToast('ok', 'Статус плагинов обновлён');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
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
        <h1>Плагины и YAM</h1>
        <p>
          ACC показывает только то, что реально найдено на устройстве. Сторонние пакеты и демоны
          автоматически не устанавливаются.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="loading" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Статус YAM и yse читается с реальной колонки." />

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div v-if="loading && !info" class="card">
        <div class="empty" style="padding: 34px">
          <LoaderCircle :size="20" class="spin" />
          <p>Проверяем установленные плагины…</p>
        </div>
      </div>

      <template v-else-if="info">
        <div class="grid grid-3">
          <div class="card stat">
            <div class="stat-top"><span class="stat-label">Найдено компонентов</span><Package :size="15" class="muted" /></div>
            <div class="stat-value">{{ installedCount }}</div>
            <div class="stat-foot"><span>YAM и yse</span><span class="mono">real</span></div>
          </div>
          <div class="card stat">
            <div class="stat-top"><span class="stat-label">YAM</span><Server :size="15" class="muted" /></div>
            <div class="stat-value" style="font-size: 22px">{{ info.yam.installed ? (info.yam.running ? 'работает' : 'установлен') : 'нет' }}</div>
            <div class="stat-foot"><span>Порт {{ info.yam.port }}</span><span class="mono">yam</span></div>
          </div>
          <div class="card stat">
            <div class="stat-top"><span class="stat-label">Автоустановка</span><ShieldCheck :size="15" class="muted" /></div>
            <div class="stat-value" style="font-size: 22px">{{ info.installationsEnabled ? 'включена' : 'выключена' }}</div>
            <div class="stat-foot"><span>Осознанное ограничение</span><span class="mono">safe</span></div>
          </div>
        </div>

        <div class="split">
          <div class="stack">
            <article class="card">
              <div class="card-head">
                <div>
                  <div class="card-title"><Server :size="15" /> YAM</div>
                  <div class="card-sub">Менеджер приложений и пакетов для Яндекс Станции</div>
                </div>
                <span class="pill" :class="info.yam.installed ? (info.yam.running ? 'pill--ok' : 'pill--warn') : 'pill--muted'">
                  {{ info.yam.installed ? (info.yam.running ? 'работает' : 'установлен') : 'не установлен' }}
                </span>
              </div>

              <div class="kv">
                <div class="kv-row"><span class="kv-key">Порт</span><span class="kv-value mono">{{ info.yam.port }}</span></div>
                <div class="kv-row">
                  <span class="kv-key">Веб-панель</span>
                  <span class="kv-value mono">{{ info.yam.webUrl || 'недоступна' }}</span>
                </div>
                <div class="kv-row"><span class="kv-key">Статус</span><span class="kv-value">{{ info.yam.installed ? 'обнаружен на устройстве' : 'не обнаружен' }}</span></div>
              </div>

              <div class="alert alert--info mt-12">
                <Info :size="15" />
                <div>{{ info.yam.note }}</div>
              </div>

              <div class="toolbar mt-12">
                <a
                  v-if="info.yam.webUrl"
                  :href="info.yam.webUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="btn btn--primary"
                >
                  <ExternalLink :size="15" />
                  Открыть веб-панель
                </a>
                <a :href="info.yam.documentation" target="_blank" rel="noopener noreferrer" class="btn">
                  <ExternalLink :size="15" />
                  Документация
                </a>
                <a :href="info.yam.registry" target="_blank" rel="noopener noreferrer" class="btn btn--soft">
                  <ExternalLink :size="15" />
                  Реестр пакетов
                </a>
              </div>
            </article>

            <article class="card">
              <div class="card-head">
                <div>
                  <div class="card-title"><HardDrive :size="15" /> yse</div>
                  <div class="card-sub">Менеджер пакетов, если он уже установлен на прошивке</div>
                </div>
                <span class="pill" :class="info.yse.installed ? 'pill--ok' : 'pill--muted'">
                  {{ info.yse.installed ? 'найден' : 'не найден' }}
                </span>
              </div>
              <div class="kv">
                <div class="kv-row"><span class="kv-key">Путь</span><span class="kv-value mono">{{ info.yse.path || '—' }}</span></div>
              </div>
              <div class="alert alert--info mt-12">
                <Info :size="15" />
                <div>{{ info.yse.note }}</div>
              </div>
            </article>
          </div>

          <aside class="stack">
            <article class="card card--soft">
              <div class="card-title"><ShieldCheck :size="15" /> Почему установка отключена</div>
              <p class="field-hint mt-8">{{ info.reason }}</p>
              <ul class="check-list mt-12">
                <li><Check :size="14" /><span>Нет скачивания случайных бинарников.</span></li>
                <li><Check :size="14" /><span>Нет скрытых установок «в один клик».</span></li>
                <li><Check :size="14" /><span>Нет передачи root-доступа сторонним сервисам.</span></li>
              </ul>
            </article>

            <article class="card">
              <div class="card-title"><Info :size="15" /> Если нужно установить</div>
              <p class="field-hint mt-8">
                Устанавливайте пакеты вручную по SSH, понимая источник и хеш. ACC не будет выполнять
                это за вас и не станет обходить ограничения прошивки.
              </p>
              <div class="alert alert--warn mt-12">
                <AlertTriangle :size="15" />
                <div>Изменение системного раздела может привести к потере гарантии и нестабильной работе колонки.</div>
              </div>
            </article>
          </aside>
        </div>
      </template>
    </template>
  </div>
</template>

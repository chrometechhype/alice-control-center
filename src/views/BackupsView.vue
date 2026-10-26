<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Archive,
  Check,
  Clock,
  Download,
  HardDrive,
  Info,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from '@lucide/vue';
import type { BackupManifest } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import { api, apiUrl, errorMessage, triggerDownload } from '@/lib/api';
import { formatBytes, formatDateTime, formatRelative, kindLabel, pluralRu } from '@/lib/format';
import { pushToast, refreshBackups, store } from '@/lib/store';

type KindFilter = 'all' | BackupManifest['kind'];

const loading = ref(false);
const error = ref('');
const kind = ref<KindFilter>('all');
const detail = ref<BackupManifest | null>(null);
const deleteTarget = ref<BackupManifest | null>(null);
const restoreTarget = ref<BackupManifest | null>(null);
const busy = ref(false);
const verifying = ref(false);

const configOpen = ref(false);
const configNote = ref('');
const configConfirm = ref(false);
const configError = ref('');
const creating = ref(false);

const kindTabs: Array<{ value: KindFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'config', label: 'Конфигурация' },
  { value: 'sound', label: 'Звуки' },
  { value: 'pack', label: 'Паки' },
  { value: 'file', label: 'Файлы' },
  { value: 'manual', label: 'Вручную' },
];

const counts = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  for (const backup of store.backups) {
    result[backup.kind] = (result[backup.kind] ?? 0) + 1;
  }
  return result;
});

const filtered = computed(() =>
  kind.value === 'all' ? store.backups : store.backups.filter((backup) => backup.kind === kind.value),
);

const totalSize = computed(() =>
  store.backups.reduce(
    (sum, backup) => sum + backup.items.reduce((inner, item) => inner + item.size, 0),
    0,
  ),
);

const lastBackup = computed(() => store.backups[0] ?? null);

async function load(showToast = false): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    await refreshBackups();
    if (showToast) pushToast('ok', 'Список бэкапов обновлён');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

function openConfigBackup(): void {
  configNote.value = '';
  configConfirm.value = false;
  configError.value = '';
  configOpen.value = true;
}

async function createConfigBackup(): Promise<void> {
  if (!configConfirm.value) {
    configError.value = 'Подтвердите создание резервной копии';
    return;
  }
  creating.value = true;
  configError.value = '';
  try {
    const manifest = await api.post<BackupManifest>(
      '/backups/config',
      {
        confirm: true,
        ...(configNote.value.trim() ? { note: configNote.value.trim() } : {}),
      },
      120_000,
    );
    configOpen.value = false;
    pushToast('ok', `Бэкап сохранён: ${manifest.items.length} файлов`);
    await load();
  } catch (caught) {
    configError.value = errorMessage(caught);
  } finally {
    creating.value = false;
  }
}

function downloadItem(backup: BackupManifest, index: number): void {
  triggerDownload(apiUrl(`/backups/${encodeURIComponent(backup.id)}/download/${index}`));
}

interface VerifyItem {
  targetPath: string;
  expected: string;
  actual: string | null;
  ok: boolean;
  error?: string;
}

async function verifyBackup(backup: BackupManifest, silent = false): Promise<boolean> {
  verifying.value = true;
  try {
    const result = await api.get<{ items: VerifyItem[] }>(
      `/backups/${encodeURIComponent(backup.id)}/verify`,
    );
    const failed = result.items.filter((item) => !item.ok);
    if (!silent) {
      pushToast(
        failed.length ? 'error' : 'ok',
        failed.length
          ? `Проверка SHA-256: не совпало ${failed.length} из ${result.items.length}`
          : `Проверка SHA-256: все ${result.items.length} файлов совпадают`,
      );
    }
    return failed.length === 0;
  } catch (caught) {
    if (!silent) pushToast('error', errorMessage(caught));
    return false;
  } finally {
    verifying.value = false;
  }
}

async function restoreBackup(): Promise<void> {
  const target = restoreTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    const result = await api.post<{
      backup: BackupManifest;
      restored: Array<{ targetPath: string; ok: boolean; error?: string }>;
    }>(`/backups/${encodeURIComponent(target.id)}/restore`, { confirm: true }, 180_000);
    const failed = result.restored.filter((item) => !item.ok);
    if (failed.length) {
      pushToast('error', `Восстановлено ${result.restored.length - failed.length} из ${result.restored.length}. Ошибок: ${failed.length}`);
    } else {
      pushToast('ok', `Восстановлено файлов: ${result.restored.length}`);
    }
    restoreTarget.value = null;
    await load();
  } catch (caught) {
    const applied = await verifyBackup(target, true);
    if (applied) {
      restoreTarget.value = null;
      pushToast(
        'ok',
        'Файлы уже восстановлены: проверка SHA-256 на устройстве совпала. Ошибка была только в ответе backend.',
      );
      await load();
    } else {
      pushToast(
        'error',
        `${errorMessage(caught)} Проверка SHA-256 не подтвердила восстановление — повторите или выберите другой бэкап.`,
      );
    }
  } finally {
    busy.value = false;
  }
}

async function deleteBackup(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  busy.value = true;
  try {
    await api.delete(`/backups/${encodeURIComponent(target.id)}`, { confirm: true });
    if (detail.value?.id === target.id) detail.value = null;
    deleteTarget.value = null;
    pushToast('info', 'Бэкап удалён с компьютера');
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Backup Manager</h1>
        <p>
          Резервные копии хранятся на этом компьютере в
          <span class="code-inline">data/backups</span>. Перед восстановлением проверяется SHA-256
          каждого файла — и на диске, и после записи на устройство.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="loading" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
        <button class="btn btn--primary" @click="openConfigBackup">
          <Archive :size="15" />
          Бэкап конфигурации
        </button>
      </div>
    </div>

    <div v-if="error" class="alert alert--error">
      <AlertTriangle :size="16" />
      <div>{{ error }}</div>
    </div>

    <div class="grid grid-3">
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Всего бэкапов</span><Archive :size="15" class="muted" /></div>
        <div class="stat-value">{{ store.backups.length }}</div>
        <div class="stat-foot">
          <span>{{ pluralRu(store.backups.length, ['копия', 'копии', 'копий']) }} на компьютере</span>
          <span class="mono">local</span>
        </div>
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Объём</span><HardDrive :size="15" class="muted" /></div>
        <div class="stat-value" style="font-size: 24px">{{ formatBytes(totalSize) }}</div>
        <div class="stat-foot"><span>Файлы и манифесты</span><span class="mono">sha256</span></div>
      </div>
      <div class="card stat">
        <div class="stat-top"><span class="stat-label">Последний</span><Clock :size="15" class="muted" /></div>
        <div class="stat-value" style="font-size: 20px">
          {{ lastBackup ? formatRelative(lastBackup.createdAt) : '—' }}
        </div>
        <div class="stat-foot"><span>{{ lastBackup ? kindLabel(lastBackup.kind) : 'Пока нет копий' }}</span><span class="mono">auto</span></div>
      </div>
    </div>

    <article class="card card--flush">
      <div class="file-toolbar">
        <div class="tabs" style="flex: 1; min-width: 220px">
          <button
            v-for="tab in kindTabs"
            :key="tab.value"
            type="button"
            class="tab"
            :class="{ active: kind === tab.value }"
            @click="kind = tab.value"
          >
            {{ tab.label }}
            <span v-if="tab.value !== 'all'" class="muted">· {{ counts[tab.value] ?? 0 }}</span>
          </button>
        </div>
        <span class="pill pill--muted">{{ filtered.length }} из {{ store.backups.length }}</span>
      </div>

      <div v-if="loading && !store.backups.length" class="empty" style="padding: 34px">
        <LoaderCircle :size="20" class="spin" />
        <p>Читаем каталог бэкапов…</p>
      </div>

      <EmptyState
        v-else-if="!filtered.length"
        title="Бэкапов не найдено"
        text="Создайте резервную копию конфигурации или замените звук — бэкап появится здесь автоматически."
      >
        <template #icon><Archive :size="22" /></template>
        <button class="btn btn--primary mt-12" @click="openConfigBackup">
          <Archive :size="15" />
          Создать бэкап конфигурации
        </button>
      </EmptyState>

      <div v-else class="list">
        <div v-for="backup in filtered" :key="backup.id" class="list-row">
          <div class="empty-icon" style="width: 38px; height: 38px; border-radius: 11px; flex: none">
            <Archive :size="16" />
          </div>
          <div class="list-main">
            <div class="list-title truncate">{{ backup.title }}</div>
            <div class="list-meta">
              <span class="pill pill--muted">{{ kindLabel(backup.kind) }}</span>
              <span>{{ backup.items.length }} {{ pluralRu(backup.items.length, ['файл', 'файла', 'файлов']) }}</span>
              <span>·</span>
              <span>{{ formatDateTime(backup.createdAt) }}</span>
              <span v-if="backup.note" class="truncate">· {{ backup.note }}</span>
            </div>
          </div>
          <div class="row" style="gap: 4px">
            <button class="btn btn--soft btn--sm" @click="detail = backup">Подробнее</button>
            <button class="btn btn--ghost btn--icon btn--sm" title="Восстановить" @click="restoreTarget = backup">
              <RotateCcw :size="14" />
            </button>
            <button class="btn btn--ghost btn--icon btn--sm" title="Удалить" @click="deleteTarget = backup">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>
    </article>

    <article class="card card--soft">
      <div class="card-title"><ShieldCheck :size="15" /> Как устроены бэкапы</div>
      <div class="grid grid-3 mt-12">
        <div class="info-line"><Check :size="14" /><span>Каждый файл сохраняется с SHA-256 в манифесте.</span></div>
        <div class="info-line"><Check :size="14" /><span>Оригинал на устройстве не меняется до подтверждения замены.</span></div>
        <div class="info-line"><Check :size="14" /><span>Восстановление пишет файлы обратно и сверяет хеш на колонке.</span></div>
      </div>
      <div class="alert alert--info mt-12">
        <Info :size="15" />
        <div>Ничего не удаляется с устройства автоматически. ACC не перезапускает станцию после восстановления.</div>
      </div>
    </article>

    <Modal
      :open="Boolean(detail)"
      wide
      :title="detail?.title || 'Бэкап'"
      :subtitle="detail ? `${kindLabel(detail.kind)} · ${formatDateTime(detail.createdAt)}` : ''"
      @close="detail = null"
    >
      <div v-if="detail" class="stack" style="gap: 14px">
        <div class="kv">
          <div class="kv-row"><span class="kv-key">ID</span><span class="kv-value mono">{{ detail.id }}</span></div>
          <div class="kv-row"><span class="kv-key">Файлов</span><span class="kv-value">{{ detail.items.length }}</span></div>
          <div class="kv-row">
            <span class="kv-key">Объём</span>
            <span class="kv-value">{{ formatBytes(detail.items.reduce((sum, item) => sum + item.size, 0)) }}</span>
          </div>
          <div v-if="detail.note" class="kv-row"><span class="kv-key">Заметка</span><span class="kv-value">{{ detail.note }}</span></div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Файл на устройстве</th>
                <th class="num">Размер</th>
                <th>SHA-256</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(item, index) in detail.items" :key="item.file">
                <td class="mono" style="font-size: 11px">{{ item.targetPath }}</td>
                <td class="num">{{ formatBytes(item.size) }}</td>
                <td class="mono" style="font-size: 10.5px" :title="item.sha256">
                  {{ item.sha256.slice(0, 16) }}…
                </td>
                <td class="text-right">
                  <button class="btn btn--ghost btn--icon btn--sm" title="Скачать" @click="downloadItem(detail, index)">
                    <Download :size="14" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="detail = null">Закрыть</button>
        <button
          v-if="detail"
          class="btn btn--soft"
          :disabled="busy || verifying"
          @click="verifyBackup(detail)"
        >
          <LoaderCircle v-if="verifying" :size="15" class="spin" />
          <ShieldCheck v-else :size="15" />
          {{ verifying ? 'Проверяем…' : 'Проверить SHA' }}
        </button>
        <button
          v-if="detail"
          class="btn btn--soft"
          :disabled="busy"
          @click="restoreTarget = detail"
        >
          <RotateCcw :size="15" />
          Восстановить
        </button>
        <button
          v-if="detail"
          class="btn btn--danger"
          :disabled="busy"
          @click="deleteTarget = detail"
        >
          <Trash2 :size="15" />
          Удалить
        </button>
      </template>
    </Modal>

    <Modal :open="configOpen" title="Бэкап конфигурации" subtitle="Файлы Quasar, ALSA и Bluetooth" @close="configOpen = false">
      <div class="stack" style="gap: 14px">
        <div class="alert alert--info">
          <Info :size="15" />
          <div>
            ACC прочитает только существующие файлы из фиксированного списка: quasar.cfg, launch.json,
            asound.conf, main.conf и файлы устройств в /data/quasar. Ничего не изменяется.
          </div>
        </div>
        <div class="field">
          <label for="backup-note">Заметка (необязательно)</label>
          <input id="backup-note" v-model="configNote" class="input" maxlength="300" placeholder="Например: перед обновлением прошивки" />
        </div>
        <label class="check">
          <input v-model="configConfirm" type="checkbox" />
          <span>Подтверждаю чтение файлов конфигурации с устройства и сохранение копии на компьютер.</span>
        </label>
        <div v-if="configError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ configError }}</div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="creating" @click="configOpen = false">Отмена</button>
        <button class="btn btn--primary" :disabled="creating || !configConfirm" @click="createConfigBackup">
          <LoaderCircle v-if="creating" :size="15" class="spin" />
          <Archive v-else :size="15" />
          {{ creating ? 'Сохраняем…' : 'Создать бэкап' }}
        </button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="Boolean(restoreTarget)"
      title="Восстановить из бэкапа?"
      :message="restoreTarget ? `Файлы бэкапа «${restoreTarget.title}» будут записаны на устройство. После записи ACC сверит SHA-256. Станция не перезапускается.` : ''"
      confirm-label="Восстановить"
      :busy="busy"
      @confirm="restoreBackup"
      @cancel="restoreTarget = null"
    />

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="Удалить бэкап?"
      :message="deleteTarget ? `Копия «${deleteTarget.title}» будет удалена с компьютера. Восстановить её будет нельзя.` : ''"
      confirm-label="Удалить"
      :busy="busy"
      @confirm="deleteBackup"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

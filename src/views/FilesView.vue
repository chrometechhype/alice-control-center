<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  ArrowUp,
  ChevronRight,
  Download,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Info,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from '@lucide/vue';
import type { FileEntry, FileRoot } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import OfflineState from '@/components/OfflineState.vue';
import Modal from '@/components/Modal.vue';
import { api, apiUrl, errorMessage, triggerDownload } from '@/lib/api';
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format';
import { everConnected, isConnected, pushToast } from '@/lib/store';

interface ListResult {
  path: string;
  parent: string;
  entries: FileEntry[];
}

interface ReadResult {
  path: string;
  size: number;
  mtimeMs: number;
  content: string;
}

const roots = ref<FileRoot[]>([]);
const current = ref('');
const parent = ref('');
const entries = ref<FileEntry[]>([]);
const loading = ref(false);
const error = ref('');
const query = ref('');

const uploadInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

const mkdirOpen = ref(false);
const mkdirName = ref('');
const mkdirBusy = ref(false);
const mkdirError = ref('');

const renameTarget = ref<FileEntry | null>(null);
const renameName = ref('');
const renameBusy = ref(false);
const renameError = ref('');

const deleteTarget = ref<FileEntry | null>(null);
const deleteBusy = ref(false);

const previewOpen = ref(false);
const previewTarget = ref<FileEntry | null>(null);
const preview = ref<ReadResult | null>(null);
const previewLoading = ref(false);
const previewError = ref('');

const activeRoot = computed(() =>
  roots.value.find((root) =>
    current.value === root.path || current.value.startsWith(`${root.path.replace(/\/+$/, '')}/`),
  ),
);
const canWrite = computed(() => Boolean(activeRoot.value?.writable));
const isAtRoot = computed(() => Boolean(activeRoot.value && current.value === activeRoot.value.path));
const canGoUp = computed(
  () => Boolean(activeRoot.value) && !isAtRoot.value && parent.value.startsWith(activeRoot.value?.path ?? '\u0000'),
);

const crumbs = computed(() => {
  const root = activeRoot.value;
  if (!root) return [] as Array<{ name: string; path: string }>;
  const rest = current.value.slice(root.path.length).split('/').filter(Boolean);
  return rest.map((name, index) => ({
    name,
    path: joinPath(root.path, ...rest.slice(0, index + 1)),
  }));
});

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return entries.value;
  return entries.value.filter((entry) => entry.name.toLowerCase().includes(needle));
});

const visibleRoots = computed(() => roots.value.filter((root) => root.exists));
const absentRoots = computed(() => roots.value.filter((root) => !root.exists));

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/{2,}/g, '/');
}

function rootLabel(): string {
  return activeRoot.value?.label || current.value;
}

async function loadRoots(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<{ roots: FileRoot[] }>('/files/roots');
    roots.value = result.roots;
    const first = result.roots.find((root) => root.exists);
    if (first) await list(first.path);
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function list(path: string): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<ListResult>(`/files/list?path=${encodeURIComponent(path)}`);
    current.value = result.path;
    parent.value = result.parent;
    entries.value = result.entries;
    query.value = '';
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

function openEntry(entry: FileEntry): void {
  if (entry.type === 'dir') {
    void list(entry.path);
  } else {
    void openPreview(entry);
  }
}

function goUp(): void {
  if (canGoUp.value) void list(parent.value);
}

async function openPreview(entry: FileEntry): Promise<void> {
  previewTarget.value = entry;
  preview.value = null;
  previewError.value = '';
  previewOpen.value = true;
  previewLoading.value = true;
  try {
    preview.value = await api.get<ReadResult>(`/files/read?path=${encodeURIComponent(entry.path)}`);
  } catch (caught) {
    previewError.value = errorMessage(caught);
  } finally {
    previewLoading.value = false;
  }
}

function closePreview(): void {
  previewOpen.value = false;
  previewTarget.value = null;
  preview.value = null;
  previewError.value = '';
}

function download(entry: FileEntry): void {
  triggerDownload(apiUrl(`/files/download?path=${encodeURIComponent(entry.path)}`));
}

function openMkdir(): void {
  mkdirName.value = '';
  mkdirError.value = '';
  mkdirOpen.value = true;
}

async function createFolder(): Promise<void> {
  const name = mkdirName.value.trim();
  if (!name) return;
  mkdirBusy.value = true;
  mkdirError.value = '';
  try {
    await api.post('/files/mkdir', { path: joinPath(current.value, name) });
    mkdirOpen.value = false;
    pushToast('ok', `Каталог «${name}» создан`);
    await list(current.value);
  } catch (caught) {
    mkdirError.value = errorMessage(caught);
  } finally {
    mkdirBusy.value = false;
  }
}

function openRename(entry: FileEntry): void {
  renameTarget.value = entry;
  renameName.value = entry.name;
  renameError.value = '';
}

async function rename(): Promise<void> {
  const target = renameTarget.value;
  const name = renameName.value.trim();
  if (!target || !name) return;
  renameBusy.value = true;
  renameError.value = '';
  try {
    await api.post('/files/rename', {
      from: target.path,
      to: joinPath(current.value, name),
    });
    renameTarget.value = null;
    pushToast('ok', 'Переименовано');
    await list(current.value);
  } catch (caught) {
    renameError.value = errorMessage(caught);
  } finally {
    renameBusy.value = false;
  }
}

async function removeEntry(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleteBusy.value = true;
  try {
    await api.post('/files/delete', { path: target.path, confirm: true });
    deleteTarget.value = null;
    pushToast('info', `Удалено: ${target.name}`);
    await list(current.value);
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    deleteBusy.value = false;
  }
}

function pickUpload(): void {
  uploadInput.value?.click();
}

async function onUploadPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  uploading.value = true;
  try {
    const form = new FormData();
    form.append('path', current.value);
    form.append('file', file);
    const result = await api.form<{ path: string; size: number }>('/files/upload', form);
    pushToast('ok', `Загружено: ${file.name} (${formatBytes(result.size)})`);
    await list(current.value);
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    uploading.value = false;
  }
}

function entryIcon(entry: FileEntry) {
  if (entry.type === 'dir') return Folder;
  if (entry.type === 'link') return Link2;
  if (/\.(txt|conf|cfg|json|log|sh|md|ini|service)$/i.test(entry.name)) return FileText;
  return File;
}

onMounted(() => {
  if (isConnected.value) void loadRoots();
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Файловый менеджер</h1>
        <p>
          Только разрешённые каталоги. Пути проверяются на выход за пределы root на стороне
          backend, запись ограничена каталогами с правом <span class="code-inline">rw</span>.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="loading || !current" @click="list(current)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
        <button class="btn btn--soft" :disabled="!canWrite || uploading" @click="openMkdir">
          <FolderPlus :size="15" />
          Папка
        </button>
        <button class="btn btn--primary" :disabled="!canWrite || uploading" @click="pickUpload">
          <LoaderCircle v-if="uploading" :size="15" class="spin" />
          <Upload v-else :size="15" />
          {{ uploading ? 'Загружаем…' : 'Загрузить' }}
        </button>
        <input ref="uploadInput" type="file" class="hidden" @change="onUploadPicked" />
      </div>
    </div>

    <OfflineState v-if="!everConnected" feature="Файловый менеджер читает реальные каталоги колонки." />

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="file-layout">
        <aside class="card">
          <div class="card-title"><HardDrive :size="15" /> Разрешённые каталоги</div>
          <div class="category-list mt-12">
            <button
              v-for="root in visibleRoots"
              :key="root.path"
              type="button"
              class="category-item"
              :class="{ active: activeRoot?.path === root.path }"
              @click="list(root.path)"
            >
              <span style="min-width: 0; flex: 1">
                <span class="truncate" style="display: block">{{ root.label }}</span>
                <span class="mono muted truncate" style="display: block; font-size: 10px">{{ root.path }}</span>
              </span>
              <span class="pill" style="flex: none" :class="root.writable ? 'pill--ok' : 'pill--muted'">
                {{ root.writable ? 'rw' : 'ro' }}
              </span>
            </button>
          </div>
          <div class="alert alert--info mt-12" style="font-size: 11px">
            <Info :size="14" />
            <div>
              Список каталогов задан в backend — произвольный путь не добавить. Предпросмотр читает
              текстовые файлы до 512 КБ; двоичные файлы и архивы можно только скачать.
            </div>
          </div>
          <div v-if="absentRoots.length" class="field-hint mt-8">
            На этой колонке нет: {{ absentRoots.map((root) => root.label.toLowerCase()).join(', ') }}.
            Такие каталоги скрыты — панель предлагает только то, что реально существует.
          </div>
        </aside>

        <div class="stack">
          <article class="card card--flush">
            <div class="file-toolbar">
              <div class="breadcrumb" style="flex: 1; min-width: 160px">
                <button type="button" @click="list(activeRoot?.path || current)">
                  <FolderOpen :size="13" style="vertical-align: -2px" />
                  {{ rootLabel() }}
                </button>
                <template v-for="crumb in crumbs" :key="crumb.path">
                  <ChevronRight :size="12" />
                  <button type="button" @click="list(crumb.path)">{{ crumb.name }}</button>
                </template>
              </div>
              <div class="search" style="min-width: 190px">
                <Search :size="14" />
                <input v-model="query" class="input" placeholder="Фильтр по имени…" />
              </div>
              <button class="btn btn--soft btn--icon btn--sm" title="На уровень выше" :disabled="!canGoUp" @click="goUp">
                <ArrowUp :size="14" />
              </button>
            </div>

            <div v-if="loading && !entries.length" class="empty" style="padding: 34px">
              <LoaderCircle :size="20" class="spin" />
              <p>Читаем каталог…</p>
            </div>

            <EmptyState
              v-else-if="!filtered.length"
              compact
              :title="query ? 'Ничего не найдено' : 'Каталог пуст'"
              :text="query ? 'Измените фильтр по имени файла.' : 'В этом каталоге нет файлов или подкаталогов.'"
            >
              <template #icon><FolderOpen :size="20" /></template>
            </EmptyState>

            <div v-else class="table-wrap scroll-pane">
              <table class="table table--files">
                <colgroup>
                  <col />
                  <col class="col-size" />
                  <col class="col-date" />
                  <col class="col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Имя</th>
                    <th class="num">Размер</th>
                    <th>Изменён</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in filtered" :key="entry.path">
                    <td>
                      <div class="file-name" @click="openEntry(entry)">
                        <component
                          :is="entryIcon(entry)"
                          :size="16"
                          class="file-icon"
                          :style="entry.type === 'dir' ? 'color: var(--primary)' : ''"
                        />
                        <span>{{ entry.name }}</span>
                        <span v-if="entry.type === 'link'" class="pill pill--muted">link</span>
                      </div>
                    </td>
                    <td class="num muted">{{ entry.type === 'dir' ? '—' : formatBytes(entry.size) }}</td>
                    <td class="muted nowrap" :title="formatDateTime(entry.mtimeMs)">{{ formatRelative(entry.mtimeMs) }}</td>
                    <td>
                      <div class="file-row-actions">
                        <button
                          v-if="entry.type !== 'dir'"
                          class="btn btn--ghost btn--icon btn--sm"
                          title="Скачать"
                          @click="download(entry)"
                        >
                          <Download :size="14" />
                        </button>
                        <button
                          v-if="entry.type !== 'dir'"
                          class="btn btn--ghost btn--icon btn--sm"
                          title="Предпросмотр"
                          @click="openPreview(entry)"
                        >
                          <FileText :size="14" />
                        </button>
                        <button
                          v-if="entry.writable"
                          class="btn btn--ghost btn--icon btn--sm"
                          title="Переименовать"
                          @click="openRename(entry)"
                        >
                          <Pencil :size="14" />
                        </button>
                        <button
                          v-if="entry.writable"
                          class="btn btn--ghost btn--icon btn--sm"
                          title="Удалить"
                          @click="deleteTarget = entry"
                        >
                          <Trash2 :size="14" />
                        </button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </div>
    </template>

    <Modal
      :open="previewOpen"
      wide
      :title="previewTarget?.name || 'Предпросмотр'"
      :subtitle="previewTarget?.path"
      @close="closePreview"
    >
      <div v-if="previewLoading" class="empty" style="padding: 30px">
        <LoaderCircle :size="20" class="spin" />
        <p>Читаем файл…</p>
      </div>
      <div v-else-if="previewError" class="alert alert--warn">
        <AlertTriangle :size="15" />
        <div>{{ previewError }}</div>
      </div>
      <div v-else-if="preview" class="stack" style="gap: 10px">
        <div class="row-wrap muted" style="font-size: 11.5px">
          <span>{{ formatBytes(preview.size) }}</span>
          <span>·</span>
          <span>{{ formatDateTime(preview.mtimeMs) }}</span>
        </div>
        <pre class="console" style="max-height: 55vh">{{ preview.content }}</pre>
      </div>
      <template #footer>
        <button class="btn" @click="closePreview">Закрыть</button>
        <button
          v-if="previewTarget"
          class="btn btn--soft"
          @click="download(previewTarget)"
        >
          <Download :size="15" />
          Скачать
        </button>
      </template>
    </Modal>

    <Modal :open="mkdirOpen" title="Новый каталог" :subtitle="current" @close="mkdirOpen = false">
      <div class="stack" style="gap: 14px">
        <div class="field">
          <label for="mkdir-name">Имя каталога</label>
          <input id="mkdir-name" v-model="mkdirName" class="input" maxlength="120" placeholder="backup-2026" @keydown.enter="createFolder" />
        </div>
        <div v-if="mkdirError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ mkdirError }}</div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="mkdirBusy" @click="mkdirOpen = false">Отмена</button>
        <button class="btn btn--primary" :disabled="mkdirBusy || !mkdirName.trim()" @click="createFolder">
          <LoaderCircle v-if="mkdirBusy" :size="15" class="spin" />
          <FolderPlus v-else :size="15" />
          Создать
        </button>
      </template>
    </Modal>

    <Modal
      :open="Boolean(renameTarget)"
      title="Переименовать"
      :subtitle="renameTarget?.path"
      @close="renameTarget = null"
    >
      <div class="stack" style="gap: 14px">
        <div class="field">
          <label for="rename-name">Новое имя</label>
          <input id="rename-name" v-model="renameName" class="input" maxlength="120" @keydown.enter="rename" />
        </div>
        <div v-if="renameError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ renameError }}</div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="renameBusy" @click="renameTarget = null">Отмена</button>
        <button class="btn btn--primary" :disabled="renameBusy || !renameName.trim()" @click="rename">
          <LoaderCircle v-if="renameBusy" :size="15" class="spin" />
          <Pencil v-else :size="15" />
          Переименовать
        </button>
      </template>
    </Modal>

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="Удалить безвозвратно?"
      :message="deleteTarget ? `«${deleteTarget.name}» будет удалён с устройства. Для каталога используется rm -rf. Это действие нельзя отменить.` : ''"
      confirm-label="Удалить"
      :busy="deleteBusy"
      @confirm="removeEntry"
      @cancel="deleteTarget = null"
    />
  </div>
</template>

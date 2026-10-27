<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Archive,
  AudioLines,
  Check,
  Download,
  Info,
  LoaderCircle,
  Mic,
  Package,
  Pause,
  Play,
  RefreshCw,
  Search,
  Upload,
  Volume2,
} from '@lucide/vue';
import type { BackupManifest, SoundFile, SoundListing } from '@shared/types';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import { api, apiUrl, errorMessage, triggerDownload } from '@/lib/api';
import { isConnected, pushToast, refreshBackups } from '@/lib/store';
import { formatBytes, formatRelative } from '@/lib/format';

const listing = ref<SoundListing | null>(null);
const loading = ref(false);
const error = ref('');
const category = ref('all');
const query = ref('');
const playing = ref<string | null>(null);
const audioRef = ref<HTMLAudioElement | null>(null);

const players = ref<string[] | null>(null);
const stationBusy = ref<string | null>(null);
const speechText = ref('');
const speaking = ref(false);
const speechError = ref('');

const canPlayOnStation = computed(() => (players.value?.length ?? 0) > 0);
const speechLimit = 300;

const replaceTarget = ref<SoundFile | null>(null);
const replaceFile = ref<File | null>(null);
const replaceNote = ref('');
const replaceConfirm = ref(false);
const replacing = ref(false);
const replaceError = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

const packDialog = ref(false);
const packCategory = ref('all');
const packTitle = ref('');
const packConfirm = ref(false);
const packing = ref(false);
const packError = ref('');

const categories = computed(() => {
  const map = new Map<string, { count: number; size: number }>();
  for (const file of listing.value?.files ?? []) {
    const entry = map.get(file.category) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += file.size;
    map.set(file.category, entry);
  }
  const rows = [...map.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));
  return rows;
});

const totalSize = computed(() => (listing.value?.files ?? []).reduce((sum, file) => sum + file.size, 0));

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (listing.value?.files ?? []).filter((file) => {
    if (category.value !== 'all' && file.category !== category.value) return false;
    if (needle && !`${file.name} ${file.rel}`.toLowerCase().includes(needle)) return false;
    return true;
  });
});

const packCount = computed(() => {
  const files = listing.value?.files ?? [];
  if (packCategory.value === 'all') return files.length;
  return files.filter((file) => file.category === packCategory.value).length;
});

function soundUrl(path: string, download = false): string {
  return apiUrl(`/sounds/file?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`);
}

async function load(showToast = false): Promise<void> {
  if (!isConnected.value) return;
  loading.value = true;
  error.value = '';
  try {
    listing.value = await api.get<SoundListing>('/sounds');
    if (showToast) pushToast('ok', `Просканировано файлов: ${listing.value.files.length}`);
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function togglePlay(file: SoundFile): Promise<void> {
  if (!file.playable) return;
  if (playing.value === file.path) {
    audioRef.value?.pause();
    playing.value = null;
    return;
  }
  const audio = audioRef.value;
  if (!audio) return;
  audio.pause();
  audio.src = soundUrl(file.path);
  try {
    await audio.play();
    playing.value = file.path;
  } catch {
    playing.value = null;
    pushToast('error', 'Не удалось воспроизвести файл в браузере');
  }
}

async function loadPlayers(): Promise<void> {
  try {
    const result = await api.get<{ players: string[] }>('/audio/players', 15_000);
    players.value = result.players;
  } catch {
    players.value = [];
  }
}

async function playOnStation(file: SoundFile): Promise<void> {
  if (stationBusy.value) return;
  stationBusy.value = file.path;
  try {
    const result = await api.post<{ player: string }>('/audio/play', { path: file.path }, 20_000);
    pushToast('ok', `Играем на станции через ${result.player}`);
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    stationBusy.value = null;
  }
}

async function sayOnStation(): Promise<void> {
  const text = speechText.value.trim();
  if (!text || speaking.value) return;
  speaking.value = true;
  speechError.value = '';
  try {
    const result = await api.post<{ player: string }>('/audio/say', { text }, 90_000);
    speechText.value = '';
    pushToast('ok', `Колонка говорит через ${result.player}. Файл удалён со станции сразу после воспроизведения.`);
  } catch (caught) {
    speechError.value = errorMessage(caught);
  } finally {
    speaking.value = false;
  }
}

function openReplace(file: SoundFile): void {
  replaceTarget.value = file;
  replaceFile.value = null;
  replaceNote.value = '';
  replaceConfirm.value = false;
  replaceError.value = '';
}

function closeReplace(): void {
  if (replacing.value) return;
  replaceTarget.value = null;
  replaceFile.value = null;
  replaceNote.value = '';
  replaceConfirm.value = false;
  replaceError.value = '';
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  replaceFile.value = file;
  replaceError.value = '';
  input.value = '';
}

async function submitReplace(): Promise<void> {
  const target = replaceTarget.value;
  const file = replaceFile.value;
  if (!target || !file) {
    replaceError.value = 'Выберите новый аудиофайл';
    return;
  }
  if (!replaceConfirm.value) {
    replaceError.value = 'Подтвердите замену системного звука';
    return;
  }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext !== target.ext) {
    replaceError.value = `Нужен файл формата .${target.ext}`;
    return;
  }
  replacing.value = true;
  replaceError.value = '';
  try {
    const form = new FormData();
    form.append('path', target.path);
    form.append('confirm', 'true');
    form.append('file', file);
    if (replaceNote.value.trim()) form.append('note', replaceNote.value.trim());
    const result = await api.form<{ backup: BackupManifest; sha256: string }>('/sounds/replace', form);
    replacing.value = false;
    closeReplace();
    pushToast('ok', `Звук заменён. Бэкап: ${result.backup.id}`);
    await load();
    await refreshBackups().catch(() => undefined);
  } catch (caught) {
    replaceError.value = errorMessage(caught);
    await refreshBackups().catch(() => undefined);
  } finally {
    replacing.value = false;
  }
}

function openPack(): void {
  packCategory.value = category.value;
  packTitle.value = category.value === 'all' ? 'Все системные звуки' : `Звуки: ${category.value}`;
  packConfirm.value = false;
  packError.value = '';
  packDialog.value = true;
}

async function createPack(): Promise<void> {
  if (!packConfirm.value) {
    packError.value = 'Подтвердите создание пака';
    return;
  }
  packing.value = true;
  packError.value = '';
  try {
    const manifest = await api.post<BackupManifest>('/sounds/packs', {
      category: packCategory.value === 'all' ? undefined : packCategory.value,
      title: packTitle.value.trim() || undefined,
      confirm: true,
    });
    packDialog.value = false;
    pushToast('ok', `Пак создан: ${manifest.items.length} файлов`);
    await refreshBackups().catch(() => undefined);
  } catch (caught) {
    packError.value = errorMessage(caught);
  } finally {
    packing.value = false;
  }
}

onMounted(() => {
  if (isConnected.value) {
    void load();
    void loadPlayers();
  }
});
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Sound Studio</h1>
        <p>Инвентаризация звуков в <span class="code-inline">/system/vendor/quasar/sounds</span>. Замена — только с бэкапом на компьютере и проверкой SHA-256.</p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="loading || !isConnected" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Пересканировать
        </button>
        <button class="btn btn--soft" :disabled="!listing" @click="openPack">
          <Package :size="15" />
          Создать пак
        </button>
      </div>
    </div>

    <div v-if="!isConnected" class="card">
      <EmptyState title="Устройство не подключено" text="Sound Studio читает реальный каталог звуков на колонке.">
        <template #icon><AudioLines :size="22" /></template>
      </EmptyState>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="grid grid-3">
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Файлов</span><AudioLines :size="15" class="muted" /></div>
          <div class="stat-value">{{ listing?.files.length ?? '—' }}</div>
          <div class="stat-foot"><span>Форматы: opus, ogg, mp3</span><span class="mono">sounds</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Категорий</span><Package :size="15" class="muted" /></div>
          <div class="stat-value">{{ categories.length }}</div>
          <div class="stat-foot"><span>Верхний уровень каталога</span><span class="mono">dirs</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Объём</span><Archive :size="15" class="muted" /></div>
          <div class="stat-value" style="font-size: 24px">{{ formatBytes(totalSize) }}</div>
          <div class="stat-foot"><span>Прочитано с устройства</span><span class="mono">rw</span></div>
        </div>
      </div>

      <div class="split">
        <article class="card card--flush">
          <div class="file-toolbar">
            <div class="search" style="flex: 1; min-width: 200px">
              <Search :size="14" />
              <input v-model="query" class="input" placeholder="Поиск по имени или пути…" />
            </div>
            <span class="pill pill--muted">{{ filtered.length }} из {{ listing?.files.length ?? 0 }}</span>
          </div>

          <div v-if="loading && !listing" class="empty" style="padding: 34px">
            <LoaderCircle :size="20" class="spin" />
            <p>Сканируем каталоги звуков…</p>
          </div>
          <div v-else-if="filtered.length" class="list">
            <div
              v-for="file in filtered"
              :key="file.path"
              class="sound-row"
              :class="{ playing: playing === file.path }"
            >
              <div class="row" style="min-width: 0">
                <button
                  type="button"
                  class="btn btn--icon btn--sm"
                  :disabled="!file.playable"
                  :title="file.playable ? (playing === file.path ? 'Пауза' : 'Прослушать') : 'Предпросмотр недоступен'"
                  @click="togglePlay(file)"
                >
                  <Pause v-if="playing === file.path" :size="14" />
                  <Play v-else :size="14" />
                </button>
                <div class="list-main">
                  <div class="sound-name">{{ file.name }}</div>
                  <div class="sound-meta">
                    <span class="pill pill--muted">{{ file.category }}</span>
                    <span>{{ file.ext.toUpperCase() }}</span>
                    <span>·</span>
                    <span>{{ formatBytes(file.size) }}</span>
                    <span>·</span>
                    <span>{{ formatRelative(file.mtimeMs) }}</span>
                  </div>
                </div>
              </div>
              <div class="sound-actions">
                <button
                  type="button"
                  class="btn btn--ghost btn--icon btn--sm"
                  :disabled="!canPlayOnStation || Boolean(stationBusy)"
                  :title="
                    stationBusy === file.path
                      ? 'Запускаем…'
                      : canPlayOnStation
                        ? 'Играть на станции — файл не сохраняется в библиотеку'
                        : 'На станции нет доступного плеера'
                  "
                  @click="playOnStation(file)"
                >
                  <LoaderCircle v-if="stationBusy === file.path" :size="14" class="spin" />
                  <Volume2 v-else :size="14" />
                </button>
                <button
                  type="button"
                  class="btn btn--ghost btn--icon btn--sm"
                  title="Скачать"
                  @click="triggerDownload(soundUrl(file.path, true))"
                >
                  <Download :size="14" />
                </button>
                <button
                  type="button"
                  class="btn btn--ghost btn--icon btn--sm"
                  title="Заменить с бэкапом"
                  @click="openReplace(file)"
                >
                  <Upload :size="14" />
                </button>
              </div>
            </div>
          </div>
          <EmptyState v-else title="Звуки не найдены" text="Измените фильтр или пересканируйте каталог.">
            <template #icon><AudioLines :size="22" /></template>
          </EmptyState>
        </article>

        <aside class="stack">
          <article class="card">
            <div class="card-head">
              <div class="card-title"><Package :size="15" /> Категории</div>
              <span class="pill pill--muted">{{ categories.length }}</span>
            </div>
            <div class="category-list">
              <button
                type="button"
                class="category-item"
                :class="{ active: category === 'all' }"
                @click="category = 'all'"
              >
                <span>Все звуки</span>
                <span class="mono">{{ listing?.files.length ?? 0 }}</span>
              </button>
              <button
                v-for="item in categories"
                :key="item.name"
                type="button"
                class="category-item"
                :class="{ active: category === item.name }"
                @click="category = item.name"
              >
                <span class="truncate">{{ item.name }}</span>
                <span class="mono">{{ item.count }}</span>
              </button>
            </div>
          </article>

          <article class="card card--soft">
            <div class="card-head">
              <div class="card-title"><Mic :size="15" /> Озвучка</div>
              <span class="pill" :class="canPlayOnStation ? 'pill--ok' : 'pill--muted'">
                {{ players === null ? 'проверяем' : canPlayOnStation ? players.join(' · ') : 'нет плеера' }}
              </span>
            </div>
            <div class="field mt-12">
              <label for="speech-text">Что произнести колонке</label>
              <textarea
                id="speech-text"
                v-model="speechText"
                class="textarea"
                rows="3"
                :maxlength="speechLimit"
                :disabled="speaking || !canPlayOnStation"
                placeholder="Например: загрузка завершена"
              />
              <span class="field-hint">
                {{ speechText.trim().length }}/{{ speechLimit }} · Модель и голос — в «Настройки» → «ИИ-генератор».
                Звук играется один раз и не попадает в библиотеку станции.
              </span>
            </div>
            <div v-if="speechError" class="alert alert--error">
              <AlertTriangle :size="15" />
              <div>{{ speechError }}</div>
            </div>
            <div v-else-if="players && !players.length" class="alert alert--warn">
              <AlertTriangle :size="15" />
              <div>На станции нет ни одного из плееров (aplay, paplay, ffplay, mpv, gstreamer), поэтому озвучка недоступна.</div>
            </div>
            <button
              type="button"
              class="btn btn--primary mt-12 w-full"
              :disabled="speaking || !speechText.trim() || !canPlayOnStation"
              @click="sayOnStation"
            >
              <LoaderCircle v-if="speaking" :size="15" class="spin" />
              <Mic v-else :size="15" />
              {{ speaking ? 'Озвучиваем…' : 'Сказать на колонке' }}
            </button>
          </article>

          <article class="card card--soft">
            <div class="card-title"><Info :size="15" /> Как работает замена</div>
            <ul class="check-list mt-12">
              <li><Check :size="14" /><span>Сначала создаётся бэкап исходника на этом компьютере</span></li>
              <li><Check :size="14" /><span>Формат нового файла должен совпадать с целевым</span></li>
              <li><Check :size="14" /><span>Проверяется сигнатура аудио и свободное место</span></li>
              <li><Check :size="14" /><span>После записи сравнивается SHA-256 на устройстве</span></li>
            </ul>
            <div v-if="listing?.errors.length" class="stack mt-12" style="gap: 6px">
              <div v-for="item in listing.errors" :key="item" class="alert alert--warn" style="font-size: 11px">
                <AlertTriangle :size="14" />
                <div>{{ item }}</div>
              </div>
            </div>
          </article>
          <article class="card">
            <div class="card-title"><Archive :size="15" /> Паки</div>
            <p class="field-hint mt-8">
              Пак — это резервная копия выбранных звуков на компьютере. Он не устанавливается на колонку автоматически.
            </p>
            <button class="btn btn--soft mt-12 w-full" :disabled="!listing" @click="openPack">
              <Package :size="15" />
              Собрать пак
            </button>
          </article>
        </aside>
      </div>
    </template>

    <audio ref="audioRef" style="display: none" @ended="playing = null" />

    <Modal
      :open="Boolean(replaceTarget)"
      title="Замена звука"
      :subtitle="replaceTarget?.path"
      @close="closeReplace"
    >
      <div v-if="replaceTarget" class="stack" style="gap: 14px">
        <div class="kv">
          <div class="kv-row"><span class="kv-key">Формат</span><span class="kv-value mono">.{{ replaceTarget.ext }}</span></div>
          <div class="kv-row"><span class="kv-key">Текущий размер</span><span class="kv-value">{{ formatBytes(replaceTarget.size) }}</span></div>
        </div>
        <div class="field">
          <label>Новый файл</label>
          <input
            ref="fileInput"
            type="file"
            class="input"
            :accept="`.${replaceTarget.ext}`"
            @change="onFilePicked"
          />
          <span class="field-hint">
            {{ replaceFile ? `${replaceFile.name} · ${formatBytes(replaceFile.size)}` : 'Файл не выбран' }}
          </span>
        </div>
        <div class="field">
          <label for="replace-note">Заметка к бэкапу (необязательно)</label>
          <input id="replace-note" v-model="replaceNote" class="input" maxlength="300" placeholder="Например: вернул оригинальный звук" />
        </div>
        <label class="check">
          <input v-model="replaceConfirm" type="checkbox" />
          <span>Понимаю, что изменяется системный звук. Будет создан бэкап, запись проверена по SHA-256.</span>
        </label>
        <div v-if="replaceError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ replaceError }}</div>
        </div>
        <div class="alert alert--info">
          <Info :size="15" />
          <div>Максимальный размер файла — 12 МБ. Перезапуск станции ACC не выполняет.</div>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" :disabled="replacing" @click="closeReplace">Отмена</button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="replacing || !replaceFile || !replaceConfirm"
          @click="submitReplace"
        >
          <LoaderCircle v-if="replacing" :size="15" class="spin" />
          <Upload v-else :size="15" />
          {{ replacing ? 'Записываем…' : 'Заменить с бэкапом' }}
        </button>
      </template>
    </Modal>

    <Modal :open="packDialog" title="Создать пак звуков" subtitle="Резервная копия на компьютере" @close="packDialog = false">
      <div class="stack" style="gap: 14px">
        <div class="field">
          <label for="pack-category">Категория</label>
          <select id="pack-category" v-model="packCategory" class="select">
            <option value="all">Все звуки</option>
            <option v-for="item in categories" :key="item.name" :value="item.name">
              {{ item.name }} ({{ item.count }})
            </option>
          </select>
        </div>
        <div class="field">
          <label for="pack-title">Название</label>
          <input id="pack-title" v-model="packTitle" class="input" maxlength="120" />
        </div>
        <div class="alert alert--info">
          <Archive :size="15" />
          <div>Будет сохранено файлов: <strong>{{ packCount }}</strong>. Лимит — 250 файлов на пак.</div>
        </div>
        <label class="check">
          <input v-model="packConfirm" type="checkbox" />
          <span>Подтверждаю создание пака. Файлы читаются с устройства и сохраняются на компьютер.</span>
        </label>
        <div v-if="packError" class="alert alert--error">
          <AlertTriangle :size="15" />
          <div>{{ packError }}</div>
        </div>
      </div>
      <template #footer>
        <button type="button" class="btn" :disabled="packing" @click="packDialog = false">Отмена</button>
        <button type="button" class="btn btn--primary" :disabled="packing || !packConfirm || !packCount" @click="createPack">
          <LoaderCircle v-if="packing" :size="15" class="spin" />
          <Package v-else :size="15" />
          {{ packing ? 'Сохраняем…' : 'Создать пак' }}
        </button>
      </template>
    </Modal>

  </div>
</template>

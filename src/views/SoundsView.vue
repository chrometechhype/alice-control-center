<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Archive,
  AudioLines,
  Download,
  HardDrive,
  Info,
  LoaderCircle,
  Mic,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Volume2,
} from '@lucide/vue';
import type { BackupManifest, SoundFile, SoundListing } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import OfflineState from '@/components/OfflineState.vue';
import Modal from '@/components/Modal.vue';
import VolumeControl from '@/components/VolumeControl.vue';
import { ApiError, api, apiUrl, errorMessage, triggerDownload } from '@/lib/api';
import { everConnected, isConnected, pushToast, refreshBackups } from '@/lib/store';
import { formatBytes, formatRelative, soundCategoryLabel } from '@/lib/format';

const listing = ref<SoundListing | null>(null);
const loading = ref(false);
const error = ref('');
const category = ref('all');
const originFilter = ref<'all' | 'system' | 'user'>('all');
const query = ref('');
const playing = ref<string | null>(null);
const audioRef = ref<HTMLAudioElement | null>(null);

const players = ref<string[] | null>(null);
const stationBusy = ref<string | null>(null);
const speechText = ref('');
const speechMood = ref<SpeechMood>('neutral');
/** Loudness of this one phrase; the slider on the card stays where it was. */
const speechVolumeOn = ref(false);
const speechVolume = ref(25);
const speaking = ref(false);
const speechError = ref('');

const canPlayOnStation = computed(() => (players.value?.length ?? 0) > 0);
const speechLimit = 2000;

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

const publishFile = ref<File | null>(null);
const publishName = ref('');
const publishOpen = ref(false);
const publishing = ref(false);
const publishError = ref('');
const publishConflict = ref(false);

const deleteTarget = ref<SoundFile | null>(null);
const deleting = ref(false);

/** The station only ships `aplay`, so a long clip may still be playing when the call returns. */
interface StationPlayResult {
  player: string;
  seconds: number;
  converted: boolean;
  finished: boolean;
}

/** Alice speaks through the station's own TTS capability — no player and no file are involved. */
interface AliceSpeechResult {
  engine: 'alice';
  voice: string;
  started: boolean;
  completed: boolean;
  durationMs: number;
  transport: string;
  phrases: number;
}

const SPEECH_MOODS = [
  { id: 'neutral', label: 'Как написано' },
  { id: 'calm', label: 'Спокойно' },
  { id: 'brisk', label: 'Бодро' },
  { id: 'alert', label: 'Тревожно' },
  { id: 'care', label: 'Заботливо' },
] as const;

type SpeechMood = (typeof SPEECH_MOODS)[number]['id'];

const libraryFiles = computed(() => (listing.value?.files ?? []).filter((file) => file.origin === 'user'));
const userFreeBytes = computed(() => listing.value?.userFreeBytes ?? null);

// A 1 МБ cushion is what the station needs for the decoded copy it makes in /tmp while playing.
const publishFits = computed(() => {
  const file = publishFile.value;
  const free = userFreeBytes.value;
  if (!file || free == null) return true;
  return file.size + 1024 * 1024 <= free;
});

const categories = computed(() => {
  const map = new Map<string, { count: number; size: number }>();
  for (const file of listing.value?.files ?? []) {
    const entry = map.get(file.category) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += file.size;
    map.set(file.category, entry);
  }
  const rows = [...map.entries()]
    .map(([name, value]) => ({ name, label: soundCategoryLabel(name), ...value }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'));
  return rows;
});

const totalSize = computed(() => (listing.value?.files ?? []).reduce((sum, file) => sum + file.size, 0));

const originOptions = computed(() => {
  const files = listing.value?.files ?? [];
  return [
    { value: 'all' as const, label: 'Все', count: files.length },
    { value: 'system' as const, label: 'Системные', count: files.filter((file) => file.origin === 'system').length },
    { value: 'user' as const, label: 'Мои', count: files.filter((file) => file.origin === 'user').length },
  ];
});

// Packs only ever copy the station's own sounds — the panel library is disposable by design.
const packCategories = computed(() => {
  const system = new Set(
    (listing.value?.files ?? []).filter((file) => file.origin === 'system').map((file) => file.category),
  );
  return categories.value.filter((item) => system.has(item.name));
});

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return (listing.value?.files ?? []).filter((file) => {
    if (originFilter.value !== 'all' && file.origin !== originFilter.value) return false;
    if (category.value !== 'all' && file.category !== category.value) return false;
    if (needle && !`${file.name} ${file.rel}`.toLowerCase().includes(needle)) return false;
    return true;
  });
});

const packCount = computed(() => {
  const files = (listing.value?.files ?? []).filter((file) => file.origin === 'system');
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
    const result = await api.post<StationPlayResult>('/audio/play', { path: file.path }, 200_000);
    const detail = [
      `через ${result.player}`,
      result.converted ? 'перекодировано в WAV 48 кГц' : null,
      result.finished ? `${result.seconds.toFixed(1)} с` : 'всё ещё играет',
    ].filter(Boolean).join(' · ');
    pushToast('ok', `${file.name}: ${detail}`);
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    stationBusy.value = null;
  }
}

function openPublish(): void {
  publishFile.value = null;
  publishName.value = '';
  publishError.value = '';
  publishConflict.value = false;
  publishOpen.value = true;
}

function onPublishPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  publishFile.value = input.files?.[0] ?? null;
  publishError.value = '';
  publishConflict.value = false;
  input.value = '';
}

async function publishSound(confirm = false): Promise<void> {
  const file = publishFile.value;
  if (!file) {
    publishError.value = 'Сначала выберите аудиофайл';
    return;
  }
  publishing.value = true;
  publishError.value = '';
  try {
    const form = new FormData();
    form.append('file', file);
    if (publishName.value.trim()) form.append('name', publishName.value.trim());
    if (confirm) form.append('confirm', 'true');
    const saved = await api.form<SoundFile>('/sounds/publish', form);
    publishFile.value = null;
    publishName.value = '';
    publishConflict.value = false;
    publishOpen.value = false;
    pushToast('ok', `Опубликовано в библиотеке: ${saved.name}`);
    await load();
  } catch (caught) {
    publishConflict.value = caught instanceof ApiError && caught.code === 'ALREADY_PUBLISHED';
    publishError.value = errorMessage(caught);
  } finally {
    publishing.value = false;
  }
}

async function removeUserSound(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  try {
    await api.post('/sounds/delete', { path: target.path, confirm: true }, 30_000);
    deleteTarget.value = null;
    pushToast('ok', `Удалено из библиотеки: ${target.name}`);
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    deleting.value = false;
  }
}

async function sayOnStation(): Promise<void> {
  const text = speechText.value.trim();
  if (!text || speaking.value) return;
  speaking.value = true;
  speechError.value = '';
  try {
    const result = await api.post<AliceSpeechResult>('/audio/say', {
      text,
      mood: speechMood.value,
      ...(speechVolumeOn.value ? { volume: speechVolume.value } : {}),
    }, 200_000);
    speechText.value = '';
    pushToast(
      'ok',
      result.completed
        ? `Алиса сказала${result.phrases > 1 ? ` (${result.phrases} фразы)` : ''}. На станции ничего не сохранено.`
        : 'Алиса заговорила, но подтверждение конца фразы не пришло — проверьте, что колонка договорила.',
    );
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
  const isSystemCategory = packCategories.value.some((item) => item.name === category.value);
  packCategory.value = isSystemCategory ? category.value : 'all';
  packTitle.value = packCategory.value === 'all' ? 'Все системные звуки' : `Звуки: ${packCategory.value}`;
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
        <p>
          Звуки станции в <span class="code-inline">/system/vendor/quasar/sounds</span> и своя библиотека
          в <span class="code-inline">/data/sounds</span>. Кнопка
          <span class="code-inline"><Volume2 :size="12" style="vertical-align: -1px" /></span>
          играет выбранное на колонке: панель сама перекодирует файл в WAV 48 кГц, потому что на станции
          есть только <span class="code-inline">aplay</span>.
        </p>
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

    <OfflineState v-if="!everConnected" feature="Sound Studio читает реальный каталог звуков на колонке." />

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="grid grid-4">
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Файлов</span><AudioLines :size="15" class="muted" /></div>
          <div class="stat-value">{{ listing?.files.length ?? '—' }}</div>
          <div class="stat-foot"><span>Своих: {{ libraryFiles.length }}</span><span class="mono">sounds</span></div>
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
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Свободно на /data</span><HardDrive :size="15" class="muted" /></div>
          <div class="stat-value" style="font-size: 24px">{{ formatBytes(userFreeBytes) }}</div>
          <div class="stat-foot"><span>Сюда пишется библиотека</span><span class="mono">df</span></div>
        </div>
      </div>

      <div class="split">
        <article class="card card--flush">
          <div class="file-toolbar">
            <div class="search" style="flex: 1; min-width: 200px">
              <Search :size="14" />
              <input v-model="query" class="input" placeholder="Поиск по имени или пути…" />
            </div>
            <div class="segmented" role="group" aria-label="Источник звука">
              <button
                v-for="option in originOptions"
                :key="option.value"
                type="button"
                class="seg"
                :class="{ active: originFilter === option.value }"
                @click="originFilter = option.value"
              >
                {{ option.label }}
                <span class="mono">{{ option.count }}</span>
              </button>
            </div>
            <span class="pill pill--muted">{{ filtered.length }} из {{ listing?.files.length ?? 0 }}</span>
            <button class="btn btn--primary btn--sm" :disabled="!listing" @click="openPublish">
              <Plus :size="14" />
              Опубликовать
            </button>
          </div>

          <div v-if="loading && !listing" class="empty" style="padding: 34px">
            <LoaderCircle :size="20" class="spin" />
            <p>Сканируем каталоги звуков…</p>
          </div>
          <div v-else-if="filtered.length" class="list scroll-pane">
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
                    <span
                      class="pill"
                      :class="file.origin === 'user' ? 'pill--primary' : 'pill--muted'"
                    >{{ file.origin === 'user' ? 'библиотека' : soundCategoryLabel(file.category) }}</span>
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
                  v-if="file.origin === 'system'"
                  type="button"
                  class="btn btn--ghost btn--icon btn--sm"
                  title="Заменить системный звук с бэкапом"
                  @click="openReplace(file)"
                >
                  <Upload :size="14" />
                </button>
                <button
                  v-else
                  type="button"
                  class="btn btn--ghost btn--icon btn--sm"
                  title="Удалить из библиотеки"
                  @click="deleteTarget = file"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </div>
          <EmptyState v-else compact title="Звуки не найдены" text="Измените фильтр или пересканируйте каталог.">
            <template #icon><AudioLines :size="22" /></template>
          </EmptyState>
        </article>

        <aside class="stack">
          <article class="card">
            <div class="card-head">
              <div class="card-title"><Volume2 :size="15" /> Громкость станции</div>
            </div>
            <VolumeControl />
          </article>

          <article class="card">
            <div class="card-head">
              <div class="card-title"><Package :size="15" /> Категории</div>
              <span class="pill pill--muted">{{ categories.length }}</span>
            </div>
            <div class="category-list scroll-pane scroll-pane--tight">
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
                <span class="truncate">{{ item.label }}</span>
                <span class="mono">{{ item.count }}</span>
              </button>
            </div>
          </article>

          <article class="card card--soft">
            <div class="card-head">
              <div class="card-title"><Mic :size="15" /> Озвучка голосом Алисы</div>
              <span class="pill" :class="isConnected ? 'pill--ok' : 'pill--muted'">
                {{ isConnected ? 'голос станции' : 'нужно подключение' }}
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
                :disabled="speaking || !isConnected"
                placeholder="Например: загрузка завершена"
              />
              <span class="field-hint">
                {{ speechText.trim().length }}/{{ speechLimit }} · длинная фраза разбивается на
                предложения, и каждое получает свою интонацию: иначе «?» и «!» в середине теряются.
                Знаки «|» и «||» ставят паузу. Технические слова (Wi-Fi, SSH, /data/sounds)
                заменяются тем, как их читают вслух.
              </span>
            </div>
            <div class="field">
              <span class="field-label">Интонация</span>
              <div class="segmented" role="group" aria-label="Интонация озвучки">
                <button
                  v-for="mood in SPEECH_MOODS"
                  :key="mood.id"
                  type="button"
                  class="seg"
                  :class="{ active: speechMood === mood.id }"
                  :disabled="speaking || !isConnected"
                  @click="speechMood = mood.id"
                >
                  {{ mood.label }}
                </button>
              </div>
            </div>
            <div class="field mt-12">
              <label class="check-row" for="speech-volume">
                <input id="speech-volume" v-model="speechVolumeOn" type="checkbox" :disabled="speaking || !isConnected" />
                <span>Сказать тише обычного</span>
              </label>
              <div v-if="speechVolumeOn" class="field-hint">
                Громкость вернётся на место, как только фраза закончится — ползунок на карточке не
                сдвинется.
              </div>
              <input
                v-if="speechVolumeOn"
                v-model.number="speechVolume"
                class="range mt-8"
                type="range"
                min="5"
                max="100"
                step="5"
                aria-label="Громкость этой фразы"
              />
              <div v-if="speechVolumeOn" class="field-hint mono">{{ speechVolume }}%</div>
            </div>
            <div v-if="speechError" class="alert alert--error">
              <AlertTriangle :size="15" />
              <div>{{ speechError }}</div>
            </div>
            <div v-else-if="!isConnected" class="alert alert--warn">
              <AlertTriangle :size="15" />
              <div>Чтобы Алиса говорила, панель должна быть подключена к станции по SSH.</div>
            </div>
            <button
              type="button"
              class="btn btn--primary mt-12 w-full"
              :disabled="speaking || !speechText.trim() || !isConnected"
              @click="sayOnStation"
            >
              <LoaderCircle v-if="speaking" :size="15" class="spin" />
              <Mic v-else :size="15" />
              {{ speaking ? 'Алиса говорит…' : 'Сказать голосом Алисы' }}
            </button>
          </article>

          <article v-if="listing?.errors.length" class="card card--soft">
            <div class="card-title"><Info :size="15" /> Замечания при сканировании</div>
            <div class="stack mt-12" style="gap: 6px">
              <div v-for="item in listing.errors" :key="item" class="alert alert--warn" style="font-size: 11px">
                <AlertTriangle :size="14" />
                <div>{{ item }}</div>
              </div>
            </div>
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

    <Modal
      :open="publishOpen"
      title="Опубликовать звук"
      subtitle="Своя библиотека в /data/sounds"
      @close="publishOpen = false"
    >
      <div class="stack" style="gap: 14px">
        <p class="field-hint">
          Файл ложится в <span class="code-inline">/data/sounds</span> и остаётся там, пока вы его не
          удалите. Системные звуки станции удалить нельзя — их можно только заменить.
        </p>
        <div class="field">
          <label for="publish-file">Аудиофайл</label>
          <input
            id="publish-file"
            type="file"
            class="input"
            accept="audio/*,.mp3,.wav,.ogg,.opus,.flac,.m4a,.aac"
            @change="onPublishPicked"
          />
          <span v-if="publishFile" class="field-hint">
            {{ publishFile.name }} · {{ formatBytes(publishFile.size) }}
          </span>
        </div>
        <div class="field">
          <label for="publish-name">Имя на станции (необязательно)</label>
          <input
            id="publish-name"
            v-model="publishName"
            class="input"
            maxlength="90"
            :placeholder="publishFile ? publishFile.name : 'Как в файле'"
            :disabled="publishing"
          />
          <span class="field-hint">
            Свободно на /data: {{ formatBytes(userFreeBytes) }}
            <template v-if="publishFile && !publishFits">· файл не поместится, освободите место</template>
          </span>
        </div>
        <div v-if="publishError" class="alert" :class="publishConflict ? 'alert--warn' : 'alert--error'">
          <AlertTriangle :size="15" />
          <div>{{ publishError }}</div>
        </div>
        <div v-if="publishConflict" class="alert alert--info">
          <Info :size="15" />
          <div>Файл с таким именем уже есть на станции. Подтвердите замену отдельной кнопкой.</div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="publishing" @click="publishOpen = false">Отмена</button>
        <button
          v-if="publishConflict"
          class="btn"
          :disabled="publishing"
          @click="publishSound(true)"
        >
          <Upload :size="15" />
          Заменить существующий
        </button>
        <button
          v-else
          class="btn btn--primary"
          :disabled="publishing || !publishFile || !publishFits"
          @click="publishSound(false)"
        >
          <LoaderCircle v-if="publishing" :size="15" class="spin" />
          <Plus v-else :size="15" />
          {{ publishing ? 'Записываем на станцию…' : 'Загрузить на станцию' }}
        </button>
      </template>
    </Modal>

    <Modal :open="packDialog" title="Создать пак звуков" subtitle="Резервная копия на компьютере" @close="packDialog = false">
      <div class="stack" style="gap: 14px">
        <div class="field">
          <label for="pack-category">Категория</label>
          <select id="pack-category" v-model="packCategory" class="select">
            <option value="all">Все звуки</option>
            <option v-for="item in packCategories" :key="item.name" :value="item.name">
              {{ item.label }} ({{ item.count }})
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

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="Удалить из библиотеки"
      :message="`Файл «${deleteTarget?.name ?? ''}» будет удалён со станции безвозвратно. Системные звуки станции эта операция не затрагивает.`"
      confirm-label="Удалить"
      :danger="true"
      :busy="deleting"
      @cancel="deleteTarget = null"
      @confirm="removeUserSound"
    />
  </div>
</template>

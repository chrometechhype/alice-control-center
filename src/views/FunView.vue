<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import {
  AlertTriangle,
  Check,
  Info,
  Lightbulb,
  LoaderCircle,
  Palette,
  Play,
  Power,
  RotateCcw,
  Sparkles,
  Trash2,
  Wand2,
  Zap,
} from '@lucide/vue';
import type { LedPreset, PublicAiSettings } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import { api, errorMessage } from '@/lib/api';
import { hslToRgb, rgbCss } from '@/lib/format';
import { isConnected, pushToast, store } from '@/lib/store';

interface AnimationResult {
  started: boolean;
  frames: number;
  fps: number;
  repeat: number;
  loop: boolean;
  durationMs: number;
}

interface Scene {
  key: 'rainbow' | 'sunset' | 'pulse' | 'random';
  title: string;
  description: string;
  gradient: string;
  fps: number;
}

const scenes: Scene[] = [
  {
    key: 'rainbow',
    title: 'Радуга',
    description: 'Полный круг оттенков по всем зонам кольца.',
    gradient: 'linear-gradient(90deg, #ff5f6d, #ffc371, #47e5bc, #5b8cff, #c471ed, #ff5f6d)',
    fps: 24,
  },
  {
    key: 'sunset',
    title: 'Закат',
    description: 'Плавный переход от оранжевого к фиолетовому и обратно.',
    gradient: 'linear-gradient(90deg, #ff6a1a, #ff8a3d, #c471ed, #7a55ff)',
    fps: 20,
  },
  {
    key: 'pulse',
    title: 'Пульс',
    description: 'Мягкое мигание выбранным оранжевым цветом.',
    gradient: 'linear-gradient(90deg, #ff6a1a, #2a0f04, #ff6a1a)',
    fps: 2,
  },
  {
    key: 'random',
    title: 'Случайный цвет',
    description: 'Один случайный оттенок на всё кольцо.',
    gradient: 'linear-gradient(90deg, #17a45b, #3f7de0, #e0a11b, #dd4a4a)',
    fps: 1,
  },
];

const busyScene = ref('');
const error = ref('');
const restoreOpen = ref(false);
const busy = ref(false);
const LOOP_KEY = 'acc-fun-loop';
function readLoop(): boolean {
  try {
    return globalThis.localStorage?.getItem(LOOP_KEY) === '1';
  } catch {
    return false;
  }
}
const loop = ref(readLoop());
function toggleLoop(): void {
  loop.value = !loop.value;
  try {
    globalThis.localStorage?.setItem(LOOP_KEY, loop.value ? '1' : '0');
  } catch {
    // приватный режим — настройка останется до перезагрузки
  }
}
const aiPrompt = ref('');
const aiBusy = ref(false);
const aiSettings = ref<PublicAiSettings | null>(null);
const aiReady = computed(() => Boolean(aiSettings.value?.configured));
const aiProviderLabel = computed(() => {
  const current = aiSettings.value;
  if (!current) return 'проверяем настройки…';
  if (!current.configured) return 'не настроен';
  return current.presets.find((item) => item.id === current.provider)?.label ?? current.provider;
});
const presets = ref<LedPreset[]>([]);
const presetsLoading = ref(false);

const ledCap = computed(() => store.capabilities?.led);
const ledAvailable = computed(() => Boolean(ledCap.value?.available));
const zoneCount = computed(() => {
  const raw = ledCap.value?.details?.zones;
  return Array.isArray(raw) ? raw.length : 0;
});
const ledKind = computed(() => String(ledCap.value?.details?.kind ?? 'sysfs'));

function framesFor(key: Scene['key']): number[][][] {
  const count = zoneCount.value;
  if (key === 'rainbow') {
    const frames: number[][][] = [];
    for (let step = 0; step < 12; step += 1) {
      const color = hslToRgb(step * 30, 0.85, 0.55);
      frames.push(Array.from({ length: count }, () => [...color] as [number, number, number]));
    }
    return frames;
  }
  if (key === 'sunset') {
    const from: [number, number, number] = [255, 106, 26];
    const to: [number, number, number] = [122, 85, 255];
    const frames: number[][][] = [];
    for (let step = 0; step < 5; step += 1) {
      const t = step / 4;
      const color: [number, number, number] = [
        Math.round(from[0] + (to[0] - from[0]) * t),
        Math.round(from[1] + (to[1] - from[1]) * t),
        Math.round(from[2] + (to[2] - from[2]) * t),
      ];
      frames.push(Array.from({ length: count }, () => [...color] as [number, number, number]));
    }
    for (let step = 3; step >= 0; step -= 1) {
      frames.push(frames[step].map((color) => [...color] as [number, number, number]));
    }
    return frames;
  }
  if (key === 'pulse') {
    const on: [number, number, number] = [255, 106, 26];
    const off: [number, number, number] = [0, 0, 0];
    return [
      Array.from({ length: count }, () => [...on] as [number, number, number]),
      Array.from({ length: count }, () => [...off] as [number, number, number]),
    ];
  }
  return [];
}

function sceneBadge(scene: Scene): string {
  if (scene.key === 'random') return '1 кадр · сразу';
  return `${framesFor(scene.key).length} кадров · ${scene.fps} fps${loop.value ? ' · ∞' : ''}`;
}

async function startAnimation(
  frames: number[][][],
  speed: number,
  repeat = 2,
  infinite = loop.value,
): Promise<AnimationResult> {
  return api.post<AnimationResult>('/led/animation', { frames, fps: speed, repeat, loop: infinite });
}

interface AiSceneResult {
  name: string;
  fps: number;
  frames: number[][][];
  provider: string;
  model: string;
  elapsedMs: number;
}

async function loadAiSettings(): Promise<void> {
  try {
    aiSettings.value = await api.get<PublicAiSettings>('/settings/ai');
  } catch {
    aiSettings.value = null;
  }
}

async function generateScene(): Promise<void> {
  const prompt = aiPrompt.value.trim();
  if (!prompt || aiBusy.value || !zoneCount.value) return;
  aiBusy.value = true;
  error.value = '';
  try {
    const result = await api.post<AiSceneResult>('/ai/scene', { prompt }, 120_000);
    const name = result.name.trim() || (prompt.length > 48 ? `${prompt.slice(0, 45)}…` : prompt);
    const preset = await api.post<LedPreset>('/led/presets', {
      name,
      frames: result.frames,
      fps: result.fps,
    });
    presets.value.unshift(preset);
    await startAnimation(result.frames, result.fps, 2);
    pushToast(
      'ok',
      `«${name}» готова · ${result.frames.length} кадров, ${result.fps} fps · ${result.provider}, ${Math.round(result.elapsedMs / 1000)} с${loop.value ? ', без таймаута' : ''}`,
    );
    aiPrompt.value = '';
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    aiBusy.value = false;
  }
}

async function runPreset(preset: LedPreset): Promise<void> {
  if (busyScene.value) return;
  busyScene.value = preset.id;
  try {
    const result = await startAnimation(preset.frames, preset.fps, 2);
    pushToast(
      'ok',
      result.loop
        ? `«${preset.name}» запущена без таймаута`
        : `«${preset.name}» запущена на ${result.durationMs} мс`,
    );
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    busyScene.value = '';
  }
}

async function removePreset(preset: LedPreset): Promise<void> {
  try {
    await api.delete(`/led/presets/${preset.id}`);
    presets.value = presets.value.filter((item) => item.id !== preset.id);
    pushToast('info', `Пресет «${preset.name}» удалён`);
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  }
}

async function loadPresets(): Promise<void> {
  presetsLoading.value = true;
  try {
    const result = await api.get<{ presets: LedPreset[] }>('/led/presets');
    presets.value = result.presets ?? [];
  } catch {
    presets.value = [];
  } finally {
    presetsLoading.value = false;
  }
}

onMounted(() => {
  void loadAiSettings();
  if (ledAvailable.value) void loadPresets();
});

async function runScene(scene: Scene): Promise<void> {
  if (busyScene.value || !zoneCount.value) return;
  busyScene.value = scene.key;
  error.value = '';
  try {
    if (scene.key === 'random') {
      const color = hslToRgb(Math.floor(Math.random() * 360), 0.9, 0.55);
      await api.post('/led/apply', {
        zones: Array.from({ length: zoneCount.value }, () => [...color]),
      });
      pushToast('ok', `Случайный цвет: ${rgbCss(color)}`);
    } else {
      const frames = framesFor(scene.key);
      const repeat = scene.key === 'rainbow' ? 2 : scene.key === 'sunset' ? 2 : 4;
      const result = await startAnimation(frames, scene.fps, repeat);
      pushToast(
        'ok',
        result.loop
          ? `Сцена «${scene.title}» работает без таймаута`
          : `Сцена «${scene.title}» запущена на ${result.durationMs} мс`,
      );
    }
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busyScene.value = '';
  }
}

async function turnOff(): Promise<void> {
  busy.value = true;
  try {
    await api.post('/led/off');
    pushToast('info', 'LED-кольцо выключено');
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    busy.value = false;
  }
}

async function restoreNative(): Promise<void> {
  busy.value = true;
  try {
    await api.post('/led/restore');
    restoreOpen.value = false;
    pushToast('ok', 'Штатная индикация Алисы восстановлена');
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>Fun Lab</h1>
        <p>
          Только реальные световые эффекты на LED-кольце колонки. Никаких поддельных «звуковых
          анализаторов» и фоновых демонов.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="busy || !ledAvailable" @click="turnOff">
          <Power :size="15" />
          Выключить
        </button>
        <button class="btn btn--soft" :disabled="busy || !ledAvailable" @click="restoreOpen = true">
          <RotateCcw :size="15" />
          Штатный режим
        </button>
      </div>
    </div>

    <div v-if="!isConnected" class="card">
      <EmptyState title="Устройство не подключено" text="Fun Lab использует реальное LED-кольцо колонки.">
        <template #icon><Wand2 :size="22" /></template>
      </EmptyState>
    </div>

    <div v-else-if="!ledAvailable" class="card">
      <EmptyState
        title="Световые сцены недоступны"
        :text="ledCap?.reason || 'У этой прошивки нет доступных LED-зон. ACC не имитирует эффекты.'"
      >
        <template #icon><Lightbulb :size="22" /></template>
      </EmptyState>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <article class="card card--soft">
        <div class="row-wrap" style="justify-content: space-between">
          <div class="row" style="gap: 12px">
            <div class="empty-icon" style="width: 44px; height: 44px; border-radius: 13px; background: var(--primary-soft); color: var(--primary)">
              <Sparkles :size="20" />
            </div>
            <div>
              <div style="font-size: 14px; font-weight: 680">Сценарий на {{ zoneCount }} {{ zoneCount === 1 ? 'зоне' : 'зонах' }}</div>
              <div class="muted" style="font-size: 11.5px">Тип управления: <span class="mono">{{ ledKind }}</span> · кадры отправляются на устройство</div>
            </div>
          </div>
          <span class="pill pill--ok">кольцо доступно</span>
        </div>
      </article>

      <article class="card">
        <div class="row-wrap" style="justify-content: space-between; gap: 16px; align-items: center">
          <div class="row" style="gap: 12px; min-width: 0">
            <div class="empty-icon" style="width: 42px; height: 42px; border-radius: 13px; background: var(--primary-soft); color: var(--primary)">
              <RotateCcw :size="19" />
            </div>
            <div style="min-width: 0">
              <div style="font-size: 13.5px; font-weight: 680">Работать без таймаута</div>
              <div class="muted" style="font-size: 11.5px">
                Сцена повторяется, пока не нажмёте «Выключить» или «Штатный режим». Действует и на
                свои сохранённые сцены.
              </div>
            </div>
          </div>
          <button
            type="button"
            class="switch"
            :class="{ on: loop }"
            role="switch"
            :aria-checked="loop"
            aria-label="Работать без таймаута"
            @click="toggleLoop"
          />
        </div>
      </article>

      <article v-if="presetsLoading || presets.length" class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Sparkles :size="15" /> Мои сцены</div>
            <div class="card-sub">Сохранённые вами сцены — сверху, первыми</div>
          </div>
          <span v-if="presets.length" class="pill pill--primary">{{ presets.length }}</span>
        </div>
        <div v-if="presetsLoading" class="muted mt-12" style="font-size: 12px">Загружаем сохранённые сцены…</div>
        <div v-else class="preset-list mt-12">
          <div v-for="preset in presets" :key="preset.id" class="preset-row">
            <div class="preset-info">
              <strong>{{ preset.name }}</strong>
              <span>{{ preset.frames.length }} кадров · {{ preset.fps }} fps</span>
            </div>
            <button class="btn btn--soft btn--sm" :disabled="Boolean(busyScene)" @click="runPreset(preset)">
              <Play :size="14" />
              Запустить
            </button>
            <button class="btn btn--ghost btn--icon btn--sm" title="Удалить сцену" @click="removePreset(preset)">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </article>

      <div class="scene-grid">
        <button
          v-for="scene in scenes"
          :key="scene.key"
          type="button"
          class="scene-card"
          :disabled="Boolean(busyScene)"
          @click="runScene(scene)"
        >
          <span class="scene-preview" :style="{ background: scene.gradient }">
            <LoaderCircle v-if="busyScene === scene.key" :size="22" class="spin" />
            <Sparkles v-else :size="20" />
          </span>
          <span class="scene-body">
            <span style="min-width: 0">
              <span class="scene-title">{{ scene.title }}</span>
              <span class="scene-desc">{{ scene.description }}</span>
            </span>
            <span class="scene-badge">{{ sceneBadge(scene) }}</span>
          </span>
        </button>
      </div>

      <article class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Wand2 :size="15" /> ИИ-генератор</div>
            <div class="card-sub">OpenAI-совместимый ИИ сам подберёт FPS и нарисует сцену</div>
          </div>
          <span class="pill" :class="aiReady ? 'pill--ok' : 'pill--warn'">{{ aiProviderLabel }}</span>
        </div>

        <div v-if="!aiReady" class="alert alert--info mt-12">
          <Info :size="15" />
          <div>
            Выберите провайдера и модель в
            <RouterLink to="/settings">«Настройках» → «ИИ-генератор»</RouterLink>. Подойдёт любой
            OpenAI-совместимый сервер: OpenAI, OpenRouter, Groq, Ollama, LM Studio или свой.
          </div>
        </div>

        <div class="form-grid mt-12">
          <label class="field">
            <span class="field-label">Какую сцену нарисовать?</span>
            <textarea
              v-model="aiPrompt"
              class="textarea"
              rows="3"
              maxlength="240"
              placeholder="Например: плавное северное сияние зелёным и фиолетовым, тёплое огненное мерцание или мягкий ритмичный пульс"
            />
          </label>
          <div class="row-wrap" style="align-items: center; gap: 12px">
            <button class="btn btn--primary" :disabled="aiBusy || !aiPrompt.trim() || !zoneCount || !aiReady" @click="generateScene">
              <LoaderCircle v-if="aiBusy" :size="15" class="spin" />
              <Sparkles v-else :size="15" />
              {{ aiBusy ? 'ИИ рисует сцену…' : 'Сгенерировать' }}
            </button>
            <span class="muted" style="font-size: 11.5px">
              {{ aiReady ? 'FPS и кадры выберет ИИ' : 'Сначала настройте ИИ' }}
            </span>
          </div>
          <p class="field-hint">
            Модель получает описание и возвращает готовые RGB-кадры с подобранной скоростью. Сцена
            сразу сохраняется в «Мои сцены». Запрос уходит только на выбранный вами сервер.
          </p>
        </div>
      </article>

      <div class="split">
        <article class="card">
          <div class="card-title"><Palette :size="15" /> Как это работает</div>
          <div class="form-grid mt-12">
            <div class="info-line"><Zap :size="14" /><span>Анимация целиком выполняется на колонке, без канала SSH на каждый кадр.</span></div>
            <div class="info-line"><Lightbulb :size="14" /><span>Цвета применяются ко всем доступным зонам кольца.</span></div>
            <div class="info-line"><RotateCcw :size="14" /><span>«Штатный режим» возвращает триггер led_ring_fb.</span></div>
            <div class="info-line"><Check :size="14" /><span>Сцены не перезапускают станцию и не меняют прошивку.</span></div>
          </div>
        </article>

        <article class="card card--soft">
          <div class="card-title"><Info :size="15" /> Ограничения</div>
          <ul class="check-list mt-12">
            <li><Info :size="14" /><span>Нет синхронизации с музыкой: ACC не выдаёт желаемое за реальное.</span></li>
            <li><Info :size="14" /><span>Выше 30 fps кольцо может обновляться неравномерно — это ограничение прошивки, а не SSH.</span></li>
            <li><Info :size="14" /><span>«Выключить» и «Штатный режим» останавливают эффект на устройстве.</span></li>
          </ul>
          <div class="alert alert--info mt-12">
            <Info :size="15" />
            <div>Для точных цветов и статичных пресетов используйте LED Studio.</div>
          </div>
        </article>
      </div>
    </template>

    <ConfirmDialog
      :open="restoreOpen"
      title="Вернуть штатную индикацию?"
      message="Все световые эффекты Fun Lab будут остановлены, а LED-кольцо вернётся к индикации Алисы."
      confirm-label="Вернуть штатный режим"
      :danger="false"
      :busy="busy"
      @confirm="restoreNative"
      @cancel="restoreOpen = false"
    />
  </div>
</template>

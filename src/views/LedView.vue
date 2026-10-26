<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  AlertTriangle,
  Check,
  Info,
  Lightbulb,
  LoaderCircle,
  Palette,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
} from '@lucide/vue';
import type { LedPreset } from '@shared/types';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import Modal from '@/components/Modal.vue';
import { api, errorMessage } from '@/lib/api';
import { hexToRgb, hslToRgb, rgbCss, rgbToHex } from '@/lib/format';
import { isConnected, pushToast, store } from '@/lib/store';

interface LedZoneView {
  index: number;
  prefix: string;
  ring: number;
  red: string;
  green: string;
  blue: string;
  redValue: number | null;
  greenValue: number | null;
  blueValue: number | null;
  trigger: string | null;
}

interface LedStatus {
  available: boolean;
  zones: LedZoneView[];
  animation: { running: boolean };
  presets: LedPreset[];
}

interface AnimationResult {
  started: boolean;
  frames: number;
  fps: number;
  repeat: number;
  durationMs: number;
}

const status = ref<LedStatus | null>(null);
const colors = ref<string[]>([]);
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const animationRunning = ref(false);
const restoreOpen = ref(false);
const saveOpen = ref(false);
const presetName = ref('');
const saving = ref(false);
const deleteTarget = ref<LedPreset | null>(null);
const deleting = ref(false);
let animationTimer: number | null = null;

const ledCap = computed(() => store.capabilities?.led);
const ledAvailable = computed(() => Boolean(ledCap.value?.available));
const ledKind = computed(() => String(ledCap.value?.details?.kind ?? 'sysfs'));
const zones = computed(() => status.value?.zones ?? []);
const presets = computed(() => status.value?.presets ?? []);
const zoneCount = computed(() => zones.value.length);

function stopLocalAnimationTimer(): void {
  if (animationTimer) {
    window.clearTimeout(animationTimer);
    animationTimer = null;
  }
}

function markAnimation(durationMs: number): void {
  stopLocalAnimationTimer();
  animationRunning.value = true;
  animationTimer = window.setTimeout(() => {
    animationRunning.value = false;
    animationTimer = null;
  }, Math.max(600, durationMs + 250));
}

function rgbAt(index: number): [number, number, number] {
  return hexToRgb(colors.value[index] ?? '#000000');
}

function zoneColor(index: number): string {
  return colors.value[index] ?? '#000000';
}

function zoneStyle(index: number): Record<string, string> {
  const color = zoneColor(index);
  return {
    borderColor: color,
    boxShadow: `inset 0 0 26px ${rgbCss(hexToRgb(color), 0.45)}`,
  };
}

function setColor(index: number, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  colors.value[index] = value;
}

function presetColors(preset: LedPreset): string[] {
  const frame = preset.frames[0] ?? [];
  return frame.map((color) => rgbToHex(color));
}

function presetCss(preset: LedPreset, index: number): string {
  return rgbCss(preset.frames[0]?.[index] ?? [0, 0, 0]);
}

async function load(showToast = false): Promise<void> {
  if (!isConnected.value || !ledAvailable.value) return;
  loading.value = true;
  error.value = '';
  try {
    const result = await api.get<LedStatus>('/led/status');
    status.value = result;
    colors.value = result.zones.map((zone) =>
      rgbToHex([zone.redValue ?? 0, zone.greenValue ?? 0, zone.blueValue ?? 0]),
    );
    animationRunning.value = result.animation.running;
    if (result.animation.running) markAnimation(2500);
    if (showToast) pushToast('ok', 'Состояние LED обновлено');
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    loading.value = false;
  }
}

async function applySelected(): Promise<void> {
  if (!zoneCount.value) return;
  busy.value = true;
  error.value = '';
  try {
    await api.post('/led/apply', { zones: colors.value.map((_, index) => rgbAt(index)) });
    stopLocalAnimationTimer();
    animationRunning.value = false;
    pushToast('ok', 'Цвета применены к LED-кольцу');
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busy.value = false;
  }
}

async function turnOff(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.post('/led/off');
    stopLocalAnimationTimer();
    animationRunning.value = false;
    pushToast('info', 'LED-кольцо выключено');
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busy.value = false;
  }
}

async function restoreNative(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.post('/led/restore');
    restoreOpen.value = false;
    stopLocalAnimationTimer();
    animationRunning.value = false;
    pushToast('ok', 'Управление возвращено штатному триггеру led_ring_fb');
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busy.value = false;
  }
}

async function runAnimation(frames: number[][][], fps: number, repeat: number): Promise<void> {
  if (!frames.length || !zoneCount.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api.post<AnimationResult>('/led/animation', { frames, fps, repeat });
    markAnimation(result.durationMs);
    pushToast('ok', `Анимация запущена: ${result.frames} кадров, ${result.fps} fps`);
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busy.value = false;
  }
}

function blink(): Promise<void> {
  const on = colors.value.map((_, index) => rgbAt(index));
  const off = on.map(() => [0, 0, 0] as [number, number, number]);
  return runAnimation([on, off], 4, 3);
}

function rainbow(): Promise<void> {
  const frames: number[][][] = [];
  for (let step = 0; step < 12; step += 1) {
    const color = hslToRgb(step * 30, 0.85, 0.55);
    frames.push(zones.value.map(() => [...color] as [number, number, number]));
  }
  return runAnimation(frames, 8, 2);
}

async function applyPreset(preset: LedPreset): Promise<void> {
  if (!preset.frames.length) return;
  if (preset.frames.length > 1) {
    await runAnimation(preset.frames, preset.fps, 1);
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api.post('/led/apply', { zones: preset.frames[0] });
    colors.value = (preset.frames[0] ?? []).map((color) => rgbToHex(color));
    stopLocalAnimationTimer();
    animationRunning.value = false;
    pushToast('ok', `Применён пресет «${preset.name}»`);
    await load();
  } catch (caught) {
    error.value = errorMessage(caught);
    pushToast('error', error.value);
  } finally {
    busy.value = false;
  }
}

function openSavePreset(): void {
  presetName.value = '';
  saveOpen.value = true;
}

async function savePreset(): Promise<void> {
  const name = presetName.value.trim();
  if (!name) return;
  saving.value = true;
  try {
    await api.post<LedPreset>('/led/presets', {
      name,
      frames: [colors.value.map((_, index) => rgbAt(index))],
      fps: 4,
    });
    saveOpen.value = false;
    pushToast('ok', `Пресет «${name}» сохранён`);
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    saving.value = false;
  }
}

async function deletePreset(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  try {
    await api.delete(`/led/presets/${encodeURIComponent(target.id)}`);
    deleteTarget.value = null;
    pushToast('info', `Пресет «${target.name}» удалён`);
    await load();
  } catch (caught) {
    pushToast('error', errorMessage(caught));
  } finally {
    deleting.value = false;
  }
}

onMounted(() => {
  if (isConnected.value) void load();
});

onBeforeUnmount(stopLocalAnimationTimer);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>LED Studio</h1>
        <p>
          Управление реальными LED-зонами через sysfs. Доступно только если прошивка предоставляет
          нужные каналы <span class="code-inline">/sys/class/leds</span>.
        </p>
      </div>
      <div class="page-head__actions">
        <button class="btn" :disabled="loading || !ledAvailable" @click="load(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" />
          Обновить
        </button>
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
      <EmptyState title="Устройство не подключено" text="LED Studio работает с реальным кольцом колонки.">
        <template #icon><Lightbulb :size="22" /></template>
      </EmptyState>
    </div>

    <div v-else-if="!ledAvailable" class="card">
      <EmptyState
        title="LED-управление недоступно"
        :text="ledCap?.reason || 'Прошивка не предоставляет доступных LED-зон. ACC не подменяет результат.'"
      >
        <template #icon><Lightbulb :size="22" /></template>
      </EmptyState>
    </div>

    <template v-else>
      <div v-if="error" class="alert alert--error">
        <AlertTriangle :size="16" />
        <div>{{ error }}</div>
      </div>

      <div class="grid grid-3">
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">LED-зон</span><Lightbulb :size="15" class="muted" /></div>
          <div class="stat-value">{{ status ? zoneCount : '—' }}</div>
          <div class="stat-foot"><span>Тип управления</span><span class="mono">{{ ledKind }}</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Анимация</span><Sparkles :size="15" class="muted" /></div>
          <div class="stat-value" style="font-size: 24px">{{ animationRunning ? 'Идёт' : 'Нет' }}</div>
          <div class="stat-foot"><span>Локальный цикл ACC</span><span class="mono">fps ≤ 20</span></div>
        </div>
        <div class="card stat">
          <div class="stat-top"><span class="stat-label">Пресетов</span><Palette :size="15" class="muted" /></div>
          <div class="stat-value">{{ presets.length }}</div>
          <div class="stat-foot"><span>Хранятся на компьютере</span><span class="mono">local</span></div>
        </div>
      </div>

      <article class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Lightbulb :size="15" /> Зоны кольца</div>
            <div class="card-sub">Выберите цвет для каждой зоны и примените его к устройству.</div>
          </div>
          <span v-if="zones[0]?.trigger" class="pill pill--muted mono">{{ zones[0].trigger }}</span>
        </div>

        <div v-if="loading && !status" class="empty" style="padding: 34px">
          <LoaderCircle :size="20" class="spin" />
          <p>Читаем состояние LED…</p>
        </div>

        <div v-else class="led-grid">
          <div v-for="zone in zones" :key="`${zone.red}-${zone.green}-${zone.blue}`" class="led-zone">
            <div class="led-ring" :style="zoneStyle(zone.index)" />
            <div class="text-center">
              <div style="font-size: 12.5px; font-weight: 650">Зона {{ zone.index + 1 }}</div>
              <div class="muted mono" style="font-size: 10.5px">{{ zone.prefix }} · ring {{ zone.ring }}</div>
            </div>
            <div class="led-controls">
              <div class="row">
                <span class="muted" style="font-size: 11.5px">Цвет</span>
                <input
                  type="color"
                  class="led-swatch"
                  :value="zoneColor(zone.index)"
                  :disabled="busy"
                  @input="setColor(zone.index, $event)"
                />
              </div>
              <div class="row">
                <span class="muted" style="font-size: 11.5px">Каналы</span>
                <span class="mono" style="font-size: 10.5px">
                  {{ rgbAt(zone.index).join(' · ') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="toolbar mt-16">
          <button class="btn btn--primary" :disabled="busy || !zoneCount" @click="applySelected">
            <LoaderCircle v-if="busy" :size="15" class="spin" />
            <Palette v-else :size="15" />
            Применить цвета
          </button>
          <button class="btn" :disabled="busy || !zoneCount" @click="blink">
            <Play :size="15" />
            Мигнуть
          </button>
          <button class="btn" :disabled="busy || !zoneCount" @click="rainbow">
            <Sparkles :size="15" />
            Радуга
          </button>
          <button class="btn btn--soft" :disabled="!zoneCount" @click="openSavePreset">
            <Save :size="15" />
            Сохранить пресет
          </button>
        </div>

        <div class="alert alert--info mt-12">
          <Info :size="15" />
          <div>
            ACC пишет цвета напрямую в sysfs. Штатная индикация Алисы возвращается кнопкой
            «Штатный режим» — она переключает триггер обратно на
            <span class="code-inline">led_ring_fb</span>.
          </div>
        </div>
      </article>

      <article class="card">
        <div class="card-head">
          <div>
            <div class="card-title"><Palette :size="15" /> Пресеты</div>
            <div class="card-sub">Пресеты хранятся в data/led-presets.json и не покидают компьютер.</div>
          </div>
          <button class="btn btn--soft btn--sm" :disabled="!zoneCount" @click="openSavePreset">
            <Plus :size="14" />
            Новый
          </button>
        </div>

        <EmptyState
          v-if="!presets.length"
          title="Пресетов пока нет"
          text="Настройте цвета зон и сохраните их как пресет — он появится здесь."
        >
          <template #icon><Palette :size="20" /></template>
        </EmptyState>

        <div v-else class="preset-grid">
          <div
            v-for="preset in presets"
            :key="preset.id"
            class="preset"
            role="button"
            tabindex="0"
            :title="`Применить «${preset.name}»`"
            @click="applyPreset(preset)"
            @keydown.enter="applyPreset(preset)"
          >
            <div class="preset-colors">
              <span
                v-for="(color, index) in presetColors(preset)"
                :key="index"
                :style="{ background: presetCss(preset, index) }"
              />
            </div>
            <div class="row" style="justify-content: space-between; gap: 6px">
              <div style="min-width: 0">
                <div class="truncate" style="font-size: 12px; font-weight: 620">{{ preset.name }}</div>
                <div class="muted" style="font-size: 10.5px">
                  {{ preset.frames.length }} кадр. · {{ preset.fps }} fps
                </div>
              </div>
              <button
                type="button"
                class="btn btn--ghost btn--icon btn--sm"
                title="Удалить пресет"
                @click.stop="deleteTarget = preset"
              >
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
        </div>

        <ul class="check-list mt-12">
          <li><Check :size="14" /><span>Одиночный пресет применяется сразу, многокадровый — как анимация.</span></li>
          <li><Check :size="14" /><span>Анимация ограничена 120 кадрами и 20 fps на стороне backend.</span></li>
        </ul>
      </article>
    </template>

    <ConfirmDialog
      :open="restoreOpen"
      title="Вернуть штатный режим?"
      message="ACC перестанет управлять цветом и вернёт LED-зоны штатному триггеру led_ring_fb. Текущие цвета будут сброшены."
      confirm-label="Вернуть штатный режим"
      :danger="false"
      :busy="busy"
      @confirm="restoreNative"
      @cancel="restoreOpen = false"
    />

    <ConfirmDialog
      :open="Boolean(deleteTarget)"
      title="Удалить пресет?"
      :message="deleteTarget ? `Пресет «${deleteTarget.name}» будет удалён с компьютера.` : ''"
      confirm-label="Удалить"
      :busy="deleting"
      @confirm="deletePreset"
      @cancel="deleteTarget = null"
    />

    <Modal :open="saveOpen" title="Сохранить пресет" subtitle="Текущие цвета всех зон" @close="saveOpen = false">
      <div class="stack" style="gap: 14px">
        <div class="field">
          <label for="preset-name">Название</label>
          <input
            id="preset-name"
            v-model="presetName"
            class="input"
            maxlength="60"
            placeholder="Например: Тёплый вечер"
            @keydown.enter="savePreset"
          />
        </div>
        <div class="preset-colors">
          <span
            v-for="(color, index) in colors"
            :key="index"
            :style="{ background: color, height: '30px', borderRadius: '8px' }"
          />
        </div>
        <div class="alert alert--info">
          <Info :size="15" />
          <div>Пресет сохранит текущие цвета как один кадр с частотой 4 fps.</div>
        </div>
      </div>
      <template #footer>
        <button class="btn" :disabled="saving" @click="saveOpen = false">Отмена</button>
        <button class="btn btn--primary" :disabled="saving || !presetName.trim()" @click="savePreset">
          <LoaderCircle v-if="saving" :size="15" class="spin" />
          <Save v-else :size="15" />
          Сохранить
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LoaderCircle, Volume1, Volume2, VolumeX } from '@lucide/vue';
import { isConnected, pushToast, setMuted, setVolume, store } from '@/lib/store';
import { errorMessage } from '@/lib/api';

const props = defineProps<{ compact?: boolean }>();

const draft = ref(store.audio.state?.volumePct ?? 0);
const dragging = ref(false);

// Re-reads from ALSA move the handle unless the person is holding it right now.
watch(
  () => store.audio.state?.volumePct ?? null,
  (value) => {
    if (value == null || dragging.value) return;
    draft.value = value;
  },
);

const pct = computed(() => store.audio.state?.volumePct ?? null);
const levelStep = computed(() => store.audio.state?.levelStep ?? null);
const muted = computed(() => store.audio.state?.muted ?? false);
const muteSupported = computed(() => store.audio.state?.canMute ?? true);

async function commit(): Promise<void> {
  dragging.value = false;
  if (!isConnected.value) return;
  const target = draft.value;
  try {
    await setVolume(target);
    const applied = pct.value;
    if (applied != null && Math.abs(applied - target) > 2) {
      pushToast('info', `Станция ответила ${applied}% — проверьте, не двигает ли громкость кто-то ещё`);
    } else {
      const step = levelStep.value;
      pushToast('ok', `Громкость ${applied ?? target}%${step != null ? ` — уровень ${step}` : ''}, Алиса видит то же число`);
    }
  } catch (error) {
    pushToast('error', errorMessage(error));
  }
}

async function toggleMute(): Promise<void> {
  if (!muteSupported.value) return;
  try {
    await setMuted(!muted.value);
  } catch (error) {
    pushToast('error', errorMessage(error));
  }
}

const icon = computed(() => {
  if (muted.value || draft.value === 0) return VolumeX;
  return draft.value < 45 ? Volume1 : Volume2;
});
</script>

<template>
  <div class="volume" :class="{ 'volume--compact': props.compact }">
    <button
      type="button"
      class="btn btn--icon"
      :disabled="!isConnected || store.audio.busy || !muteSupported"
      :title="
        muteSupported
          ? (muted ? 'Включить звук' : 'Выключить звук')
          : 'На этой станции Master не имеет переключателя mute — используйте громкость 0%'
      "
      @click="toggleMute"
    >
      <LoaderCircle v-if="store.audio.busy" :size="16" class="spin" />
      <component :is="icon" v-else :size="16" />
    </button>
    <input
      v-model.number="draft"
      type="range"
      class="range"
      min="0"
      max="100"
      step="1"
      :disabled="!isConnected || store.audio.busy || !store.audio.state"
      aria-label="Громкость станции"
      @input="dragging = true"
      @change="commit"
    />
    <span class="volume__value mono">
      {{ pct != null ? `${pct}%` : '—' }}
      <em v-if="levelStep != null" class="volume__level">уровень {{ levelStep }}</em>
    </span>
  </div>
  <div v-if="!isConnected" class="field-hint mt-8">Колонка не подключена — громкость недоступна.</div>
  <div v-else-if="store.audio.state?.muted" class="field-hint mt-8">Звук выключен на станции.</div>
  <div v-else-if="!store.audio.state" class="field-hint mt-8">Читаем громкость ALSA…</div>
  <div v-else-if="levelStep != null" class="field-hint mt-8">
    Шкала Алисы: {{ pct }}% — это её уровень {{ levelStep }}. Ползунок пишет регистр Master так же,
    как он, поэтому «уменьши громкость» и панель показывают одно число.
  </div>
  <div v-else class="field-hint mt-8">
    Ползунок пишет напрямую в ALSA Master — тот же регулятор, который двигает Алиса голосом.
  </div>
</template>

<style scoped>
.volume {
  display: flex;
  align-items: center;
  gap: 12px;
}

.volume__value {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  min-width: 62px;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.volume__level {
  font-style: normal;
  font-size: 10.5px;
  color: var(--text-soft);
  white-space: nowrap;
}
</style>

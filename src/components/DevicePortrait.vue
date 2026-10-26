<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DeviceInfo } from '@shared/types';
import { detectDeviceVisual } from '@/lib/deviceVisual';

const props = withDefaults(
  defineProps<{
    info?: DeviceInfo | null;
    size?: 'sm' | 'md' | 'lg';
    muted?: boolean;
  }>(),
  { info: null, size: 'md', muted: false },
);

const visual = computed(() => detectDeviceVisual(props.info));
const failed = ref(false);
watch(
  () => visual.value.image,
  () => {
    failed.value = false;
  },
);
const showImage = computed(() => Boolean(visual.value.image) && !failed.value);
</script>

<template>
  <div
    class="device-portrait"
    :class="[`device-portrait--${size}`, `dp--${visual.kind}`, { 'device-portrait--muted': muted }]"
    :style="{ '--dp-accent': visual.accent, '--dp-accent-soft': visual.accentSoft }"
    role="img"
    :aria-label="`${visual.label} — ${visual.tagline}`"
  >
    <span class="dp-halo" aria-hidden="true" />
    <img
      v-if="showImage"
      class="dp-image"
      :src="visual.image!"
      alt=""
      draggable="false"
      decoding="async"
      @error="failed = true"
    />
    <span v-else class="dp-mark" aria-hidden="true">Алиса</span>
  </div>
</template>

<style scoped>
.device-portrait {
  position: relative;
  width: 130px;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  isolation: isolate;
  --dp-shadow: rgba(45, 24, 12, 0.2);
}

.device-portrait--sm {
  width: 46px;
}

.device-portrait--md {
  width: 148px;
}

.device-portrait--lg {
  width: min(272px, 62vw);
}

.dp-halo {
  position: absolute;
  inset: -10%;
  border-radius: 50%;
  background: radial-gradient(
    circle at 50% 56%,
    color-mix(in srgb, var(--dp-accent) 30%, transparent) 0%,
    color-mix(in srgb, var(--dp-accent) 10%, transparent) 46%,
    transparent 70%
  );
  filter: blur(8px);
  opacity: 0.8;
  animation: dpHalo 8s ease-in-out infinite;
  pointer-events: none;
}

.dp-image {
  position: relative;
  width: 100%;
  height: 100%;
  object-fit: contain;
  filter: drop-shadow(0 14px 18px var(--dp-shadow));
  animation: dpFloat 7s cubic-bezier(0.37, 0, 0.63, 1) infinite;
  transform-origin: 50% 92%;
  user-select: none;
  -webkit-user-drag: none;
}

.dp-mark {
  display: grid;
  place-items: center;
  width: 58%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--dp-accent-soft);
  color: color-mix(in srgb, var(--dp-accent) 82%, #2a160d);
  font-size: clamp(10px, 3.4vw, 15px);
  font-weight: 760;
  letter-spacing: -0.03em;
}

.device-portrait--sm .dp-mark {
  font-size: 9px;
}

.device-portrait--muted {
  opacity: 0.55;
}

.device-portrait--muted .dp-image {
  filter: grayscale(0.9) drop-shadow(0 10px 14px var(--dp-shadow));
}

.device-portrait--muted .dp-halo {
  opacity: 0.25;
}

[data-theme='dark'] .device-portrait {
  --dp-shadow: rgba(0, 0, 0, 0.55);
}

[data-theme='dark'] .dp-halo {
  opacity: 0.55;
}

@keyframes dpFloat {
  0%,
  100% {
    transform: translateY(0);
  }
  50% {
    transform: translateY(-6px);
  }
}

@keyframes dpHalo {
  0%,
  100% {
    opacity: 0.55;
    transform: scale(0.96);
  }
  50% {
    opacity: 0.9;
    transform: scale(1.04);
  }
}

@media (prefers-reduced-motion: reduce) {
  .dp-image,
  .dp-halo {
    animation: none;
  }
}
</style>

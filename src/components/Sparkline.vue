<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    values: Array<number | null | undefined>;
    min?: number;
    max?: number;
    height?: number;
    tone?: 'primary' | 'green' | 'red' | 'violet';
  }>(),
  { min: 0, max: 100, height: 44, tone: 'primary' },
);

const uid = `spark-${Math.random().toString(36).slice(2, 8)}`;

const geometry = computed(() => {
  const values = props.values;
  const width = 140;
  const height = 40;
  const pad = 2;
  const nums = values.filter((value): value is number => value != null && Number.isFinite(value));
  const max = props.max ?? Math.max(...nums, 1);
  const min = props.min ?? Math.min(...nums, 0);
  const span = max - min || 1;
  const coords: Array<{ x: number; y: number } | null> = values.map((value, index) => {
    if (value == null || !Number.isFinite(value)) return null;
    const x = values.length > 1 ? (index / (values.length - 1)) * width : width / 2;
    const y = pad + (1 - (value - min) / span) * (height - pad * 2);
    return { x, y };
  });
  const present = coords.filter((point): point is { x: number; y: number } => point != null);
  if (!present.length) return null;
  let line = '';
  let drawing = false;
  for (const point of coords) {
    if (!point) {
      drawing = false;
      continue;
    }
    line += `${drawing ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    drawing = true;
  }
  const area = `M${present[0].x.toFixed(1)} ${height} ${present
    .map((point) => `L${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ')} L${present[present.length - 1].x.toFixed(1)} ${height} Z`;
  return { line, area, width, height };
});
</script>

<template>
  <svg
    v-if="geometry"
    class="spark"
    :class="`spark--${tone}`"
    :viewBox="`0 0 ${geometry.width} ${geometry.height}`"
    preserveAspectRatio="none"
    :style="{ height: `${height}px` }"
    aria-hidden="true"
  >
    <defs>
      <linearGradient :id="uid" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="currentColor" stop-opacity="0.22" />
        <stop offset="100%" stop-color="currentColor" stop-opacity="0" />
      </linearGradient>
    </defs>
    <path class="area" :d="geometry.area" :fill="`url(#${uid})`" />
    <path class="line" :d="geometry.line" />
  </svg>
  <svg v-else class="spark" viewBox="0 0 140 40" preserveAspectRatio="none" :style="{ height: `${height}px` }" aria-hidden="true">
    <path class="line" d="M0 30 L140 30" opacity="0.25" />
  </svg>
</template>

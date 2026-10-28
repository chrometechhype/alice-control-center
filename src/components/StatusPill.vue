<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionState, StabilitySnapshot } from '@shared/types';

const props = defineProps<{
  state: ConnectionState;
  compact?: boolean;
  stability?: StabilitySnapshot;
}>();

const titles: Record<ConnectionState, string> = {
  connected: 'Колонка на связи',
  connecting: 'Подключаемся к колонке',
  reconnecting: 'Колонка пропала — ищем её в сети и подключаемся заново',
  error: 'Подключение не удалось',
  disconnected: 'Колонка не подключена',
};

/**
 * «Подключено» is not the whole truth when the station keeps dropping the transport: say that the
 * link is strained and that the panel has deliberately slowed down, instead of looking healthy.
 */
const title = computed(() => {
  const stability = props.stability;
  if (props.state !== 'connected' || !stability || stability.mode === 'stable') {
    return titles[props.state];
  }
  const every = Math.round(stability.pollIntervalMs / 1000);
  if (stability.mode === 'unstable') {
    return `Колонка перегружена: обрывов за 3 мин — ${stability.drops}. Панель опрашивает её раз в ${every} с, чтобы не мешать.`;
  }
  return `Связь нестабильна: обрывов за 3 мин — ${stability.drops}. Панель снизила частоту опроса до ${every} с.`;
});

// «compact» is for the sidebar, where the row shares 230 px with the live indicator and two buttons.
const label = computed(() => {
  switch (props.state) {
    case 'connected':
      return 'Подключено';
    case 'connecting':
      return props.compact ? 'Подключаемся…' : 'Подключение…';
    case 'reconnecting':
      return props.compact ? 'Ищем колонку…' : 'Восстанавливаем…';
    case 'error':
      return 'Ошибка';
    default:
      return props.compact ? 'Нет связи' : 'Не подключено';
  }
});

const tone = computed(() => {
  switch (props.state) {
    case 'connected':
      return 'ok';
    case 'connecting':
    case 'reconnecting':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'muted';
  }
});
</script>

<template>
  <span class="pill" :class="`pill--${tone}`" :title="title">
    <span class="dot" :class="{ 'dot--live': state === 'connected' }" />
    <span class="status-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.pill {
  min-width: 0;
}

/* Длинная подпись не должна выталкивать из строки кнопки — иначе в боковой панели их не видно. */
.status-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

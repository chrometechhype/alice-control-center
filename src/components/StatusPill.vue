<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionState } from '@shared/types';

const props = defineProps<{ state: ConnectionState; compact?: boolean }>();

const titles: Record<ConnectionState, string> = {
  connected: 'Колонка на связи',
  connecting: 'Подключаемся к колонке',
  reconnecting: 'Колонка пропала — ищем её в сети и подключаемся заново',
  error: 'Подключение не удалось',
  disconnected: 'Колонка не подключена',
};

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
  <span class="pill" :class="`pill--${tone}`" :title="titles[props.state]">
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

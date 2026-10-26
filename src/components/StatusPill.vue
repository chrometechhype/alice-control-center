<script setup lang="ts">
import { computed } from 'vue';
import type { ConnectionState } from '@shared/types';

const props = defineProps<{ state: ConnectionState }>();

const label = computed(() => {
  switch (props.state) {
    case 'connected':
      return 'Подключено';
    case 'connecting':
      return 'Подключение…';
    case 'reconnecting':
      return 'Восстанавливаем…';
    case 'error':
      return 'Ошибка';
    default:
      return 'Не подключено';
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
  <span class="pill" :class="`pill--${tone}`" :title="label">
    <span class="dot" :class="{ 'dot--live': state === 'connected' }" />
    <span class="status-label">{{ label }}</span>
  </span>
</template>

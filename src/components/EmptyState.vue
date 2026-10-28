<script setup lang="ts">
withDefaults(defineProps<{ title: string; text?: string; compact?: boolean }>(), {
  text: '',
  compact: false,
});
</script>

<template>
  <div class="empty" :class="{ 'empty--inline': compact }">
    <div v-if="$slots.icon" class="empty-icon">
      <slot name="icon" />
    </div>
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ title: string; text?: string }>(), { text: '' });
</script>

<template>
  <div class="empty">
    <div v-if="$slots.icon" class="empty-icon">
      <slot name="icon" />
    </div>
    <h3>{{ title }}</h3>
    <p v-if="text">{{ text }}</p>
    <slot />
  </div>
</template>

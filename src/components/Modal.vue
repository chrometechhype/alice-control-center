<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue';
import { X } from '@lucide/vue';

const props = withDefaults(
  defineProps<{ open: boolean; title: string; subtitle?: string; wide?: boolean }>(),
  { subtitle: '', wide: false },
);
const emit = defineEmits<{ close: [] }>();

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close');
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKey);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  document.body.style.overflow = '';
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
      <div class="modal" :class="{ 'modal--wide': wide }" role="dialog" aria-modal="true">
        <div class="modal-head">
          <div>
            <h3>{{ title }}</h3>
            <p v-if="subtitle">{{ subtitle }}</p>
          </div>
          <button
            type="button"
            class="btn btn--ghost btn--icon btn--sm"
            aria-label="Закрыть"
            @click="emit('close')"
          >
            <X :size="16" />
          </button>
        </div>
        <slot />
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { AlertTriangle } from '@lucide/vue';
import Modal from './Modal.vue';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    danger?: boolean;
    busy?: boolean;
  }>(),
  { confirmLabel: 'Подтвердить', danger: true, busy: false },
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <Modal :open="open" :title="title" @close="emit('cancel')">
    <div class="alert" :class="danger ? 'alert--warn' : 'alert--info'">
      <AlertTriangle :size="16" />
      <div>{{ message }}</div>
    </div>
    <slot />
    <template #footer>
      <button type="button" class="btn" :disabled="busy" @click="emit('cancel')">Отмена</button>
      <button
        type="button"
        class="btn"
        :class="danger ? 'btn--danger' : 'btn--primary'"
        :disabled="busy"
        @click="emit('confirm')"
      >
        {{ busy ? 'Выполняется…' : confirmLabel }}
      </button>
    </template>
  </Modal>
</template>

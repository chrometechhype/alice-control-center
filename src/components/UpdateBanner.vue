<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowUpCircle, LoaderCircle, Sparkles, X } from '@lucide/vue';
import ConfirmDialog from './ConfirmDialog.vue';
import UpdateNotes from './UpdateNotes.vue';
import { formatBytes } from '@/lib/format';
import {
  dismissUpdate,
  installUpdate,
  isUpdateDismissed,
  loadUpdates,
  updateStore,
} from '@/lib/updates';

const hidden = ref(false);
const confirmOpen = ref(false);

const visible = computed(
  () =>
    !hidden.value &&
    Boolean(updateStore.info?.updateAvailable) &&
    !isUpdateDismissed() &&
    !updateStore.restarting,
);

const latest = computed(() => updateStore.info?.latestVersion ?? '');
const summary = computed(() => {
  const [first, second] = updateStore.info?.highlights ?? [];
  if (!first) return 'Описание релиза — в диалоге установки.';
  return second ? `${first} Также: ${second}` : first;
});
const sizeLabel = computed(() => formatBytes(updateStore.info?.assetSizeBytes));

function closeForNow(): void {
  hidden.value = true;
  dismissUpdate();
}

async function confirmInstall(): Promise<void> {
  confirmOpen.value = false;
  await installUpdate();
}

onMounted(() => {
  void loadUpdates(false);
});
</script>

<template>
  <div v-if="updateStore.restarting" class="update-banner update-banner--busy">
    <span class="update-banner__icon"><LoaderCircle :size="18" class="spin" /></span>
    <div class="update-banner__text">
      <strong>Устанавливаем {{ latest }}</strong>
      <span>{{ updateStore.progress }}</span>
    </div>
  </div>

  <div v-else-if="visible" class="update-banner">
    <span class="update-banner__icon"><ArrowUpCircle :size="19" /></span>
    <div class="update-banner__text">
      <strong>{{ latest }} — доступно обновление</strong>
      <span>{{ summary }}</span>
    </div>
    <button type="button" class="btn btn--primary btn--sm" :disabled="updateStore.installing || !updateStore.info?.canInstall" @click="confirmOpen = true">
      <Sparkles :size="14" />
      Установить · {{ sizeLabel }}
    </button>
    <button type="button" class="btn btn--ghost btn--icon btn--sm" title="Скрыть до следующего релиза" @click="closeForNow">
      <X :size="14" />
    </button>
  </div>

  <div v-if="updateStore.error && !updateStore.restarting" class="update-error">
    <span>{{ updateStore.error }}</span>
  </div>

  <ConfirmDialog
    :open="confirmOpen"
    :title="`Установить ${latest}?`"
    message="Панель перезапустится. Настройки, история и бэкапы в data/ останутся на месте, а архив мы проверим по SHA-256 перед установкой."
    confirm-label="Скачать и установить"
    :danger="false"
    :busy="updateStore.installing"
    @cancel="confirmOpen = false"
    @confirm="confirmInstall"
  >
    <UpdateNotes />
  </ConfirmDialog>
</template>

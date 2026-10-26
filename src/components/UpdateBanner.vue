<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ArrowUpCircle, LoaderCircle, Sparkles, X } from '@lucide/vue';
import ConfirmDialog from './ConfirmDialog.vue';
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
const notes = computed(() => updateStore.info?.notes?.trim() || 'Список изменений появится в релизе на GitHub.');

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
      <strong>Доступно обновление {{ latest }}</strong>
      <span>Сейчас установлена {{ updateStore.info?.currentVersion }}. Обновление скачается с GitHub и проверится по SHA-256.</span>
    </div>
    <button type="button" class="btn btn--soft btn--sm" @click="confirmOpen = true">
      <Sparkles :size="14" />
      Что нового
    </button>
    <button
      type="button"
      class="btn btn--primary btn--sm"
      :disabled="updateStore.installing || !updateStore.info?.canInstall"
      @click="confirmOpen = true"
    >
      Установить
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
    title="Установить обновление?"
    :message="`Панель обновится до ${latest} и перезапустится. Настройки, история и бэкапы в data/ сохранятся. Перед установкой архив проверяется по SHA-256.`"
    confirm-label="Скачать и установить"
    :danger="false"
    :busy="updateStore.installing"
    @cancel="confirmOpen = false"
    @confirm="confirmInstall"
  >
    <div class="update-release">
      <div class="update-release__head">
        <strong>Что нового в {{ latest }}</strong>
        <a v-if="updateStore.info?.releaseUrl" :href="updateStore.info.releaseUrl" target="_blank" rel="noopener noreferrer">
          Открыть релиз
        </a>
      </div>
      <pre class="update-release__notes">{{ notes }}</pre>
    </div>
  </ConfirmDialog>
</template>

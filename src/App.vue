<script setup lang="ts">
import { computed, onMounted, watchEffect } from 'vue';
import { AudioLines, LoaderCircle } from '@lucide/vue';
import AppShell from './components/AppShell.vue';
import WelcomeDialog from './components/WelcomeDialog.vue';
import LoginView from './views/LoginView.vue';
import { detectDeviceVisual, LITE2_COLORS, stationLook } from './lib/deviceVisual';
import { initStore, store } from './lib/store';

const visual = computed(() => detectDeviceVisual(store.info));
const accent = computed(() => {
  if (store.info) return visual.value.accent;
  return LITE2_COLORS.find((item) => item.id === stationLook.value.color)?.hex ?? visual.value.accent;
});

watchEffect(() => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-station-accent', visual.value.kind);
  root.style.setProperty('--station-accent', accent.value);
  root.style.setProperty('--station-accent-soft', visual.value.accentSoft);
});

onMounted(() => {
  void initStore();
});
</script>

<template>
  <div v-if="!store.booted" class="centered">
    <div class="splash">
      <div class="brand-mark"><AudioLines :size="20" /></div>
      <div>
        <div class="brand-name">Alice Control Center</div>
        <div class="muted" style="font-size: 12px">Проверка доступа к backend…</div>
      </div>
      <LoaderCircle :size="18" class="spin muted" />
    </div>
  </div>
  <LoginView v-else-if="!store.auth.authenticated" />
  <template v-else>
    <AppShell />
    <WelcomeDialog />
  </template>
</template>

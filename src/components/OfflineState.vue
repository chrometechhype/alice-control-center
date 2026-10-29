<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import { PlugZap, RefreshCw } from '@lucide/vue';
import { errorMessage } from '../lib/api';
import { pushToast, reconnectDevice, store } from '../lib/store';

defineProps<{ feature: string }>();

const busy = ref(false);

async function retry(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await reconnectDevice();
  } catch (error) {
    pushToast('error', errorMessage(error));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="card gate">
    <div class="gate-head">
      <span class="gate-icon"><PlugZap :size="20" /></span>
      <div>
        <h3>Колонка не отвечает</h3>
        <p>
          Панель ещё не связалась с колонкой в этой сессии. {{ feature }} Без связи показать нечего.
        </p>
      </div>
    </div>
    <div v-if="store.status.lastError" class="alert alert--error">
      <span>{{ store.status.lastError }}</span>
    </div>
    <div class="gate-actions">
      <button class="btn btn--primary" :disabled="busy" @click="retry">
        <RefreshCw :size="15" :class="{ spin: busy }" />
        Повторить подключение
      </button>
      <RouterLink to="/setup" class="btn">Мастер подключения</RouterLink>
    </div>
    <ul class="gate-hints">
      <li>Колонка включена и в той же сети, что и этот компьютер.</li>
      <li>SSH отвечает на порту из настроек, логин root.</li>
      <li>После перезагрузки станции подождите минуту — панель пробует сама.</li>
    </ul>
  </div>
</template>

<style scoped>
.gate {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 720px;
}

.gate-head {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.gate-icon {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  background: var(--surface-2);
  color: var(--text);
}

.gate-head h3 {
  font-size: 15px;
  font-weight: 650;
  margin: 0 0 4px;
}

.gate-head p {
  margin: 0;
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.55;
}

.gate-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.gate-hints {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}

.gate-hints li {
  display: flex;
  gap: 8px;
}

.gate-hints li::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-top: 6px;
  flex: 0 0 auto;
  background: var(--line);
}
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { AudioLines, Eye, EyeOff, LoaderCircle, Lock, RefreshCw, ShieldAlert } from '@lucide/vue';
import { login, retryAuth, store } from '@/lib/store';
import { errorMessage } from '@/lib/api';

const token = ref('');
const showToken = ref(false);
const busy = ref(false);
const error = ref('');

const lanDisabled = computed(() => !store.auth.lanEnabled);
const backendError = computed(() => store.authError);

async function submit(): Promise<void> {
  if (!token.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await login(token.value.trim());
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    busy.value = false;
  }
}

async function retry(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await retryAuth();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="centered">
    <div class="auth-card">
      <div class="row">
        <div class="brand-mark"><AudioLines :size="20" /></div>
        <div>
          <div class="brand-name">Alice Control Center</div>
          <div class="brand-sub">Защищённый доступ</div>
        </div>
      </div>

      <div>
        <h1 style="font-size: 21px; font-weight: 720; letter-spacing: -0.02em">Вход по локальной сети</h1>
        <p class="muted" style="font-size: 12.5px; margin-top: 6px">
          Панель открыта с другого устройства. Введите токен доступа, созданный на компьютере с backend.
        </p>
      </div>

      <div v-if="lanDisabled" class="alert alert--warn">
        <ShieldAlert :size="16" />
        <div>
          Доступ по локальной сети отключён в настройках backend. Включите его на компьютере с backend и
          перезапустите сервер, чтобы панель стала доступна с телефона.
        </div>
      </div>

      <div v-else-if="backendError" class="alert alert--error">
        <ShieldAlert :size="16" />
        <div>{{ backendError }}</div>
      </div>

      <form v-if="!lanDisabled" class="stack" style="gap: 12px" @submit.prevent="submit">
        <div class="field">
          <label for="access-token">Токен доступа</label>
          <div class="input-group">
            <input
              id="access-token"
              v-model="token"
              class="input"
              :type="showToken ? 'text' : 'password'"
              autocomplete="current-password"
              spellcheck="false"
              placeholder="Вставьте токен"
              :disabled="busy"
            />
            <button
              type="button"
              class="btn btn--icon"
              :title="showToken ? 'Скрыть токен' : 'Показать токен'"
              @click="showToken = !showToken"
            >
              <EyeOff v-if="showToken" :size="15" />
              <Eye v-else :size="15" />
            </button>
          </div>
          <span class="field-hint">
            Токен находится на компьютере с backend: Настройки → Доступ по локальной сети.
          </span>
        </div>

        <div v-if="error" class="alert alert--error">
          <ShieldAlert :size="16" />
          <div>{{ error }}</div>
        </div>

        <button type="submit" class="btn btn--primary btn--lg w-full" :disabled="busy || !token.trim()">
          <LoaderCircle v-if="busy" :size="16" class="spin" />
          <Lock v-else :size="16" />
          {{ busy ? 'Проверка…' : 'Войти' }}
        </button>
      </form>

      <button type="button" class="btn w-full" :disabled="busy" @click="retry">
        <RefreshCw :size="15" :class="{ spin: busy }" />
        Повторить проверку доступа
      </button>

      <div class="alert alert--info">
        <Lock :size="15" />
        <div>
          Пароль SSH не передаётся в браузер: он вводится только в мастере подключения и хранится в
          локальном конфиге backend с правами 0600.
        </div>
      </div>
    </div>
  </div>
</template>

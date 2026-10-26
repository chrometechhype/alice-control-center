<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, ArrowRight, Cable, Check, Send, Sparkles } from '@lucide/vue';
import Modal from './Modal.vue';
import DevicePortrait from './DevicePortrait.vue';
import SocialLinks from './SocialLinks.vue';
import {
  LITE2_COLORS,
  detectDeviceVisual,
  setStationLook,
  stationLook,
  type Lite2Color,
} from '@/lib/deviceVisual';
import { isConnected, store } from '@/lib/store';
import { completeWelcome, maybeShowWelcome, welcomeOpen } from '@/lib/welcome';

const router = useRouter();
const step = ref<1 | 2>(1);
const visual = computed(() => detectDeviceVisual(store.info));
const connected = computed(() => isConnected.value && Boolean(store.info));
const canCustomize = computed(() => connected.value && visual.value.kind === 'lite2');

onMounted(maybeShowWelcome);

function dismiss(): void {
  step.value = 1;
  completeWelcome();
}

function chooseColor(color: Lite2Color): void {
  setStationLook({ color });
}

function chooseClock(clock: boolean): void {
  setStationLook({ clock });
}

function goSetup(): void {
  step.value = 1;
  completeWelcome();
  void router.push('/setup');
}
</script>

<template>
  <Modal
    :open="welcomeOpen"
    :title="step === 1 ? 'Привет, это Alice Control Center' : connected ? 'Ваша станция' : 'Подключение станции'"
    :subtitle="step === 1 ? 'Локальная панель для Яндекс Станции' : 'Шаг 2 из 2'"
    wide
    @close="dismiss"
  >
    <div class="welcome">
      <div class="welcome-progress" aria-hidden="true">
        <span class="welcome-progress__dot" :class="{ active: step === 1, done: step === 2 }">1</span>
        <span class="welcome-progress__line" :class="{ done: step === 2 }" />
        <span class="welcome-progress__dot" :class="{ active: step === 2 }">2</span>
        <span class="welcome-progress__label">
          {{ step === 1 ? 'Знакомство' : connected ? 'Станция и вид' : 'Подключение' }}
        </span>
      </div>

      <template v-if="step === 1">
        <div class="welcome-hero">
          <div class="welcome-hero__glow" aria-hidden="true" />
          <div class="welcome-hero__text">
            <span class="pill pill--primary"><Sparkles :size="13" /> Знакомство</span>
            <h2>Всё управление станцией — в одном окне</h2>
            <p>
              Звуки, LED-кольцо, Bluetooth, файлы, бэкапы, сценарии и Fun Lab. Команды идут через
              локальный backend и SSH: пароль остаётся на компьютере и не попадает в браузер.
            </p>
            <div class="welcome-points">
              <span>Звук и LED</span>
              <span>Файлы и бэкапы</span>
              <span>Сценарии и Fun Lab</span>
            </div>
          </div>
        </div>

        <a class="tg-card" href="https://t.me/myloveiskeri" target="_blank" rel="noopener noreferrer">
          <img class="tg-avatar" src="/telegram/avatar.jpg" alt="Аватар Alexandr T." width="56" height="56" />
          <span class="tg-info">
            <strong>Alexandr T.</strong>
            <span>@myloveiskeri</span>
            <span class="tg-note">Напишите, что добавить или что не работает — я читаю всё.</span>
          </span>
          <span class="tg-action">
            <Send :size="15" />
            Telegram
          </span>
        </a>
        <div class="welcome-social">
          <span>Исходники и обновления</span>
          <SocialLinks labels />
        </div>
      </template>

      <template v-else-if="connected">
        <div class="welcome-device">
          <DevicePortrait :info="store.info" size="md" />
          <div class="welcome-device__text">
            <span class="pill pill--ok"><Check :size="13" /> Подключено</span>
            <h2>{{ visual.label }}</h2>
            <p>{{ visual.tagline }}. Модель определена автоматически по данным колонки.</p>
          </div>
        </div>

        <div v-if="canCustomize" class="welcome-look">
          <div>
            <strong>Как выглядит ваша станция?</strong>
            <p>
              Цвет корпуса и часы прошивка не сообщает. Подтвердите свой вариант — панель подстроит
              акценты под цвет Алисы.
            </p>
          </div>
          <div class="welcome-look__controls">
            <div class="look__swatches" role="group" aria-label="Цвет корпуса станции">
              <button
                v-for="color in LITE2_COLORS"
                :key="color.id"
                type="button"
                class="look__swatch"
                :class="{ active: stationLook.color === color.id }"
                :style="{ '--swatch': color.hex }"
                :title="color.label"
                :aria-label="color.label"
                :aria-pressed="stationLook.color === color.id"
                @click="chooseColor(color.id)"
              >
                <Check v-if="stationLook.color === color.id" :size="13" />
              </button>
            </div>
            <div class="segmented" role="group" aria-label="Часы на корпусе">
              <button type="button" class="seg" :class="{ active: !stationLook.clock }" @click="chooseClock(false)">
                Без часов
              </button>
              <button type="button" class="seg" :class="{ active: stationLook.clock }" @click="chooseClock(true)">
                С часами
              </button>
            </div>
          </div>
        </div>

        <p v-else class="field-hint welcome-note">
          Акценты панели уже подстроены под цвет этой модели. Вид можно изменить позже в настройках.
        </p>
      </template>

      <div v-else class="welcome-connect">
        <div class="welcome-connect__icon"><Cable :size="22" /></div>
        <div>
          <h2>Станция ещё не подключена</h2>
          <p>
            Панель пока не знает модель и цвет корпуса, поэтому не показывает станцию. Мастер
            подключения попросит адрес, порт и root-пароль — они сохранятся только на этом
            компьютере.
          </p>
          <ul class="welcome-connect__list">
            <li>Пароль не попадает в браузер и в исходный код.</li>
            <li>Backend слушает только 127.0.0.1, пока вы не включите доступ с телефона.</li>
          </ul>
        </div>
      </div>
    </div>

    <template #footer>
      <template v-if="step === 1">
        <button class="btn btn--ghost" @click="dismiss">Пропустить</button>
        <button class="btn btn--primary" @click="step = 2">
          Далее
          <ArrowRight :size="15" />
        </button>
      </template>
      <template v-else-if="connected">
        <button class="btn btn--ghost" @click="step = 1">
          <ArrowLeft :size="15" />
          Назад
        </button>
        <button class="btn btn--primary" @click="dismiss">
          Готово
          <Check :size="15" />
        </button>
      </template>
      <template v-else>
        <button class="btn btn--ghost" @click="step = 1">
          <ArrowLeft :size="15" />
          Назад
        </button>
        <button class="btn btn--primary" @click="goSetup">
          <Cable :size="15" />
          Мастер подключения
        </button>
      </template>
    </template>
  </Modal>
</template>

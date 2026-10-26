import { ref } from 'vue';

const KEY = 'acc-welcome-v2';
export const welcomeOpen = ref(false);

export function openWelcome(): void {
  welcomeOpen.value = true;
}

export function completeWelcome(): void {
  welcomeOpen.value = false;
  try {
    globalThis.localStorage?.setItem(KEY, 'done');
  } catch {
    // приватный режим — покажем в следующий раз
  }
}

export function maybeShowWelcome(): void {
  try {
    welcomeOpen.value = globalThis.localStorage?.getItem(KEY) !== 'done';
  } catch {
    welcomeOpen.value = true;
  }
}

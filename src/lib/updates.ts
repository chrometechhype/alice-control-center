import { reactive } from 'vue';
import type { UpdateInfo, UpdateInstallResult } from '@shared/types';
import { api, errorMessage } from './api';

export interface UpdateStateView extends UpdateInfo {
  state?: {
    phase: 'staging' | 'applying' | 'done' | 'failed';
    version: string;
    previousVersion: string;
    startedAt: number;
    message: string;
  } | null;
}

const DISMISS_KEY = 'acc-update-dismissed';

export const updateStore = reactive({
  info: null as UpdateStateView | null,
  loading: false,
  installing: false,
  restarting: false,
  error: '',
  progress: '',
});

let inFlight: Promise<void> | null = null;

function dismissedVersion(): string {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) ?? '';
  } catch {
    return '';
  }
}

export function isUpdateDismissed(): boolean {
  return Boolean(updateStore.info?.latestVersion && dismissedVersion() === updateStore.info.latestVersion);
}

export function dismissUpdate(): void {
  const version = updateStore.info?.latestVersion;
  if (!version) return;
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, version);
  } catch {
    // приватный режим — просто скроем баннер до перезагрузки
  }
}

export async function loadUpdates(force = false): Promise<void> {
  if (inFlight || updateStore.loading) return inFlight ?? undefined;
  updateStore.loading = true;
  updateStore.error = '';
  inFlight = (async () => {
    try {
      const result = force
        ? await api.post<UpdateStateView>('/updates/check', { force: true }, 30_000)
        : await api.get<UpdateStateView>('/updates');
      updateStore.info = result;
      if (result.latestVersion && dismissedVersion() !== result.latestVersion) {
        globalThis.localStorage?.removeItem(DISMISS_KEY);
      }
    } catch (caught) {
      updateStore.error = errorMessage(caught);
    } finally {
      updateStore.loading = false;
      inFlight = null;
    }
  })();
  return inFlight;
}

async function healthVersion(): Promise<string | null> {
  try {
    const response = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok?: boolean; data?: { version?: string } };
    return payload.ok ? (payload.data?.version ?? null) : null;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function installUpdate(): Promise<void> {
  const target = updateStore.info?.latestVersion;
  if (!target || updateStore.installing) return;
  updateStore.installing = true;
  updateStore.error = '';
  updateStore.progress = 'Скачиваем архив и проверяем SHA-256…';
  try {
    const result = await api.post<UpdateInstallResult>('/updates/install', { confirm: 'ОБНОВИТЬ' }, 150_000);
    updateStore.info = updateStore.info
      ? { ...updateStore.info, latestVersion: result.version }
      : updateStore.info;
    updateStore.installing = false;
    updateStore.restarting = true;
    updateStore.progress = 'Панель перезапускается. Это может занять до минуты…';
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await sleep(2000);
      const version = await healthVersion();
      if (version === target) {
        updateStore.progress = `Версия ${target} установлена. Обновляем страницу…`;
        await sleep(600);
        window.location.reload();
        return;
      }
    }
    throw new Error('Backend не вернулся после обновления. Запустите панель заново через start.bat.');
  } catch (caught) {
    updateStore.installing = false;
    updateStore.restarting = false;
    updateStore.progress = '';
    updateStore.error = errorMessage(caught);
  }
}

import { computed, reactive } from 'vue';
import type {
  AccEvent,
  AppSettings,
  AuthStatus,
  BackupManifest,
  Capabilities,
  ConnectionSnapshot,
  ConnectionStatus,
  DeviceInfo,
  MetricsSample,
  PublicSettings,
  ThemeMode,
  WsMessage,
} from '@shared/types';
import { api, errorMessage } from './api';

export type ToastKind = 'ok' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export const store = reactive({
  booted: false,
  authLoading: true,
  auth: { required: false, authenticated: false, lanEnabled: true } as AuthStatus,
  authError: '',
  settings: null as PublicSettings | null,
  status: { state: 'disconnected', transport: null } as ConnectionStatus,
  info: null as DeviceInfo | null,
  capabilities: null as Capabilities | null,
  warnings: [] as string[],
  metrics: [] as MetricsSample[],
  lastSample: null as MetricsSample | null,
  events: [] as AccEvent[],
  eventModules: [] as string[],
  eventTotal: 0,
  backups: [] as BackupManifest[],
  backupsLoaded: false,
  wsState: 'offline' as 'offline' | 'connecting' | 'online',
  theme: 'light' as 'light' | 'dark',
  themeMode: 'system' as ThemeMode,
  toasts: [] as ToastItem[],
  updatingSettings: false,
});

export const isConnected = computed(() => store.status.state === 'connected');
export const deviceName = computed(() => store.info?.modelGuess || 'Яндекс Станция');

let toastSeq = 0;
let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let pollTimer: number | null = null;
let initStarted = false;
let unauthorizedHandlerAttached = false;
let snapshotInFlight = false;
let systemThemeBound = false;

const THEME_META: Record<'light' | 'dark', string> = {
  light: '#fffaf7',
  dark: '#17110e',
};

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  store.themeMode = mode;
  store.theme = resolved;
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem('acc-theme', mode);
  } catch {
    // localStorage может быть недоступен
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_META[resolved]);
}

function bindSystemTheme(): void {
  if (systemThemeBound || typeof window === 'undefined') return;
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) return;
  systemThemeBound = true;
  const onChange = (): void => {
    if (store.themeMode === 'system') applyTheme('system');
  };
  if (query.addEventListener) query.addEventListener('change', onChange);
  else query.addListener(onChange);
}

function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('acc-theme');
  } catch {
    stored = null;
  }
  if (stored === 'dark' || stored === 'light' || stored === 'system') applyTheme(stored);
  else applyTheme('system');
  bindSystemTheme();
}

export function dismissToast(id: number): void {
  const index = store.toasts.findIndex((item) => item.id === id);
  if (index >= 0) store.toasts.splice(index, 1);
}

export function pushToast(kind: ToastKind, message: string, timeout = 6000): void {
  const id = ++toastSeq;
  store.toasts.push({ id, kind, message });
  if (store.toasts.length > 5) store.toasts.shift();
  window.setTimeout(() => dismissToast(id), timeout);
}

function resetDeviceState(): void {
  store.status = { state: 'disconnected', transport: null };
  store.info = null;
  store.capabilities = null;
  store.warnings = [];
  store.metrics = [];
  store.lastSample = null;
}

export function applySnapshot(snapshot: ConnectionSnapshot): void {
  store.status = snapshot.status;
  store.info = snapshot.info;
  store.capabilities = snapshot.capabilities;
  store.warnings = snapshot.warnings ?? [];
  store.lastSample = snapshot.lastSample ?? null;
  if (Array.isArray(snapshot.metrics) && snapshot.metrics.length) {
    store.metrics = snapshot.metrics.slice(-360);
  } else if (!snapshot.metrics?.length && snapshot.status.state !== 'connected') {
    store.metrics = [];
  }
}

export async function loadSnapshot(): Promise<ConnectionSnapshot> {
  if (snapshotInFlight) {
    return api.get<ConnectionSnapshot>('/device');
  }
  snapshotInFlight = true;
  try {
    const snapshot = await api.get<ConnectionSnapshot>('/device');
    applySnapshot(snapshot);
    return snapshot;
  } finally {
    snapshotInFlight = false;
  }
}

export async function refreshSettings(): Promise<PublicSettings | null> {
  const settings = await api.get<PublicSettings>('/settings');
  store.settings = settings;
  applyTheme(settings.theme);
  return settings;
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<PublicSettings> {
  store.updatingSettings = true;
  try {
    const settings = await api.patch<PublicSettings>('/settings', patch);
    store.settings = settings;
    if (patch.theme) applyTheme(settings.theme);
    return settings;
  } finally {
    store.updatingSettings = false;
  }
}

export async function toggleTheme(): Promise<void> {
  const next = store.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await updateSettings({ theme: next });
  } catch (error) {
    pushToast('error', errorMessage(error));
  }
}

export async function setThemeMode(mode: ThemeMode): Promise<void> {
  applyTheme(mode);
  try {
    await updateSettings({ theme: mode });
  } catch (error) {
    pushToast('error', errorMessage(error));
  }
}

export async function refreshEvents(): Promise<void> {
  const result = await api.get<{
    events: AccEvent[];
    modules: string[];
    total: number;
  }>('/events?limit=300');
  store.events = result.events;
  store.eventModules = result.modules;
  store.eventTotal = result.total;
}

export async function refreshBackups(): Promise<void> {
  const result = await api.get<{
    backups: BackupManifest[];
    counts: Record<string, number>;
  }>('/backups');
  store.backups = result.backups;
  store.backupsLoaded = true;
}

export async function refreshMetrics(): Promise<void> {
  const result = await api.get<{
    history: MetricsSample[];
    last: MetricsSample | null;
    error: string | null;
  }>('/system/metrics');
  if (result.history.length) store.metrics = result.history.slice(-360);
  if (result.last) store.lastSample = result.last;
}

export async function refreshProbe(): Promise<void> {
  const result = await api.post<{
    info: DeviceInfo | null;
    capabilities: Capabilities | null;
    warnings: string[];
  }>('/system/refresh');
  store.info = result.info;
  store.capabilities = result.capabilities;
  store.warnings = result.warnings;
  await loadSnapshot().catch(() => undefined);
}

export async function reconnectDevice(): Promise<void> {
  const snapshot = await api.post<ConnectionSnapshot>('/connection/reconnect');
  applySnapshot(snapshot);
  pushToast('ok', 'Соединение с колонкой восстановлено');
}

export async function disconnectDevice(): Promise<void> {
  const snapshot = await api.post<ConnectionSnapshot>('/connection/disconnect');
  applySnapshot(snapshot);
  pushToast('info', 'Подключение закрыто');
}

function handleWsMessage(raw: string): void {
  let message: WsMessage;
  try {
    message = JSON.parse(raw) as WsMessage;
  } catch {
    return;
  }
  switch (message.type) {
    case 'hello': {
      applySnapshot(message.data as ConnectionSnapshot);
      break;
    }
    case 'metrics': {
      const sample = message.data as MetricsSample;
      if (!sample || typeof sample.ts !== 'number') return;
      store.lastSample = sample;
      store.metrics.push(sample);
      if (store.metrics.length > 360) store.metrics.splice(0, store.metrics.length - 360);
      break;
    }
    case 'connection': {
      const status = message.data as ConnectionStatus;
      const wasConnected = store.status.state === 'connected';
      store.status = status;
      if (status.state !== 'connected') {
        store.lastSample = null;
      }
      if (status.state === 'connected' && (!wasConnected || !store.info)) {
        void loadSnapshot().catch(() => undefined);
      }
      if (status.state === 'disconnected' || status.state === 'error') {
        store.info = null;
        store.capabilities = null;
        store.metrics = [];
      }
      break;
    }
    case 'capabilities': {
      const payload = message.data as {
        info: DeviceInfo | null;
        capabilities: Capabilities | null;
        warnings: string[];
      };
      store.info = payload.info;
      store.capabilities = payload.capabilities;
      store.warnings = payload.warnings ?? [];
      break;
    }
    case 'event': {
      const event = message.data as AccEvent;
      if (!event?.id) return;
      store.events.unshift(event);
      if (store.events.length > 400) store.events.length = 400;
      store.eventTotal += 1;
      if (event.module === 'automation' && event.operation === 'notify' && event.result === 'ok') {
        pushToast('info', event.message);
      }
      break;
    }
    default:
      break;
  }
}

export function connectWs(): void {
  if (!store.auth.authenticated) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  store.wsState = 'connecting';
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const next = new WebSocket(`${protocol}://${window.location.host}/ws`);
  socket = next;
  next.addEventListener('open', () => {
    store.wsState = 'online';
  });
  next.addEventListener('message', (event) => {
    if (typeof event.data === 'string') handleWsMessage(event.data);
  });
  next.addEventListener('close', () => {
    if (socket === next) socket = null;
    store.wsState = 'offline';
    if (store.auth.authenticated && store.booted) {
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectWs();
      }, 4000);
    }
  });
  next.addEventListener('error', () => {
    next.close();
  });
}

function stopWs(): void {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    const current = socket;
    socket = null;
    current.close();
  }
  store.wsState = 'offline';
}

export async function bootstrapApp(): Promise<void> {
  await Promise.allSettled([
    refreshSettings(),
    loadSnapshot(),
    refreshEvents(),
    refreshBackups(),
  ]);
  connectWs();
}

async function handleUnauthorized(): Promise<void> {
  if (!store.auth.authenticated) return;
  store.auth = { ...store.auth, authenticated: false };
  stopWs();
  resetDeviceState();
  pushToast('error', 'Сессия истекла. Войдите заново с токеном доступа.');
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = window.setInterval(() => {
    if (!store.auth.authenticated) return;
    if (store.wsState === 'online') return;
    void loadSnapshot().catch(() => undefined);
    void refreshMetrics().catch(() => undefined);
  }, 25_000);
}

export async function initStore(): Promise<void> {
  if (initStarted) return;
  initStarted = true;
  initTheme();
  if (!unauthorizedHandlerAttached) {
    unauthorizedHandlerAttached = true;
    window.addEventListener('acc:unauthorized', () => void handleUnauthorized());
  }
  try {
    const auth = await api.get<AuthStatus>('/auth/status');
    store.auth = auth;
    if (auth.authenticated) await bootstrapApp();
  } catch (error) {
    store.authError = errorMessage(error);
  } finally {
    store.authLoading = false;
    store.booted = true;
  }
  startPolling();
}

export async function login(token: string): Promise<void> {
  const auth = await api.post<AuthStatus>('/auth/login', { token });
  store.auth = auth;
  store.authError = '';
  await bootstrapApp();
}

export async function retryAuth(): Promise<void> {
  store.authLoading = true;
  try {
    const auth = await api.get<AuthStatus>('/auth/status');
    store.auth = auth;
    if (auth.authenticated) await bootstrapApp();
    store.authError = '';
  } catch (error) {
    store.authError = errorMessage(error);
  } finally {
    store.authLoading = false;
    store.booted = true;
  }
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } catch {
    // локальная сессия всё равно сбрасывается
  }
  stopWs();
  resetDeviceState();
  store.settings = null;
  store.backups = [];
  store.events = [];
  store.auth = { ...store.auth, authenticated: false };
  pushToast('info', 'Вы вышли из панели');
}

export function lanTokenNeeded(): boolean {
  return store.auth.lanEnabled;
}

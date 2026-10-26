export type Transport = 'ssh' | 'mock';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface DeviceConnectionConfig {
  transport: Transport;
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKeyPath?: string;
  autoReconnect: boolean;
}

export interface ConnectionStatus {
  state: ConnectionState;
  transport: Transport | null;
  host?: string;
  port?: number;
  username?: string;
  connectedAt?: number;
  lastError?: string;
  reconnectAttempt?: number;
  nextRetryAt?: number;
}

export interface DeviceInfo {
  hostname: string;
  modelRaw: string;
  modelGuess: string;
  firmware: string;
  quasarVersion: string;
  kernel: string;
  arch: string;
  os: string;
  cpuModel: string;
  cpuCores: number;
  totalMemBytes: number;
  uptimeSec: number;
  ip?: string;
  wifiRssi?: number | null;
  deviceId?: string;
  collectedAt: number;
}

export interface Capability {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface LedZone {
  index: number;
  prefix: string;
  ring: number;
  red: string;
  green: string;
  blue: string;
}

export interface SoundCapabilityDetails {
  count?: number;
  categories?: string[];
  formats?: string[];
  directories?: string[];
}

export interface Capabilities {
  system: Capability;
  sftp: Capability;
  sounds: Capability & { details?: SoundCapabilityDetails };
  led: Capability & { kind?: 'sysfs' | 'framebuffer' | 'none'; zones?: LedZone[]; defaultTriggers?: string[] };
  bluetooth: Capability & {
    adapter?: string;
    powered?: boolean | null;
    name?: string | null;
    alias?: string | null;
    address?: string | null;
    tool?: string;
  };
  logs: Capability & { files?: string[] };
  fastfetch: Capability & { path?: string };
  yam: Capability & { path?: string; running?: boolean; port?: number };
  adb: Capability & { network?: boolean };
  thermal: Capability & { zones?: string[] };
  sensors: Capability;
  audio: Capability;
  framebuffer: Capability;
  yse: Capability;
}

export interface MetricsSample {
  ts: number;
  cpuPct: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  memPct: number;
  tempC: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  dataUsedBytes: number | null;
  dataTotalBytes: number | null;
  load1: number | null;
  uptimeSec: number | null;
  wifiRssi?: number | null;
}

export type EventLevel = 'info' | 'warn' | 'error' | 'success';

export interface AccEvent {
  id: string;
  ts: number;
  level: EventLevel;
  module: string;
  operation: string;
  result: 'ok' | 'error' | 'info';
  message: string;
  details?: unknown;
}

export interface BackupItem {
  targetPath: string;
  file: string;
  size: number;
  sha256: string;
  mtimeMs?: number;
  mode?: string;
}

export interface BackupManifest {
  id: string;
  kind: 'sound' | 'config' | 'file' | 'pack' | 'manual';
  title: string;
  createdAt: number;
  items: BackupItem[];
  note?: string;
}

export interface SoundFile {
  path: string;
  rel: string;
  name: string;
  category: string;
  size: number;
  mtimeMs: number;
  ext: string;
  playable: boolean;
}

export interface SoundListing {
  root: string;
  files: SoundFile[];
  scannedAt: number;
  errors: string[];
}

export interface AppSettings {
  theme: ThemeMode;
  pollIntervalMs: number;
  lanAccess: boolean;
  autoConnect: boolean;
}

export type ThemeMode = 'dark' | 'light' | 'system';

export interface PublicSettings {
  theme: ThemeMode;
  pollIntervalMs: number;
  lanAccess: boolean;
  autoConnect: boolean;
  lanAddresses: string[];
  lanTokenSet: boolean;
}

export type AiProviderId =
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'pollinations'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

export interface AiProviderPreset {
  id: AiProviderId;
  label: string;
  baseUrl: string;
  model: string;
  requiresKey: boolean;
  note: string;
}

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresKey: true,
    note: 'Официальный API OpenAI. Нужен ключ вида sk-...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    requiresKey: true,
    note: 'Один ключ для десятков моделей разных авторов.',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    requiresKey: true,
    note: 'Быстрый бесплатный тариф с ключом из консоли Groq.',
  },
  {
    id: 'pollinations',
    label: 'Pollinations (без ключа)',
    baseUrl: 'https://text.pollinations.ai/openai',
    model: 'openai-fast',
    requiresKey: false,
    note: 'Публичный OpenAI-совместимый сервис. Ограничение — примерно 1 запрос в 30 секунд.',
  },
  {
    id: 'ollama',
    label: 'Ollama (локально)',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.1',
    requiresKey: false,
    note: 'Локальная модель на этом компьютере. Интернет не нужен.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (локально)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    requiresKey: false,
    note: 'Локальный сервер LM Studio с OpenAI-совместимым API.',
  },
  {
    id: 'custom',
    label: 'Свой сервер',
    baseUrl: '',
    model: '',
    requiresKey: false,
    note: 'Вручную укажите base URL, модель и ключ, если он нужен.',
  },
];

export interface AiConfig {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface PublicAiSettings {
  provider: AiProviderId;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  configured: boolean;
  presets: AiProviderPreset[];
}

export interface PublicConnectionConfig {
  transport: Transport;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  privateKeyPath?: string;
  autoReconnect: boolean;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface ConnectionSnapshot {
  status: ConnectionStatus;
  info: DeviceInfo | null;
  capabilities: Capabilities | null;
  warnings: string[];
  metrics: MetricsSample[];
  lastSample: MetricsSample | null;
  config: PublicConnectionConfig | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export interface FileEntry {
  path: string;
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtimeMs: number;
  mode?: number;
  writable: boolean;
}

export interface FileRoot {
  path: string;
  label: string;
  writable: boolean;
}

export interface LedPreset {
  id: string;
  name: string;
  frames: number[][][];
  fps: number;
  createdAt: number;
}

export interface LedFrame {
  zones: [number, number, number][];
}

export interface BluetoothStatus {
  adapter: string | null;
  powered: boolean | null;
  name: string | null;
  alias: string | null;
  address: string | null;
  discoverable: boolean | null;
  pairable: boolean | null;
  connectedDevice: string | null;
  raw: string;
}

export interface AudioState {
  volumePct: number;
  volumeRaw: number;
  maxRaw: number;
}

export interface ToolCheck {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  note?: string;
}

export interface SetupProbeResult {
  connection: ConnectionStatus;
  info: DeviceInfo | null;
  capabilities: Capabilities | null;
  warnings: string[];
}

export interface WsMessage {
  type: 'metrics' | 'event' | 'connection' | 'capabilities' | 'hello';
  data: unknown;
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
  lanEnabled: boolean;
}

export interface AutomationCondition {
  metric: 'cpuPct' | 'memPct' | 'tempC';
  op: '>' | '<';
  value: number;
}

export interface AutomationAction {
  type: 'notify' | 'diagnostic' | 'ledPreset';
  value?: string;
}

export interface AutomationScenario {
  id: string;
  name: string;
  enabled: boolean;
  trigger: 'device.connect' | 'device.disconnect' | 'metrics' | 'app.start';
  condition?: AutomationCondition;
  cooldownSec: number;
  action: AutomationAction;
  lastRunAt?: number;
  lastResult?: string;
}

export interface LogLine {
  ts: number;
  level: EventLevel;
  message: string;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  canInstall: boolean;
  reason?: string;
  repo: string;
  releaseUrl: string | null;
  notes: string;
  publishedAt: string | null;
  checkedAt: number | null;
  checkError?: string;
}

export interface UpdateInstallResult {
  status: 'scheduled';
  version: string;
  message: string;
}

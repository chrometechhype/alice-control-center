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
  /** MAC and device id of the station we last talked to — used to find it after DHCP moves it. */
  mac?: string;
  deviceId?: string;
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
  stability?: StabilitySnapshot;
}

/** How the link behaves right now — the panel's own verdict on its SSH session. */
export type StabilityMode = 'stable' | 'strained' | 'unstable';

export interface StabilitySnapshot {
  mode: StabilityMode;
  /** Uplinks lost inside the observation window. */
  drops: number;
  windowMs: number;
  /** Share of the window the station actually answered, 0…1. */
  uptimeRatio: number;
  lastDropAgoMs: number | null;
  meanRecoveryMs: number | null;
  /** Reads that took long enough to be a symptom of a loaded station. */
  slowReads: number;
  /** Milliseconds between ambient polls the panel currently keeps to. */
  pollIntervalMs: number;
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
  /**
   * quasar's own loudness table, read from quasar.cfg. Without it the panel writes a plain ALSA
   * percentage, which is a different number from the one Alice says out loud.
   */
  volumeScale?: VolumeScale | null;
  collectedAt: number;
}

export interface VolumeScale {
  /** Breakpoints of `platformToOutputMap`: a step on quasar's axis and the ALSA register it writes. */
  points: Array<{ platform: number; output: number }>;
  /** Highest platform step, which quasar treats as 100 %. */
  topPlatform: number;
  /** How many steps Alice counts between 0 and 100 % — 10 on the Lite 2. */
  levelCount: number;
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
  /** `user` lives in the panel's own library and can be deleted; `system` can only be replaced. */
  origin: 'system' | 'user';
}

export interface SoundListing {
  root: string;
  files: SoundFile[];
  scannedAt: number;
  errors: string[];
  /** Free bytes on the partition behind the user library, so the UI can warn before an upload. */
  userFreeBytes?: number | null;
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
  /** Whether this directory is actually on the station right now — YAM, for example, is optional. */
  exists: boolean;
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

export type WifiSecurity = 'open' | 'wep' | 'wpa' | 'wpa2' | 'wpa3' | 'enterprise';

/** One `network={…}` block of the station's wpa_supplicant.conf. */
export interface WifiConfigNetwork {
  id: string;
  ssid: string;
  /** The stored password as written in the file — shown only inside the panel. */
  psk: string | null;
  keyMgmt: string | null;
  priority: number | null;
  hidden: boolean;
  disabled: boolean;
}

export interface WifiScanEntry {
  ssid: string;
  bssid: string;
  freq: number | null;
  signal: number | null;
  security: WifiSecurity;
  hidden: boolean;
}

export interface WifiStatus {
  /** False when the firmware has no `wpa_cli` — the panel then says so instead of faking a scan. */
  available: boolean;
  cliPath: string | null;
  interface: string;
  /** Null when none of the known config paths exists. */
  configPath: string | null;
  /** `wpa_state` as reported by wpa_cli: COMPLETED, SCANNING, DISCONNECTED… */
  state: string;
  connected: {
    ssid: string;
    psk: string | null;
    keyMgmt: string | null;
    bssid: string | null;
    ip: string | null;
    freq: number | null;
  } | null;
  networks: WifiConfigNetwork[];
  raw: string;
}

/** Live ALSA state, read straight from `amixer sget Master` on the station. */
export interface AudioState {
  /** Volume on Alice's own scale — the number she will say out loud. */
  volumePct: number | null;
  /** Alice counts loudness in steps (0–10 on the Lite 2); null when the station has no table. */
  levelStep: number | null;
  /** Raw ALSA register value, kept for the hardware percentage. */
  level: number | null;
  max: number | null;
  muted: boolean | null;
  /** False on stations whose Master has no pswitch — there the volume slider is the only mute. */
  canMute: boolean;
}

export interface ToolCheck {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
  note?: string;
  /** The panel can fetch this one itself, so a missing tool needs no manual PATH editing. */
  canInstall?: boolean;
  /** Found in the panel's own tools folder rather than on PATH. */
  local?: boolean;
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

export const AUTOMATION_METRICS = ['cpuPct', 'memPct', 'tempC', 'dataFreePct', 'load1', 'wifiRssi'] as const;
export type AutomationMetric = (typeof AUTOMATION_METRICS)[number];

export interface AutomationCondition {
  metric: AutomationMetric;
  op: '>' | '<';
  value: number;
}

export const SCENARIO_TRIGGERS = [
  'manual',
  'app.start',
  'device.connect',
  'device.disconnect',
  'station.reboot',
  'update.available',
  'metrics',
  'schedule',
  'interval',
  'volume',
  'wifi',
  'bluetooth',
  'scenario.done',
] as const;
export type ScenarioTriggerType = (typeof SCENARIO_TRIGGERS)[number];

export interface ScenarioTriggerConfig {
  /** `metrics`: which reading to compare and against what. */
  condition?: AutomationCondition;
  /** `schedule`: local time `HH:MM` and ISO weekdays (1 = Monday … 7 = Sunday). */
  time?: string;
  weekdays?: number[];
  /** `interval`: how often to repeat while the panel runs. */
  everyMinutes?: number;
  /** `volume`: fire when the level crosses the threshold in the chosen direction. */
  volume?: { op: '>' | '<'; percent: number };
  /** `wifi`: a named network appears, disappears, or the station switches to another one. */
  wifi?: { event: 'connected' | 'disconnected' | 'changed'; ssid?: string };
  /** `bluetooth`: a device whose MAC or name contains `match` connects or goes away. */
  bluetooth?: { event: 'connected' | 'disconnected'; match?: string };
  /** `scenario.done`: the scenario that has to finish first. */
  scenarioId?: string;
  /** `scenario.done`: skip the chain when the previous scenario failed. */
  onSuccessOnly?: boolean;
}

/** Motions the ring renderer knows. The recipe is expanded into pixels on the panel, never stored. */
export const SCENE_EFFECTS = [
  'solid',
  'gradient',
  'sweep',
  'pulse',
  'breathe',
  'chase',
  'sparkle',
  'ripple',
] as const;

export type SceneEffect = (typeof SCENE_EFFECTS)[number];

/**
 * One move in a scenario. Steps run in order, so «замигай красным и скажи ошибка» is a led step
 * followed by a say step. LED steps keep a recipe instead of pixels: the ring grows with the model.
 * `parallelWith` is the 1-based number of an earlier step to start in the same tick — the ring and
 * the voice then begin together instead of one after the other.
 */
export type ScenarioStep = (
  | { kind: 'say'; text: string; mood?: SpeechMood }
  | { kind: 'sound'; path: string }
  | { kind: 'led'; effect: SceneEffect; colors: string[]; fps: number; seconds: number; intensity?: number; reverse?: boolean }
  | { kind: 'pause'; seconds: number }
  | { kind: 'notify'; text: string }
  | { kind: 'diagnostic' }
) & { parallelWith?: number };

export type ScenarioStepKind = ScenarioStep['kind'];

/** How the station should deliver a spoken line; see server/speechShape.ts. */
export type SpeechMood = 'neutral' | 'calm' | 'brisk' | 'alert' | 'care';

export interface AutomationScenario {
  id: string;
  name: string;
  enabled: boolean;
  trigger: ScenarioTriggerType;
  /** Parameters of the chosen trigger; absent for triggers that take none. */
  triggerConfig?: ScenarioTriggerConfig;
  /** Kept for scenarios written before `triggerConfig`; always mirrors `triggerConfig.condition`. */
  condition?: AutomationCondition;
  cooldownSec: number;
  steps: ScenarioStep[];
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
  /** Release notes boiled down to plain bullet lines the panel can actually render. */
  highlights: string[];
  assetSizeBytes: number | null;
  publishedAt: string | null;
  checkedAt: number | null;
  checkError?: string;
}

export interface UpdateInstallResult {
  status: 'scheduled';
  version: string;
  message: string;
}

/** Public GitHub numbers for the repository owner: how many archives were downloaded. */
export interface RepoInsights {
  repo: string;
  totalDownloads: number;
  releases: Array<{ version: string; downloads: number; publishedAt: string | null }>;
  latest: { version: string; downloads: number; publishedAt: string | null } | null;
  stars: number;
  forks: number;
  watchers: number;
  checkedAt: number;
  /** Why a forced refresh returned the previous numbers instead of new ones. */
  refreshError?: string;
}

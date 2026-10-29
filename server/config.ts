import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import type {
  AiConfig,
  AppSettings,
  DeviceConnectionConfig,
  PublicAiSettings,
  PublicConnectionConfig,
  PublicSettings,
} from '../shared/types.ts';
import { AI_PROVIDER_PRESETS } from '../shared/types.ts';

export const projectRoot = process.cwd();
export const dataDir = path.resolve(process.env.ACC_DATA_DIR ?? path.join(projectRoot, 'data'));
export const backupsDir = path.join(dataDir, 'backups');
export const tmpDir = path.join(dataDir, 'tmp');
export const uploadsDir = path.join(dataDir, 'uploads');
export const configFile = path.join(dataDir, 'config.json');
export const eventsFile = path.join(dataDir, 'events.jsonl');
export const ledPresetsFile = path.join(dataDir, 'led-presets.json');
export const scenariosFile = path.join(dataDir, 'scenarios.json');

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  pollIntervalMs: 5000,
  lanAccess: false,
  autoConnect: true,
  presence: false,
};

interface PersistedConfig {
  connection?: DeviceConnectionConfig;
  settings: AppSettings;
  lanToken?: string;
  ai?: AiConfig;
  owner?: boolean;
}

export function ownerMode(): boolean {
  if (process.env.ACC_OWNER === '1') return true;
  return loadConfig().owner === true;
}

export function ensureDataDirs(): void {
  for (const dir of [dataDir, backupsDir, tmpDir, uploadsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): PersistedConfig {
  ensureDataDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Partial<PersistedConfig>;
    return {
      connection: raw.connection,
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      lanToken: raw.lanToken,
      ai: raw.ai,
      owner: raw.owner === true,
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS } };
  }
}

export function saveConfig(config: PersistedConfig): void {
  ensureDataDirs();
  const tmp = `${configFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configFile);
}

export function getSettings(): AppSettings {
  return loadConfig().settings;
}

export function loadConnection(): DeviceConnectionConfig | undefined {
  return loadConfig().connection;
}

export function saveConnection(connection: DeviceConnectionConfig): void {
  const config = loadConfig();
  config.connection = connection;
  saveConfig(config);
}

export function clearConnection(): void {
  const config = loadConfig();
  delete config.connection;
  saveConfig(config);
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const config = loadConfig();
  config.settings = { ...config.settings, ...patch };
  saveConfig(config);
  return config.settings;
}

export function getLanToken(): string {
  const config = loadConfig();
  if (config.lanToken) return config.lanToken;
  const token = randomBytes(24).toString('base64url');
  config.lanToken = token;
  saveConfig(config);
  return token;
}

export function rotateLanToken(): string {
  const config = loadConfig();
  config.lanToken = randomBytes(24).toString('base64url');
  saveConfig(config);
  return config.lanToken;
}

export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

export function publicSettings(): PublicSettings {
  const config = loadConfig();
  return {
    theme: config.settings.theme,
    pollIntervalMs: config.settings.pollIntervalMs,
    lanAccess: config.settings.lanAccess,
    autoConnect: config.settings.autoConnect,
    presence: config.settings.presence,
    lanAddresses: lanAddresses(),
    lanTokenSet: Boolean(config.lanToken),
  };
}

export function publicConnection(config: DeviceConnectionConfig): PublicConnectionConfig {
  return {
    transport: config.transport,
    host: config.host,
    port: config.port,
    username: config.username,
    hasPassword: Boolean(config.password),
    privateKeyPath: config.privateKeyPath,
    autoReconnect: config.autoReconnect,
  };
}

export function loadAiConfig(): AiConfig {
  const config = loadConfig();
  return config.ai ?? { provider: 'custom', baseUrl: '', model: '' };
}

export function saveAiConfig(ai: AiConfig): void {
  const config = loadConfig();
  config.ai = ai;
  saveConfig(config);
}

export function publicAiSettings(): PublicAiSettings {
  const ai = loadAiConfig();
  const preset = AI_PROVIDER_PRESETS.find((item) => item.id === ai.provider);
  const baseUrl = ai.baseUrl.trim();
  const model = ai.model.trim();
  const hasKey = Boolean(ai.apiKey);
  const configured = Boolean(baseUrl && model && (!preset?.requiresKey || hasKey));
  return {
    provider: ai.provider,
    baseUrl,
    model,
    hasKey,
    configured,
    presets: AI_PROVIDER_PRESETS,
  };
}

import { EventEmitter } from 'node:events';
import type {
  Capabilities,
  ConnectionSnapshot,
  ConnectionStatus,
  DeviceConnectionConfig,
  DeviceInfo,
  MetricsSample,
  PublicConnectionConfig,
} from '../shared/types.ts';
import { SshAdapter } from './adapters/SshAdapter.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import {
  getSettings,
  loadConfig,
  loadConnection,
  publicConnection,
  saveConnection,
} from './config.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { MetricsService } from './metrics.ts';
import { runProbe, type ProbeResult } from './probe.ts';
import { discoverSshHosts, findIpByMac, looksLikeYandex, macOfIp, type DiscoveredHost } from './discovery.ts';
import { safeErrorMessage } from './util.ts';

const MAX_FAST_ATTEMPTS = 4;
const REVIVAL_INTERVAL_MS = 45_000;
const METRICS_DEATH_STREAK = 3;

export type { ConnectionSnapshot };

export class ConnectionManager extends EventEmitter {
  private adapter: StationAdapter | null = null;
  private config: DeviceConnectionConfig | null = null;
  private status: ConnectionStatus = { state: 'disconnected', transport: null };
  private info: DeviceInfo | null = null;
  private capabilities: Capabilities | null = null;
  private warnings: string[] = [];
  private lastProbe: ProbeResult | null = null;
  private metrics: MetricsService;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private revivalTimer: NodeJS.Timeout | null = null;
  private connectPromise: Promise<ConnectionSnapshot> | null = null;
  private attempts = 0;
  private manualDisconnect = false;
  private metricsErrorStreak = 0;

  constructor() {
    super();
    this.config = loadConnection() ?? null;
    if (this.config) {
      this.status = {
        state: 'disconnected',
        transport: this.config.transport,
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
      };
    }
    this.metrics = new MetricsService(() => this.adapter);
    this.metrics.on('sample', (sample: MetricsSample) => {
      this.metricsErrorStreak = 0;
      this.emit('metrics', sample);
    });
    this.metrics.on('error', (error: unknown) => {
      this.metricsErrorStreak += 1;
      if (this.metricsErrorStreak === 1) {
        eventLog.append({
          level: 'warn',
          module: 'system',
          operation: 'metrics',
          result: 'error',
          message: 'Не удалось получить метрики устройства',
          details: { error: safeErrorMessage(error) },
        });
      }
      // A dead TCP peer can keep reporting "connected" forever; metrics are our heartbeat.
      if (
        this.metricsErrorStreak >= METRICS_DEATH_STREAK &&
        this.status.state === 'connected' &&
        !this.connectPromise
      ) {
        void this.teardownAdapter().then(() => this.handleUnexpectedClose('метрики не приходят'));
      }
    });
  }

  async init(): Promise<void> {
    if (!this.config) return;
    if (!getSettings().autoConnect) return;
    try {
      await this.connect(this.config, { persist: false, source: 'startup' });
    } catch {
      // ошибка уже записана в журнал; интерфейс предложит повторить подключение
    }
  }

  getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  getPublicConfig(): PublicConnectionConfig | null {
    return this.config ? publicConnection(this.config) : null;
  }

  getAdapter(): StationAdapter | null {
    return this.adapter;
  }

  requireAdapter(): StationAdapter {
    if (!this.adapter?.isConnected()) {
      throw new AccError('NOT_CONNECTED', 'Устройство не подключено', 409);
    }
    return this.adapter;
  }

  getInfo(): DeviceInfo | null {
    return this.info;
  }

  getCapabilities(): Capabilities | null {
    return this.capabilities;
  }

  getWarnings(): string[] {
    return [...this.warnings];
  }

  getLastProbe(): ProbeResult | null {
    return this.lastProbe;
  }

  getMetricsService(): MetricsService {
    return this.metrics;
  }

  snapshot(): ConnectionSnapshot {
    return {
      status: this.getStatus(),
      info: this.info,
      capabilities: this.capabilities,
      warnings: this.getWarnings(),
      metrics: this.metrics.getHistory(),
      lastSample: this.metrics.getLast(),
      config: this.getPublicConfig(),
    };
  }

  async testConnection(config: DeviceConnectionConfig): Promise<ProbeResult> {
    if (config.transport !== 'ssh') {
      throw new AccError('UNSUPPORTED_TRANSPORT', 'Проверка поддерживается только для SSH', 400);
    }
    const adapter = new SshAdapter(config);
    try {
      await adapter.connect();
      const probe = await runProbe(adapter);
      eventLog.append({
        level: 'success',
        module: 'connection',
        operation: 'test',
        result: 'ok',
        message: `Проверка SSH успешна: ${probe.info.modelGuess}`,
        details: { host: config.host, port: config.port, model: probe.info.modelGuess },
      });
      return probe;
    } catch (error) {
      eventLog.append({
        level: 'error',
        module: 'connection',
        operation: 'test',
        result: 'error',
        message: 'Проверка SSH не удалась',
        details: { host: config.host, port: config.port, error: safeErrorMessage(error) },
      });
      throw error;
    } finally {
      await adapter.disconnect().catch(() => undefined);
    }
  }

  /**
   * One connect at a time. Auto-reconnect, startup and a manual retry used to race and tear
   * each other's fresh socket down, which looked to the user like endless reconnecting.
   */
  async connect(
    config?: DeviceConnectionConfig,
    options: { persist?: boolean; source?: string } = {},
  ): Promise<ConnectionSnapshot> {
    if (this.connectPromise) {
      if (!config) return this.connectPromise;
      await this.connectPromise.catch(() => undefined);
    }
    const promise = this.openConnection(config, options);
    this.connectPromise = promise;
    let failed: unknown;
    try {
      return await promise;
    } catch (error) {
      failed = error;
      throw error;
    } finally {
      if (this.connectPromise === promise) this.connectPromise = null;
      // A failed attempt nobody scheduled would leave the panel in «Ошибка» forever — that is the
      // «вечное переподключение» complaint. The ladder refuses to start while a connect promise is
      // alive, so it is kicked only after the slot is released.
      if (failed && options.source !== 'auto-reconnect' && this.config?.autoReconnect && !this.manualDisconnect) {
        this.scheduleReconnect();
      }
    }
  }

  private async openConnection(
    config?: DeviceConnectionConfig,
    options: { persist?: boolean; source?: string } = {},
  ): Promise<ConnectionSnapshot> {
    const target = config ?? this.config;
    if (!target) {
      throw new AccError('NO_CONNECTION_CONFIG', 'Не заданы параметры подключения', 400);
    }
    const persist = options.persist ?? true;
    this.manualDisconnect = false;
    this.stopReconnect();
    await this.teardownAdapter();

    if (options.source === 'auto-reconnect' && this.attempts >= 2) {
      await this.rehomeIfNeeded();
    }
    const resolved = this.config ?? target;

    this.config = { ...resolved };
    this.status = {
      state: 'connecting',
      transport: resolved.transport,
      host: resolved.host,
      port: resolved.port,
      username: resolved.username,
    };
    this.emit('status', this.getStatus());

    if (resolved.transport !== 'ssh') {
      this.status = {
        ...this.status,
        state: 'error',
        lastError: 'Этот транспорт ещё не поддерживается',
      };
      this.emit('status', this.getStatus());
      throw new AccError('UNSUPPORTED_TRANSPORT', 'Транспорт не поддерживается', 400);
    }

    const adapter = new SshAdapter(resolved);
    this.adapter = adapter;
    adapter.on('closed', (reason?: string) => {
      if (this.adapter === adapter) this.handleUnexpectedClose(reason);
    });

    try {
      await adapter.connect();
      const probe = await runProbe(adapter);
      this.applyProbe(probe);
      this.status = {
        state: 'connected',
        transport: resolved.transport,
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        connectedAt: Date.now(),
      };
      this.attempts = 0;
      this.metricsErrorStreak = 0;
      if (persist) saveConnection(resolved);
      await this.learnIdentity(probe);
      this.metrics.start();
      this.emit('status', this.getStatus());
      this.emit('probe', probe);
      eventLog.append({
        level: 'success',
        module: 'connection',
        operation: 'connect',
        result: 'ok',
        message: `Подключено: ${probe.info.modelGuess} (${resolved.host}:${resolved.port})`,
        details: {
          model: probe.info.modelGuess,
          firmware: probe.info.firmware,
          arch: probe.info.arch,
          source: options.source ?? 'api',
        },
      });
      return this.snapshot();
    } catch (error) {
      const message = safeErrorMessage(error);
      const autoRetry = options.source === 'auto-reconnect';
      this.status = {
        state: autoRetry ? 'reconnecting' : 'error',
        transport: resolved.transport,
        host: resolved.host,
        port: resolved.port,
        username: resolved.username,
        lastError: autoRetry ? undefined : message,
        reconnectAttempt: autoRetry ? this.attempts : undefined,
        nextRetryAt: autoRetry ? this.status.nextRetryAt : undefined,
        connectedAt: autoRetry ? this.status.connectedAt : undefined,
      };
      this.adapter = null;
      await adapter.disconnect().catch(() => undefined);
      this.metrics.stop();
      this.emit('status', this.getStatus());
      if (!autoRetry) {
        eventLog.append({
          level: 'error',
          module: 'connection',
          operation: 'connect',
          result: 'error',
          message: 'Подключение не удалось',
          details: { host: resolved.host, port: resolved.port, error: message },
        });
      }
      throw error instanceof AccError
        ? error
        : new AccError('CONNECT_FAILED', message, 502, { cause: message });
    }
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.stopReconnect();
    this.metrics.stop();
    await this.teardownAdapter();
    this.status = {
      state: 'disconnected',
      transport: this.config?.transport ?? null,
      host: this.config?.host,
      port: this.config?.port,
      username: this.config?.username,
    };
    this.info = null;
    this.capabilities = null;
    this.warnings = [];
    this.attempts = 0;
    this.emit('status', this.getStatus());
    eventLog.append({
      level: 'info',
      module: 'connection',
      operation: 'disconnect',
      result: 'ok',
      message: 'Отключено от устройства',
    });
  }

  async refreshProbe(): Promise<ProbeResult> {
    const adapter = this.requireAdapter();
    const probe = await runProbe(adapter);
    this.applyProbe(probe);
    this.emit('probe', probe);
    return probe;
  }

  async reconnectNow(): Promise<ConnectionSnapshot> {
    if (!this.config) {
      throw new AccError('NO_CONNECTION_CONFIG', 'Нет сохранённого подключения', 400);
    }
    this.stopReconnect();
    this.attempts = 0;
    return this.connect(this.config, { persist: false, source: 'manual-retry' });
  }

  dispose(): void {
    this.stopReconnect();
    this.metrics.stop();
    void this.teardownAdapter();
  }

  private applyProbe(probe: ProbeResult): void {
    this.lastProbe = probe;
    this.info = probe.info;
    this.capabilities = probe.capabilities;
    this.warnings = probe.warnings;
  }

  private handleUnexpectedClose(reason = 'transport closed'): void {
    const wasConnected = this.status.state === 'connected';
    this.metrics.stop();
    this.adapter = null;
    this.attempts = 0;
    this.status = {
      state: wasConnected ? 'reconnecting' : 'error',
      transport: this.config?.transport ?? null,
      host: this.config?.host,
      port: this.config?.port,
      username: this.config?.username,
      lastError: wasConnected ? undefined : this.status.lastError,
      connectedAt: wasConnected ? this.status.connectedAt : undefined,
    };
    this.emit('status', this.getStatus());
    if (wasConnected) {
      eventLog.append({
        level: 'warn',
        module: 'connection',
        operation: 'connection-lost',
        result: 'error',
        message: 'Соединение с устройством потеряно, восстанавливаем',
        details: { reason },
      });
    }
    if (this.config?.autoReconnect && !this.manualDisconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.config) return;
    if (this.reconnectTimer || this.revivalTimer || this.connectPromise) return;
    if (this.attempts >= MAX_FAST_ATTEMPTS) {
      // Giving up entirely was the worst part of the old behaviour: the station comes back
      // after a reboot or a new DHCP lease, and the panel stayed dead until a manual retry.
      this.attempts = 0;
      this.status = {
        ...this.status,
        state: 'reconnecting',
        lastError: undefined,
        reconnectAttempt: undefined,
        nextRetryAt: Date.now() + REVIVAL_INTERVAL_MS,
      };
      this.emit('status', this.getStatus());
      eventLog.append({
        level: 'warn',
        module: 'connection',
        operation: 'reconnect',
        result: 'error',
        message: 'Колонка не отвечает. Ищем её в сети каждые 45 секунд.',
      });
      this.revivalTimer = setTimeout(() => {
        this.revivalTimer = null;
        this.reconnectTimer = null;
        void this.connect(undefined, { persist: false, source: 'auto-reconnect' }).catch(() => {
          if (!this.manualDisconnect) this.scheduleReconnect();
        });
      }, REVIVAL_INTERVAL_MS);
      return;
    }
    const delay = this.attempts === 0 ? 800 : Math.min(20_000, 1500 * 2 ** (this.attempts - 1));
    this.attempts += 1;
    this.status = {
      ...this.status,
      state: 'reconnecting',
      lastError: undefined,
      reconnectAttempt: this.attempts,
      nextRetryAt: Date.now() + delay,
    };
    this.emit('status', this.getStatus());
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(undefined, { persist: false, source: 'auto-reconnect' }).catch(() => {
        if (!this.manualDisconnect) this.scheduleReconnect();
      });
    }, delay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.revivalTimer) clearTimeout(this.revivalTimer);
    this.reconnectTimer = null;
    this.revivalTimer = null;
  }

  /** Remembers how the station looks on the network so we can find it after DHCP moves it. */
  private async learnIdentity(probe: ProbeResult): Promise<void> {
    const config = this.config;
    if (!config) return;
    const mac = await macOfIp(config.host).catch(() => undefined);
    const next: DeviceConnectionConfig = {
      ...config,
      mac: mac ?? config.mac,
      deviceId: probe.info.deviceId ?? config.deviceId,
    };
    if (next.mac === config.mac && next.deviceId === config.deviceId) return;
    this.config = next;
    saveConnection(next);
  }

  /** When the saved address is gone, follow the station to its new IP. */
  private async rehomeIfNeeded(): Promise<void> {
    const config = this.config;
    if (!config) return;
    if (config.mac) {
      const found = await findIpByMac(config.mac).catch(() => null);
      this.rehome(found ? { host: found, port: config.port, mac: config.mac, reason: `MAC ${config.mac}` } : null);
      return;
    }
    // A station that was never reached under this build has no saved MAC, so the only way to keep
    // up with a new DHCP lease is to recognise it on the network. Adopted only when there is a
    // single SSH host to choose from — otherwise the user picks it in the wizard.
    // mDNS holds the first 2.5 s of the budget, so anything under 6 s leaves the port sweep no time
    // for a full /24 and the station stays invisible. This runs only while reconnecting is failing.
    const hosts = await discoverSshHosts({ timeoutMs: 6_000 }).catch(() => [] as DiscoveredHost[]);
    const addresses = new Set(hosts.map((host) => host.ip));
    if (addresses.size !== 1) return;
    const host = hosts.find((item) => item.ip === [...addresses][0] && (looksLikeYandex(item) || /dropbear/i.test(item.banner)));
    if (!host) return;
    this.rehome({ host: host.ip, port: host.port, mac: host.mac, reason: host.banner });
  }

  private rehome(found: { host: string; port: number; mac?: string; reason: string } | null): void {
    const config = this.config;
    if (!config || !found || config.host === found.host) return;
    this.config = { ...config, host: found.host, port: found.port, mac: found.mac ?? config.mac };
    saveConnection(this.config);
    eventLog.append({
      level: 'info',
      module: 'connection',
      operation: 'rehome',
      result: 'ok',
      message: `Колонка найдена в сети: ${config.host}:${config.port} → ${found.host}:${found.port}`,
      details: { reason: found.reason, previousHost: config.host, mac: this.config.mac ?? null },
    });
  }

  private async teardownAdapter(): Promise<void> {
    if (!this.adapter) return;
    const adapter = this.adapter;
    this.adapter = null;
    await adapter.disconnect().catch(() => undefined);
  }
}

export const connectionManager = new ConnectionManager();

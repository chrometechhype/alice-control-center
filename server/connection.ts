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
import { safeErrorMessage } from './util.ts';

const MAX_RECONNECT_ATTEMPTS = 5;

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

  async connect(
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

    this.config = { ...target };
    this.status = {
      state: 'connecting',
      transport: target.transport,
      host: target.host,
      port: target.port,
      username: target.username,
    };
    this.emit('status', this.getStatus());

    if (target.transport !== 'ssh') {
      this.status = {
        ...this.status,
        state: 'error',
        lastError: 'Этот транспорт ещё не поддерживается',
      };
      this.emit('status', this.getStatus());
      throw new AccError('UNSUPPORTED_TRANSPORT', 'Транспорт не поддерживается', 400);
    }

    const adapter = new SshAdapter(target);
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
        transport: target.transport,
        host: target.host,
        port: target.port,
        username: target.username,
        connectedAt: Date.now(),
      };
      this.attempts = 0;
      this.metricsErrorStreak = 0;
      if (persist) saveConnection(target);
      this.metrics.start();
      this.emit('status', this.getStatus());
      this.emit('probe', probe);
      eventLog.append({
        level: 'success',
        module: 'connection',
        operation: 'connect',
        result: 'ok',
        message: `Подключено: ${probe.info.modelGuess} (${target.host}:${target.port})`,
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
        transport: target.transport,
        host: target.host,
        port: target.port,
        username: target.username,
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
          details: { host: target.host, port: target.port, error: message },
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
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.status = {
        ...this.status,
        state: 'error',
        lastError: 'Не удалось восстановить соединение после 5 попыток',
        reconnectAttempt: this.attempts,
      };
      this.emit('status', this.getStatus());
      eventLog.append({
        level: 'error',
        module: 'connection',
        operation: 'reconnect',
        result: 'error',
        message: 'Повторные подключения исчерпаны',
      });
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
      void this.connect(this.config!, { persist: false, source: 'auto-reconnect' }).catch(() => {
        if (!this.manualDisconnect) this.scheduleReconnect();
      });
    }, delay);
  }

  private stopReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async teardownAdapter(): Promise<void> {
    if (!this.adapter) return;
    const adapter = this.adapter;
    this.adapter = null;
    await adapter.disconnect().catch(() => undefined);
  }
}

export const connectionManager = new ConnectionManager();

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
import { AccError, isTransportDeath } from './errors.ts';
import { eventLog } from './events.ts';
import { MetricsService } from './metrics.ts';
import { runProbe, type ProbeResult } from './probe.ts';
import {
  discoverSshHosts,
  findIpByMac,
  interfaceForHost,
  isTcpOpen,
  looksLikeYandex,
  macOfIp,
  type DiscoveredHost,
} from './discovery.ts';
import { safeErrorMessage } from './util.ts';

const MAX_FAST_ATTEMPTS = 4;
const REVIVAL_INTERVAL_MS = 45_000;
const METRICS_DEATH_STREAK = 3;
/** A reboot is only declared when the wall clock and `/proc/uptime` disagree by this much… */
const REBOOT_MIN_GAP_SEC = 300;
/** …and only for a device that has been up no longer than this, so a laptop clock jump is not a reboot. */
const REBOOT_FRESH_SEC = 3 * 3600;

/**
 * Deliberate actions — play, publish, delete, move the volume — are worth waiting for. Measured on
 * a station stuck in its own update loop, a reconnect takes 6-25 s, so the ambient 6 s window gives
 * up exactly while the ladder is one step from a live socket.
 */
export const ACTION_READY_WAIT_MS = 20_000;

/**
 * A status read keeps to a shorter budget than an action: the frontend waits 12 s for the volume,
 * and a panel that is still patiently reconnecting when the browser gave up looks worse than one
 * that says «не отвечает» on time.
 */
const READ_WINDOW_MS = 8_000;

const NOT_ANSWERING_MESSAGE =
  'Колонка не отвечает. Панель пытается связаться с ней — попробуйте через несколько секунд.';

/**
 * Which scanned host is our column. A known MAC settles it; otherwise the station is adopted only
 * when there is exactly one SSH host on the network, or exactly one that looks like Yandex
 * hardware — never a guess between two unknown devices. mDNS holds the first 2.5 s of a scan, so a
 * budget under 6 s leaves the sweep no time for a full /24 and the station stays invisible.
 */
function pickStation(hosts: DiscoveredHost[], config: DeviceConnectionConfig): DiscoveredHost | undefined {
  const normalize = (value: string): string => value.toLowerCase().replace(/:/g, '-');
  if (config.mac) {
    const wanted = normalize(config.mac);
    const byMac = hosts.find((host) => host.mac && normalize(host.mac) === wanted);
    if (byMac) return byMac;
  }
  if (new Set(hosts.map((host) => host.ip)).size === 1) return hosts[0];
  const yandex = hosts.filter((host) => looksLikeYandex(host) || /dropbear/i.test(host.banner));
  return yandex.length === 1 ? yandex[0] : undefined;
}

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
  private lastUptime: { uptimeSec: number; at: number } | null = null;

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

  /**
   * The bridge stalls for a second now and then, and a request landing in that window used to
   * answer «не подключено» while the reconnect ladder was already rebuilding the socket. Anything a
   * person is waiting on — playing a sound, publishing a file — gives that a few seconds instead.
   *
   * «Socket is open» is not «shell answers»: measured today, a publish died with «No response from
   * server» on a socket that claimed to be connected. A deliberate action therefore pays for one
   * tiny liveness exec, and a wedged transport is torn down here so the ladder rebuilds it and the
   * action is retried inside the same waiting window.
   */
  async awaitReady(
    timeoutMs = 6_000,
    options: { verifyShell?: boolean } = {},
  ): Promise<StationAdapter> {
    const deadline = Date.now() + timeoutMs;
    let kicked = false;
    for (;;) {
      const adapter = this.adapter;
      if (adapter?.isConnected()) {
        if (!options.verifyShell) return adapter;
        const alive = await adapter
          .exec('true', { timeoutMs: 3_000, maxBytes: 200 })
          .then((result) => result.code === 0)
          .catch(() => false);
        if (alive) return adapter;
        await this.teardownAdapter();
        this.handleUnexpectedClose('оболочка станции не отвечает');
        continue;
      }
      if (!this.config) {
        throw new AccError('NO_CONNECTION_CONFIG', 'Не заданы параметры подключения', 400);
      }
      if (this.manualDisconnect) {
        throw new AccError('NOT_CONNECTED', 'Панель отключилась вручную — нажмите «Подключить»', 409);
      }
      if (!kicked && !this.connectPromise) {
        kicked = true;
        void this.connect(undefined, { persist: false, source: 'await-ready' }).catch(() => undefined);
      }
      if (Date.now() >= deadline) {
        throw new AccError('NOT_CONNECTED', NOT_ANSWERING_MESSAGE, 409);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /**
   * A read-only round trip that survives the station dropping its own socket.
   *
   * The column interrupts its SSH transport every few minutes, and the reconnect ladder rebuilds it
   * in seconds — long before a person would notice, except that the request already in flight came
   * back with a line of ssh2 chatter («Unable to exec», «No response from server») which the panel
   * printed as a red error and read as a broken product. So a read that lands in that window
   * tears the wedged transport down, waits for the ladder and reads again inside the same budget;
   * only then does it give up, and it gives up with the same honest words the rest of the panel
   * uses. Deliberate actions are not wrapped here — re-running a write on a retry is not safe.
   */
  async stationRead<T>(read: (adapter: StationAdapter) => Promise<T>): Promise<T> {
    const deadline = Date.now() + READ_WINDOW_MS;
    let tried = false;
    for (;;) {
      const adapter = await this.awaitReady(Math.max(250, deadline - Date.now()));
      try {
        return await read(adapter);
      } catch (error) {
        if (tried || !isTransportDeath(error) || Date.now() >= deadline) {
          throw isTransportDeath(error)
            ? new AccError('NOT_CONNECTED', NOT_ANSWERING_MESSAGE, 409)
            : error;
        }
        tried = true;
        eventLog.append({
          level: 'warn',
          module: 'connection',
          operation: 'read-retry',
          result: 'error',
          message: `Станция оборвала ответ панели (${safeErrorMessage(error)}). Переподключаемся и читаем заново.`,
        });
        await this.teardownAdapter();
        this.handleUnexpectedClose('станция оборвала ответ');
      }
    }
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
    // Re-homing rewrites this.config, so the address being tried has to live there before the probe.
    this.config = { ...target };

    if (options.source === 'auto-reconnect') {
      // A saved address that answers nothing is a moved DHCP lease, not a busy station. Probing the
      // port for 1.5 s and following the MAC beats the old behaviour: four 10-second handshake
      // timeouts against a dead IP, and then a revival loop that never re-homed at all.
      const stale = target ? !(await isTcpOpen(target.host, target.port)) : false;
      if (stale || this.attempts >= 2) {
        await this.rehomeIfNeeded();
      }
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
    this.detectReboot(probe.info.uptimeSec);
  }

  /**
   * The column reboots on its own — the update loop keeps retrying — and every such reboot looked like
   * the panel dropping the connection. `/proc/uptime` cannot lie about that: it either went backwards
   * or it is far behind what the wall clock promised. Say so in the journal instead of staying silent.
   */
  private detectReboot(uptimeSec: number): void {
    const previous = this.lastUptime;
    const now = Date.now();
    this.lastUptime = { uptimeSec, at: now };
    if (!previous || !(uptimeSec > 0) || !(previous.uptimeSec > 0)) return;
    const expected = previous.uptimeSec + (now - previous.at) / 1000;
    const wentBackwards = uptimeSec < previous.uptimeSec;
    const freshlyBooted = expected - uptimeSec > REBOOT_MIN_GAP_SEC && uptimeSec < REBOOT_FRESH_SEC;
    if (!wentBackwards && !freshlyBooted) return;
    const adapter = this.adapter;
    const reason = adapter
      ? adapter
          .exec('cat /sys/class/aml_info/reboot_reason 2>/dev/null', { timeoutMs: 6000, maxBytes: 2000 })
          .then((result) => result.stdout.trim())
          .catch(() => '')
      : Promise.resolve('');
    void reason.then((value) => {
      eventLog.append({
        level: 'warn',
        module: 'connection',
        operation: 'station-reboot',
        result: 'error',
        message:
          `Колонка перезагрузилась сама — она включена уже ${Math.round(uptimeSec / 60)} мин. ` +
          'Панель подключается к ней заново: рвётся связь на стороне устройства, а не панели.',
        details: { rebootReason: value || null, uptimeSec: Math.round(uptimeSec), lostSec: Math.round(expected - uptimeSec) },
      });
    });
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
        // Worth saying out loud: no amount of retrying reaches a station on another subnet, and
        // «вечно переподключается» is usually exactly that — the hotspot changed its range.
        message: interfaceForHost(this.config.host)
          ? 'Колонка не отвечает. Ищем её в сети каждые 45 секунд.'
          : `${this.config.host} не в вашей подсети: компьютер и колонка в разных сетях. Ищем каждые 45 секунд.`,
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

  /**
   * Follow the station to whatever address it holds now. The MAC branch is exact; the sweep is the
   * fallback for the case that actually bit us — the hotspot moved to a new range, so the address
   * is gone from the ARP table entirely and only a scan of the current /24 finds the column.
   */
  private async rehomeIfNeeded(): Promise<void> {
    const config = this.config;
    if (!config) return;
    if (config.mac) {
      const found = await findIpByMac(config.mac).catch(() => null);
      if (found) {
        this.rehome({ host: found, port: config.port, mac: config.mac, reason: `MAC ${config.mac}` });
        return;
      }
    }
    const hosts = await discoverSshHosts({ timeoutMs: 6_000 }).catch(() => [] as DiscoveredHost[]);
    const adopted = pickStation(hosts, config);
    if (adopted) {
      this.rehome({ host: adopted.ip, port: adopted.port, mac: adopted.mac, reason: adopted.banner });
      return;
    }
    if (hosts.length > 1) {
      eventLog.append({
        level: 'warn',
        module: 'connection',
        operation: 'rehome',
        result: 'error',
        message: 'В сети несколько устройств по SSH — выбираем не вслепую. Откройте мастер подключения.',
        details: { hosts: hosts.map((host) => `${host.ip}:${host.port}`) },
      });
    }
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

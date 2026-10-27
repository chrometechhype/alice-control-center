import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import type { DeviceConnectionConfig } from '../../shared/types.ts';
import { AccError } from '../errors.ts';
import { parseLsLong } from '../parse.ts';
import { shQuote } from '../util.ts';
import type {
  AdapterDirEntry,
  AdapterStat,
  AdapterStats,
  ExecOptions,
  ExecResult,
  StationAdapter,
} from './StationAdapter.ts';

const DEFAULT_TIMEOUT = 20_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const MAX_CHANNELS = 3;
const TRANSIENT_EXEC = /unable to exec|channel open failure|open failed|administratively prohibited|resource shortage/i;
const SFTP_ABSENT = /exit code 127|subsystem request failed|no such file|not found/i;

/**
 * This dropbear runs no sftp-server: the subsystem request comes back as exit code 127. Probing it
 * again after every reconnect buys nothing, so the answer is remembered per endpoint.
 */
const sftpAbsentEndpoints = new Set<string>();

export class SshAdapter extends EventEmitter implements StationAdapter {
  readonly transport = 'ssh' as const;
  private client: Client | null = null;
  private sftpSession: SFTPWrapper | null = null;
  private sftpBroken = false;
  private connected = false;
  private manualClose = false;
  private closeNotified = false;
  private activeChannels = 0;
  private channelWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private readonly startedAt = Date.now();
  private refusedOpens = 0;
  private timedOutExecs = 0;
  private retries = 0;
  private readonly endpoint: string;

  constructor(private readonly config: DeviceConnectionConfig) {
    super();
    this.endpoint = `${config.host}:${config.port ?? 22}`;
    if (sftpAbsentEndpoints.has(this.endpoint)) this.sftpBroken = true;
  }

  isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const client = new Client();
    this.client = client;
    this.manualClose = false;
    this.closeNotified = false;

    const notifyClosed = (reason?: string) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.client = null;
      this.sftpSession = null;
      this.failChannelWaiters();
      if (wasConnected && !this.manualClose && !this.closeNotified) {
        this.closeNotified = true;
        this.emit('closed', reason ?? 'transport closed');
      }
    };

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };

      const timer = setTimeout(() => {
        client.end();
        finish(new AccError('SSH_TIMEOUT', 'Истекло время подключения по SSH', 504));
      }, 12_000);

      client.on('ready', () => {
        this.connected = true;
        this.emit('state', 'connected');
        finish();
      });

      client.on('error', (error) => {
        const wasConnected = this.connected;
        notifyClosed('transport error');
        if (!wasConnected) {
          this.emit('state', 'error');
          finish(
            new AccError(
              'SSH_AUTH_FAILED',
              this.describeError(error),
              502,
            ),
          );
        }
      });

      client.on('close', () => {
        notifyClosed('transport closed');
      });

      const options: Record<string, unknown> = {
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        readyTimeout: 10_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 6,
      };

      if (this.config.privateKeyPath) {
        try {
          options.privateKey = fs.readFileSync(this.config.privateKeyPath, 'utf8');
        } catch (error) {
          finish(
            new AccError(
              'SSH_KEY_UNREADABLE',
              `Не удалось прочитать ключ ${this.config.privateKeyPath}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              400,
            ),
          );
          return;
        }
      } else {
        options.password = this.config.password ?? '';
      }

      try {
        client.connect(options);
      } catch (error) {
        finish(
          new AccError(
            'SSH_CONNECT_FAILED',
            error instanceof Error ? error.message : 'Не удалось запустить SSH-клиент',
            502,
          ),
        );
      }
    });
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    this.connected = false;
    this.sftpSession = null;
    this.failChannelWaiters();
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  private acquireChannel(): Promise<() => void> {
    const notConnected = () => new AccError('NOT_CONNECTED', 'Устройство не подключено', 409);
    if (!this.connected || !this.client) return Promise.reject(notConnected());
    if (this.activeChannels < MAX_CHANNELS) {
      this.activeChannels += 1;
      return Promise.resolve(this.releaseChannel);
    }
    return new Promise<void>((resolve, reject) => {
      this.channelWaiters.push({ resolve, reject });
    }).then(() => {
      if (!this.connected) {
        this.releaseChannel();
        throw notConnected();
      }
      return this.releaseChannel;
    });
  }

  private releaseChannel = (): void => {
    const next = this.channelWaiters.shift();
    if (next) {
      next.resolve();
      return;
    }
    this.activeChannels = Math.max(0, this.activeChannels - 1);
  };

  private failChannelWaiters(): void {
    const waiters = this.channelWaiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new AccError('NOT_CONNECTED', 'Устройство не подключено', 409));
    }
  }

  private async withChannel<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const client = this.client;
    if (!client || !this.connected) {
      throw new AccError('NOT_CONNECTED', 'Устройство не подключено', 409);
    }
    const release = await this.acquireChannel();
    try {
      if (!this.connected) {
        throw new AccError('NOT_CONNECTED', 'Устройство не подключено', 409);
      }
      return await run(client);
    } finally {
      release();
    }
  }

  private async runWithRetry<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof AccError &&
        error.code === 'SSH_EXEC_FAILED' &&
        TRANSIENT_EXEC.test(error.message) &&
        this.connected
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (this.connected) {
          this.retries += 1;
          return run();
        }
      }
      throw error;
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    return this.withChannel((client) =>
      this.runWithRetry(() => this.execOnce(client, command, timeoutMs, maxBytes)),
    );
  }

  private execOnce(
    client: Client,
    command: string,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<ExecResult> {
    return new Promise<ExecResult>((resolve, reject) => {
      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
          truncated,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.timedOutExecs += 1;
        finish(null);
        try {
          channel?.close();
        } catch {
          // канал уже мог закрыться
        }
      }, timeoutMs);

      let channel: ClientChannel | undefined;
      client.exec(command, (error, stream) => {
        if (error) {
          this.refusedOpens += 1;
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(new AccError('SSH_EXEC_FAILED', error.message, 502));
          }
          return;
        }
        if (settled) {
          // Таймер успел сработать до колбэка — этот канал никто бы не закрыл, и он остался
          // висеть на сессии до самого разрыва.
          try {
            stream.close();
          } catch {
            // уже закрыт
          }
          return;
        }
        channel = stream;
        stream.on('data', (chunk: Buffer) => {
          if (stdout.length >= maxBytes) {
            truncated = true;
            return;
          }
          stdout += chunk.toString('utf8');
          if (stdout.length > maxBytes) {
            stdout = stdout.slice(0, maxBytes);
            truncated = true;
          }
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length >= 64_000) return;
          stderr += chunk.toString('utf8');
          if (stderr.length > 64_000) stderr = stderr.slice(0, 64_000);
        });
        stream.on('close', (code: number | null) => finish(code));
        stream.on('error', (streamError: Error) => {
          stderr += `\n${streamError.message}`;
          finish(null);
        });
      });
    });
  }

  getStats(): AdapterStats {
    return {
      activeChannels: this.activeChannels,
      queuedWaiters: this.channelWaiters.length,
      maxChannels: MAX_CHANNELS,
      refusedOpens: this.refusedOpens,
      timedOutExecs: this.timedOutExecs,
      retries: this.retries,
      sftpBroken: this.sftpBroken,
      startedAt: this.startedAt,
    };
  }

  async supportsSftp(): Promise<boolean> {
    if (this.sftpSession) return true;
    if (this.sftpBroken) return false;
    try {
      await this.getSftp();
      return true;
    } catch {
      return false;
    }
  }

  private getSftp(): Promise<SFTPWrapper> {
    if (this.sftpSession) return Promise.resolve(this.sftpSession);
    const client = this.client;
    if (!client || !this.connected) {
      return Promise.reject(new AccError('NOT_CONNECTED', 'Устройство не подключено', 409));
    }
    if (this.sftpBroken) {
      return Promise.reject(new AccError('SFTP_UNAVAILABLE', 'SFTP недоступен на этом устройстве', 501));
    }
    return new Promise<SFTPWrapper>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.sftpBroken = true;
        reject(new AccError('SFTP_TIMEOUT', 'SFTP-подсистема не ответила за 8 секунд', 504));
      }, 8000);
      client.sftp((error, sftp) => {
        if (settled) {
          sftp?.end();
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.sftpBroken = true;
          if (SFTP_ABSENT.test(error.message)) sftpAbsentEndpoints.add(this.endpoint);
          reject(new AccError('SFTP_FAILED', `SFTP недоступен: ${error.message}`, 502));
          return;
        }
        this.sftpSession = sftp;
        resolve(sftp);
      });
    });
  }

  private execBinary(command: string, timeoutMs = 20_000, maxBytes = 20_000_000): Promise<Buffer> {
    return this.withChannel((client) =>
      this.runWithRetry(() => this.execBinaryOnce(client, command, timeoutMs, maxBytes)),
    );
  }

  private execBinaryOnce(
    client: Client,
    command: string,
    timeoutMs: number,
    maxBytes: number,
  ): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let total = 0;
      let stderr = '';
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(Buffer.concat(chunks));
        else {
          reject(
            new AccError(
              'REMOTE_COMMAND_FAILED',
              stderr.trim() || `Команда завершилась с кодом ${code ?? 'тайм-аута'}`,
              502,
            ),
          );
        }
      };
      const timer = setTimeout(() => {
        this.timedOutExecs += 1;
        finish(null);
        try {
          channel?.close();
        } catch {
          // канал уже закрыт
        }
      }, timeoutMs);
      let channel: ClientChannel | undefined;
      client.exec(command, (error, stream) => {
        if (error) {
          this.refusedOpens += 1;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new AccError('SSH_EXEC_FAILED', error.message, 502));
          }
          return;
        }
        if (settled) {
          try {
            stream.close();
          } catch {
            // уже закрыт
          }
          return;
        }
        channel = stream;
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            finish(null);
            stream.close();
            return;
          }
          chunks.push(chunk);
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 32_000) stderr += chunk.toString('utf8');
        });
        stream.on('close', (code: number | null) => finish(code));
        stream.on('error', (streamError: Error) => {
          stderr += streamError.message;
          finish(null);
        });
      });
    });
  }

  private writeViaShell(remotePath: string, data: Buffer): Promise<void> {
    return this.withChannel((client) =>
      this.runWithRetry(() => this.writeViaShellOnce(client, remotePath, data)),
    );
  }

  private writeViaShellOnce(client: Client, remotePath: string, data: Buffer): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      client.exec(`cat > ${shQuote(remotePath)}`, (error, stream) => {
        if (error) {
          this.refusedOpens += 1;
          reject(new AccError('WRITE_FAILED', error.message, 502));
          return;
        }
        let stderr = '';
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        let exitTimer: NodeJS.Timeout | undefined;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (exitTimer) clearTimeout(exitTimer);
          if (ok) resolve();
          else reject(new AccError('WRITE_FAILED', stderr.trim() || 'Не удалось записать файл', 502));
        };
        timer = setTimeout(() => {
          if (settled) return;
          this.timedOutExecs += 1;
          settled = true;
          try {
            stream.close();
          } catch {
            // канал уже закрыт
          }
          reject(
            new AccError(
              'WRITE_TIMEOUT',
              `Запись ${remotePath} не завершилась за 30 секунд. Проверьте файл и бэкап.`,
              504,
            ),
          );
        }, 30_000);
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 16_000) stderr += chunk.toString('utf8');
        });
        stream.stdout.on('data', () => undefined);
        stream.on('close', (code: number | null) => finish(code === 0));
        // Некоторые BusyBox-серверы присылают exit-status, но не закрывают канал,
        // поэтому не ждём close бесконечно.
        stream.on('exit', (code: number | null) => {
          if (settled) return;
          exitTimer = setTimeout(() => {
            if (settled) return;
            try {
              stream.destroy();
            } catch {
              // канал уже закрыт
            }
            finish(code === 0);
          }, 120);
        });
        stream.on('error', (streamError: Error) => {
          stderr += streamError.message;
          finish(false);
        });
        stream.end(data);
      });
    });
  }

  async readFile(remotePath: string, maxBytes = 8_000_000): Promise<Buffer> {
    if (this.sftpSession || !this.sftpBroken) {
      try {
        const sftp = await this.getSftp();
        return await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let total = 0;
          let settled = false;
          const stream = sftp.createReadStream(remotePath, { highWaterMark: 64 * 1024 });
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            stream.destroy();
            reject(new AccError('READ_TIMEOUT', `Чтение ${remotePath} не завершилось за 20 секунд`, 504));
          }, 20_000);
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              stream.destroy();
              reject(new AccError('FILE_TOO_LARGE', `Файл превышает лимит ${maxBytes} байт`, 413));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new AccError('READ_FAILED', `Не удалось прочитать ${remotePath}: ${error.message}`, 502));
          });
          stream.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(chunks));
          });
        });
      } catch (error) {
        if (error instanceof AccError && error.code === 'FILE_TOO_LARGE') throw error;
      }
    }
    try {
      const data = await this.execBinary(`cat ${shQuote(remotePath)}`, 20_000, maxBytes + 1);
      if (data.length > maxBytes) {
        throw new AccError('FILE_TOO_LARGE', `Файл превышает лимит ${maxBytes} байт`, 413);
      }
      return data;
    } catch (error) {
      if (error instanceof AccError && error.code === 'FILE_TOO_LARGE') throw error;
      throw new AccError(
        'READ_FAILED',
        `Не удалось прочитать ${remotePath}: ${error instanceof Error ? error.message : 'ошибка'}`,
        502,
      );
    }
  }

  async writeFile(remotePath: string, data: Buffer, mode?: number): Promise<void> {
    if (this.sftpSession || !this.sftpBroken) {
      try {
        const sftp = await this.getSftp();
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            this.sftpBroken = true;
            this.sftpSession = null;
            reject(
              new AccError(
                'WRITE_FAILED',
                `Запись ${remotePath} не завершилась за 25 секунд. Проверьте файл и бэкап.`,
                504,
              ),
            );
          }, 25_000);
          sftp.writeFile(remotePath, data, mode ? { mode } : {}, (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
              reject(new AccError('WRITE_FAILED', `Не удалось записать ${remotePath}: ${error.message}`, 502));
              return;
            }
            resolve();
          });
        });
        return;
      } catch (error) {
        if (!(error instanceof AccError && error.code === 'WRITE_FAILED')) {
          // SFTP-сессия недоступна — используем shell-канал
        } else {
          throw error;
        }
      }
    }
    await this.writeViaShell(remotePath, data);
    if (mode !== undefined) {
      await this.exec(`chmod ${mode.toString(8)} ${shQuote(remotePath)}`, { timeoutMs: 5000 });
    }
  }

  async listDir(remotePath: string): Promise<AdapterDirEntry[]> {
    if (this.sftpSession || !this.sftpBroken) {
      try {
        const sftp = await this.getSftp();
        return await new Promise<AdapterDirEntry[]>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            this.sftpBroken = true;
            this.sftpSession = null;
            reject(new AccError('LIST_TIMEOUT', 'SFTP не ответил за 12 секунд', 504));
          }, 12_000);
          sftp.readdir(remotePath, (error, entries) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) {
              reject(new AccError('LIST_FAILED', `Не удалось прочитать каталог: ${error.message}`, 502));
              return;
            }
            resolve(
              entries.map((entry) => ({
                name: entry.filename,
                size: entry.attrs.size,
                mtimeMs: entry.attrs.mtime * 1000,
                mode: entry.attrs.mode,
                isDirectory: entry.attrs.isDirectory(),
                isFile: entry.attrs.isFile(),
                isSymbolicLink: entry.attrs.isSymbolicLink(),
              })),
            );
          });
        });
      } catch {
        // переходим к shell-листингу
      }
    }
    let result = await this.exec(`ls -la --full-time ${shQuote(remotePath)}`, {
      timeoutMs: 10_000,
      maxBytes: 2_000_000,
    });
    if (result.code !== 0) {
      result = await this.exec(`ls -la ${shQuote(remotePath)}`, {
        timeoutMs: 10_000,
        maxBytes: 2_000_000,
      });
    }
    if (result.code !== 0) {
      throw new AccError(
        'LIST_FAILED',
        result.stderr.trim() || `Не удалось прочитать каталог ${remotePath}`,
        502,
      );
    }
    return parseLsLong(result.stdout).filter((entry) => entry.name !== '.' && entry.name !== '..');
  }

  async stat(remotePath: string): Promise<AdapterStat> {
    if (this.sftpSession || !this.sftpBroken) {
      try {
        const sftp = await this.getSftp();
        return await new Promise<AdapterStat>((resolve, reject) => {
          sftp.stat(remotePath, (error, attrs) => {
            if (error) {
              reject(new AccError('STAT_FAILED', `Не удалось получить атрибуты: ${error.message}`, 502));
              return;
            }
            resolve({
              size: attrs.size,
              mtimeMs: attrs.mtime * 1000,
              mode: attrs.mode,
              isDirectory: attrs.isDirectory(),
              isFile: attrs.isFile(),
              isSymbolicLink: attrs.isSymbolicLink(),
            });
          });
        });
      } catch {
        // shell fallback
      }
    }
    let result = await this.exec(`ls -ld --full-time ${shQuote(remotePath)}`, {
      timeoutMs: 8000,
      maxBytes: 32_000,
    });
    if (result.code !== 0) {
      result = await this.exec(`ls -ld ${shQuote(remotePath)}`, {
        timeoutMs: 8000,
        maxBytes: 32_000,
      });
    }
    const entry = parseLsLong(result.stdout)[0];
    if (result.code !== 0 || !entry) {
      throw new AccError('STAT_FAILED', `Не удалось получить атрибуты ${remotePath}`, 502);
    }
    return {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      mode: entry.mode,
      isDirectory: entry.isDirectory,
      isFile: entry.isFile,
      isSymbolicLink: entry.isSymbolicLink,
    };
  }

  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const data = await this.readFile(remotePath, 50_000_000);
    fs.writeFileSync(localPath, data);
  }

  async uploadFile(localPath: string, remotePath: string): Promise<void> {
    const data = fs.readFileSync(localPath);
    await this.writeFile(remotePath, data);
  }

  private describeError(error: Error): string {
    const message = error.message || 'ошибка SSH';
    if (/authentication methods failed|All configured authentication/i.test(message)) {
      return 'SSH отклонил авторизацию: проверьте пользователя, пароль или ключ';
    }
    if (/ECONNREFUSED/i.test(message)) return 'SSH-порт закрыт: проверьте адрес и порт';
    if (/EHOSTUNREACH|ETIMEDOUT|ENETUNREACH/i.test(message)) return 'Устройство недоступно по сети';
    return message;
  }
}

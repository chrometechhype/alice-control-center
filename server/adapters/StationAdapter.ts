export interface ExecOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface AdapterStat {
  size: number;
  mtimeMs: number;
  mode: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export interface AdapterDirEntry extends AdapterStat {
  name: string;
}

/** Counters from inside the transport, for reading over concurrent-request failures. */
export interface AdapterStats {
  activeChannels: number;
  queuedWaiters: number;
  maxChannels: number;
  refusedOpens: number;
  timedOutExecs: number;
  retries: number;
  sftpBroken: boolean;
  /** When this adapter instance was built — reconnects reset every counter. */
  startedAt: number;
}

export type AdapterEvent = 'closed' | 'state';

export interface StationAdapter {
  readonly transport: 'ssh' | 'mock';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readFile(remotePath: string, maxBytes?: number): Promise<Buffer>;
  writeFile(remotePath: string, data: Buffer, mode?: number): Promise<void>;
  listDir(remotePath: string): Promise<AdapterDirEntry[]>;
  stat(remotePath: string): Promise<AdapterStat>;
  downloadFile(remotePath: string, localPath: string): Promise<void>;
  uploadFile(localPath: string, remotePath: string): Promise<void>;
  supportsSftp(): Promise<boolean>;
  getStats?(): AdapterStats;
  on(event: AdapterEvent, listener: (payload?: Error | string) => void): this;
  off(event: AdapterEvent, listener: (payload?: Error | string) => void): this;
}

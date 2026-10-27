import type { StationAdapter } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';
import { shQuote } from './util.ts';

export async function withRootfsRw<T>(adapter: StationAdapter, task: () => Promise<T>): Promise<T> {
  const remount = await adapter.exec('mount -o remount,rw /', { timeoutMs: 10_000 });
  if (remount.code !== 0) {
    throw new AccError(
      'ROOTFS_RW_FAILED',
      remount.stderr.trim() || 'Не удалось перевести корневую ФС в режим записи',
      502,
    );
  }
  try {
    return await task();
  } finally {
    await adapter.exec('sync', { timeoutMs: 20_000 }).catch(() => undefined);
    await adapter.exec('mount -o remount,ro /', { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

export async function writeDeviceFile(
  adapter: StationAdapter,
  remotePath: string,
  data: Buffer,
  mode?: number,
): Promise<void> {
  const write = async () => {
    await adapter.writeFile(remotePath, data, mode);
    const sync = await adapter.exec('sync', { timeoutMs: 20_000 });
    if (sync.code !== 0) {
      throw new AccError('SYNC_FAILED', sync.stderr.trim() || 'sync завершился с ошибкой', 502);
    }
  };
  if (remotePath.startsWith('/system/')) {
    await withRootfsRw(adapter, write);
  } else {
    await write();
  }
}

/**
 * `rm -f` exits 0 for a path that never existed, so an unverified delete tells the user the file is
 * gone while it is still on the station — which is exactly how a sound looked undeletable. The
 * existence checks around the `rm` turn «already gone» and «station refused» into real errors.
 */
export async function removeDeviceFile(adapter: StationAdapter, remotePath: string): Promise<void> {
  const command = [
    `p=${shQuote(remotePath)};`,
    'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo MISSING; exit 0; fi;',
    'if [ -d "$p" ] && [ ! -L "$p" ]; then rm -rf "$p"; else rm -f "$p"; fi;',
    'if [ -e "$p" ] || [ -L "$p" ]; then echo SURVIVED; exit 0; fi;',
    'echo GONE',
  ].join(' ');
  const remove = async () => {
    const result = await adapter.exec(command, { timeoutMs: 15_000 });
    const verdict = result.stdout.trim().split('\n').pop();
    if (result.code !== 0 || verdict === 'SURVIVED') {
      throw new AccError(
        'DELETE_FAILED',
        result.stderr.trim() || 'Станция не удалила файл — каталог может быть доступен только на чтение',
        502,
      );
    }
    if (verdict === 'MISSING') {
      throw new AccError('DELETE_FAILED', `Файла уже нет на станции: ${remotePath}`, 404);
    }
    await adapter.exec('sync', { timeoutMs: 20_000 }).catch(() => undefined);
  };
  if (remotePath.startsWith('/system/')) {
    await withRootfsRw(adapter, remove);
  } else {
    await remove();
  }
}

export async function remoteSha256(adapter: StationAdapter, remotePath: string): Promise<string> {
  const result = await adapter.exec(`sha256sum ${shQuote(remotePath)}`, { timeoutMs: 20_000 });
  if (result.code !== 0) {
    throw new AccError('HASH_FAILED', result.stderr.trim() || 'Не удалось вычислить SHA-256', 502);
  }
  const hash = /^([a-f0-9]{64})\s/mi.exec(result.stdout)?.[1];
  if (!hash) {
    throw new AccError('HASH_FAILED', 'sha256sum вернул неожиданный ответ', 502);
  }
  return hash.toLowerCase();
}

export async function remoteFreeBytes(
  adapter: StationAdapter,
  remotePath: string,
): Promise<{ mount: string; availableBytes: number } | null> {
  const result = await adapter.exec(`df -k ${shQuote(remotePath)}`, { timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  const lines = result.stdout.trim().split('\n');
  const parts = (lines.at(-1) ?? '').trim().split(/\s+/);
  if (parts.length < 6) return null;
  const availableKb = Number(parts[3]);
  if (!Number.isFinite(availableKb)) return null;
  return { mount: parts.slice(5).join(' '), availableBytes: availableKb * 1024 };
}

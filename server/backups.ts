import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BackupItem, BackupManifest } from '../shared/types.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { backupsDir } from './config.ts';
import { remoteSha256, writeDeviceFile } from './deviceOps.ts';
import { AccError } from './errors.ts';
import { baseName } from './parse.ts';
import { newId } from './util.ts';

export interface BackupSource {
  targetPath: string;
  mode?: string;
  data?: Buffer;
}

const MAX_ITEM_BYTES = 32 * 1024 * 1024;

function backupPath(id: string): string {
  return path.join(backupsDir, id);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
  return cleaned.slice(-80) || 'file';
}

function readManifest(id: string): BackupManifest {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AccError('BACKUP_NOT_FOUND', 'Бэкап не найден', 404);
  const file = path.join(backupPath(id), 'manifest.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest;
  } catch {
    throw new AccError('BACKUP_NOT_FOUND', 'Бэкап не найден', 404);
  }
}

export async function createBackup(
  adapter: StationAdapter,
  kind: BackupManifest['kind'],
  title: string,
  sources: BackupSource[],
  note?: string,
): Promise<BackupManifest> {
  if (!sources.length) {
    throw new AccError('BACKUP_EMPTY', 'Нечего сохранять: список файлов пуст', 400);
  }
  const id = newId(kind);
  const dir = backupPath(id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const items: BackupItem[] = [];
  try {
    for (const [index, source] of sources.entries()) {
      const data = source.data ?? (await adapter.readFile(source.targetPath, MAX_ITEM_BYTES));
      const file = `${String(index).padStart(3, '0')}-${safeFileName(baseName(source.targetPath))}`;
      fs.writeFileSync(path.join(dir, file), data, { mode: 0o600 });
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (!source.data) {
        const deviceHash = await remoteSha256(adapter, source.targetPath).catch(() => sha256);
        if (deviceHash !== sha256) {
          throw new AccError(
            'BACKUP_HASH_MISMATCH',
            `Хеш файла ${baseName(source.targetPath)} на устройстве не совпал с полученным`,
            502,
          );
        }
      }
      items.push({
        targetPath: source.targetPath,
        file,
        size: data.length,
        sha256,
        mode: source.mode,
      });
    }
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  const manifest: BackupManifest = {
    id,
    kind,
    title,
    createdAt: Date.now(),
    items,
    note,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o600,
  });
  return manifest;
}

export function listBackups(): BackupManifest[] {
  fs.mkdirSync(backupsDir, { recursive: true });
  const result: BackupManifest[] = [];
  for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      result.push(readManifest(entry.name));
    } catch {
      // каталог без манифеста — не бэкап
    }
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}

export function getBackup(id: string): BackupManifest {
  return readManifest(id);
}

export function getBackupItemPath(id: string, index: number): { manifest: BackupManifest; filePath: string; item: BackupItem } {
  const manifest = readManifest(id);
  const item = manifest.items[index];
  if (!item) throw new AccError('BACKUP_ITEM_NOT_FOUND', 'Файл в бэкапе не найден', 404);
  const filePath = path.join(backupPath(id), path.basename(item.file));
  if (!fs.existsSync(filePath)) {
    throw new AccError('BACKUP_ITEM_NOT_FOUND', 'Файл бэкапа отсутствует на диске', 404);
  }
  return { manifest, filePath, item };
}

export function deleteBackup(id: string): void {
  readManifest(id);
  fs.rmSync(backupPath(id), { recursive: true, force: true });
}

export interface RestoreResultItem {
  targetPath: string;
  ok: boolean;
  sha256?: string;
  error?: string;
}

export async function restoreBackup(
  adapter: StationAdapter,
  id: string,
): Promise<{ restored: RestoreResultItem[] }> {
  const manifest = readManifest(id);
  const restored: RestoreResultItem[] = [];
  for (const item of manifest.items) {
    try {
      const filePath = path.join(backupPath(id), path.basename(item.file));
      const data = fs.readFileSync(filePath);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== item.sha256) {
        throw new AccError('BACKUP_CORRUPTED', 'Файл бэкапа повреждён: хеш не совпал', 500);
      }
      const mode = item.mode ? Number.parseInt(item.mode, 8) : undefined;
      await writeDeviceFile(adapter, item.targetPath, data, Number.isFinite(mode) ? mode : undefined);
      const deviceHash = await remoteSha256(adapter, item.targetPath);
      if (deviceHash !== item.sha256) {
        throw new AccError('RESTORE_HASH_MISMATCH', 'После записи хеш на устройстве не совпал', 502);
      }
      restored.push({ targetPath: item.targetPath, ok: true, sha256: deviceHash });
    } catch (error) {
      restored.push({
        targetPath: item.targetPath,
        ok: false,
        error: error instanceof Error ? error.message : 'Неизвестная ошибка',
      });
    }
  }
  return { restored };
}

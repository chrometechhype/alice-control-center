import type { SoundFile, SoundListing } from '../shared/types.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';
import { dirTreeCommand, isSoundFile, parseDirWalk, soundCategory } from './parse.ts';
import { SOUNDS_ROOT, USER_SOUNDS_ROOT } from './security/paths.ts';

export function soundExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function isPreviewable(ext: string): boolean {
  return ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac'].includes(ext);
}

export const USER_CATEGORY = 'Мои звуки';

/** A library folder nobody has uploaded to yet is not worth reporting; a stalled transport is. */
const ABSENT_OR_STALLED = /не подключено|no such file|не существует|not found|нет ответа/i;

export function toSoundFile(
  remotePath: string,
  size: number,
  mtimeMs: number,
  origin: 'system' | 'user' = 'system',
): SoundFile {
  const name = remotePath.split('/').pop() ?? remotePath;
  const root = origin === 'user' ? USER_SOUNDS_ROOT : SOUNDS_ROOT;
  const rel = remotePath.startsWith(`${root}/`) ? remotePath.slice(root.length + 1) : remotePath;
  const ext = soundExt(name);
  return {
    path: remotePath,
    rel,
    name,
    category: origin === 'user' ? USER_CATEGORY : soundCategory(rel),
    size,
    mtimeMs,
    ext,
    playable: isPreviewable(ext),
    origin,
  };
}

export async function scanSounds(adapter: StationAdapter): Promise<SoundListing> {
  const files: SoundFile[] = [];
  const errors: string[] = [];
  const collect = async (root: string, origin: 'system' | 'user'): Promise<void> => {
    // One shell pass per root. Eleven separate listings used to be needed for the same tree, and a
    // station that drops every couple of minutes cut the scan halfway through — the library then
    // showed an arbitrary slice of the sounds it actually holds.
    try {
      const result = await adapter.exec(dirTreeCommand(root), {
        timeoutMs: 45_000,
        maxBytes: 4_000_000,
      });
      if (result.truncated) {
        throw new AccError('LIST_FAILED', `Слишком много файлов в ${root}`, 502);
      }
      if (result.code !== 0) {
        throw new AccError(
          'LIST_FAILED',
          result.stderr.trim() || `Не удалось прочитать каталог ${root}`,
          502,
        );
      }
      for (const entry of parseDirWalk(result.stdout)) {
        if (entry.isDirectory || entry.isSymbolicLink) continue;
        if (!entry.path || !isSoundFile(entry.name)) continue;
        files.push(toSoundFile(entry.path, entry.size, entry.mtimeMs, origin));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ошибка чтения';
      // A missing library is normal before the first upload; a stalled transport is not. Swallowing
      // the second one hides published sounds from the list while the panel still answers 200.
      if (origin === 'user' && ABSENT_OR_STALLED.test(message)) return;
      errors.push(`${root}: ${message}`);
    }
  };
  await collect(SOUNDS_ROOT, 'system');
  await collect(USER_SOUNDS_ROOT, 'user');
  files.sort((a, b) => a.rel.localeCompare(b.rel, 'ru'));
  return { root: SOUNDS_ROOT, files, scannedAt: Date.now(), errors };
}

const AUDIO_SIGNATURES: Record<string, (buffer: Buffer) => boolean> = {
  mp3: (buffer) =>
    buffer.subarray(0, 3).toString('latin1') === 'ID3' ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0),
  wav: (buffer) =>
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WAVE',
  ogg: (buffer) => buffer.subarray(0, 4).toString('latin1') === 'OggS',
  opus: (buffer) => buffer.subarray(0, 4).toString('latin1') === 'OggS',
  flac: (buffer) => buffer.subarray(0, 4).toString('latin1') === 'fLaC',
  m4a: (buffer) => buffer.subarray(4, 8).toString('latin1') === 'ftyp',
  aac: (buffer) => buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0,
};

export function looksLikeAudio(ext: string, buffer: Buffer): boolean {
  const check = AUDIO_SIGNATURES[ext];
  return check ? check(buffer) : false;
}

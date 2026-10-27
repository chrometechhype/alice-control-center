import type { SoundFile, SoundListing } from '../shared/types.ts';
import type { StationAdapter, AdapterDirEntry } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';
import { isSoundFile, soundCategory } from './parse.ts';
import { shQuote } from './util.ts';
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

/**
 * BusyBox `ls` — the only ls this station has — replaces every byte above 0x7f with '?', and no
 * flag or locale changes that. A listing built from it therefore hands the player paths that do not
 * exist, so «проверка звука.mp3» comes back as «????????.mp3» and refuses to play. A shell glob
 * printed with printf keeps the raw bytes, which is what the library needs. Costs two forks per
 * entry (wc and date), acceptable for a directory of clips and far cheaper than a broken path.
 */
async function listLibraryDir(adapter: StationAdapter, dir: string): Promise<AdapterDirEntry[]> {
  const command = [
    `for f in ${shQuote(dir)}/*; do`,
    '[ -e "$f" ] || [ -L "$f" ] || continue;',
    'if [ -d "$f" ] && [ ! -L "$f" ]; then t=d; s=0;',
    'else t=f; s=$(wc -c < "$f" 2>/dev/null || echo 0); fi;',
    'm=$(date -r "$f" +%s 2>/dev/null || echo 0);',
    `printf '%s\\t%s\\t%s\\t%s\\n' "$t" "$s" "$m" "$f";`,
    'done',
  ].join(' ');
  const result = await adapter.exec(command, { timeoutMs: 30_000, maxBytes: 2_000_000 });
  if (result.code !== 0) {
    throw new AccError(
      'LIST_FAILED',
      result.stderr.trim() || `Не удалось прочитать каталог ${dir}`,
      502,
    );
  }
  const entries: AdapterDirEntry[] = [];
  for (const line of result.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    const full = parts.slice(3).join('\t');
    const isDirectory = parts[0] === 'd';
    entries.push({
      name: full.slice(full.lastIndexOf('/') + 1),
      size: Number.parseInt(parts[1], 10) || 0,
      mtimeMs: (Number.parseInt(parts[2], 10) || 0) * 1000,
      mode: 0,
      isDirectory,
      isFile: parts[0] === 'f',
      isSymbolicLink: false,
    });
  }
  return entries;
}

export async function scanSounds(adapter: StationAdapter): Promise<SoundListing> {
  const files: SoundFile[] = [];
  const errors: string[] = [];
  const walk = async (dir: string, depth: number, origin: 'system' | 'user'): Promise<void> => {
    if (depth > 4 || files.length >= 1000) return;
    let entries;
    try {
      entries = await listLibraryDir(adapter, dir);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ошибка чтения';
      // A missing library is normal before the first upload; a stalled transport is not. Swallowing
      // the second one hides published sounds from the list while the panel still answers 200.
      if (origin === 'user' && ABSENT_OR_STALLED.test(message)) return;
      errors.push(`${dir}: ${message}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full, depth + 1, origin);
      } else if (entry.isFile && isSoundFile(entry.name)) {
        files.push(toSoundFile(full, entry.size, entry.mtimeMs, origin));
      }
    }
  };
  await walk(SOUNDS_ROOT, 0, 'system');
  await walk(USER_SOUNDS_ROOT, 0, 'user');
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

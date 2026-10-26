import type { SoundFile, SoundListing } from '../shared/types.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { isSoundFile, soundCategory } from './parse.ts';
import { SOUNDS_ROOT } from './security/paths.ts';

export function soundExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

export function isPreviewable(ext: string): boolean {
  return ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac'].includes(ext);
}

export function toSoundFile(remotePath: string, size: number, mtimeMs: number): SoundFile {
  const name = remotePath.split('/').pop() ?? remotePath;
  const rel = remotePath.startsWith(`${SOUNDS_ROOT}/`)
    ? remotePath.slice(SOUNDS_ROOT.length + 1)
    : remotePath;
  const ext = soundExt(name);
  return {
    path: remotePath,
    rel,
    name,
    category: soundCategory(rel),
    size,
    mtimeMs,
    ext,
    playable: isPreviewable(ext),
  };
}

export async function scanSounds(adapter: StationAdapter): Promise<SoundListing> {
  const files: SoundFile[] = [];
  const errors: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= 1000) return;
    let entries;
    try {
      entries = await adapter.listDir(dir);
    } catch (error) {
      errors.push(`${dir}: ${error instanceof Error ? error.message : 'ошибка чтения'}`);
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(full, depth + 1);
      } else if (entry.isFile && isSoundFile(entry.name)) {
        files.push(toSoundFile(full, entry.size, entry.mtimeMs));
      }
    }
  };
  await walk(SOUNDS_ROOT, 0);
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

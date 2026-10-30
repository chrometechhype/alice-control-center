import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AccError } from './errors.ts';
import { localToolPath } from './tools.ts';

const execFileAsync = promisify(execFile);

/** The station's ALSA card only accepts 16/24/32-bit PCM, and its `aplay` has no plug layer. */
export const TARGET_SAMPLE_RATE = 48_000;
export const TARGET_CHANNELS = 2;
const TARGET_BYTES_PER_SECOND = TARGET_SAMPLE_RATE * TARGET_CHANNELS * 2;

/** A library clip is tiny compared with what the station can hold; anything bigger is a song. */
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024;
/** 48 kHz stereo PCM weighs ~192 КБ/с, so this caps a clip at roughly three minutes. */
const MAX_CONVERTED_BYTES = 40 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 60_000;

let ffmpegProbe: Promise<string | null>;

function probeFfmpeg(): Promise<string | null> {
  // A copy the panel downloaded itself wins: it exists even when PATH does not know about it.
  const local = localToolPath('ffmpeg');
  return execFileAsync(local ?? 'ffmpeg', ['-version'], { timeout: 10_000, windowsHide: true })
    .then(() => local ?? 'ffmpeg')
    .catch(() => null);
}

/** Installing ffmpeg has to invalidate the cached answer, or the first "not found" sticks forever. */
export function resetFfmpegProbe(): void {
  ffmpegProbe = undefined as unknown as Promise<string | null>;
}

export function ffmpegPath(): Promise<string | null> {
  ffmpegProbe ??= probeFfmpeg();
  return ffmpegProbe;
}

export interface ConvertedAudio {
  data: Buffer;
  seconds: number;
}

/**
 * Decodes anything ffmpeg understands (opus, mp3, 8-bit wav…) into the one shape the station's
 * amplifier always accepts: 48 kHz stereo 16-bit PCM in a WAV container.
 *
 * Both ends go through temp files rather than pipes: ffmpeg cannot rewind a pipe, so it leaves the
 * WAV chunk sizes unpatched and `aplay` refuses the stream.
 */
export async function toStationWav(source: Buffer): Promise<ConvertedAudio> {
  if (!source.length) throw new AccError('EMPTY_AUDIO', 'Файл оказался пустым', 400);
  if (source.length > MAX_SOURCE_BYTES) {
    throw new AccError('AUDIO_TOO_LARGE', 'Звук больше 24 МБ — возьмите короткий фрагмент', 413);
  }
  const binary = await ffmpegPath();
  if (!binary) {
    throw new AccError(
      'NO_FFMPEG',
      'На компьютере не найден ffmpeg, а без него панель не может подготовить звук для станции. '
        + 'Установите ffmpeg и добавьте его в PATH.',
      500,
    );
  }
  const stamp = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  const inPath = path.join(os.tmpdir(), `acc-in-${stamp}`);
  const outPath = path.join(os.tmpdir(), `acc-out-${stamp}.wav`);
  try {
    fs.writeFileSync(inPath, source, { mode: 0o600 });
    await execFileAsync(
      binary,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-i', inPath,
        '-map', '0:a:0',
        '-map_metadata', '-1',
        '-fflags', '+bitexact',
        '-vn',
        '-acodec', 'pcm_s16le',
        '-ar', String(TARGET_SAMPLE_RATE),
        '-ac', String(TARGET_CHANNELS),
        '-y',
        outPath,
      ],
      { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    );
    const stat = fs.statSync(outPath);
    if (stat.size < 44) {
      throw new AccError('AUDIO_CONVERT_FAILED', 'Файл не похож на звук — декодировать не удалось', 422);
    }
    if (stat.size > MAX_CONVERTED_BYTES) {
      throw new AccError(
        'AUDIO_TOO_LONG',
        'После декодирования звук занимает больше 40 МБ — станция не примет такой клип. Возьмите фрагмент короче трёх минут.',
        413,
      );
    }
    const data = fs.readFileSync(outPath);
    return { data, seconds: Math.max(0.1, wavDataBytes(data) / TARGET_BYTES_PER_SECOND) };
  } catch (error) {
    if (error instanceof AccError) throw error;
    const stderr = (error as { stderr?: Buffer | string }).stderr?.toString().split('\n').pop() ?? '';
    const killed = (error as { killed?: boolean }).killed === true;
    throw new AccError(
      'AUDIO_CONVERT_FAILED',
      killed
        ? `ffmpeg не завершил декодирование за ${CONVERT_TIMEOUT_MS / 1000} секунд.`
        : `Не удалось подготовить звук к воспроизведению на станции. ${stderr}`.trim(),
      422,
    );
  } finally {
    for (const file of [inPath, outPath]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // временный файл уже удалён или недоступен — на результат не влияет
      }
    }
  }
}

/** Walks the RIFF chunks to find the payload size; ffmpeg may put LIST/INFO before `data`. */
export function wavDataBytes(buffer: Buffer): number {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return Math.min(size, buffer.length - offset - 8);
    offset += 8 + size + (size % 2);
  }
  return 0;
}

export function isStationWav(buffer: Buffer): boolean {
  return buffer.length > 44
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WAVE'
    && buffer.readUInt16LE(20) === 1
    && buffer.readUInt16LE(34) === 16;
}

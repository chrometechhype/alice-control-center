import path from 'node:path';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';
import { isStationWav, MAX_SOURCE_BYTES, toStationWav } from './audioConvert.ts';

/**
 * One-shot playback: the panel puts a file into /tmp, plays it and removes it in the same remote
 * command, so nothing ever lands in the station's sound library.
 */
const TEMP_DIR = '/tmp';
/**
 * A clip longer than this plays in the background instead of holding the SSH channel open, and the
 * panel can no longer read the player's exit code — it reports «запустили» rather than «сыграли».
 */
const FOREGROUND_LIMIT_SECONDS = 180;

const PLAYERS = ['ffplay', 'mpv', 'gstreamer', 'paplay', 'aplay'] as const;
/** Only these decode by themselves; aplay and paplay need PCM the station's card already accepts. */
const FLEXIBLE_PLAYERS = ['ffplay', 'mpv', 'gstreamer'] as const;

export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let cachedPlayers: string[] | null = null;
let cachedAdapter: StationAdapter | null = null;

export async function findPlayers(adapter: StationAdapter): Promise<string[]> {
  if (cachedPlayers && cachedAdapter === adapter) return cachedPlayers;
  const probe = PLAYERS.map((bin) => `command -v ${bin} 2>/dev/null`).join('\n');
  const result = await adapter.exec(probe, { timeoutMs: 8000, maxBytes: 4000 });
  const found = result.stdout
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
  cachedAdapter = adapter;
  cachedPlayers = PLAYERS.filter((bin) => found.some((line) => line.endsWith(`/${bin}`) || line === bin));
  return cachedPlayers;
}

function commandFor(player: string, file: string, limitSeconds: number): string {
  const target = quote(file);
  switch (player) {
    case 'ffplay':
      return `ffplay -nodisp -autoexit -t ${limitSeconds} -loglevel quiet ${target}`;
    case 'mpv':
      return `mpv --no-video --really-quiet --length-limit=${limitSeconds} ${target}`;
    case 'paplay':
      return `paplay ${target}`;
    case 'aplay':
      // Without -d a broken clip would hold the channel until the SSH timeout fires.
      return `aplay -q -d ${limitSeconds} ${target}`;
    case 'gstreamer':
      return `gst-launch-1.0 -q filesrc location=${target} ! decodebin ! audioconvert ! autoaudiosink`;
    default:
      throw new AccError('NO_AUDIO_PLAYER', `Неизвестный плеер ${player}`, 500);
  }
}

export interface PlaybackResult {
  player: string;
  seconds: number;
  /** True when ffmpeg on the computer rewrote the clip into the station's PCM format. */
  converted: boolean;
  /** False for long clips that keep playing after the command returned. */
  finished: boolean;
}

/** Unknown-length clips (played by ffplay/mpv straight from the file) get a two-minute ceiling. */
function playLimit(seconds: number): number {
  return seconds > 0 ? Math.ceil(seconds) + 5 : 120;
}

async function run(
  adapter: StationAdapter,
  command: string,
  seconds: number,
): Promise<{ result: 'ok' | 'failed' | 'background'; message: string }> {
  const limit = Math.max(5, Math.ceil(Math.min(seconds || 120, FOREGROUND_LIMIT_SECONDS)) + 12);
  if (seconds > FOREGROUND_LIMIT_SECONDS) {
    await adapter.exec(`${command} > /dev/null 2>&1 &`, { timeoutMs: 15_000, maxBytes: 4000 });
    return { result: 'background', message: 'Клип длиннее трёх минут — играем в фоне' };
  }
  // The exit code is the only proof the card accepted the stream: aplay prints «Sample format non
  // available» and the panel used to call that a success.
  const probe = `{ ${command}; echo "ACC_RC=$?"; } 2>&1`;
  const exec = await adapter.exec(probe, {
    timeoutMs: (limit + 12) * 1000,
    maxBytes: 20_000,
  });
  const code = Number(/ACC_RC=(\d+)/.exec(exec.stdout)?.[1] ?? exec.code);
  const noise = exec.stdout.replace(/ACC_RC=\d+\s*/g, '').trim();
  if (code === 0) return { result: 'ok', message: '' };
  return { result: 'failed', message: noise || `Плеер завершился с кодом ${code}` };
}

/**
 * Plays an arbitrary audio buffer on the station. Formats the card cannot take are decoded by
 * ffmpeg on the computer first, because the station's own `aplay` has no resampling plugin.
 */
export async function playBufferOnStation(
  adapter: StationAdapter,
  source: Buffer,
  ext: string,
): Promise<PlaybackResult> {
  const players = await findPlayers(adapter);
  if (!players.length) {
    throw new AccError(
      'NO_AUDIO_PLAYER',
      'На станции не нашлось плеера (aplay, paplay, ffplay, mpv, gstreamer). Проверьте, что ALSA-утилиты на месте.',
      502,
    );
  }
  const flexible = players.find((bin) => (FLEXIBLE_PLAYERS as readonly string[]).includes(bin));
  const alreadyPcm = ext === 'wav' && isStationWav(source);
  let data = source;
  let player = flexible ?? players[0];
  let seconds = 0;
  let converted = false;
  if (!flexible && !alreadyPcm) {
    const prepared = await toStationWav(source);
    data = prepared.data;
    seconds = prepared.seconds;
    converted = true;
    player = players.includes('aplay') ? 'aplay' : players[0];
  }
  const file = `${TEMP_DIR}/acc-play-${Date.now().toString(36)}.${converted ? 'wav' : ext}`;
  await adapter.writeFile(file, data, 0o600);
  // A subshell so the cleanup runs and `exit` leaves the outer shell alive to report the code.
  const command = `( ${commandFor(player, file, playLimit(seconds))}; rc=$?; rm -f ${quote(file)}; exit $rc )`;
  const played = await run(adapter, command, seconds);
  if (played.result === 'failed') {
    throw new AccError(
      'PLAYBACK_FAILED',
      `Станция не смогла воспроизвести звук: ${played.message}`,
      502,
    );
  }
  return {
    player,
    seconds: Math.round(seconds * 10) / 10,
    converted,
    finished: played.result === 'ok',
  };
}

/** Plays a file that already lives on the station by reading it back and streaming it to the card. */
export async function playDeviceFile(adapter: StationAdapter, remotePath: string): Promise<PlaybackResult> {
  const ext = path.posix.extname(remotePath).replace('.', '').toLowerCase() || 'bin';
  const data = await adapter.readFile(remotePath, MAX_SOURCE_BYTES);
  return playBufferOnStation(adapter, data, ext);
}

import path from 'node:path';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';
import { loadAiConfig } from './config.ts';
import { aiEndpoint } from './ai.ts';

/**
 * One-shot playback: the panel puts a file into /tmp, plays it and removes it in the same remote
 * command, so nothing ever lands in the station's sound library.
 */
const TEMP_DIR = '/tmp';
const MAX_TEXT_LENGTH = 300;

const PLAYERS = ['ffplay', 'mpv', 'gstreamer', 'paplay', 'aplay'] as const;

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

function commandFor(player: string, file: string): string {
  const target = quote(file);
  switch (player) {
    case 'ffplay':
      return `ffplay -nodisp -autoexit -loglevel quiet ${target}`;
    case 'mpv':
      return `mpv --no-video --really-quiet ${target}`;
    case 'paplay':
      return `paplay ${target}`;
    case 'aplay':
      return `aplay -q ${target}`;
    case 'gstreamer':
      return `gst-launch-1.0 -q filesrc location=${target} ! decodebin ! audioconvert ! autoaudiosink`;
    default:
      throw new AccError('NO_AUDIO_PLAYER', `Неизвестный плеер ${player}`, 500);
  }
}

function pickPlayer(players: string[], ext: string): string {
  const pcmContainer = ['wav', 'raw', 'pcm'].includes(ext);
  const flexible = players.filter((bin) => !['paplay', 'aplay'].includes(bin));
  if (pcmContainer) return players[0] ?? '';
  return flexible[0] ?? players[0] ?? '';
}

/** Plays a file that already lives on the station (a system sound) — read-only, nothing is written. */
export async function playDeviceFile(adapter: StationAdapter, remotePath: string): Promise<string> {
  const players = await findPlayers(adapter);
  const player = pickPlayer(players, path.posix.extname(remotePath).replace('.', '').toLowerCase());
  if (!player) {
    throw new AccError(
      'NO_AUDIO_PLAYER',
      'На станции не нашлось плеера (aplay, paplay, ffplay, mpv, gstreamer). Проверьте, что ALSA-утилиты на месте.',
      502,
    );
  }
  const command = `${commandFor(player, remotePath)} > /dev/null 2>&1 &`;
  await adapter.exec(command, { timeoutMs: 15_000, maxBytes: 4000 });
  return player;
}

/** Uploads a buffer to /tmp, plays it and deletes the file right after playback. */
export async function playTempAudio(
  adapter: StationAdapter,
  data: Buffer,
  ext: string,
): Promise<string> {
  const players = await findPlayers(adapter);
  const player = pickPlayer(players, ext);
  if (!player) {
    throw new AccError(
      'NO_AUDIO_PLAYER',
      'На станции не нашлось плеера (aplay, paplay, ffplay, mpv, gstreamer) — озвучка невозможна.',
      502,
    );
  }
  const file = `${TEMP_DIR}/acc-voice-${Date.now().toString(36)}.${ext}`;
  await adapter.writeFile(file, data, 0o600);
  const command = `{ ${commandFor(player, file)} > /dev/null 2>&1; rm -f ${quote(file)}; } &`;
  await adapter.exec(command, { timeoutMs: 15_000, maxBytes: 4000 });
  return player;
}

export interface SpeechResult {
  audio: Buffer;
  ext: string;
  model: string;
  voice: string;
}

/**
 * Text-to-speech through the OpenAI-compatible server the user already configured. The endpoint
 * is a sibling of /chat/completions, so we derive it from the same base URL.
 */
export async function synthesizeSpeech(text: string): Promise<SpeechResult> {
  const clean = text.trim().slice(0, MAX_TEXT_LENGTH);
  if (!clean) throw new AccError('EMPTY_TEXT', 'Введите текст, который нужно произнести', 400);
  const config = loadAiConfig();
  if (!config.baseUrl.trim() || !config.model.trim()) {
    throw new AccError(
      'AI_NOT_CONFIGURED',
      'ИИ не настроен. Откройте «Настройки» → «ИИ-генератор» и выберите провайдера.',
      409,
    );
  }
  const chat = aiEndpoint(config.baseUrl);
  const speechUrl = chat.replace(/\/chat\/completions$/, '/audio/speech');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  let response: Response;
  try {
    response = await fetch(speechUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ttsModel?.trim() || 'tts-1',
        voice: config.ttsVoice?.trim() || 'alloy',
        input: clean,
      }),
      signal: controller.signal,
    });
  } catch (caught) {
    throw new AccError(
      'TTS_UNAVAILABLE',
      caught instanceof Error && caught.name === 'AbortError'
        ? 'Сервер ИИ не ответил на запрос озвучки за 45 секунд.'
        : 'Не удалось связаться с сервером ИИ для озвучки.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AccError(
      'TTS_UNSUPPORTED',
      `Сервер ИИ не поддерживает озвучку текста (ответ ${response.status}). Нужен провайдер с /audio/speech: OpenAI, Groq, ElevenLabs или свой.`,
      502,
    );
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (!audio.length) {
    throw new AccError('TTS_EMPTY', 'Сервер ИИ прислал пустой звук.', 502);
  }
  const type = response.headers.get('content-type') ?? '';
  const ext = type.includes('wav') ? 'wav' : type.includes('ogg') || type.includes('opus') ? 'ogg' : 'mp3';
  return { audio, ext, model: config.ttsModel?.trim() || 'tts-1', voice: config.ttsVoice?.trim() || 'alloy' };
}

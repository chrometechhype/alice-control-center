import type { StationAdapter } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';

/**
 * Alice's own voice, spoken by the station. The firmware keeps its speech stack behind a local IPC
 * socket (`127.0.0.1:9875`): the panel pipes a length-prefixed protobuf conversation through it,
 * the station synthesises the phrase in Yandex's cloud exactly as it does for a spoken request, and
 * `audio_client_tts_player` plays it. Nothing is written to disk and no third-party TTS is involved.
 */
const IPC_PORT = 9875;
const CAPABILITY = Buffer.from('AliceCapability', 'utf8');
const MAX_FRAME_BYTES = 512 * 1024;
const MAX_TEXT_LENGTH = 2000;

type AliceTransport = 'socat' | 'nc' | 'busybox-nc';

/**
 * The station's speech stack has no SSML: measured on Plum, `<speak>Да.</speak>` takes 4.8 s instead
 * of 1.7 s because the synthesiser reads the tag names out loud. Intonation comes only from the
 * text itself, so markup is refused with an explanation instead of being spoken.
 */
const SPEECH_MARKUP = /<\s*\/?\s*(?:speak|p|s|break|prosody|emphasis|sub|say-as|phoneme|voice|audio)\b[^>]*>/i;

/**
 * Punctuation is the station's only intonation control: «?» lifts the voice, «!» makes it loud,
 * commas and periods add pauses. A space before a comma or a missing space after a period swallows
 * that pause, so the phrase is tidied here and then goes to the synthesiser as plain text.
 */
export function prepareSpeech(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?=[^\s,;:\d])/g, '$1 ')
    .replace(/([.!?…])(?=[^\s.!?…)\]»"”’])/g, '$1 ');
}

const TRANSPORT_COMMAND: Record<AliceTransport, string> = {
  socat: `socat STDIO TCP:127.0.0.1:${IPC_PORT},connect-timeout=2`,
  nc: `nc 127.0.0.1 ${IPC_PORT}`,
  'busybox-nc': `busybox nc 127.0.0.1 ${IPC_PORT}`,
};

const TRANSPORT_PROBE = [
  'if command -v socat >/dev/null 2>&1; then echo socat',
  'elif command -v nc >/dev/null 2>&1; then echo nc',
  'elif busybox --list 2>/dev/null | grep -qx nc; then echo busybox-nc',
  'else echo none',
  'fi',
].join('\n');

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function integerField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function byteField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

/** One RPC envelope: the remote service name plus its method payload, tagged as a request (253=210). */
function rpcFrame(method: number, payload: Buffer): Buffer {
  const remote = Buffer.concat([byteField(7, CAPABILITY), byteField(method, payload)]);
  const envelope = Buffer.concat([byteField(252, remote), integerField(253, 210)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(envelope.length, 0);
  return Buffer.concat([length, envelope]);
}

/**
 * `AliceCapability`, method START_VOCALIZE (18), events=true, carrying the phrase with mode
 * Append (1). The subscription goes first on the same connection, so the station publishes the
 * speech state next to the directive instead of silently accepting it.
 */
export function buildAliceFrames(text: string): Buffer {
  const directive = Buffer.concat([byteField(1, Buffer.from(text, 'utf8')), integerField(2, 1)]);
  const request = rpcFrame(
    8,
    Buffer.concat([integerField(1, 18), integerField(3, 1), byteField(13, directive)]),
  );
  const subscribe = rpcFrame(20, byteField(1, CAPABILITY));
  return Buffer.concat([subscribe, request]);
}

interface Fields {
  [field: number]: Buffer | number;
}

function readVarint(data: Buffer, cursor: { offset: number }): number {
  let value = 0;
  for (let shift = 0; shift <= 63; shift += 7) {
    if (cursor.offset >= data.length) throw new Error('Неполное protobuf-сообщение от станции');
    const byte = data[cursor.offset];
    cursor.offset += 1;
    if (shift === 63 && byte > 1) throw new Error('Некорректное protobuf-число от станции');
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 0x80) return value;
  }
  throw new Error('Некорректное protobuf-число от станции');
}

function parseFields(data: Buffer): Fields {
  const result: Fields = {};
  const cursor = { offset: 0 };
  while (cursor.offset < data.length) {
    const key = readVarint(data, cursor);
    if (key >> 3 === 0) throw new Error('Некорректное protobuf-поле от станции');
    const wire = key & 7;
    if (wire === 0) {
      result[key >> 3] = readVarint(data, cursor);
    } else if (wire === 2) {
      const size = readVarint(data, cursor);
      if (cursor.offset + size > data.length) throw new Error('Неполное protobuf-поле от станции');
      result[key >> 3] = data.subarray(cursor.offset, cursor.offset + size);
      cursor.offset += size;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (cursor.offset + size > data.length) throw new Error('Неполное protobuf-поле от станции');
      cursor.offset += size;
    } else {
      throw new Error('Неподдерживаемый тип protobuf-поля от станции');
    }
  }
  return result;
}

export type AliceEvent = 'started' | 'completed' | 'error';

/** Frames arrive split across TCP reads, so the reader keeps the unfinished tail between chunks. */
export class AliceFrameReader {
  private buffer = Buffer.alloc(0);
  private sawCapabilityEvent = false;

  push(chunk: Buffer): AliceEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: AliceEvent[] = [];
    for (;;) {
      if (this.buffer.length < 4) break;
      const size = this.buffer.readUInt32LE(0);
      if (size === 0 || size > MAX_FRAME_BYTES) {
        throw new Error(`Некорректный размер кадра от станции (${size})`);
      }
      if (this.buffer.length < 4 + size) break;
      const frame = this.buffer.subarray(4, 4 + size);
      this.buffer = this.buffer.subarray(4 + size);
      const event = this.eventFromFrame(frame);
      if (event) events.push(event);
    }
    return events;
  }

  private eventFromFrame(frame: Buffer): AliceEvent | null {
    const envelope = parseFields(frame);
    // Pushed events carry 253=3; anything else is an echo or an unrelated reply.
    if (envelope[253] !== 3) return null;
    const remoteRaw = envelope[252];
    if (!Buffer.isBuffer(remoteRaw)) return null;
    const remote = parseFields(remoteRaw);
    const capabilityRaw = remote[18];
    if (Buffer.isBuffer(capabilityRaw)) {
      this.sawCapabilityEvent = true;
      const event = parseFields(capabilityRaw)[1];
      if (event === 6) return 'started'; // TTS_STARTED
      if (event === 1) return 'completed'; // TTS_COMPLETED
      if (event === 4) return 'error'; // ON_ALICE_ERROR
      return null;
    }
    // When the firmware speaks in TTS events, generic state frames must not finish the phrase early.
    if (this.sawCapabilityEvent) return null;
    // This firmware sends no AliceCapability events, but it publishes the speech session on the
    // same socket: a request record (field 10, `1=2`) appears right after the directive and drops
    // out with `1=0` when playback ends. Verified on Plum, 0.369.x: the window matches the phrase
    // length — 1.2 s for "Раз два три", 8.5 s for 120 characters, nothing at all for empty text.
    try {
      const request = remote[10];
      if (Buffer.isBuffer(request)) {
        if (parseFields(request)[1] === 2) return 'started';
      } else if (remote[1] === 0) {
        return 'completed';
      }
    } catch {
      // Чужой кадр состояния — не повод считать озвучку сломанной.
    }
    return null;
  }
}

export interface AliceSpeechResult {
  engine: 'alice';
  voice: string;
  started: boolean;
  completed: boolean;
  durationMs: number;
  transport: AliceTransport;
}

const transportCache = new WeakMap<StationAdapter, AliceTransport | null>();

async function resolveTransport(adapter: StationAdapter): Promise<AliceTransport | null> {
  if (transportCache.has(adapter)) return transportCache.get(adapter) ?? null;
  const probe = await adapter.exec(TRANSPORT_PROBE, { timeoutMs: 8000, maxBytes: 2000 });
  const line = probe.stdout.trim().split('\n').map((item) => item.trim()).filter(Boolean).at(-1);
  const transport: AliceTransport | null =
    line === 'socat' || line === 'nc' || line === 'busybox-nc' ? line : null;
  transportCache.set(adapter, transport);
  return transport;
}

/**
 * Speech is a conversation on one socket, so two phrases at once would interleave frames and the
 * station would read neither. The queue keeps the second request waiting its turn instead of
 * failing it.
 */
let speechQueue: Promise<unknown> = Promise.resolve();

export function speakWithAlice(
  adapter: StationAdapter,
  text: string,
  options: { timeoutMs?: number } = {},
): Promise<AliceSpeechResult> {
  const run = () => speakOnce(adapter, text, options);
  const next = speechQueue.then(run, run);
  speechQueue = next.catch(() => undefined);
  return next;
}

function estimateTimeout(text: string): number {
  // Alice speaks at roughly 14 characters per second; 75 ms per character plus a margin for the
  // cloud round trip keeps the upper bound above the actual playback time.
  return Math.min(180_000, Math.max(20_000, Math.ceil(text.length * 75) + 15_000));
}

function connectionProblem(stderr: string): string {
  if (/not found|No such file/i.test(stderr)) {
    return 'На станции не нашлось ни socat, ни nc — открыть локальный канал голоса Алисы нечем.';
  }
  if (/refused|unreachable|timed out|timeout|Cannot assign requested address/i.test(stderr)) {
    return 'Локальный канал голоса Алисы (127.0.0.1:9875) не отвечает: похоже, quasar ещё не запустился или прошивка не поддерживает озвучку по IPC.';
  }
  return stderr.trim().slice(0, 200);
}

async function speakOnce(
  adapter: StationAdapter,
  text: string,
  options: { timeoutMs?: number },
): Promise<AliceSpeechResult> {
  if (SPEECH_MARKUP.test(text)) {
    throw new AccError(
      'ALICE_TTS_MARKUP',
      'Станция не понимает SSML: она прочитает теги вслух. Интонацию задайте самим текстом — «?» поднимает голос, «!» делает громче, запятые и точки дают паузы.',
      400,
    );
  }
  const clean = prepareSpeech(text);
  if (!clean) throw new AccError('EMPTY_TEXT', 'Введите текст, который должна произнести Алиса', 400);
  if (clean.length > MAX_TEXT_LENGTH) {
    throw new AccError(
      'TEXT_TOO_LONG',
      `Алиса озвучивает до ${MAX_TEXT_LENGTH} символов за раз — сократите фразу.`,
      400,
    );
  }
  if (!adapter.streamExec) {
    throw new AccError(
      'ALICE_TTS_UNSUPPORTED',
      'Озвучка голосом Алисы работает только по SSH: панель должна сама открыть канал до станции.',
      501,
    );
  }
  const transport = await resolveTransport(adapter);
  if (!transport) {
    throw new AccError(
      'ALICE_TTS_NO_TOOL',
      'На станции нет ни socat, ни nc — открыть локальный канал голоса Алисы нечем.',
      501,
    );
  }
  const timeoutMs = options.timeoutMs ?? estimateTimeout(clean);
  const reader = new AliceFrameReader();
  let started = false;
  let completed = false;
  let aliceError = false;
  let protocolError = '';

  const result = await adapter.streamExec(TRANSPORT_COMMAND[transport], {
    timeoutMs,
    input: buildAliceFrames(clean),
    onStdout: (chunk) => {
      let events: AliceEvent[];
      try {
        events = reader.push(chunk);
      } catch (caught) {
        protocolError = caught instanceof Error ? caught.message : 'Колонка ответила не по протоколу озвучки.';
        return true;
      }
      for (const event of events) {
        if (event === 'started') started = true;
        else if (event === 'completed') {
          // TTS_COMPLETED and the idle state frame mean nothing until the speech has started.
          if (!started) continue;
          completed = true;
          return true;
        } else if (event === 'error') {
          aliceError = true;
          return true;
        }
      }
      return false;
    },
  }).catch((caught: unknown) => {
    if (caught instanceof AccError && caught.code === 'SSH_EXEC_FAILED') {
      throw new AccError(
        'ALICE_TTS_CHANNEL',
        `Не удалось открыть канал до голосового сервиса станции: ${caught.message}`,
        502,
      );
    }
    throw caught;
  });

  if (aliceError) {
    throw new AccError(
      'ALICE_TTS_ERROR',
      'Голосовой сервис станции вернул ошибку. Проверьте, что колонка привязана к аккаунту и онлайн.',
      502,
    );
  }
  if (protocolError) {
    throw new AccError('ALICE_TTS_PROTOCOL', protocolError, 502);
  }
  if (completed) {
    return {
      engine: 'alice',
      voice: 'Алиса',
      started,
      completed,
      durationMs: result.durationMs,
      transport,
    };
  }
  if (started) {
    // Alice confirmed the start, so the phrase is being spoken; the stream just ended (or the
    // upper bound hit) before the idle frame. Reporting an error here would be a lie.
    return {
      engine: 'alice',
      voice: 'Алиса',
      started,
      completed: false,
      durationMs: result.durationMs,
      transport,
    };
  }
  if (result.timedOut) {
    throw new AccError(
      'ALICE_TTS_TIMEOUT',
      `Алиса не подтвердила озвучку за ${Math.round(timeoutMs / 1000)} с. Проверьте, что колонка на связи и не разговаривает прямо сейчас.`,
      504,
    );
  }
  const detail = connectionProblem(result.stderr);
  throw new AccError(
    'ALICE_TTS_CLOSED',
    detail || 'Канал до голосового сервиса Алисы закрылся до подтверждения озвучки.',
    502,
  );
}

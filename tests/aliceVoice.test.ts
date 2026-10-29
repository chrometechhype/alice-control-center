import { describe, expect, it } from 'vitest';
import type { StationAdapter, StreamExecOptions, StreamExecResult } from '../server/adapters/StationAdapter.ts';
import { AliceFrameReader, buildAliceFrames, speakWithAlice } from '../server/aliceVoice.ts';

/** Frames produced by the reference implementation from alice-say.py, byte for byte. */
const REFERENCE_SUBSCRIBE = '2c000000e20f253a0f416c6963654361706162696c697479a201110a0f416c6963654361706162696c697479e80fd201';
const REFERENCE_FOR_A = '25000000e20f1e3a0f416c6963654361706162696c697479420b081218016a050a01411001e80fd201';

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest & 127) | 128);
    rest >>= 7;
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function integer(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)]);
}

function byteField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
}

/** What the station pushes back: envelope 253=3, remote 252, capability 18, event in field 1. */
function eventFrame(event: number): Buffer {
  const remote = byteField(18, integer(1, event));
  const envelope = Buffer.concat([byteField(252, remote), integer(253, 3)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(envelope.length, 0);
  return Buffer.concat([length, envelope]);
}

/** The speech-state frame captured from Plum: while Alice talks, `1=2` and the request record (10). */
function stateFrame(active: boolean): Buffer {
  const request = Buffer.concat([
    integer(1, active ? 2 : 0),
    integer(2, 3),
    integer(3, 6),
    byteField(4, Buffer.from('80b9194c-bab6-4836-a7c3-0d60c371e8a2')),
    byteField(5, Buffer.from('L11WH310098RTZ')),
  ]);
  const remote = Buffer.concat(
    active
      ? [integer(1, 2), integer(5, 1), byteField(10, request), integer(11, 1), integer(12, 0)]
      : [integer(1, 0), integer(5, 1), integer(11, 1), integer(12, 0)],
  );
  const envelope = Buffer.concat([byteField(252, remote), integer(253, 3)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(envelope.length, 0);
  return Buffer.concat([length, envelope]);
}

function replyFrame(): Buffer {
  const remote = byteField(7, Buffer.from('AliceCapability'));
  const envelope = Buffer.concat([byteField(252, remote), integer(253, 210)]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(envelope.length, 0);
  return Buffer.concat([length, envelope]);
}

function streamResult(patch: Partial<StreamExecResult> = {}): StreamExecResult {
  return { code: 0, stderr: '', durationMs: 5, timedOut: false, stopped: false, ...patch };
}

interface FakeAdapterOptions {
  toolOutput?: string;
  onSpeak?: (text: string, options: StreamExecOptions, frames: Buffer) => StreamExecResult | Promise<StreamExecResult>;
}

function fakeAdapter(options: FakeAdapterOptions = {}): StationAdapter {
  return {
    transport: 'ssh',
    async exec() {
      return {
        code: 0,
        stdout: `${options.toolOutput ?? 'socat'}\n`,
        stderr: '',
        durationMs: 1,
        timedOut: false,
        truncated: false,
      };
    },
    async streamExec(command: string, streamOptions: StreamExecOptions = {}) {
      const frames = streamOptions.input ?? Buffer.alloc(0);
      if (options.onSpeak) return options.onSpeak(command, streamOptions, frames);
      streamOptions.onStdout?.(eventFrame(6));
      streamOptions.onStdout?.(eventFrame(1));
      return streamResult({ stopped: true });
    },
  } as unknown as StationAdapter;
}

describe('buildAliceFrames', () => {
  it('matches the reference frames from alice-say.py byte for byte', () => {
    const expected = Buffer.concat([
      Buffer.from(REFERENCE_SUBSCRIBE, 'hex'),
      Buffer.from(REFERENCE_FOR_A, 'hex'),
    ]);
    expect(buildAliceFrames('A').equals(expected)).toBe(true);
  });

  it('sends the phrase as UTF-8 and subscribes before the request', () => {
    const frames = buildAliceFrames('Привет, Алиса!');
    const subscribeLength = frames.readUInt32LE(0);
    expect(subscribeLength).toBe(44);
    expect(frames.subarray(4, 4 + subscribeLength).includes(Buffer.from('AliceCapability'))).toBe(true);
    expect(frames.includes(Buffer.from('Привет, Алиса!', 'utf8'))).toBe(true);
  });
});

describe('AliceFrameReader', () => {
  it('reports started and completed events', () => {
    const reader = new AliceFrameReader();
    expect(reader.push(Buffer.concat([eventFrame(6), eventFrame(1)]))).toEqual([
      'started',
      'completed',
    ]);
  });

  it('keeps an unfinished frame between chunks', () => {
    const frame = eventFrame(1);
    const reader = new AliceFrameReader();
    expect(reader.push(frame.subarray(0, 3))).toEqual([]);
    expect(reader.push(frame.subarray(3, 9))).toEqual([]);
    expect(reader.push(frame.subarray(9))).toEqual(['completed']);
  });

  it('ignores echoes and unrelated replies', () => {
    const reader = new AliceFrameReader();
    expect(reader.push(Buffer.concat([replyFrame(), eventFrame(6)]))).toEqual(['started']);
  });

  it('reports Alice errors as their own event', () => {
    const reader = new AliceFrameReader();
    expect(reader.push(eventFrame(4))).toEqual(['error']);
  });

  it('reads the speech session when the firmware sends no TTS events', () => {
    const reader = new AliceFrameReader();
    expect(reader.push(Buffer.concat([stateFrame(false), stateFrame(true)]))).toEqual([
      'completed',
      'started',
    ]);
    expect(reader.push(stateFrame(false))).toEqual(['completed']);
  });

  it('ignores state frames once the firmware speaks in TTS events', () => {
    const reader = new AliceFrameReader();
    expect(reader.push(Buffer.concat([eventFrame(6), stateFrame(false)]))).toEqual(['started']);
  });

  it('rejects an impossible frame size', () => {
    const reader = new AliceFrameReader();
    const broken = Buffer.alloc(4);
    broken.writeUInt32LE(0x7fffffff, 0);
    expect(() => reader.push(broken)).toThrow(/размер кадра/);
  });
});

describe('speakWithAlice', () => {
  it('speaks through socat when the station has it', async () => {
    const commands: string[] = [];
    const adapter = fakeAdapter({
      onSpeak: (command, streamOptions, frames) => {
        commands.push(command);
        expect(frames.includes(Buffer.from('Проверка', 'utf8'))).toBe(true);
        streamOptions.onStdout?.(eventFrame(6));
        streamOptions.onStdout?.(eventFrame(1));
        return streamResult({ stopped: true, durationMs: 1500 });
      },
    });
    const speech = await speakWithAlice(adapter, 'Проверка');
    expect(commands[0]).toContain('socat STDIO TCP:127.0.0.1:9875');
    expect(speech).toMatchObject({
      engine: 'alice',
      voice: 'Алиса',
      started: true,
      completed: true,
      transport: 'socat',
    });
  });

  it('falls back to nc when socat is absent', async () => {
    const adapter = fakeAdapter({
      toolOutput: 'nc',
      onSpeak: (command, streamOptions) => {
        expect(command).toBe('nc 127.0.0.1 9875');
        streamOptions.onStdout?.(eventFrame(6));
        streamOptions.onStdout?.(eventFrame(1));
        return streamResult({ stopped: true });
      },
    });
    expect((await speakWithAlice(adapter, 'Привет')).transport).toBe('nc');
  });

  it('explains when neither socat nor nc exists', async () => {
    const adapter = fakeAdapter({ toolOutput: 'none' });
    await expect(speakWithAlice(adapter, 'Привет')).rejects.toMatchObject({
      code: 'ALICE_TTS_NO_TOOL',
    });
  });

  it('surfaces the station speech service error', async () => {
    const adapter = fakeAdapter({
      onSpeak: (_command, streamOptions) => {
        streamOptions.onStdout?.(eventFrame(4));
        return streamResult({ stopped: true });
      },
    });
    await expect(speakWithAlice(adapter, 'Привет')).rejects.toMatchObject({
      code: 'ALICE_TTS_ERROR',
    });
  });

  it('does not call silence a success when nothing was confirmed', async () => {
    const adapter = fakeAdapter({
      onSpeak: (_command, _options, _frames) => streamResult({ timedOut: true }),
    });
    await expect(speakWithAlice(adapter, 'Привет', { timeoutMs: 1000 })).rejects.toMatchObject({
      code: 'ALICE_TTS_TIMEOUT',
    });
  });

  it('finishes on the speech session when events never arrive', async () => {
    const adapter = fakeAdapter({
      onSpeak: (_command, streamOptions) => {
        streamOptions.onStdout?.(stateFrame(false));
        streamOptions.onStdout?.(stateFrame(true));
        streamOptions.onStdout?.(stateFrame(false));
        return streamResult({ stopped: true, durationMs: 1200 });
      },
    });
    await expect(speakWithAlice(adapter, 'Раз два три')).resolves.toMatchObject({
      engine: 'alice',
      voice: 'Алиса',
      started: true,
      completed: true,
      durationMs: 1200,
    });
  });

  it('keeps a started phrase a success even without the end of speech', async () => {
    const adapter = fakeAdapter({
      onSpeak: (_command, streamOptions) => {
        streamOptions.onStdout?.(stateFrame(true));
        return streamResult({ timedOut: true, durationMs: 20000 });
      },
    });
    await expect(speakWithAlice(adapter, 'Длинная фраза')).resolves.toMatchObject({
      started: true,
      completed: false,
    });
  });

  it('names the IPC port when it refuses the connection', async () => {
    const adapter = fakeAdapter({
      onSpeak: () =>
        streamResult({
          code: 1,
          stderr: 'socat[123] E connect(5, AF=2 127.0.0.1:9875, 16): Connection refused',
        }),
    });
    await expect(speakWithAlice(adapter, 'Привет')).rejects.toThrow(/127\.0\.0\.1:9875/);
  });

  it('serialises phrases so two requests never interleave on one socket', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = fakeAdapter({
      onSpeak: async (_command, streamOptions) => {
        order.push('start');
        await gate;
        order.push('end');
        streamOptions.onStdout?.(eventFrame(6));
        streamOptions.onStdout?.(eventFrame(1));
        return streamResult({ stopped: true });
      },
    });
    const first = speakWithAlice(adapter, 'раз');
    const second = speakWithAlice(adapter, 'два');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start', 'end', 'start', 'end']);
  });
});

import { describe, expect, it } from 'vitest';
import { isStationWav } from '../server/audioConvert.ts';
import { wavHeader } from '../src/lib/audioForStation.ts';

/**
 * On a phone the panel has no ffmpeg: the browser decodes the clip and writes this header itself, and
 * the backend then decides whether the station can play it. If the two disagree by one byte offset,
 * every sound on the phone fails with «не PCM16» and nothing in the code looks wrong.
 */
function pcm(seconds: number, channels: number, rate: number): Buffer {
  const samples = Math.floor(seconds * rate) * channels * 2;
  return Buffer.concat([Buffer.from(wavHeader(samples, channels, rate)), Buffer.alloc(samples)]);
}

describe('the WAV the phone writes for the station', () => {
  it('is accepted as station PCM by the backend', () => {
    expect(isStationWav(pcm(1, 2, 48_000))).toBe(true);
    expect(isStationWav(pcm(0.25, 1, 48_000))).toBe(true);
  });

  it('describes the payload it actually carries', () => {
    const head = pcm(2, 2, 48_000).subarray(0, 44);
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint32(28, true)).toBe(48_000 * 2 * 2);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint32(4, true)).toBe(36 + view.getUint32(40, true));
  });

  it('refuses the same file when it is not 16-bit PCM', () => {
    const float = pcm(1, 2, 48_000);
    float.writeUInt16LE(3, 20); // IEEE float instead of PCM
    expect(isStationWav(float)).toBe(false);

    expect(isStationWav(Buffer.from('RIFFJUNKWAVEsome text file that is not audio........'))).toBe(false);
  });
});

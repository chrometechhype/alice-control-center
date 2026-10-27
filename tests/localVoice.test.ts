import { describe, expect, it } from 'vitest';
import { encodeScript, speakScript, synthesizeLocally } from '../server/localVoice.ts';

describe('speakScript', () => {
  it('uses the method SpeechSynthesizer actually has', () => {
    const script = speakScript('/tmp/text.txt', '/tmp/out.wav');
    expect(script).toContain('SetOutputToWaveFile');
    // SetWaveFile does not exist and failed the first real run with MethodNotFound.
    expect(script).not.toMatch(/\.SetWaveFile\(/);
  });

  it('never puts spoken text into the command line', () => {
    expect(speakScript('/tmp/text.txt', '/tmp/out.wav')).toContain(
      "Get-Content -LiteralPath '/tmp/text.txt'",
    );
  });
});

describe('encodeScript', () => {
  it('round-trips through the UTF-16LE base64 -EncodedCommand expects', () => {
    expect(Buffer.from(encodeScript('Проверка'), 'base64').toString('utf16le')).toBe('Проверка');
  });
});

describe('synthesizeLocally', () => {
  it.skipIf(process.platform !== 'win32')(
    'speaks Russian text into a WAV the station card accepts',
    async () => {
      const speech = await synthesizeLocally('Проверка озвучки.');
      expect(speech.voice.length).toBeGreaterThan(0);
      expect(speech.audio.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(speech.audio.readUInt16LE(20)).toBe(1);
      expect(speech.audio.readUInt32LE(24)).toBe(48_000);
      expect(speech.audio.length).toBeGreaterThan(44);
    },
    90_000,
  );
});

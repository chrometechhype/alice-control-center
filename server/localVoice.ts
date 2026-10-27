import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AccError } from './errors.ts';
import { toStationWav } from './audioConvert.ts';

const execFileAsync = promisify(execFile);

const SPEAK_TIMEOUT_MS = 30_000;

/**
 * Alice's own voice is built in Yandex's cloud during her dialogue — the rooted firmware exposes no
 * local TTS the panel could feed arbitrary text to, so «скажи это голосом Алисы» is not something the
 * station can do offline. What it can do is hear a real Russian voice without any API key: Windows
 * ships an SAPI5 synthesiser (Microsoft Irina on a Russian system), and a station with no speech
 * provider is still a speaker.
 *
 * The text travels through a file, never through the command line: quoting survives the round trip
 * that way, and no user characters reach the shell.
 */
export function speakScript(textFile: string, waveFile: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Speech',
    '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled })',
    'if ($voices.Count -eq 0) { Write-Error "NO_VOICE"; exit 1 }',
    "$ru = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'ru*' } | Select-Object -First 1",
    'if ($null -eq $ru) { $ru = $voices[0] }',
    '$synth.SelectVoice($ru.VoiceInfo.Name)',
    `$text = (Get-Content -LiteralPath '${textFile}' -Raw -Encoding UTF8).Trim()`,
    `$synth.SetOutputToWaveFile('${waveFile}')`,
    '$synth.Speak($text)',
    '$synth.Dispose()',
    '$ru.VoiceInfo.Name',
  ].join('\n');
}

/** `-EncodedCommand` takes UTF-16LE base64, so the script never has to survive cmd quoting. */
export function encodeScript(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export interface LocalSpeech {
  audio: Buffer;
  voice: string;
}

export function localVoiceAvailable(): boolean {
  return process.platform === 'win32';
}

export async function synthesizeLocally(text: string): Promise<LocalSpeech> {
  if (!localVoiceAvailable()) {
    throw new AccError(
      'LOCAL_TTS_UNSUPPORTED',
      'Локальная озвучка доступна только на Windows, где есть голосовый движок системы.',
      500,
    );
  }
  const stamp = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  const textFile = path.join(os.tmpdir(), `acc-say-${stamp}.txt`);
  const waveFile = path.join(os.tmpdir(), `acc-say-${stamp}.wav`);
  try {
    fs.writeFileSync(textFile, text, { encoding: 'utf8', mode: 0o600 });
    const script = speakScript(textFile, waveFile);
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeScript(script)],
      { timeout: SPEAK_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    if (!fs.existsSync(waveFile)) {
      throw new AccError('LOCAL_TTS_FAILED', 'Системный голос не записал звук — проверьте, что в Windows установлен русский голосовой пакет.', 502);
    }
    // The card takes 48 kHz stereo; SAPI answers in 22 kHz mono, so the same ffmpeg path as the
    // library clips has to run or aplay will refuse the stream.
    const prepared = await toStationWav(fs.readFileSync(waveFile));
    // A voice with nothing to say still writes a WAV header, and the station plays that as
    // silence while the panel reports success — measured on a mangled request body.
    if (prepared.seconds < 0.3) {
      throw new AccError(
        'LOCAL_TTS_EMPTY',
        'Системный голос не произнёс ни звука — текст оказался нечитаемым для него.',
        502,
      );
    }
    return {
      audio: prepared.data,
      voice: stdout.trim().split('\n').filter(Boolean).at(-1) ?? 'Голос Windows',
    };
  } catch (caught) {
    if (caught instanceof AccError) throw caught;
    const message = caught instanceof Error ? caught.message : '';
    throw new AccError(
      'LOCAL_TTS_FAILED',
      /NO_VOICE/.test(message)
        ? 'В Windows нет установленного голосового пакета — озвучить текст нечем.'
        : `Системная озвучка не сработала: ${message.slice(0, 160)}`,
      502,
    );
  } finally {
    for (const file of [textFile, waveFile]) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // временный файл уже удалён — на результат не влияет
      }
    }
  }
}

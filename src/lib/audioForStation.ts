import { ApiError, api, errorMessage } from './api';

/**
 * The station's `aplay` has no plug layer: it only takes 16-bit PCM at 48 kHz stereo. On a computer
 * the backend converts with ffmpeg. A phone has no ffmpeg and no shell to run one, but the browser it
 * runs the panel in decodes mp3, ogg, opus, aac and flac in hardware — so the conversion happens here,
 * next to the person who pressed play, and the backend receives something it no longer has to decode.
 */
const TARGET_SAMPLE_RATE = 48_000;
const TARGET_CHANNELS = 2;
const MAX_SOURCE_BYTES = 24 * 1024 * 1024;

export interface StationPlayResult {
  player: string;
  seconds: number;
  converted: boolean;
  finished: boolean;
}

/** Mirrors `isStationWav` on the server: PCM16 inside a RIFF container is already what the card wants. */
async function isStationPcm(blob: Blob): Promise<boolean> {
  if (blob.size <= 44) return false;
  const raw = await blob.slice(0, 36).arrayBuffer();
  const view = new DataView(raw);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...new Uint8Array(raw.slice(offset, offset + length)));
  return (
    ascii(0, 4) === 'RIFF' &&
    ascii(8, 12) === 'WAVE' &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(34, true) === 16
  );
}

/**
 * The exact header the station's `aplay` and the backend's `isStationWav` both read. `byteLength` is
 * the size of the PCM that follows, so the RIFF length is that plus the 36 bytes after its own field.
 */
export function wavHeader(byteLength: number, channels: number, rate: number): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(44));
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, byteLength + 36, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, byteLength, true);
  return view.buffer;
}

/** Any audio the browser knows becomes a station-ready WAV; anything it cannot read is left alone. */
async function toStationPcm(blob: Blob): Promise<Blob> {
  if (blob.size > MAX_SOURCE_BYTES || (await isStationPcm(blob))) return blob;

  let decoded: AudioBuffer;
  try {
    // Decoding needs a context of its own: the length of the resampled output is only known after the
    // compressed file has been read, and an OfflineAudioContext is fixed in size before it renders.
    const reader = new AudioContext();
    decoded = await reader.decodeAudioData(await blob.arrayBuffer());
    reader.close();
  } catch {
    return blob;
  }

  const context = new OfflineAudioContext(
    TARGET_CHANNELS,
    Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE)),
    TARGET_SAMPLE_RATE,
  );
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.start(0);
  const rendered = await context.startRendering();

  const channels = rendered.numberOfChannels;
  const frames = rendered.length;
  const samples = new Int16Array(frames * channels);
  for (let channel = 0; channel < channels; channel += 1) {
    const plane = rendered.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      const value = Math.max(-1, Math.min(1, plane[frame]));
      samples[frame * channels + channel] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }
  }
  const pcm = new Int8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  return new Blob([wavHeader(samples.byteLength, channels, rendered.sampleRate), pcm], {
    type: 'audio/wav',
  });
}

/**
 * Plays a clip that lives on the station. The normal route converts with ffmpeg; when the answer is
 * that there is no ffmpeg, this is the second way round — the file comes to the browser, is decoded
 * there, and goes back as PCM.
 */
export async function playFromStation(remotePath: string): Promise<StationPlayResult> {
  try {
    return await api.post<StationPlayResult>('/audio/play', { path: remotePath }, 200_000);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'NO_FFMPEG') throw error;
    const download = await fetch(
      `/api/files/download?path=${encodeURIComponent(remotePath)}`,
      { credentials: 'same-origin' },
    );
    if (!download.ok) throw new ApiError({ code: 'DECODE_SOURCE_FAILED',
      message: `Звук не удалось забрать со станции: ${errorMessage(error)}` }, download.status);
    const prepared = await toStationPcm(await download.blob());
    const form = new FormData();
    form.append('file', new File([prepared], 'decoded.wav', { type: 'audio/wav' }));
    return await api.form<StationPlayResult>('/audio/play-decoded', form, 200_000);
  }
}

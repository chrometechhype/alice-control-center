/**
 * Shaping the text Alice is about to speak.
 *
 * The firmware has no SSML — tags are read out letter by letter — so punctuation is the only
 * prosody control the station has. Two things were breaking that in practice:
 *
 *  - a multi-sentence phrase went to the synthesiser as one long string, and only the very last
 *    mark survived: «Всё готово. Проверьте колонку!» came out flat, with the «!» and «?» lost;
 *  - technical words and paths were spelled out («си-аш-эс-эш», «слэш дата слэш саундс»), because
 *    the cloud voice does not know that `SSH` or `/data/sounds` are not Russian words.
 *
 * So the text is split into sentences — each becomes its own Append directive and gets its own
 * intonation — and every construct the voice misreads is replaced before it leaves the panel.
 */

export type SpeechMood = 'neutral' | 'calm' | 'brisk' | 'alert' | 'care';

export const SPEECH_MOODS: Array<{ id: SpeechMood; label: string }> = [
  { id: 'neutral', label: 'Как написано' },
  { id: 'calm', label: 'Спокойно' },
  { id: 'brisk', label: 'Бодро' },
  { id: 'alert', label: 'Тревожно' },
  { id: 'care', label: 'Заботливо' },
];

export const MOOD_LABELS: Record<SpeechMood, string> = {
  neutral: 'как написано',
  calm: 'спокойно',
  brisk: 'бодро',
  alert: 'тревожно',
  care: 'заботливо',
};

/** Author markup: `|` starts a new sentence, `||` trails the current one into a real pause. */
const PAUSE_MARK = /\|{1,2}/g;

/**
 * Words the cloud voice mispronounces. Values are written the way a Russian speaker reads them,
 * not as letters, because the synthesiser spells any run of Latin characters letter by letter.
 */
const PRONUNCIATION: Array<[RegExp, string]> = [
  [/\bWi-?Fi\b/gi, 'вай-фай'],
  [/\bSSH\b/g, 'эс-эс-эйч'],
  [/\bSSL\b/g, 'эс-эс-эль'],
  [/\bADB\b/g, 'эй-ди-би'],
  [/\bCPU\b/gi, 'процессор'],
  [/\bRAM\b/gi, 'память'],
  [/\bUSB\b/gi, 'ю-эс-би'],
  [/\bURL\b/gi, 'адрес'],
  [/\bJSON\b/gi, 'джисон'],
  [/\bOTA\b/gi, 'обновление по воздуху'],
  [/\bIP\b/g, 'ай-пи'],
  [/\bLAN\b/gi, 'локальной сети'],
  [/\bMAC\b/g, 'мак-адрес'],
  [/\bOK\b/gi, 'ок'],
  [/\bGT\b/i, 'больше'],
  [/\bLT\b/i, 'меньше'],
  [/\b°C\b/g, 'градуса Цельсия'],
  [/\b℃\b/g, 'градуса Цельсия'],
  [/\bdBm\b/gi, 'децибел'],
  [/\bMB\b/g, 'мегабайт'],
  [/\bKB\b/g, 'килобайт'],
  [/\bGB\b/g, 'гигабайт'],
];

/** Paths and file names read as a stream of slashes; say what they mean instead. */
const PATHS: Array<[RegExp, string]> = [
  [/\/data\/sounds\b/gi, 'в каталоге звуков'],
  [/\/data\/quasar\b/gi, 'в каталоге станции'],
  [/\/data\b/g, 'в каталоге данных'],
  [/\/system\/vendor\/quasar\b/gi, 'в системном каталоге станции'],
  [/\/bkupgrade\b/gi, 'в каталоге обновлений'],
  [/\/tmp\b/g, 'во временной папке'],
  [/\/[\w./-]+/g, 'по пути из настроек'],
];

const END_MARK = /[.!?…]/;

function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?=[^\s,;:\d])/g, '$1 ')
    .replace(/(.)([.!?…])(.)/g, (match, before: string, mark: string, after: string) =>
      // «42.5» is one number, not the end of a sentence — no space may appear inside it.
      mark === '.' && /\d/.test(before) && /\d/.test(after) ? match : `${before}${mark} ${after}`,
    )
    .trim();
}

function pronounce(text: string): string {
  let out = text;
  for (const [pattern, value] of PRONUNCIATION) out = out.replace(pattern, value);
  for (const [pattern, value] of PATHS) out = out.replace(pattern, value);
  // Guillemets and quotes are announced by some voices and dropped by others — the text reads
  // fine without them, so they go.
  return out.replace(/[«»"'“”‘’]/g, '');
}

/** Split into sentences; a fragment without a trailing mark still has to be spoken. */
function sentences(text: string): string[] {
  const chars = [...text];
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    current += char;
    if (!END_MARK.test(char)) continue;
    if (char === '.' && /\d/.test(chars[index - 1] ?? '') && /\d/.test(chars[index + 1] ?? '')) continue;
    parts.push(current);
    current = '';
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => tidy(part)).filter(Boolean);
}

/**
 * Mood is punctuation only — we never invent words the user did not ask for. Each preset changes
 * how the phrase ends and how hard the clauses are separated, which is all the synthesiser reacts
 * to: «?» lifts the voice, «!» makes it loud, «…» holds it open.
 */
function applyMood(parts: string[], mood: SpeechMood): string[] {
  if (!parts.length || mood === 'neutral') return parts;

  return parts.map((part, index) => {
    const body = part.replace(/[.!?…\s]+$/, '');
    const last = index === parts.length - 1;
    switch (mood) {
      case 'calm':
        return `${body.replace(/,\s+/g, '… ')}.`;
      case 'brisk':
        return last ? `${body}!` : `${body}.`;
      case 'alert':
        return `${body}!`;
      case 'care':
        return last ? `${body}…` : `${body}.`;
      default:
        return part;
    }
  });
}

export interface ShapedSpeech {
  /** One item per utterance; each carries its own ending mark, so each gets its own intonation. */
  segments: string[];
  /** Marks the voice would have read aloud, found and taken out on the way. */
  stripped: string[];
}

const SSML_MARKUP =
  /<\s*\/?\s*(?:speak|p|s|break|prosody|emphasis|sub|say-as|phoneme|voice|audio)\b[^>]*>/i;

export function shapeSpeech(text: string, mood: SpeechMood = 'neutral'): ShapedSpeech {
  const stripped: string[] = [];

  const cleaned = text.replace(PAUSE_MARK, (match) => {
    stripped.push(match);
    return match.length > 1 ? '… ' : '. ';
  });
  const safe = cleaned.replace(SSML_MARKUP, (match) => {
    stripped.push(match);
    return ' ';
  });

  const normalized = tidy(pronounce(safe.replace(/\.{3,}/g, '…')));
  if (!normalized) return { segments: [], stripped };

  return { segments: applyMood(sentences(normalized), mood), stripped };
}

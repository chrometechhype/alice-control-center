import { z } from 'zod';
import { SCENE_EFFECTS, type SceneEffect } from '../shared/types.ts';
import { AccError } from './errors.ts';

/**
 * Models are bad at emitting hundreds of raw RGB integers: the answer gets truncated by
 * max_tokens and the scene dies in validation. So the model only chooses an effect, a palette and
 * a few numbers, and the frames are computed here — deterministically and always loop-closed.
 */
export { SCENE_EFFECTS, type SceneEffect };

export const EFFECT_HINTS: Record<SceneEffect, string> = {
  solid: 'all zones one colour, no movement',
  gradient: 'still smooth colour gradient around the ring',
  sweep: 'the colour runs around the ring',
  pulse: 'the whole ring flashes and dims rhythmically',
  breathe: 'slow breathing between two colours',
  chase: 'a bright dot runs around the ring',
  sparkle: 'random segments twinkle',
  ripple: 'waves travel outward around the ring',
};

const RawSceneSchema = z.object({
  name: z.string().trim().min(1, 'Название сцены пустое').max(48, 'Название длиннее 48 символов'),
  fps: z.number({ error: 'fps должен быть числом' }).finite().min(1, 'Минимум 1 fps').max(60, 'Максимум 60 fps'),
  effect: z.enum(SCENE_EFFECTS, {
    error: `Движение кольца должно быть одним из: ${SCENE_EFFECTS.join(', ')}`,
  }),
  colors: z
    .array(z.string().min(4, 'Нужен HEX вроде #ff2d2d').max(40, 'Слишком длинный цвет'))
    .min(1, 'Нужен хотя бы один цвет')
    .max(6, 'Хватит и шести цветов'),
  frames: z
    .number({ error: 'Количество кадров — число' })
    .finite()
    .min(2, 'В сцене должно быть минимум 2 кадра')
    .max(64, 'Больше 64 кадров не нужно'),
  intensity: z.number({ error: 'Яркость — число' }).finite().min(0.1, 'Яркость меньше 0,1').max(1, 'Яркость больше 1'),
  reverse: z.boolean({ error: 'Движение в обратную сторону — да или нет' }),
});

// The keys without a fallback come first: if the answer is cut off by the token budget, the
// salvage still keeps an effect and a palette, and the panel fills in the rest.
export const SCENE_SPEC_EXAMPLE =
  '{"effect":"sweep","colors":["#2cb67d","#7f5af0","#4cc9f0"],"name":"Северное сияние","fps":10,"frames":18,"intensity":0.9,"reverse":false}';

export function sceneSystemPrompt(zones: number): string {
  return [
    'You design LED animations for a smart speaker light ring and answer with ONE JSON object only.',
    `The ring has ${zones} independent zones. Never output raw pixel frames: the program expands your recipe.`,
    'Exact JSON shape (no markdown, no comments, no extra keys):',
    SCENE_SPEC_EXAMPLE,
    `Allowed "effect" values: ${SCENE_EFFECTS.join(', ')}.`,
    `Meanings: ${SCENE_EFFECTS.map((effect) => `${effect} = ${EFFECT_HINTS[effect]}`).join('; ')}.`,
    'Hard rules:',
    '- The user description is the brief, not a suggestion: every colour, motion and tempo word in it must be obeyed. "красный" means red in your palette, "мигает" means effect "pulse", "бежит/крутится" means "sweep", "дышит" means "breathe", "искрит/звёзды" means "sparkle", "волны" means "ripple", "плавно/медленно" means fps 6..8, "быстро/резко" means fps 24..40.',
    '- If the description names a mood instead of a colour (тревога, авария, ошибка -> red; ночь, спокойствие -> deep blue/violet; праздник -> rainbow), choose colours that show that mood.',
    '- Never invent details the user forbade ("только зелёный" means one colour).',
    '- The example above only shows the shape. Write your own values, never repeat it and never start the object twice.',
    '- "colors" is 1..6 HEX strings like "#7f5af0". No color names, no arrays of numbers.',
    '- "frames" is 8..24 (number of animation steps, not pixels). "fps" is 4..40.',
    '- "intensity" is 0.4..1. "reverse" is true or false.',
    '- "name" is up to 24 characters in Russian, without quotes inside.',
    '- Pick fps and frames so the motion is smooth: slow colour travel 6..14 fps, flashing 20..40 fps.',
    '- The first frame must already be visible; the animation must loop back into it.',
    'Before answering, check silently: one object only, every key from the shape above and nothing else, numbers not strings, no trailing commas, no empty colours.',
    'Answer with JSON only. Do not explain anything. No markdown fences, no text before or after. Your very first character must be "{" and your very last must be "}".',
  ].join('\n');
}

export function sceneRepairPrompt(reason: string): string {
  return [
    `Твой предыдущий ответ не подошёл: ${reason}`,
    'Ответь ровно одним JSON-объектом по схеме, без пояснений и без кадров пикселей.',
    SCENE_SPEC_EXAMPLE,
  ].join('\n');
}

/** Words people actually type, mapped to what the ring can do. Checked in order, first hit wins. */
const INTENT_COLORS: Array<{ word: RegExp; colors: string[] }> = [
  { word: /радуг|радужн/i, colors: ['#ff2d2d', '#ff8b1f', '#ffd426', '#2cb67d', '#3a5bd9', '#7f5af0'] },
  { word: /огон|пламен|пожар|магм/i, colors: ['#ff2d2d', '#ff8b1f', '#ffd426'] },
  { word: /красн|багря|малин/i, colors: ['#ff2d2d'] },
  { word: /оранж|рыж/i, colors: ['#ff8b1f'] },
  { word: /жёлт|желт|золот|янтар/i, colors: ['#ffd426'] },
  { word: /зелен|зелён|изумруд/i, colors: ['#2cb67d'] },
  { word: /мят|бирюз|голуб|небес|океан|морск/i, colors: ['#4cc9f0'] },
  { word: /син|лазур|сапфир/i, colors: ['#3a5bd9'] },
  { word: /фиолет|сирен|пурпур|лило|маджента/i, colors: ['#7f5af0'] },
  { word: /роз|фукси|магент/i, colors: ['#ff5da2'] },
  { word: /бел|снеж|молочн/i, colors: ['#f2f2f2'] },
];

const INTENT_EFFECTS: Array<{ word: RegExp; effect: SceneEffect }> = [
  { word: /искр|звёзд|звезд|мерца|блеск|микра/i, effect: 'sparkle' },
  { word: /волн|ряб|накат/i, effect: 'ripple' },
  { word: /дыша|дыши|дыхан|вдыха|выдыха/i, effect: 'breathe' },
  { word: /мига|морг|блик|строб|пульс|сигнал|тревог|аварий/i, effect: 'pulse' },
  { word: /беж|круж|вращ|бегущ|спирал|карусел/i, effect: 'sweep' },
  { word: /градиент|перелив|перелива/i, effect: 'gradient' },
  { word: /ровн|статич|моностекло|просто горит/i, effect: 'solid' },
];

export interface SceneIntent {
  /** HEX strings in the order the user named them; empty when the description says nothing about colour. */
  colors: string[];
  effect: SceneEffect | null;
  speed: 'fast' | 'slow' | null;
}

/**
 * The model is the creative layer, the description is the contract: a free-text request that names
 * red and says "мигает" must come back red and flashing even when the model answered with violet and
 * a slow chase. So the words are read here and win over the model wherever they are decisive.
 */
export function parseSceneIntent(prompt: string): SceneIntent {
  const colors: string[] = [];
  for (const { word, colors: hex } of INTENT_COLORS) {
    if (!word.test(prompt)) continue;
    for (const value of hex) if (!colors.includes(value)) colors.push(value);
  }
  const effect = INTENT_EFFECTS.find(({ word }) => word.test(prompt))?.effect ?? null;
  let speed: SceneIntent['speed'] = null;
  if (/быстр|резк|стремит|срочно|молни|агресс/i.test(prompt)) speed = 'fast';
  else if (/медленн|плавн|спокойн|расслаб|неспеш/i.test(prompt)) speed = 'slow';
  return { colors: colors.slice(0, 6), effect, speed };
}

export interface PreparedScene {
  name: string;
  fps: number;
  frames: number[][][];
}

type Rgb = [number, number, number];

const clamp255 = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

function parseColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    const n = Number.parseInt(digits, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(text);
  if (rgb) return [clamp255(+rgb[1]), clamp255(+rgb[2]), clamp255(+rgb[3])];
  return null;
}

function toJsonObject(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Reads one object starting at `start`. Models cut off by the token budget often stop mid-answer,
 * so an unterminated object is repaired back to its last complete top-level pair instead of
 * being thrown away.
 */
function readObject(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastTopLevelComma = -1;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return toJsonObject(text.slice(start, i + 1));
      if (depth < 0) break;
    } else if (depth === 1 && char === ',') {
      lastTopLevelComma = i;
    }
  }
  return lastTopLevelComma > start ? toJsonObject(`${text.slice(start, lastTopLevelComma)}}`) : null;
}

/** Extracts the first JSON object from a chatty model answer. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  // Models restart the example mid-answer (`{"name":"{"name":"..."}`) or bury it in prose,
  // so every opening brace is tried until one yields a real object.
  let offset = 0;
  for (let attempts = 0; attempts < 12; attempts += 1) {
    const start = cleaned.indexOf('{', offset);
    if (start < 0) break;
    const object = readObject(cleaned, start);
    if (object) return object;
    offset = start + 1;
  }
  return null;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || 'сцена'}: ${issue.message}` : 'неизвестная ошибка';
}

function legacyFrames(object: Record<string, unknown>): number[][][] | null {
  if (!Array.isArray(object.frames)) return null;
  const frames: number[][][] = [];
  for (const frame of object.frames) {
    if (!Array.isArray(frame)) continue;
    const pixels = frame
      .filter((pixel): pixel is unknown[] => Array.isArray(pixel) && pixel.length >= 3)
      .map((pixel) => pixel.slice(0, 3).map((value) => clamp255(Number(value) || 0)));
    if (pixels.length) frames.push(pixels);
  }
  return frames.length >= 2 ? frames.slice(0, 64) : null;
}

/**
 * Turns a model answer into real frames. Returns null when the answer is not a scene at all so
 * the caller can retry once with a correction instead of failing on the first hiccup.
 * `prompt` is the user's own words: it names the scene if the model did not, and it overrules the
 * model wherever the request is explicit about colour, motion or tempo.
 */
export function buildScene(raw: string, zones: number, prompt: string): PreparedScene | null {
  const object = extractJsonObject(raw);
  if (!object) return null;

  const rawName = typeof object.name === 'string' ? object.name.trim() : '';
  const name = (rawName || prompt || 'Сцена ИИ').slice(0, 48);

  const legacy = legacyFrames(object);
  if (legacy) {
    const fps = Number.isFinite(Number(object.fps)) ? Number(object.fps) : 16;
    return {
      name,
      fps: Math.min(60, Math.max(1, Math.round(fps))),
      frames: normalize(legacy, zones),
    };
  }

  const parsed = RawSceneSchema.safeParse({
    name: rawName || 'Сцена ИИ',
    fps: 16,
    frames: 16,
    intensity: 0.9,
    reverse: false,
    ...object,
  });
  if (!parsed.success) {
    throw new AccError('AI_BAD_SCENE', `ИИ прислал сцену не по схеме — ${describeIssue(parsed.error)}`, 502);
  }
  const intent = parseSceneIntent(prompt);
  const spec = {
    ...parsed.data,
    name,
    colors: intent.colors.length ? intent.colors : parsed.data.colors,
    effect: intent.effect ?? parsed.data.effect,
    fps:
      intent.speed === 'fast'
        ? Math.max(parsed.data.fps, 24)
        : intent.speed === 'slow'
          ? Math.min(parsed.data.fps, 8)
          : parsed.data.fps,
  };
  const palette = spec.colors.map(parseColor).filter((color): color is Rgb => color !== null);
  if (!palette.length) {
    throw new AccError('AI_BAD_SCENE', 'ИИ прислал цвета в непонятном формате. Нужен HEX вроде "#7f5af0"', 502);
  }

  const frameCount = Math.max(2, Math.min(64, Math.round(spec.frames)));
  const frames: number[][][] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const phase = spec.reverse ? 1 - index / frameCount : index / frameCount;
    const frame: number[][] = [];
    for (let zone = 0; zone < zones; zone += 1) {
      const pixel = pixelFor(spec.effect, palette, zone, zones, phase, index);
      frame.push(scale(pixel, spec.intensity).map(clamp255));
    }
    frames.push(frame);
  }
  return { name, fps: Math.round(spec.fps), frames };
}

function normalize(frames: number[][][], zones: number): number[][][] {
  return frames.map((frame) =>
    Array.from({ length: zones }, (_, index) => [...(frame[index % frame.length] ?? [0, 0, 0])]),
  );
}

function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
}

/** Samples a cyclic palette at position t in 0..1. */
function paletteAt(palette: Rgb[], t: number): Rgb {
  if (palette.length === 1) return palette[0];
  const wrapped = ((t % 1) + 1) % 1;
  const scaled = wrapped * palette.length;
  const index = Math.floor(scaled);
  return mix(palette[index % palette.length], palette[(index + 1) % palette.length], scaled - index);
}

function scale(color: Rgb, gain: number): Rgb {
  return [color[0] * gain, color[1] * gain, color[2] * gain];
}

/** Stable hash so "sparkle" looks the same on every regeneration of the same scene. */
function hash(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b9, 2654435761) ^ Math.imul(b + 0x85ebca6b, 1597334677);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

const wave = (t: number) => (Math.sin(2 * Math.PI * t) + 1) / 2;

function pixelFor(effect: SceneEffect, palette: Rgb[], zone: number, zones: number, phase: number, frameIndex: number): Rgb {
  const position = zones <= 1 ? 0 : zone / zones;
  switch (effect) {
    case 'solid':
      return palette[0];
    case 'gradient':
      return paletteAt(palette, position);
    case 'sweep':
      return paletteAt(palette, position + phase);
    case 'pulse':
      return scale(paletteAt(palette, position), 0.12 + 0.88 * wave(phase));
    case 'breathe': {
      const breath = wave(phase);
      return scale(mix(palette[0], palette[Math.min(1, palette.length - 1)], breath), 0.3 + 0.7 * breath);
    }
    case 'chase': {
      const head = phase * zones;
      const behind = (((head - position * zones) % zones) + zones) % zones;
      const tail = Math.max(0, 1 - behind / Math.max(2, zones / 3));
      return scale(paletteAt(palette, position), 0.1 + 0.9 * tail * tail);
    }
    case 'ripple': {
      const distance = Math.min(position, 1 - position);
      return scale(paletteAt(palette, position + phase), 0.15 + 0.85 * wave(distance * 3 - phase));
    }
    case 'sparkle': {
      const twinkle = hash(zone, frameIndex);
      return scale(paletteAt(palette, hash(zone, frameIndex + 7)), twinkle > 0.55 ? 0.25 + 0.75 * twinkle : 0.1);
    }
    default:
      return palette[0];
  }
}

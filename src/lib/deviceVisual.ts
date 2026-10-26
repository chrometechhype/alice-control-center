import { ref } from 'vue';
import type { DeviceInfo } from '@shared/types';

export type StationKind =
  | 'lite2'
  | 'lite'
  | 'mini'
  | 'mini-pro'
  | 'mini-clock'
  | 'mini-old'
  | 'max'
  | 'station2'
  | 'station3'
  | 'duo-max'
  | 'midi'
  | 'street'
  | 'generic';

export type Lite2Color = 'violet' | 'pink' | 'blue' | 'coral' | 'green' | 'gray';

export interface StationLook {
  color: Lite2Color;
  clock: boolean;
}

export const LITE2_COLORS: Array<{ id: Lite2Color; label: string; adj: string; hex: string; soft: string }> = [
  { id: 'green', label: 'Зелёный', adj: 'зелёная', hex: '#35b978', soft: '#d4f3e4' },
  { id: 'violet', label: 'Лавандовый', adj: 'лавандовая', hex: '#7b7cff', soft: '#e2e2ff' },
  { id: 'blue', label: 'Синий', adj: 'синяя', hex: '#4d8df6', soft: '#d6e6ff' },
  { id: 'pink', label: 'Розовый', adj: 'розовая', hex: '#ff6f9c', soft: '#ffdde8' },
  { id: 'coral', label: 'Коралловый', adj: 'коралловая', hex: '#ff7a5c', soft: '#ffe0d8' },
  { id: 'gray', label: 'Серый', adj: 'серая', hex: '#8d97a3', soft: '#e4e8ec' },
];

const LOOK_KEY = 'acc-station-look';
const DEFAULT_LOOK: StationLook = { color: 'green', clock: false };

function readLook(): StationLook {
  try {
    const raw = globalThis.localStorage?.getItem(LOOK_KEY);
    if (!raw) return { ...DEFAULT_LOOK };
    const parsed = JSON.parse(raw) as Partial<StationLook>;
    const color = LITE2_COLORS.some((item) => item.id === parsed.color) ? (parsed.color as Lite2Color) : DEFAULT_LOOK.color;
    return { color, clock: Boolean(parsed.clock) };
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

export const stationLook = ref<StationLook>(readLook());

export function setStationLook(patch: Partial<StationLook>): void {
  stationLook.value = { ...stationLook.value, ...patch };
  try {
    globalThis.localStorage?.setItem(LOOK_KEY, JSON.stringify(stationLook.value));
  } catch {
    // приватный режим браузера — вид останется до перезагрузки
  }
}

export function resetStationLook(): void {
  stationLook.value = { ...DEFAULT_LOOK };
  try {
    globalThis.localStorage?.removeItem(LOOK_KEY);
  } catch {
    // ignore
  }
}

export interface DeviceVisual {
  kind: StationKind;
  label: string;
  family: string;
  tagline: string;
  accent: string;
  accentSoft: string;
  image: string | null;
}

const VISUALS: Record<StationKind, Omit<DeviceVisual, 'kind'>> = {
  lite2: {
    label: 'Станция Лайт 2',
    family: 'Лайт',
    tagline: 'компактная колонка без часов',
    accent: '#35b978',
    accentSoft: '#d4f3e4',
    image: '/devices/lite2-green.webp',
  },
  lite: {
    label: 'Станция Лайт',
    family: 'Лайт',
    tagline: 'первая Лайт с Алисой',
    accent: '#8f7bff',
    accentSoft: '#e8e1ff',
    image: '/devices/lite.webp',
  },
  mini: {
    label: 'Станция Мини 3',
    family: 'Мини',
    tagline: 'маленькая колонка с Алисой',
    accent: '#a06bff',
    accentSoft: '#ecddff',
    image: '/devices/mini.webp',
  },
  'mini-pro': {
    label: 'Станция Мини 3 Про',
    family: 'Мини',
    tagline: 'Мини с экраном и часами',
    accent: '#598cff',
    accentSoft: '#dbe7ff',
    image: '/devices/mini-pro.webp',
  },
  'mini-clock': {
    label: 'Станция Мини с часами',
    family: 'Мини',
    tagline: 'небольшая колонка с дисплеем',
    accent: '#7d8794',
    accentSoft: '#e2e6ea',
    image: '/devices/mini-clock.webp',
  },
  'mini-old': {
    label: 'Станция Мини',
    family: 'Мини',
    tagline: 'первая Мини с Алисой',
    accent: '#8d97a3',
    accentSoft: '#e4e8ec',
    image: '/devices/mini-old.webp',
  },
  max: {
    label: 'Станция Макс',
    family: 'Макс',
    tagline: 'громкая станция с Алисой',
    accent: '#8a6cff',
    accentSoft: '#e5defe',
    image: '/devices/max.webp',
  },
  station2: {
    label: 'Станция 2',
    family: 'Станция',
    tagline: 'объёмный звук и Zigbee',
    accent: '#1aab6b',
    accentSoft: '#d2f3e2',
    image: '/devices/station2.webp',
  },
  station3: {
    label: 'Станция 3',
    family: 'Станция',
    tagline: 'станция с эмбиент-подсветкой',
    accent: '#7b61ff',
    accentSoft: '#e3ddff',
    image: '/devices/station3.webp',
  },
  'duo-max': {
    label: 'Станция Дуо Макс',
    family: 'Станция',
    tagline: 'поворотный Full HD экран',
    accent: '#4f7dff',
    accentSoft: '#dbe4ff',
    image: '/devices/duo-max.webp',
  },
  midi: {
    label: 'Станция Миди',
    family: 'Станция',
    tagline: 'компактная станция с экраном',
    accent: '#1fae8a',
    accentSoft: '#d1f4ea',
    image: '/devices/midi.webp',
  },
  street: {
    label: 'Станция Стрит',
    family: 'Станция',
    tagline: 'портативная станция с Алисой',
    accent: '#e0843a',
    accentSoft: '#ffe4ce',
    image: '/devices/street.webp',
  },
  generic: {
    label: 'Яндекс Станция',
    family: 'Станция',
    tagline: 'умная колонка с Алисой',
    accent: '#ff7a2f',
    accentSoft: '#ffd9c7',
    image: null,
  },
};

export function detectDeviceVisual(info: DeviceInfo | null | undefined): DeviceVisual {
  const haystack = `${info?.modelGuess ?? ''} ${info?.modelRaw ?? ''} ${info?.hostname ?? ''}`.toLowerCase();
  let kind: StationKind = 'generic';
  if (/лайт\s*2|lite\s*2|lite-gen2|prune|\bplum\b/.test(haystack)) kind = 'lite2';
  else if (/дуо\s*макс|duo\s*max|duo-max/.test(haystack)) kind = 'duo-max';
  else if (/станция\s*3|station\s*3|station-gen3|station3/.test(haystack)) kind = 'station3';
  else if (/станция\s*2|station\s*2|station-gen2|station2|stereo/.test(haystack)) kind = 'station2';
  else if (/мини\s*3\s*про|mini\s*3\s*pro|mini-gen3-pro|mini-pro/.test(haystack)) kind = 'mini-pro';
  else if (/мини[\s\S]*час|mini[\s\S]*clock/.test(haystack)) kind = 'mini-clock';
  else if (/мини\s*3|mini\s*3|mini-gen3/.test(haystack)) kind = 'mini';
  else if (/миди|midi/.test(haystack)) kind = 'midi';
  else if (/стрит|street/.test(haystack)) kind = 'street';
  else if (/макс|\bmax\b/.test(haystack)) kind = 'max';
  else if (/мини|mini/.test(haystack)) kind = 'mini-old';
  else if (/лайт|lite/.test(haystack)) kind = 'lite';
  if (kind === 'lite2') {
    const look = stationLook.value;
    const color = LITE2_COLORS.find((item) => item.id === look.color) ?? LITE2_COLORS[0];
    return {
      kind,
      ...VISUALS.lite2,
      tagline: `${color.adj}, ${look.clock ? 'с часами' : 'без часов'}`,
      accent: color.hex,
      accentSoft: color.soft,
      image: `/devices/lite2-${color.id}${look.clock ? '-clock' : ''}.webp`,
    };
  }
  return { kind, ...VISUALS[kind] };
}

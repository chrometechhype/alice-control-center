import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.ts';

/**
 * «Выключить» left the ring dark with no way back: the trigger was cleared, the colours were gone
 * and nothing remembered what the ring looked like. So the panel keeps the last colours it wrote and
 * whether it switched the ring off; "on" is then an honest restore, not a guess.
 */
export interface LedState {
  /** Colours last written to the ring, one [r, g, b] per zone; null when ACC never applied any. */
  colors: number[][] | null;
  /** False means ACC switched the ring off — native trigger cleared, brightness zero. */
  on: boolean;
}

const stateFile = path.join(dataDir, 'led-state.json');

let state: LedState | null = null;

function load(): LedState {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<LedState>;
    const colors = Array.isArray(raw.colors)
      ? raw.colors.filter(
          (color): color is number[] =>
            Array.isArray(color) && color.length === 3 && color.every((value) => Number.isFinite(value)),
        )
      : null;
    state = { colors: colors?.length ? colors : null, on: raw.on !== false };
  } catch {
    state = { colors: null, on: true };
  }
  return state;
}

export function ledState(): LedState {
  return { ...load(), colors: load().colors ? load().colors!.map((color) => [...color]) : null };
}

export function rememberColors(colors: number[][], on = true): void {
  const next: LedState = { colors: colors.map((color) => [...color]), on };
  state = next;
  write(next);
}

/** Puts back a whole remembered state — used when «Сброс» restores the point saved before an effect. */
export function rememberState(next: LedState): void {
  const copy: LedState = {
    colors: next.colors ? next.colors.map((color) => [...color]) : null,
    on: next.on,
  };
  state = copy;
  write(copy);
}

export function rememberOff(): void {
  const current = load();
  const next: LedState = { colors: current.colors, on: false };
  state = next;
  write(next);
}

export function rememberNative(): void {
  const next: LedState = { colors: null, on: true };
  state = next;
  write(next);
}

function write(next: LedState): void {
  try {
    fs.writeFileSync(stateFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    // The station still holds the colours; losing the local copy only costs the "on" shortcut.
  }
}

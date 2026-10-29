import { beforeEach, describe, expect, it } from 'vitest';
import type { DeviceInfo } from '../shared/types.ts';
import {
  LITE2_COLORS,
  detectDeviceVisual,
  resetStationLook,
  setStationLook,
  stationLook,
} from '../src/lib/deviceVisual.ts';

function device(hostname: string, modelGuess = '', modelRaw = ''): DeviceInfo {
  return {
    hostname,
    modelRaw,
    modelGuess,
    firmware: '0.372.1.13',
    quasarVersion: '2.0.21',
    kernel: '4.9.113',
    arch: 'aarch64',
    os: 'Buildroot',
    cpuModel: 'Amlogic',
    cpuCores: 4,
    totalMemBytes: 256 * 1024 * 1024,
    uptimeSec: 1000,
    collectedAt: Date.now(),
  };
}

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
    configurable: true,
  });
  resetStationLook();
});

describe('detectDeviceVisual', () => {
  it('recognizes the actual Lite 2 by hostname and model', () => {
    const visual = detectDeviceVisual(device('Yandex-Lite-gen2-TEST', 'Станция Лайт 2', 'Yandex Prune EVT2'));
    expect(visual.kind).toBe('lite2');
    expect(visual.label).toBe('Станция Лайт 2');
    expect(visual.image).toBe('/devices/lite2-green.webp');
  });

  it('recognizes the Lite 2 codename alone', () => {
    expect(detectDeviceVisual(device('station', 'Yandex Prune EVT2')).kind).toBe('lite2');
  });

  it('distinguishes Mini 3 Pro, Mini with clock, and Mini 3', () => {
    expect(detectDeviceVisual(device('a', 'Станция Мини 3 Про')).kind).toBe('mini-pro');
    expect(detectDeviceVisual(device('a', 'Станция Мини с часами')).kind).toBe('mini-clock');
    expect(detectDeviceVisual(device('a', 'Станция Мини 3')).kind).toBe('mini');
  });

  it('no longer shows a Mini 2 as the first Mini', () => {
    const clock = detectDeviceVisual(device('a', 'Станция Мини 2 с часами'));
    expect(clock.kind).toBe('mini2-clock');
    expect(clock.label).toBe('Станция Мини 2 с часами');
    expect(clock.image).toBe('/devices/mini-clock.webp');

    const plain = detectDeviceVisual(device('a', 'Станция Мини 2'));
    expect(plain.kind).toBe('mini2');
    expect(plain.label).toBe('Станция Мини 2');
    expect(plain.tagline).not.toContain('первая');
  });

  it('reads the Mini 2 look from the raw model string too', () => {
    expect(detectDeviceVisual(device('yandex-station', 'Yandex Mini 2 with clock')).kind).toBe('mini2-clock');
    expect(detectDeviceVisual(device('yandex-station', 'yandex_station_mini_2')).kind).toBe('mini2');
  });

  it('checks Station 3 before Station 2 and Duo Max before both', () => {
    expect(detectDeviceVisual(device('a', 'Станция 3')).kind).toBe('station3');
    expect(detectDeviceVisual(device('a', 'Станция 2')).kind).toBe('station2');
    expect(detectDeviceVisual(device('a', 'Станция Дуо Макс')).kind).toBe('duo-max');
  });

  it('detects Max, first Lite, and unknown devices', () => {
    expect(detectDeviceVisual(device('a', 'Станция Макс')).kind).toBe('max');
    expect(detectDeviceVisual(device('a', 'Станция Лайт')).kind).toBe('lite');
    const generic = detectDeviceVisual(device('a', 'Неизвестное устройство'));
    expect(generic.kind).toBe('generic');
    expect(generic.image).toBeNull();
  });

  it('handles a missing device', () => {
    expect(detectDeviceVisual(null).kind).toBe('generic');
  });
});

describe('Lite 2 look customization', () => {
  it('starts green without a clock', () => {
    const visual = detectDeviceVisual(device('Yandex-Lite-gen2-TEST', 'Станция Лайт 2'));
    expect(visual.image).toBe('/devices/lite2-green.webp');
    expect(visual.tagline).toBe('зелёная, без часов');
    expect(visual.accent).toBe('#35b978');
  });

  it('switches to an official clock render and updates the accent', () => {
    setStationLook({ color: 'blue', clock: true });
    const visual = detectDeviceVisual(device('Yandex-Lite-gen2-TEST', 'Станция Лайт 2'));
    expect(visual.image).toBe('/devices/lite2-blue-clock.webp');
    expect(visual.tagline).toBe('синяя, с часами');
    expect(visual.accent).toBe('#4d8df6');
    expect(JSON.parse(storage.get('acc-station-look') ?? '{}')).toEqual({
      color: 'blue',
      clock: true,
    });
  });

  it('exposes every color with a distinct render', () => {
    const images = new Set<string>();
    for (const color of LITE2_COLORS) {
      setStationLook({ color: color.id });
      const visual = detectDeviceVisual(device('a', 'Станция Лайт 2'));
      expect(visual.image).not.toMatch(/undefined/);
      images.add(visual.image!);
    }
    expect(images.size).toBe(LITE2_COLORS.length);
  });

  it('resets to the default look and clears storage', () => {
    setStationLook({ color: 'pink', clock: true });
    resetStationLook();
    expect(stationLook.value).toEqual({ color: 'green', clock: false });
    expect(storage.has('acc-station-look')).toBe(false);
  });
});

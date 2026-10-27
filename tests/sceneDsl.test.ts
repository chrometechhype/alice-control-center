import { describe, expect, it } from 'vitest';
import { buildScene, extractJsonObject } from '../server/sceneDsl.ts';

const ZONES = 12;

function spec(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'Сияние',
    fps: 10,
    effect: 'sweep',
    colors: ['#2cb67d', '#7f5af0'],
    frames: 16,
    intensity: 0.9,
    reverse: false,
    ...overrides,
  });
}

describe('extractJsonObject', () => {
  it('takes the object out of markdown and chatter', () => {
    expect(extractJsonObject('Вот сцена:\n```json\n{"effect":"pulse"}\n```\nГотово')).toEqual({ effect: 'pulse' });
  });

  it('returns null without an object', () => {
    expect(extractJsonObject('я не умею в JSON')).toBeNull();
  });

  it('repairs an answer cut off by the token budget', () => {
    const truncated = '{"name":"Дождь","fps":15,"effect":"sparkle","colors":["#1e3a8a","#ffffff"],"frames":1';
    expect(extractJsonObject(truncated)).toEqual({
      name: 'Дождь',
      fps: 15,
      effect: 'sparkle',
      colors: ['#1e3a8a', '#ffffff'],
    });
  });

  it('stops at the first object even if the model keeps talking', () => {
    expect(extractJsonObject('{"effect":"pulse"}\nПотом ещё {"effect":"ripple"}')).toEqual({ effect: 'pulse' });
  });

  it('survives a model that restarts the example halfway through', () => {
    const doubled = '{"name":"{"name":"Дождь","fps":20,"effect":"sparkle","colors":["#1e90ff"],"frames":12}';
    expect(extractJsonObject(doubled)).toEqual({
      name: 'Дождь',
      fps: 20,
      effect: 'sparkle',
      colors: ['#1e90ff'],
      frames: 12,
    });
  });
});

describe('buildScene', () => {
  it('expands a recipe into one frame per step with exactly N zones', () => {
    const scene = buildScene(spec(), ZONES, 'запрос');
    expect(scene).not.toBeNull();
    expect(scene?.name).toBe('Сияние');
    expect(scene?.fps).toBe(10);
    expect(scene?.frames).toHaveLength(16);
    for (const frame of scene?.frames ?? []) {
      expect(frame).toHaveLength(ZONES);
      for (const pixel of frame) {
        expect(pixel).toHaveLength(3);
        for (const value of pixel) {
          expect(Number.isInteger(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('accepts a legacy raw-frame answer', () => {
    const scene = buildScene(
      JSON.stringify({ name: 'Старая', fps: 20, frames: [[[255, 0, 0]], [[0, 255, 0]]] }),
      ZONES,
      'запрос',
    );
    expect(scene?.frames).toHaveLength(2);
    expect(scene?.frames[0]).toHaveLength(ZONES);
    expect(scene?.frames[0]?.[0]).toEqual([255, 0, 0]);
    expect(scene?.fps).toBe(20);
  });

  it('fills missing defaults instead of failing', () => {
    const scene = buildScene('{"effect":"solid","colors":["#ff0000"]}', ZONES, 'красный');
    expect(scene?.name).toBe('красный');
    expect(scene?.fps).toBe(16);
    expect(scene?.frames).toHaveLength(16);
    expect(scene?.frames[0]?.[0]).toEqual([230, 0, 0]);
  });

  it('keeps every effect loopable and lit', () => {
    for (const effect of ['solid', 'gradient', 'sweep', 'pulse', 'breathe', 'chase', 'sparkle', 'ripple']) {
      const scene = buildScene(spec({ effect }), ZONES, 'тест');
      expect(scene?.frames.length, effect).toBe(16);
      const brightest = Math.max(...(scene?.frames.flat() ?? []).flat());
      expect(brightest, `${effect} не должна быть чёрной`).toBeGreaterThan(20);
    }
  });

  it('is deterministic for the same recipe', () => {
    expect(buildScene(spec({ effect: 'sparkle' }), ZONES, 'тест')?.frames).toEqual(
      buildScene(spec({ effect: 'sparkle' }), ZONES, 'тест')?.frames,
    );
  });

  it('reverse mirrors the direction of travel', () => {
    const forward = buildScene(spec({ effect: 'chase', frames: 8 }), ZONES, 'тест');
    const backward = buildScene(spec({ effect: 'chase', frames: 8, reverse: true }), ZONES, 'тест');
    expect(forward?.frames).not.toEqual(backward?.frames);
  });

  it('rejects colours the renderer cannot use', () => {
    expect(() => buildScene(spec({ colors: ['красный'] }), ZONES, 'тест')).toThrow(/HEX/);
  });

  it('rejects an unknown effect', () => {
    expect(() => buildScene(spec({ effect: 'disco' }), ZONES, 'тест')).toThrow(/effect/);
  });

  it('gives up quietly when the answer holds no JSON', () => {
    expect(buildScene('Конечно! Вот твоя сцена, она будет прекрасна.', ZONES, 'тест')).toBeNull();
  });

  it('salvages a scene from an answer cut off mid-way', () => {
    const scene = buildScene(
      'Размышляю. {"name":"Дождь","fps":15,"effect":"ripple","colors":["#1e3a8a","#4cc9f0"],"frames":1',
      ZONES,
      'дождь по кольцу',
    );
    expect(scene?.name).toBe('Дождь');
    expect(scene?.fps).toBe(15);
    expect(scene?.frames).toHaveLength(16);
  });
});

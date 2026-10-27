import { describe, expect, it } from 'vitest';
import { buildScenario, describeStep } from '../server/scenarioDsl.ts';
import { AccError } from '../server/errors.ts';

function json(value: Record<string, unknown>) {
  return JSON.stringify(value);
}

describe('buildScenario', () => {
  it('turns a model answer into ordered steps', () => {
    const built = buildScenario(
      json({
        name: 'Авария',
        steps: [
          { kind: 'led', effect: 'pulse', colors: ['#ff2d2d'], fps: 26, seconds: 4 },
          { kind: 'say', text: 'Ошибка. Ошибка. Ошибка.' },
        ],
      }),
      'мигает красным и говорит ошибка',
    );
    expect(built?.name).toBe('Авария');
    expect(built?.steps.map((step) => step.kind)).toEqual(['led', 'say']);
  });

  it('gives up quietly when the answer holds no JSON', () => {
    expect(buildScenario('я не понял задание', 'тест')).toBeNull();
  });

  it('refuses steps the model has no business choosing', () => {
    const raw = json({ name: 'Хитрость', steps: [{ kind: 'sound', path: '/etc/shadow' }] });
    expect(() => buildScenario(raw, 'тест')).toThrowError(AccError);
    try {
      buildScenario(raw, 'тест');
    } catch (error) {
      expect((error as AccError).code).toBe('AI_BAD_SCENARIO');
    }
  });

  it('keeps a show short enough to watch', () => {
    const built = buildScenario(
      json({ name: 'Долго', steps: [{ kind: 'led', effect: 'sweep', colors: ['#4cc9f0'], fps: 8, seconds: 90 }] }),
      'бежит по кругу',
    );
    const step = built?.steps[0];
    expect(step?.kind === 'led' && step.seconds).toBe(20);
  });

  it('obeys colour, motion and tempo words when the model ignored them', () => {
    const built = buildScenario(
      json({
        name: 'Что-то',
        steps: [{ kind: 'led', effect: 'chase', colors: ['#7f5af0'], fps: 6, seconds: 5 }],
      }),
      'мигает красным очень быстро',
    );
    const step = built?.steps[0];
    expect(step?.kind === 'led' && step.effect).toBe('pulse');
    expect(step?.kind === 'led' && step.colors).toEqual(['#ff2d2d']);
    expect(step?.kind === 'led' && step.fps).toBeGreaterThanOrEqual(24);
  });

  it('leaves a multi-colour plan alone', () => {
    const built = buildScenario(
      json({
        name: 'Светофор',
        steps: [
          { kind: 'led', effect: 'solid', colors: ['#2cb67d'], fps: 6, seconds: 2 },
          { kind: 'led', effect: 'solid', colors: ['#ffd426'], fps: 6, seconds: 2 },
          { kind: 'led', effect: 'solid', colors: ['#ff2d2d'], fps: 6, seconds: 2 },
        ],
      }),
      'потом красным',
    );
    const colors = (built?.steps ?? []).map((step) => (step.kind === 'led' ? step.colors[0] : ''));
    expect(colors).toEqual(['#2cb67d', '#ffd426', '#ff2d2d']);
  });

  it('rejects an answer cut off inside a step so the route can ask for a repair', () => {
    expect(() => buildScenario('{"name":"Привет","steps":[{"kind":"say","text":"При', 'скажи привет')).toThrowError(AccError);
  });

  it('describes a step the way the journal shows it', () => {
    expect(describeStep({ kind: 'say', text: 'Привет, хозяин' })).toBe('Сказать «Привет, хозяин»');
    expect(describeStep({ kind: 'pause', seconds: 2 })).toBe('Пауза 2 с');
  });
});

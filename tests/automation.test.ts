import { describe, expect, it } from 'vitest';
import { migrateScenario, planStepGroups } from '../server/automation.ts';
import { stepSchema } from '../server/scenarioDsl.ts';
import type { AutomationScenario } from '../shared/types.ts';

const base = {
  id: 'scn-1',
  name: 'Старый',
  enabled: true,
  trigger: 'device.connect' as const,
  cooldownSec: 60,
};

describe('migrateScenario', () => {
  it('reads a legacy notification action as one step', () => {
    const migrated = migrateScenario({ ...base, action: { type: 'notify', value: 'Колонка на связи' } });
    expect(migrated.steps).toEqual([{ kind: 'notify', text: 'Колонка на связи' }]);
    expect(migrated).not.toHaveProperty('action');
  });

  it('reads a legacy diagnostic action as one step', () => {
    const migrated = migrateScenario({ ...base, action: { type: 'diagnostic' } });
    expect(migrated.steps).toEqual([{ kind: 'diagnostic' }]);
  });

  it('keeps scenarios that already have steps', () => {
    const steps: AutomationScenario['steps'] = [
      { kind: 'led', effect: 'pulse', colors: ['#ff2d2d'], fps: 24, seconds: 3 },
      { kind: 'say', text: 'Ошибка' },
    ];
    expect(migrateScenario({ ...base, steps, action: { type: 'notify', value: 'старое' } }).steps).toEqual(steps);
  });

  it('leaves a scenario with neither action nor steps empty instead of inventing work', () => {
    expect(migrateScenario({ ...base }).steps).toEqual([]);
  });
});

describe('simultaneous steps', () => {
  const say = (text: string): AutomationScenario['steps'][number] => ({ kind: 'say', text });

  it('runs unlinked steps one at a time, in order', () => {
    expect(planStepGroups([say('раз'), say('два'), say('три')])).toEqual([[0], [1], [2]]);
  });

  it('starts a linked step in the same group as the step it names', () => {
    const groups = planStepGroups([say('кольцо'), { ...say('голос'), parallelWith: 1 }, say('итог')]);
    expect(groups).toEqual([[0, 1], [2]]);
  });

  it('pulls a whole chain into one group', () => {
    const groups = planStepGroups([
      say('раз'),
      { ...say('два'), parallelWith: 1 },
      { ...say('три'), parallelWith: 2 },
    ]);
    expect(groups).toEqual([[0, 1, 2]]);
  });

  it('ignores links to itself or to a later step', () => {
    expect(planStepGroups([{ ...say('раз'), parallelWith: 1 }, say('два')])).toEqual([[0], [1]]);
    expect(planStepGroups([{ ...say('раз'), parallelWith: 2 }, say('два')])).toEqual([[0], [1]]);
  });
});

describe('step schema', () => {
  it('accepts the 32nd step number and rejects anything higher', () => {
    const step = { kind: 'say', text: 'Готово', parallelWith: 32 };
    expect(stepSchema.safeParse(step).success).toBe(true);
    expect(stepSchema.safeParse({ ...step, parallelWith: 33 }).success).toBe(false);
    expect(stepSchema.safeParse({ ...step, parallelWith: 0 }).success).toBe(false);
  });
});

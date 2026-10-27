import { describe, expect, it } from 'vitest';
import { migrateScenario } from '../server/automation.ts';
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

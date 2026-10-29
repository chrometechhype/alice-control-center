import { describe, expect, it } from 'vitest';
import {
  bluetoothTransitionMatches,
  conditionMatches,
  isoWeekday,
  metricValue,
  migrateScenario,
  planStepGroups,
  rebootDetected,
  scheduleMatches,
  volumeCrossed,
  wifiTransitionMatches,
} from '../server/automation.ts';
import { stepSchema } from '../server/scenarioDsl.ts';
import type { AutomationScenario, MetricsSample } from '../shared/types.ts';

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

  it('moves a legacy metric condition into the trigger config and keeps it mirrored', () => {
    const condition = { metric: 'tempC' as const, op: '>' as const, value: 70 };
    const migrated = migrateScenario({ ...base, trigger: 'metrics', condition });
    expect(migrated.triggerConfig?.condition).toEqual(condition);
    expect(migrated.condition).toEqual(condition);
  });

  it('falls back to the manual trigger when an old file names a trigger we removed', () => {
    const stored = { ...base, trigger: undefined as unknown as AutomationScenario['trigger'] };
    expect(migrateScenario(stored).trigger).toBe('manual');
  });
});

const sample: MetricsSample = {
  ts: 0,
  cpuPct: 91.5,
  memUsedBytes: 800,
  memTotalBytes: 1000,
  memPct: 80,
  tempC: 75,
  diskUsedBytes: 1,
  diskTotalBytes: 2,
  dataUsedBytes: 250,
  dataTotalBytes: 1000,
  load1: 3.2,
  uptimeSec: 1000,
  wifiRssi: -71,
};

describe('metric thresholds', () => {
  it('reads every metric the panel offers', () => {
    expect(metricValue(sample, 'cpuPct')).toBe(91.5);
    expect(metricValue(sample, 'memPct')).toBe(80);
    expect(metricValue(sample, 'tempC')).toBe(75);
    expect(metricValue(sample, 'load1')).toBe(3.2);
    expect(metricValue(sample, 'wifiRssi')).toBe(-71);
    expect(metricValue(sample, 'dataFreePct')).toBe(75);
  });

  it('reports a missing reading as null instead of zero', () => {
    expect(metricValue({ ...sample, dataTotalBytes: null, dataUsedBytes: null }, 'dataFreePct')).toBeNull();
    expect(metricValue({ ...sample, wifiRssi: null }, 'wifiRssi')).toBeNull();
  });

  it('compares in both directions and refuses to fire on a missing value', () => {
    expect(conditionMatches({ metric: 'cpuPct', op: '>', value: 90 }, sample)).toBe(true);
    expect(conditionMatches({ metric: 'cpuPct', op: '<', value: 90 }, sample)).toBe(false);
    expect(conditionMatches({ metric: 'wifiRssi', op: '<', value: -70 }, sample)).toBe(true);
    expect(conditionMatches({ metric: 'tempC', op: '>', value: 70 }, { ...sample, tempC: null })).toBe(false);
    expect(conditionMatches(undefined, sample)).toBe(false);
  });

  it('detects a reboot from a wide drop in uptime only', () => {
    expect(rebootDetected(5000, 40)).toBe(true);
    expect(rebootDetected(5000, 4990)).toBe(false);
    expect(rebootDetected(null, 40)).toBe(false);
    expect(rebootDetected(5000, null)).toBe(false);
  });
});

describe('schedule trigger', () => {
  // 2026-10-29 is a Thursday (ISO 4).
  const at = (hour: number, minute: number): Date => new Date(2026, 9, 29, hour, minute, 15);

  it('numbers weekdays the ISO way', () => {
    expect(isoWeekday(new Date(2026, 9, 26))).toBe(1);
    expect(isoWeekday(new Date(2026, 9, 29))).toBe(4);
    expect(isoWeekday(new Date(2026, 10, 1))).toBe(7);
  });

  it('fires on the configured minute and weekday', () => {
    expect(scheduleMatches({ time: '08:30', weekdays: [4] }, at(8, 30))).toBe(true);
    expect(scheduleMatches({ time: '08:30', weekdays: [1, 2, 3] }, at(8, 30))).toBe(false);
    expect(scheduleMatches({ time: '08:31', weekdays: [4] }, at(8, 30))).toBe(false);
  });

  it('treats a missing weekday list as every day and rejects a broken time', () => {
    expect(scheduleMatches({ time: '08:30' }, at(8, 30))).toBe(true);
    expect(scheduleMatches({ time: '8:30' }, at(8, 30))).toBe(false);
    expect(scheduleMatches({}, at(8, 30))).toBe(false);
  });
});

describe('volume trigger', () => {
  it('fires only on the crossing, not while the level stays past the threshold', () => {
    expect(volumeCrossed(50, 85, '>', 80)).toBe(true);
    expect(volumeCrossed(85, 90, '>', 80)).toBe(false);
    expect(volumeCrossed(85, 40, '<', 50)).toBe(true);
    expect(volumeCrossed(40, 30, '<', 50)).toBe(false);
  });

  it('needs both readings', () => {
    expect(volumeCrossed(null, 85, '>', 80)).toBe(false);
    expect(volumeCrossed(50, null, '>', 80)).toBe(false);
  });
});

describe('Wi-Fi trigger', () => {
  it('notices a network appearing and disappearing', () => {
    expect(wifiTransitionMatches(null, 'Home', { event: 'connected' })).toBe(true);
    expect(wifiTransitionMatches('Home', 'Home', { event: 'connected' })).toBe(false);
    expect(wifiTransitionMatches('Home', null, { event: 'disconnected' })).toBe(true);
  });

  it('matches the SSID fragment case-insensitively', () => {
    expect(wifiTransitionMatches(null, 'Home_5G', { event: 'connected', ssid: 'home' })).toBe(true);
    expect(wifiTransitionMatches(null, 'Office', { event: 'connected', ssid: 'home' })).toBe(false);
    expect(wifiTransitionMatches('Home_5G', null, { event: 'disconnected', ssid: 'home' })).toBe(true);
  });

  it('fires on a switch and ignores falling off the network for «changed»', () => {
    expect(wifiTransitionMatches('Home', 'Office', { event: 'changed' })).toBe(true);
    expect(wifiTransitionMatches('Home', 'Home', { event: 'changed' })).toBe(false);
    expect(wifiTransitionMatches('Home', null, { event: 'changed' })).toBe(false);
  });
});

describe('Bluetooth trigger', () => {
  const phone = { mac: 'AA:BB:CC:DD:EE:FF', name: 'iPhone' };
  const watch = { mac: '11:22:33:44:55:66', name: 'Watch' };

  it('fires when a device appears or goes away', () => {
    expect(bluetoothTransitionMatches([], [phone], { event: 'connected' })).toBe(true);
    expect(bluetoothTransitionMatches([phone], [phone], { event: 'connected' })).toBe(false);
    expect(bluetoothTransitionMatches([phone, watch], [watch], { event: 'disconnected' })).toBe(true);
    expect(bluetoothTransitionMatches([watch], [watch], { event: 'disconnected' })).toBe(false);
  });

  it('matches by name or MAC fragment', () => {
    expect(bluetoothTransitionMatches([], [phone], { event: 'connected', match: 'iphone' })).toBe(true);
    expect(bluetoothTransitionMatches([], [phone], { event: 'connected', match: 'aa:bb' })).toBe(true);
    expect(bluetoothTransitionMatches([], [phone], { event: 'connected', match: 'watch' })).toBe(false);
    expect(bluetoothTransitionMatches([watch], [], { event: 'disconnected', match: 'iphone' })).toBe(false);
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

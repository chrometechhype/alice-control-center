import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult, StationAdapter } from '../server/adapters/StationAdapter.ts';
import type { LedZone } from '../shared/types.ts';

/**
 * The reported bugs: a «красный-голубой-красный» pattern played as «голубой-чёрный-голубой», a
 * finished effect stayed frozen on its last colour, and «Сброс» brought back a preset deleted long
 * ago because the restore point was taken from a stale file instead of the ring (issue #2).
 */

const zones: LedZone[] = [1, 2, 3].map((ring) => ({
  index: ring - 1,
  prefix: 'plum',
  ring,
  red: `plum:red:ring${ring}`,
  green: `plum:green:ring${ring}`,
  blue: `plum:blue:ring${ring}`,
}));

let buildAnimationScript: typeof import('../server/ledAnimation.ts')['buildAnimationScript'];
let ledControl: typeof import('../server/ledControl.ts');
let ledState: typeof import('../server/ledState.ts');

beforeAll(async () => {
  // The LED state lives on disk; point it at a scratch directory so a test never rewrites real data.
  process.env.ACC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-led-test-'));
  ledState = await import('../server/ledState.ts');
  ledControl = await import('../server/ledControl.ts');
  buildAnimationScript = (await import('../server/ledAnimation.ts')).buildAnimationScript;
});

function brightnessWrites(script: string, device: string): number[] {
  const pattern = new RegExp(`printf '%s\\\\n' (\\d+) > /sys/class/leds/${device}/brightness`, 'g');
  return [...script.matchAll(pattern)].map((match) => Number(match[1]));
}

function ringAdapter(stdout: string): StationAdapter {
  const result: ExecResult = {
    code: 0,
    stdout,
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
  };
  return {
    exec: (_command: string, _options?: ExecOptions) => Promise.resolve(result),
  } as unknown as StationAdapter;
}

function channel(device: string, trigger: string, value: number): string {
  return `${device}|${trigger}|${value}`;
}

function allChannels(trigger: string, values: number[][]): string {
  return zones
    .flatMap((zone, index) => [
      channel(zone.red, trigger, values[index][0]),
      channel(zone.green, trigger, values[index][1]),
      channel(zone.blue, trigger, values[index][2]),
    ])
    .join('\n');
}

describe('frame → zone mapping', () => {
  it('gives each ring its own colour instead of shifting them', () => {
    const frames = [[[255, 0, 0], [0, 0, 255], [255, 0, 0]]];
    const script = buildAnimationScript(frames, 4, 1, [], zones);
    expect(brightnessWrites(script, 'plum:red:ring1')).toEqual([255]);
    expect(brightnessWrites(script, 'plum:blue:ring1')).toEqual([0]);
    expect(brightnessWrites(script, 'plum:red:ring2')).toEqual([0]);
    expect(brightnessWrites(script, 'plum:blue:ring2')).toEqual([255]);
    expect(brightnessWrites(script, 'plum:red:ring3')).toEqual([255]);
    expect(brightnessWrites(script, 'plum:blue:ring3')).toEqual([0]);
  });

  it('tiles a short two-colour frame across three rings', () => {
    const frames = [[[255, 0, 0], [0, 0, 255]]];
    const script = buildAnimationScript(frames, 4, 1, [], zones);
    expect(brightnessWrites(script, 'plum:red:ring3')).toEqual([255]);
    expect(brightnessWrites(script, 'plum:blue:ring3')).toEqual([0]);
  });

  it('turns every ring off for a frame with no colours', () => {
    const script = buildAnimationScript([[]], 4, 1, [], zones);
    for (const zone of zones) {
      expect(brightnessWrites(script, zone.red)).toEqual([0]);
      expect(brightnessWrites(script, zone.green)).toEqual([0]);
      expect(brightnessWrites(script, zone.blue)).toEqual([0]);
    }
  });
});

describe('reading the ring before an effect', () => {
  it('captures the colours ACC itself left on the ring', async () => {
    const adapter = ringAdapter(allChannels('none', [[255, 0, 0], [0, 255, 0], [0, 0, 255]]));
    await expect(ledControl.readRingState(adapter, zones)).resolves.toEqual({
      colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
      on: true,
    });
  });

  it('captures the dark ring as off instead of inventing a colour', async () => {
    const adapter = ringAdapter(allChannels('none', [[0, 0, 0], [0, 0, 0], [0, 0, 0]]));
    await expect(ledControl.readRingState(adapter, zones)).resolves.toEqual({ colors: null, on: false });
  });

  it('captures Alice’s own trigger as native, not as a frozen frame', async () => {
    const adapter = ringAdapter(allChannels('none [led_ring_fb] rfkill-any', [[40, 0, 0], [0, 40, 0], [0, 0, 40]]));
    await expect(ledControl.readRingState(adapter, zones)).resolves.toEqual({ colors: null, on: true });
  });

  it('reports nothing when the firmware exposes no channels at all', async () => {
    await expect(ledControl.readRingState(ringAdapter(''), zones)).resolves.toBeNull();
  });
});

describe('restore after an effect', () => {
  it('does not leave the last frame frozen at the end of a finite animation', () => {
    const restore = ledControl.restoreLinesForState(zones, {
      colors: [[10, 20, 30], [10, 20, 30], [10, 20, 30]],
      on: true,
    });
    const script = buildAnimationScript([[[255, 0, 0], [0, 0, 255], [0, 0, 0]]], 4, 2, restore, zones);
    const tail = script.slice(script.indexOf('done'));
    expect(tail).toContain('plum:red:ring1/brightness');
    expect(tail).toContain("echo 10 > '/sys/class/leds/plum:red:ring1/brightness'");
    // An infinite effect has no end to restore at — it is stopped explicitly instead.
    const looped = buildAnimationScript([[[1, 2, 3]]], 4, 0, [], zones);
    expect(looped).toContain('while :; do');
    expect(looped).not.toContain("echo 0 > '/sys/class/leds");
  });

  it('writes back a captured colour state', () => {
    const lines = ledControl
      .restoreLinesForState(zones, { colors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]], on: true })
      .join('\n');
    expect(lines).toContain("echo 255 > '/sys/class/leds/plum:red:ring1/brightness'");
    expect(lines).toContain("echo 255 > '/sys/class/leds/plum:green:ring2/brightness'");
    expect(lines).toContain("echo 255 > '/sys/class/leds/plum:blue:ring3/brightness'");
  });

  it('keeps the ring dark when it was off', () => {
    const lines = ledControl.restoreLinesForState(zones, { colors: null, on: false }).join('\n');
    expect(lines).not.toContain('led_ring_fb');
    expect(lines).toContain("echo 0 > '/sys/class/leds/plum:red:ring1/brightness'");
  });

  it('falls back to the native trigger when the point is Alice’s indication', () => {
    const lines = ledControl.restoreLinesForState(zones, { colors: null, on: true }).join('\n');
    expect(lines).toContain("echo led_ring_fb > '/sys/class/leds/plum:red:ring1/trigger'");
  });

  it('remembers colours for «Включить» after «Выключить»', async () => {
    ledState.rememberColors([[9, 8, 7]], true);
    ledState.rememberOff();
    expect(ledState.ledState().on).toBe(false);
    expect(ledState.ledState().colors).toEqual([[9, 8, 7]]);
  });
});

describe('restore point for «Сброс»', () => {
  it('undoes a Fun Lab effect instead of writing its colour back', () => {
    ledControl.clearRestorePoint();
    ledState.rememberNative();
    const before = ledState.ledState();
    ledControl.saveRestorePoint({ colors: null, on: true });
    // A random colour is saved as "last colours", which is why reset used to restore it.
    ledState.rememberColors([[255, 0, 0], [255, 0, 0], [255, 0, 0]]);

    expect(ledControl.restorePointLines(zones).join('\n')).toContain('led_ring_fb');

    ledControl.commitRestorePoint();
    expect(ledState.ledState()).toEqual(before);
  });

  it('does not resurrect an old preset when the ring was dark before the effect', () => {
    ledControl.clearRestorePoint();
    ledState.rememberColors([[255, 0, 0], [255, 0, 0], [255, 0, 0]]);
    ledControl.saveRestorePoint({ colors: null, on: false });

    const lines = ledControl.restorePointLines(zones).join('\n');
    expect(lines).not.toContain('echo 255 >');
    expect(lines).toContain("echo 0 > '/sys/class/leds/plum:red:ring1/brightness'");
  });

  it('keeps the first point while the show goes on', () => {
    ledControl.clearRestorePoint();
    ledControl.saveRestorePoint({ colors: [[1, 2, 3]], on: true });
    ledControl.saveRestorePoint({ colors: [[9, 9, 9]], on: true });

    ledControl.commitRestorePoint();
    expect(ledState.ledState().colors).toEqual([[1, 2, 3]]);
  });

  it('forgets the point after a deliberate apply, power change or hand-over', () => {
    ledControl.clearRestorePoint();
    ledControl.saveRestorePoint({ colors: [[4, 5, 6]], on: true });
    ledControl.clearRestorePoint();
    ledState.rememberColors([[7, 8, 9]]);

    const lines = ledControl.restorePointLines(zones).join('\n');
    expect(lines).toContain('led_ring_fb');
    expect(lines).not.toContain("echo 7 > '/sys/class/leds/plum:red:ring1/brightness'");
  });

  it('hands the ring back to Alice when no effect was ever started', () => {
    ledControl.clearRestorePoint();
    ledState.rememberColors([[3, 3, 3]]);

    const lines = ledControl.restorePointLines(zones).join('\n');
    expect(lines).toContain('led_ring_fb');
    expect(lines).not.toContain("echo 3 > '/sys/class/leds/plum:red:ring1/brightness'");
    expect(ledControl.restorePointKind()).toBe('native');
  });
});

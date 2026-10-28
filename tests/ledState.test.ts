import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { LedZone } from '../shared/types.ts';

/**
 * The reported bug: a «красный-голубой-красный» pattern played as «голубой-чёрный-голубой», and a
 * finished effect stayed frozen on its last colour with no way to turn the ring back on. These tests
 * pin the frame→zone mapping and the restore-after-effect rules.
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
let restoreLines: typeof import('../server/ledControl.ts')['restoreLines'];
let ledControl: typeof import('../server/ledControl.ts');
let ledState: typeof import('../server/ledState.ts');

beforeAll(async () => {
  // The LED state lives on disk; point it at a scratch directory so a test never rewrites real data.
  process.env.ACC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-led-test-'));
  ledState = await import('../server/ledState.ts');
  ledControl = await import('../server/ledControl.ts');
  restoreLines = ledControl.restoreLines;
  buildAnimationScript = (await import('../server/ledAnimation.ts')).buildAnimationScript;
});

function brightnessWrites(script: string, device: string): number[] {
  const pattern = new RegExp(`printf '%s\\\\n' (\\d+) > /sys/class/leds/${device}/brightness`, 'g');
  return [...script.matchAll(pattern)].map((match) => Number(match[1]));
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

describe('restore after an effect', () => {
  it('does not leave the last frame frozen at the end of a finite animation', () => {
    ledState.rememberColors([[10, 20, 30], [10, 20, 30], [10, 20, 30]]);
    const restore = restoreLines(zones);
    const script = buildAnimationScript([[[255, 0, 0], [0, 0, 255], [0, 0, 0]]], 4, 2, restore, zones);
    const tail = script.slice(script.indexOf('done'));
    expect(tail).toContain('plum:red:ring1/brightness');
    expect(tail).toContain("echo 10 > '/sys/class/leds/plum:red:ring1/brightness'");
    // An infinite effect has no end to restore at — it is stopped explicitly instead.
    const looped = buildAnimationScript([[[1, 2, 3]]], 4, 0, [], zones);
    expect(looped).toContain('while :; do');
    expect(looped).not.toContain("echo 0 > '/sys/class/leds");
  });

  it('restores the colours ACC last wrote', () => {
    ledState.rememberColors([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    const lines = restoreLines(zones).join('\n');
    expect(lines).toContain("echo 255 > '/sys/class/leds/plum:red:ring1/brightness'");
    expect(lines).toContain("echo 255 > '/sys/class/leds/plum:green:ring2/brightness'");
    expect(lines).toContain("echo 255 > '/sys/class/leds/plum:blue:ring3/brightness'");
  });

  it('keeps the ring dark when it was switched off', () => {
    ledState.rememberColors([[255, 0, 0]], true);
    ledState.rememberOff();
    const lines = restoreLines(zones).join('\n');
    expect(lines).not.toContain('led_ring_fb');
    expect(lines).toContain("echo 0 > '/sys/class/leds/plum:red:ring1/brightness'");
  });

  it('falls back to the native trigger when ACC never owned the ring', () => {
    ledState.rememberNative();
    const lines = restoreLines(zones).join('\n');
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
    ledControl.markRestorePoint();
    // A random colour is saved as "last colours", which is why reset used to restore it.
    ledState.rememberColors([[255, 0, 0], [255, 0, 0], [255, 0, 0]]);

    expect(ledControl.restorePointLines(zones).join('\n')).toContain('led_ring_fb');

    ledControl.commitRestorePoint();
    expect(ledState.ledState()).toEqual(before);
  });

  it('keeps the first point while the show goes on', () => {
    ledControl.clearRestorePoint();
    ledState.rememberColors([[1, 2, 3]]);
    ledControl.markRestorePoint();
    ledState.rememberColors([[9, 9, 9]]);
    ledControl.markRestorePoint();
    ledState.rememberColors([[8, 8, 8]]);

    ledControl.commitRestorePoint();
    expect(ledState.ledState().colors).toEqual([[1, 2, 3]]);
  });

  it('forgets the point after a deliberate apply, power change or hand-over', () => {
    ledState.rememberColors([[4, 5, 6]]);
    ledControl.markRestorePoint();
    ledControl.clearRestorePoint();
    ledState.rememberColors([[7, 8, 9]]);

    const lines = ledControl.restorePointLines(zones).join('\n');
    expect(lines).toContain("echo 7 > '/sys/class/leds/plum:red:ring1/brightness'");
  });

  it('falls back to the saved state when no effect was played', () => {
    ledControl.clearRestorePoint();
    ledState.rememberColors([[3, 3, 3]]);

    const lines = ledControl.restorePointLines(zones).join('\n');
    expect(lines).toContain("echo 3 > '/sys/class/leds/plum:red:ring1/brightness'");
  });
});

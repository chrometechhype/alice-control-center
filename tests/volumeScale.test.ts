import { describe, expect, it } from 'vitest';
import { parseVolumeCapability, percentToLevel, percentToRaw, rawToPercent } from '../server/volumeScale.ts';

/** Verbatim shape of the `volume_capability` slice that `sed` cuts out of /system/vendor/quasar/quasar.cfg. */
const QUASAR_BLOCK = `"volume_capability" : {
   "version" : 1,
   "volumeDbLevels" : {
      "plum" : [ 22.0, 26.4, 29.8, 34.5, 39.2, 44.4, 49.2, 54.5, 59.4, 64.4, 67.3 ]
   },
   "volume_manager_settings" : {
      "platformToOutputMap" : "{ \\"0\\": 0, \\"1\\": 49, \\"20\\": 255}",
      "changeStepPercent" : 5,
      "changeStepMs" : 10000
   },
   "smart_volume" : {
      "disabledDirectives" : [ "sound_set_level", "volume_set" ]
   }
},`;

const scale = parseVolumeCapability(QUASAR_BLOCK);

describe('parseVolumeCapability', () => {
  it('reads quasar’s platform→register table and its level count', () => {
    expect(scale).not.toBeNull();
    expect(scale?.points).toEqual([
      { platform: 0, output: 0 },
      { platform: 1, output: 49 },
      { platform: 20, output: 255 },
    ]);
    expect(scale?.topPlatform).toBe(20);
    expect(scale?.levelCount).toBe(10);
  });

  it('returns null instead of guessing on anything that is not the block', () => {
    expect(parseVolumeCapability('')).toBeNull();
    expect(parseVolumeCapability('volume_capability')).toBeNull();
    expect(parseVolumeCapability('"volume_capability" : { "a" : 1 }')).toBeNull();
  });
});

describe('percentToRaw / rawToPercent', () => {
  it('reproduces the register value measured on the station', () => {
    // Alice’s 40 % (level 4) is `amixer sset Master 125` — ALSA itself shows that as 49 %.
    expect(percentToRaw(scale!, 40, 255)).toBe(125);
    expect(rawToPercent(scale!, 125)).toBe(40);
  });

  it('survives a roundtrip on every step Alice offers', () => {
    for (let percent = 0; percent <= 100; percent += 5) {
      const raw = percentToRaw(scale!, percent, 255);
      expect(raw).not.toBeNull();
      expect(rawToPercent(scale!, raw!)).toBeCloseTo(percent, 0);
    }
  });

  it('keeps the plain percentage when the table cannot belong to this mixer', () => {
    expect(percentToRaw(scale!, 100, 100)).toBeNull();
    expect(percentToRaw(scale!, 50, null)).toBeNull();
  });

  it('refuses register values outside the table', () => {
    expect(rawToPercent(scale!, 256)).toBeNull();
    expect(rawToPercent(scale!, -1)).toBeNull();
  });
});

describe('percentToLevel', () => {
  it('counts levels the way Alice names them', () => {
    expect(percentToLevel(40, scale!)).toBe(4);
    expect(percentToLevel(100, scale!)).toBe(10);
    expect(percentToLevel(0, scale!)).toBe(0);
  });
});

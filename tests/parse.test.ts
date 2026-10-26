import { describe, expect, it } from 'vitest';
import {
  computeCpuPct,
  guessModel,
  parseBluetoothctlShow,
  parseDf,
  parseSections,
  parseThermal,
  parseWifiRssi,
} from '../server/parse.ts';

describe('parseSections', () => {
  it('splits @@ sections and trims each block', () => {
    const raw = '@@STAT\ncpu 1 2\n\n@@MEM\nMemTotal: 1 kB\n@@END';
    expect(parseSections(raw)).toEqual({
      STAT: 'cpu 1 2',
      MEM: 'MemTotal: 1 kB',
      END: '',
    });
  });

  it('ignores text before the first marker', () => {
    expect(parseSections('garbage\n@@A\nvalue')).toEqual({ A: 'value' });
  });
});

describe('parseDf', () => {
  it('converts 1K blocks to bytes and keeps mount paths with spaces', () => {
    const text = [
      'Filesystem     1K-blocks    Used Available Use% Mounted on',
      '/dev/root         100000   40000     60000  40% /',
      '/dev/data         200000   50000    150000  25% /data',
      '/dev/sd1            1000      10       990   1% /mnt/my disk',
      'not a df line',
    ].join('\n');
    const disks = parseDf(text);
    expect(disks).toHaveLength(3);
    expect(disks[0]).toEqual({ mount: '/', usedBytes: 40000 * 1024, totalBytes: 100000 * 1024 });
    expect(disks[2].mount).toBe('/mnt/my disk');
  });
});

describe('parseThermal', () => {
  it('normalizes millidegrees and tenths, ignoring zero and nonsense', () => {
    expect(parseThermal('47000\n0\n312\n-5\n999999')).toBe(47);
  });

  it('returns the hottest valid zone', () => {
    expect(parseThermal('42000\n51000\n38000')).toBe(51);
  });

  it('returns null when nothing usable is present', () => {
    expect(parseThermal('0\nabc\n')).toBeNull();
  });
});

describe('parseWifiRssi', () => {
  it('extracts dBm from /proc/net/wireless', () => {
    const text = [
      'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE',
      ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22',
      ' wlan0: 0000   56.  -47.  -256        0      0      0      0      0        0',
    ].join('\n');
    expect(parseWifiRssi(text)).toBe(-47);
  });

  it('rejects positive and impossible values', () => {
    expect(parseWifiRssi(' wlan0: 0000   56.  10.  -256')).toBeNull();
    expect(parseWifiRssi(' wlan0: 0000   56.  -120.  -256')).toBeNull();
  });
});

describe('computeCpuPct', () => {
  it('computes busy share from deltas', () => {
    expect(computeCpuPct({ total: 100, idle: 40 }, { total: 200, idle: 60 })).toBeCloseTo(80);
  });

  it('returns null without a previous sample or delta', () => {
    expect(computeCpuPct(null, { total: 10, idle: 5 })).toBeNull();
    expect(computeCpuPct({ total: 100, idle: 40 }, { total: 100, idle: 40 })).toBeNull();
  });
});

describe('parseBluetoothctlShow', () => {
  it('reads controller fields', () => {
    const text = [
      'Controller 00:11:22:33:44:55 (public)',
      '\tName: Yandex-Station',
      '\tAlias: Station',
      '\tPowered: yes',
      '\tDiscoverable: no',
      '\tPairable: yes',
    ].join('\n');
    expect(parseBluetoothctlShow(text)).toEqual({
      alias: 'Station',
      name: 'Yandex-Station',
      powered: true,
      discoverable: false,
      pairable: true,
      address: '00:11:22:33:44:55',
    });
  });
});

describe('guessModel', () => {
  it('detects Lite 2 from the device hostname', () => {
    expect(guessModel('Yandex Prune EVT2', 'Yandex-Lite-gen2-TEST')).toBe('Станция Лайт 2');
  });

  it('prefers Mini 3 Pro over Mini 3', () => {
    expect(guessModel('Yandex Pickle', 'yandex-station')).toBe('Станция Мини 3 Про');
  });

  it('falls back to the raw model', () => {
    expect(guessModel('Unknown Box', 'host')).toBe('Unknown Box');
  });
});

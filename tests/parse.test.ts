import { describe, expect, it } from 'vitest';
import {
  bluetoothPairedFilterWorks,
  bluetoothSessionConnected,
  bluetoothSessionPaired,
  computeCpuPct,
  dirTreeCommand,
  dirWalkCommand,
  explainBtFailure,
  guessModel,
  parseBluetoothctlShow,
  parseBtBatch,
  parseDf,
  parseDirWalk,
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

describe('parseBtBatch', () => {
  it('splits the single bluetoothctl exec back into its four answers', () => {
    const batch = [
      'Controller 11:22:33:44:55:66 (public)',
      '\tName: Алисонька',
      '\tPowered: yes',
      '@@ACC_DEVICES@@',
      'Device AA:BB:CC:11:22:33 Redmi Buds 6 Play',
      '@@ACC_PAIRED@@',
      '@@ACC_CONNECTED@@',
    ].join('\n');
    const parts = parseBtBatch(batch);
    expect(parts.show).toContain('Алисонька');
    expect(parts.known.trim()).toBe('Device AA:BB:CC:11:22:33 Redmi Buds 6 Play');
    // Listed but not bonded: the pairing the column lost after a reboot looks exactly like this.
    expect(parts.paired.trim()).toBe('');
    expect(parts.connected.trim()).toBe('');
  });

  it('tolerates a truncated answer instead of throwing', () => {
    expect(parseBtBatch('Controller 00:11:22:33:44:55').paired).toBe('');
  });

  it('notices an old bluetoothctl that prints its usage instead of the paired list', () => {
    expect(bluetoothPairedFilterWorks(parseBtBatch('show\n@@ACC_DEVICES@@\nDevice 1\n@@ACC_PAIRED@@\nToo many arguments\n@@ACC_CONNECTED@@\n')))
      .toBe(false);
    expect(bluetoothPairedFilterWorks(parseBtBatch('show\n@@ACC_DEVICES@@\n@@ACC_PAIRED@@\n@@ACC_CONNECTED@@\n'))).toBe(true);
  });
});

describe('bluetoothSessionConnected', () => {
  it('trusts `info` over the premature «Connection successful» line', () => {
    const output = [
      'Attempting to connect to AA:BB:CC:11:22:33',
      'Connection successful',
      'Device AA:BB:CC:11:22:33 (public)',
      'Connected: no',
    ].join('\n');
    expect(bluetoothSessionConnected(output)).toBe(false);
  });

  it('reads «Connected: yes» even with the coloured prompt in the way', () => {
    expect(bluetoothSessionConnected('\x1b[0;94m[bluetooth]\x1b[0m# \tConnected: yes')).toBe(true);
  });

  it('falls back to the successful line when there is no info block', () => {
    expect(bluetoothSessionConnected('[CHG] Device AA:BB:CC:11:22:33 Connected: yes')).toBe(true);
    expect(bluetoothSessionConnected('Failed to connect: org.bluez.Error.Failed')).toBe(false);
  });
});

describe('bluetoothSessionPaired', () => {
  it('treats AlreadyExists as bonded, not as a failure', () => {
    expect(bluetoothSessionPaired('Failed to pair: org.bluez.Error.AlreadyExists', false)).toBe(true);
  });

  it('does not claim a pairing that failed', () => {
    expect(bluetoothSessionPaired('Failed to pair: org.bluez.Error.AuthenticationFailed', true)).toBe(false);
  });

  it('keeps the previous bonding state when pairing never ran', () => {
    expect(bluetoothSessionPaired('Connection successful', true)).toBe(true);
    expect(bluetoothSessionPaired('Connection successful', false)).toBe(false);
  });
});

describe('explainBtFailure', () => {
  it('turns the BlueZ «not available» line into a next action', () => {
    const explained = explainBtFailure(
      'Attempt to connect to AA:BB:CC:11:22:33: Failed: Device AA:BB:CC:11:22:33 not available',
      'AA:BB:CC:11:22:33',
    );
    expect(explained).toContain('AA:BB:CC:11:22:33');
    expect(explained).toContain('Сканировать');
    expect(explained).not.toMatch(/not available/i);
  });

  it('says so when the device is already paired', () => {
    expect(explainBtFailure('Failed to pair: org.bluez.Error.AlreadyExists', 'AA:BB:CC:11:22:33'))
      .toContain('уже сопряжено');
  });

  it('keeps an unknown line visible rather than inventing a reason', () => {
    expect(explainBtFailure('Some weird kernel message', 'AA:BB')).toContain('Some weird kernel message');
  });

  it('has no English left in the Russian strings', () => {
    for (const raw of [
      'not powered',
      'org.bluez.Error.AuthenticationRejected',
      'connect timed out',
      'Device XX no such device',
      'Not connected',
      'Operation already in progress',
    ]) {
      expect(explainBtFailure(raw, 'AA:BB:CC:11:22:33')).toMatch(/[а-я]/);
    }
  });
});

describe('guessModel', () => {
  it('detects Lite 2 from the device hostname', () => {
    expect(guessModel('Yandex Prune EVT2', 'Yandex-Lite-gen2-TEST')).toBe('Станция Лайт 2');
  });

  it('prefers Mini 3 Pro over Mini 3', () => {
    expect(guessModel('Yandex Pickle', 'yandex-station')).toBe('Станция Мини 3 Про');
  });

  it('tells a Mini 2 with a clock from a plain Mini 2', () => {
    expect(guessModel('Yandex Mini 2 with clock', 'yandex-station')).toBe('Станция Мини 2 с часами');
    expect(guessModel('yandex_station_mini2_clock', 'yandex-station')).toBe('Станция Мини 2 с часами');
    expect(guessModel('yandex_station_mini_2', 'yandex-station')).toBe('Станция Мини 2');
  });

  it('falls back to the raw model', () => {
    expect(guessModel('Unknown Box', 'host')).toBe('Unknown Box');
  });
});

describe('dirWalkCommand', () => {
  it('guards the directory and walks it with globs instead of ls output', () => {
    const command = dirWalkCommand("/data/it's");
    expect(command).toContain("d='/data/it'\\''s';");
    expect(command).toContain('No such file or directory');
    expect(command).toContain('for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do');
    expect(command).toContain('ls -ld --full-time "$f"');
    expect(command).toContain(`printf '%s\\t%s\\t%s\\n'`);
  });

  it('drops --full-time for a station whose ls lacks it', () => {
    expect(dirWalkCommand('/data', false)).toContain('ls -ld "$f"');
    expect(dirWalkCommand('/data', false)).not.toContain('--full-time');
  });
});

describe('parseDirWalk', () => {
  const line = (kind: string, attrs: string, fullPath: string) => `${kind}\t${attrs}\t${fullPath}`;

  it('keeps the byte-safe name while taking attributes from the mangled ls line', () => {
    const entries = parseDirWalk(
      line(
        'f',
        '-rw-r--r--    1 root     root           844 2026-10-27 17:48:52 +0000 /data/sounds/????????.wav',
        '/data/sounds/проверка кириллицы.wav',
      ),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe('проверка кириллицы.wav');
    expect(entries[0].path).toBe('/data/sounds/проверка кириллицы.wav');
    expect(entries[0].size).toBe(844);
    expect(entries[0].mtimeMs).toBe(Date.parse('2026-10-27T17:48:52+00:00'));
    expect(entries[0].isFile).toBe(true);
    expect(entries[0].mode).toBe(0o644);
  });

  it('reads directories, links and the short date format', () => {
    const entries = parseDirWalk(
      [
        line('d', 'drwxr-xr-x    2 root root 4096 2026-10-27 17:48:52 +0000 /data/???', '/data/мой пак'),
        line('l', 'lrwxrwxrwx    1 root root   12 2026-10-27 17:48:52 +0000 /data/lnk -> /data/target', '/data/lnk'),
        line('f', '-rw-r--r--    1 root root 844 Oct 27 17:48 /data/old.wav', '/data/old.wav'),
      ].join('\n'),
    );
    expect(entries.map((entry) => [entry.name, entry.isDirectory, entry.isSymbolicLink])).toEqual([
      ['мой пак', true, false],
      ['lnk', false, true],
      ['old.wav', false, false],
    ]);
    expect(entries[2].mtimeMs).toBeGreaterThan(0);
  });

  it('still reports the name when ls gave nothing usable', () => {
    const entries = parseDirWalk([line('f', '', '/data/sounds/weird name.wav'), 'junk'].join('\n'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: 'weird name.wav',
      path: '/data/sounds/weird name.wav',
      size: 0,
      mtimeMs: 0,
      mode: 0,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    });
  });
});

describe('dirTreeCommand', () => {
  it('keeps every loop variable local so a subdirectory cannot steal the parent depth', () => {
    const command = dirTreeCommand('/data/sounds');
    expect(command).toContain('local t=$1 k=$2 f k2 a;');
    expect(command).toContain('walk "$d" 1');
    expect(command).toContain('if [ "$k2" = d ] && [ "$k" -lt 4 ]; then walk "$f" $((k + 1)); fi;');
  });

  it('stops at the requested depth', () => {
    expect(dirTreeCommand('/data', 2)).toContain('[ "$k" -lt 2 ]');
  });
});

import { describe, expect, it } from 'vitest';
import type { ExecResult } from '../server/adapters/StationAdapter.ts';
import {
  FULL_DEBUG_COMMANDS,
  renderFullDebugReport,
  reportFileName,
  runFullDebug,
  scrubSecrets,
} from '../server/fullDebug.ts';

function result(partial: Partial<ExecResult>): ExecResult {
  return {
    code: 0,
    stdout: '',
    stderr: '',
    durationMs: 12,
    timedOut: false,
    truncated: false,
    ...partial,
  };
}

describe('scrubSecrets', () => {
  it('masks every psk, quoted or not, and keeps the ssid', () => {
    const text = [
      'network={',
      '\tssid="Дом"',
      '\tpsk="home-pass-1"',
      '}',
      'psk=guestpass',
    ].join('\n');
    const masked = scrubSecrets(text);
    expect(masked).not.toContain('home-pass-1');
    expect(masked).not.toContain('guestpass');
    expect(masked).toContain('ssid="Дом"');
    expect(masked).toContain('psk="***"');
  });
});

describe('runFullDebug', () => {
  const commands = [
    { key: 'a', title: 'Первая', command: 'echo ok', timeoutMs: 1000, maxBytes: 1000 },
    { key: 'b', title: 'Вторая', command: 'cat /bkupgrade/data/wpa_supplicant.conf', timeoutMs: 1000, maxBytes: 1000 },
  ];

  it('keeps collecting after a failed section and records the error', async () => {
    const seen: string[] = [];
    const run = await runFullDebug(
      async (command) => {
        if (command === 'echo ok') throw new Error('канал закрыт');
        return result({ stdout: 'ssid="Дом"\npsk="home-pass-1"' });
      },
      { commands, onSection: (section) => seen.push(section.key) },
    );
    expect(run.sections[0]).toMatchObject({ key: 'a', error: 'канал закрыт', output: '' });
    expect(run.sections[1]).toMatchObject({ key: 'b', code: 0 });
    expect(seen).toEqual(['a', 'b']);
  });

  it('masks a psk even when a non-Wi-Fi section prints one', async () => {
    const run = await runFullDebug(async () => result({ stdout: 'psk="home-pass-1"' }), { commands });
    for (const section of run.sections) {
      expect(section.output).not.toContain('home-pass-1');
    }
  });

  it('joins stdout and stderr and carries the transport flags', async () => {
    const run = await runFullDebug(
      async () =>
        result({ code: 2, stdout: 'out', stderr: 'err', timedOut: true, truncated: true, durationMs: 77 }),
      { commands: [commands[0]] },
    );
    expect(run.sections[0]).toMatchObject({
      code: 2,
      output: 'out\nerr',
      timedOut: true,
      truncated: true,
      durationMs: 77,
    });
  });
});

describe('full debug report', () => {
  it('names the file after the start time', () => {
    expect(reportFileName(new Date(2026, 9, 29, 11, 15, 7).getTime())).toBe(
      'full-debug-20261029-111507.txt',
    );
  });

  it('renders every section with its command and status', async () => {
    const run = await runFullDebug(
      async () => result({ stdout: 'SSID: Дом', code: 0 }),
      { commands: [{ key: 'wifi', title: 'Wi-Fi', command: 'wpa_cli status', timeoutMs: 1000, maxBytes: 1000 }] },
    );
    const report = renderFullDebugReport(run, {
      version: '1.0.0-alpha.6',
      node: 'v24.0.0',
      host: '192.0.2.50',
      username: 'root',
      startedAt: run.startedAt,
    });
    expect(report).toContain('Alice Control Center — полная отладка');
    expect(report).toContain('1.0.0-alpha.6');
    expect(report).toContain('root@192.0.2.50');
    expect(report).toContain('01. Wi-Fi');
    expect(report).toContain('$ wpa_cli status');
    expect(report).toContain('код 0');
    expect(report).toContain('SSID: Дом');
    expect(report).toContain('Пароли Wi-Fi замаскированы');
  });

  it('ships the deep sections the flag promises', () => {
    const keys = FULL_DEBUG_COMMANDS.map((item) => item.key);
    expect(keys).toEqual(
      expect.arrayContaining(['dmesg', 'logs', 'quasar', 'memory', 'disk-speed', 'wifi']),
    );
    const wifi = FULL_DEBUG_COMMANDS.find((item) => item.key === 'wifi');
    expect(wifi?.command).toContain('/bkupgrade/data/wpa_supplicant.conf');
    expect(FULL_DEBUG_COMMANDS.find((item) => item.key === 'disk-speed')?.command).toContain('dd ');
  });
});

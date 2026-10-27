import { describe, expect, it } from 'vitest';
import type { ExecOptions, ExecResult, StationAdapter } from '../server/adapters/StationAdapter.ts';
import { AccError } from '../server/errors.ts';
import { removeDeviceFile } from '../server/deviceOps.ts';

function result(partial: Partial<ExecResult>): ExecResult {
  return {
    code: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    timedOut: false,
    truncated: false,
    ...partial,
  };
}

/** Records the shell the delete issues so the test can assert on the order of commands. */
function fakeAdapter(
  replies: (command: string) => ExecResult,
): { adapter: StationAdapter; calls: string[] } {
  const calls: string[] = [];
  const adapter = {
    exec(command: string, _options?: ExecOptions) {
      calls.push(command);
      return Promise.resolve(replies(command));
    },
  } as unknown as StationAdapter;
  return { adapter, calls };
}

describe('removeDeviceFile', () => {
  it('reports success only when the station confirms the file is gone', async () => {
    const { adapter, calls } = fakeAdapter((command) =>
      command.startsWith('p=') ? result({ stdout: 'GONE\n' }) : result({}),
    );
    await expect(removeDeviceFile(adapter, '/data/sounds/проверка кириллицы.wav')).resolves.toBeUndefined();
    expect(calls[0]).toContain(`'/data/sounds/проверка кириллицы.wav'`);
    expect(calls.at(-1)).toBe('sync');
  });

  it('says so when the path was never on the station', async () => {
    const { adapter, calls } = fakeAdapter((command) =>
      command.startsWith('p=') ? result({ stdout: 'MISSING\n' }) : result({}),
    );
    const error = await removeDeviceFile(adapter, '/data/opt/ghost.wav').catch((e) => e);
    expect(error).toBeInstanceOf(AccError);
    expect((error as AccError).status).toBe(404);
    expect((error as AccError).message).toContain('Файла уже нет на станции');
    expect(calls).toHaveLength(1);
  });

  it('refuses to claim a deletion the station did not carry out', async () => {
    const { adapter, calls } = fakeAdapter((command) =>
      command.startsWith('p=') ? result({ stdout: 'SURVIVED\n' }) : result({}),
    );
    const error = await removeDeviceFile(adapter, '/data/opt/locked.wav').catch((e) => e);
    expect((error as AccError).status).toBe(502);
    expect((error as AccError).message).toContain('не удалила файл');
    expect(calls).toHaveLength(1);
  });

  it('remounts the read-only rootfs around a system file', async () => {
    const { adapter, calls } = fakeAdapter((command) =>
      command.startsWith('p=') ? result({ stdout: 'GONE\n' }) : result({}),
    );
    await removeDeviceFile(adapter, '/system/vendor/quasar/sounds/ru-RU/boot.wav');
    expect(calls[0]).toBe('mount -o remount,rw /');
    expect(calls.at(-1)).toBe('mount -o remount,ro /');
    expect(calls.some((command) => command.includes('rm -f'))).toBe(true);
  });
});

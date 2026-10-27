import { describe, expect, it } from 'vitest';
import { AccError, isTransportDeath } from '../server/errors.ts';

describe('isTransportDeath', () => {
  it('recognises the socket dying before the command was carried', () => {
    for (const message of [
      'Unable to exec',
      'No response from server',
      'Timed out while waiting for handshake',
      'Socket closed',
      'read ECONNRESET',
      'Encountered end of file',
      'Устройство не подключено',
    ]) {
      expect(isTransportDeath(new AccError('SSH_EXEC_FAILED', message, 502))).toBe(true);
    }
  });

  it('leaves a real answer alone', () => {
    expect(isTransportDeath(new AccError('BAD_VOLUME', 'Громкость должна быть от 0 до 100%', 400))).toBe(false);
    expect(isTransportDeath(new AccError('AMIXER_FAILED', 'amixer: Unable to find simple control', 502))).toBe(false);
    expect(isTransportDeath(new AccError('NOT_CONNECTED', 'Панель отключилась вручную — нажмите «Подключить»', 409))).toBe(false);
  });
});

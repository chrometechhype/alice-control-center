import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

function requestFrom(address: string, token?: string): Request {
  return {
    socket: { remoteAddress: address },
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as Request;
}

describe('token holders get the same rights as the machine running the backend', () => {
  let dir = '';

  afterEach(() => {
    delete process.env.ACC_DATA_DIR;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets a network device with the token through and refuses it without one', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-auth-'));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ settings: { theme: 'light', pollIntervalMs: 5000, lanAccess: true, autoConnect: true } }),
    );
    process.env.ACC_DATA_DIR = dir;
    vi.resetModules();

    const auth = await import('../server/auth.ts');
    const config = await import('../server/config.ts');
    const token = config.getLanToken();

    const next = vi.fn();
    auth.requireAuth(requestFrom('192.168.1.42', token), {} as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(auth.requestAuthorized(requestFrom('192.168.1.42', token))).toBe(true);

    expect(auth.requestAuthorized(requestFrom('192.168.1.100', 'wrong-token'))).toBe(false);
    try {
      auth.requireAuth(requestFrom('192.168.1.100'), {} as never, vi.fn());
      throw new Error('ожидался отказ без токена');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('UNAUTHORIZED');
    }
  });

  it('keeps loopback working with no token at all', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-auth-'));
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({ settings: { theme: 'light', pollIntervalMs: 5000, lanAccess: true, autoConnect: true } }),
    );
    process.env.ACC_DATA_DIR = dir;
    vi.resetModules();

    const auth = await import('../server/auth.ts');
    const next = vi.fn();
    auth.requireAuth(requestFrom('127.0.0.1'), {} as never, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

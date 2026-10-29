import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Counter = Map<string, number>;

const WINDOW_MS = 5 * 60_000;
const START = new Date('2026-10-29T21:00:00Z');

let dir = '';
let counter: Counter;

function fakeCounter(fail = false) {
  return async (input: string | URL): Promise<Response> => {
    if (fail) throw new Error('offline');
    const key = new URL(String(input)).pathname.split('/')[3];
    const value = (counter.get(key) ?? 0) + 1;
    if (String(input).includes('/hit/')) counter.set(key, value);
    return { ok: true, status: 200, json: async () => ({ value: counter.get(key) ?? 0 }) } as Response;
  };
}

async function presenceModule() {
  vi.resetModules();
  return import('../server/presence.ts');
}

function bucket(offsetWindows = 0): string {
  return `online-${Math.floor(Date.now() / WINDOW_MS) + offsetWindows}`;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-presence-'));
  counter = new Map();
  process.env.ACC_DATA_DIR = dir;
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal('fetch', fakeCounter());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.ACC_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('presence', () => {
  it('bumps the counter once per window', async () => {
    const presence = await presenceModule();
    expect(await presence.sendHeartbeat()).toBe(true);
    expect(await presence.sendHeartbeat()).toBe(false);
    expect([...counter.values()]).toEqual([1]);
  });

  it('does not count a restart inside the same window', async () => {
    const first = await presenceModule();
    await first.sendHeartbeat();
    const restarted = await presenceModule();
    expect(await restarted.sendHeartbeat()).toBe(false);
    expect([...counter.values()]).toEqual([1]);
  });

  it('bumps the next window after it opens', async () => {
    const presence = await presenceModule();
    await presence.sendHeartbeat();
    vi.setSystemTime(new Date(START.getTime() + WINDOW_MS));
    expect(await presence.sendHeartbeat()).toBe(true);
    expect([...counter.values()]).toEqual([1, 1]);
  });

  it('leaves the window open when the hit failed', async () => {
    vi.stubGlobal('fetch', fakeCounter(true));
    const presence = await presenceModule();
    expect(await presence.sendHeartbeat()).toBe(false);
    vi.stubGlobal('fetch', fakeCounter());
    expect(await presence.sendHeartbeat()).toBe(true);
  });

  it('reads the peak of the current and the previous window', async () => {
    counter.set(bucket(0), 1);
    counter.set(bucket(-1), 9);
    const presence = await presenceModule();
    expect(await presence.onlineCount()).toBe(9);
  });

  it('reports nothing when the counter is unreachable', async () => {
    vi.stubGlobal('fetch', fakeCounter(true));
    const presence = await presenceModule();
    expect(await presence.onlineCount()).toBeNull();
  });
});

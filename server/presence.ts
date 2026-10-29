import { getSettings } from './config.ts';

/**
 * Presence is opt-in and aggregate: a panel that has the switch on bumps a public counter once per
 * five-minute window, and the owner's overview reads the current window. No identifier, hostname or
 * version leaves the machine — only the fact that one panel was running.
 */
const BASE = (process.env.ACC_PRESENCE_URL ?? 'https://abacus.jasoncameron.dev').replace(/\/+$/, '');

const NAMESPACE = 'alice-control-center';

export const PRESENCE_WINDOW_MS = 5 * 60_000;

let lastHitBucket = -1;
let loop: NodeJS.Timeout | null = null;

function currentBucket(now = Date.now()): number {
  return Math.floor(now / PRESENCE_WINDOW_MS);
}

function bucketKey(bucket: number): string {
  return `online-${bucket}`;
}

async function call(method: 'hit' | 'get', key: string): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${BASE}/${method}/${NAMESPACE}/${encodeURIComponent(key)}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (response.status === 404) return 0;
    if (!response.ok) throw new Error(`presence ${response.status}`);
    const payload = (await response.json()) as { value?: unknown };
    return typeof payload.value === 'number' ? payload.value : 0;
  } finally {
    clearTimeout(timer);
  }
}

export function presenceEnabled(): boolean {
  return getSettings().presence === true;
}

/** A panel bumps its window once; `force` ignores that guard for a manual refresh. */
export async function sendHeartbeat(force = false): Promise<boolean> {
  if (!presenceEnabled()) return false;
  const bucket = currentBucket();
  if (!force && lastHitBucket === bucket) return false;
  lastHitBucket = bucket;
  try {
    await call('hit', bucketKey(bucket));
    return true;
  } catch {
    lastHitBucket = -1;
    return false;
  }
}

export async function onlineCount(): Promise<number | null> {
  try {
    return await call('get', bucketKey(currentBucket()));
  } catch {
    return null;
  }
}

export function startPresence(): void {
  if (loop) return;
  void sendHeartbeat();
  loop = setInterval(() => {
    void sendHeartbeat();
  }, 60_000);
  loop.unref();
}

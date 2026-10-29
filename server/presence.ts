import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.ts';

/**
 * Presence is aggregate and always on: a running panel bumps a public counter once per five-minute
 * window, and the owner's overview reads the current window. No identifier, hostname or version
 * leaves the machine — only the fact that one panel was running. There is no switch: a counter that
 * only counts volunteers says «five people agreed», not «five people use it».
 */
const BASE = (process.env.ACC_PRESENCE_URL ?? 'https://abacus.jasoncameron.dev').replace(/\/+$/, '');

const NAMESPACE = 'alice-control-center';

export const PRESENCE_WINDOW_MS = 5 * 60_000;

/** A window fills up only as panels tick, so the overview reads two of them. */
export const PRESENCE_SPAN_MS = PRESENCE_WINDOW_MS * 2;

const stampFile = path.join(dataDir, 'presence.json');

let loop: NodeJS.Timeout | null = null;

function currentBucket(now = Date.now()): number {
  return Math.floor(now / PRESENCE_WINDOW_MS);
}

/**
 * The window already reported is stored on disk, not just in memory: a restart inside the same
 * window would otherwise bump the counter again, and a panel restarted nine times would look like
 * nine people.
 */
function reportedBucket(): number {
  try {
    const raw = JSON.parse(fs.readFileSync(stampFile, 'utf8')) as { bucket?: unknown };
    return typeof raw.bucket === 'number' ? raw.bucket : -1;
  } catch {
    return -1;
  }
}

function rememberBucket(bucket: number): void {
  try {
    fs.writeFileSync(stampFile, JSON.stringify({ bucket }), { mode: 0o600 });
  } catch {
    // A failed write costs one duplicate hit, never the count itself.
  }
}

let lastHitBucket = reportedBucket();

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

/** A panel bumps its window once; `force` ignores that guard for a manual refresh. */
export async function sendHeartbeat(force = false): Promise<boolean> {
  const bucket = currentBucket();
  if (!force && lastHitBucket === bucket) return false;
  lastHitBucket = bucket;
  try {
    await call('hit', bucketKey(bucket));
    rememberBucket(bucket);
    return true;
  } catch {
    lastHitBucket = -1;
    return false;
  }
}

/**
 * Panels tick at their own moments, so a window reads low right after it opens and the plain
 * current value dropped to «1» every five minutes. The peak of this window and the previous one is
 * what the overview shows: how many panels were running in the last ten minutes.
 */
export async function onlineCount(): Promise<number | null> {
  const bucket = currentBucket();
  const [current, previous] = await Promise.all([
    call('get', bucketKey(bucket)).catch(() => null),
    call('get', bucketKey(bucket - 1)).catch(() => null),
  ]);
  if (current === null && previous === null) return null;
  return Math.max(current ?? 0, previous ?? 0);
}

export function startPresence(): void {
  if (loop) return;
  void sendHeartbeat();
  loop = setInterval(() => {
    void sendHeartbeat();
  }, 60_000);
  loop.unref();
}

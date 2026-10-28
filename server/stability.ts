import type { StabilityMode, StabilitySnapshot } from '../shared/types.ts';

/**
 * The station cannot be made faster from here: its own update loop keeps a core busy and dropbear
 * gives up on sessions that stop answering. What the panel can do is stop adding load while that
 * happens — poll less often, reconnect less eagerly — and say plainly which state the link is in.
 *
 * Thresholds come from the live journal: a healthy station answered a full metrics script in
 * 0.2–0.5 s and held a session for minutes, while the stuck one dropped every 20–30 s and timed out
 * whole reads. Everything measures the last few minutes, so a station that recovers is believed
 * within a minute instead of being punished for the rest of the session.
 */

/** How far back the verdict looks. */
export const STABILITY_WINDOW_MS = 3 * 60_000;
/** Uplinks lost inside the window before the link counts as strained / unstable. */
const STRAINED_DROPS = 2;
const UNSTABLE_DROPS = 4;
/** A read slower than this is a symptom, not a slow network. */
const SLOW_READ_MS = 1_500;
const MAX_RECORDS = 64;

interface Sample {
  at: number;
  kind: 'up' | 'down' | 'slow';
}

export class StabilityMonitor {
  private samples: Sample[] = [];
  private recoveryStartedAt: number | null = null;
  private recoveries: number[] = [];
  private pollIntervalMs: number;

  constructor(private readonly baseIntervalMs = 5_000) {
    this.pollIntervalMs = baseIntervalMs;
  }

  /** The station answered a probe: the link is up from now on. */
  recordConnected(at = Date.now()): void {
    if (this.recoveryStartedAt != null) {
      this.recoveries.push(Math.max(0, at - this.recoveryStartedAt));
      if (this.recoveries.length > 8) this.recoveries.shift();
      this.recoveryStartedAt = null;
    }
    this.push({ at, kind: 'up' });
  }

  /** The transport died. Called once per loss, not per failed reconnect attempt. */
  recordDrop(at = Date.now()): void {
    if (this.recoveryStartedAt == null) this.recoveryStartedAt = at;
    this.push({ at, kind: 'down' });
  }

  recordRead(durationMs: number, at = Date.now()): void {
    if (durationMs >= SLOW_READ_MS) this.push({ at, kind: 'slow' });
  }

  /** Milliseconds actually spent between polls, adjusted to how the link behaves. */
  nextPollInterval(now = Date.now()): number {
    const { mode } = this.snapshot(now);
    const floor = mode === 'unstable' ? 20_000 : mode === 'strained' ? 8_000 : 0;
    const target = Math.max(this.baseIntervalMs, floor);
    // A fresh station that only just answered gets a gentle start instead of a 2 s hammer.
    const warmingUp = mode === 'unstable' && this.uptimeRatio(now) < 0.4;
    // Jitter only ever stretches the interval: decorrelates the panel from the station's own loop
    // without ever polling faster than the mode allows.
    this.pollIntervalMs = warmingUp ? target : Math.max(target, Math.round(target * (0.9 + Math.random() * 0.2)));
    return this.pollIntervalMs;
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  /**
   * Reconnect delays grow with the observed drop rate, and carry jitter so the ladder does not
   * land in the same phase as the loop that keeps killing the session.
   */
  reconnectDelay(baseMs: number, now = Date.now()): number {
    const { mode } = this.snapshot(now);
    const scaled = mode === 'unstable' ? Math.max(5_000, baseMs * 2) : mode === 'strained' ? baseMs * 1.5 : baseMs;
    // The ceiling holds after jitter too: 45 s is the promise the journal message makes.
    const jittered = Math.min(45_000, scaled) * (0.85 + Math.random() * 0.3);
    return Math.round(Math.min(45_000, jittered));
  }

  reset(): void {
    this.samples = [];
    this.recoveries = [];
    this.recoveryStartedAt = null;
    this.pollIntervalMs = this.baseIntervalMs;
  }

  snapshot(now = Date.now()): StabilitySnapshot {
    this.prune(now);
    const drops = this.samples.filter((sample) => sample.kind === 'down').length;
    const slowReads = this.samples.filter((sample) => sample.kind === 'slow').length;
    const lastDown = [...this.samples].reverse().find((sample) => sample.kind === 'down');
    const mode: StabilityMode =
      drops >= UNSTABLE_DROPS ? 'unstable' : drops >= STRAINED_DROPS ? 'strained' : 'stable';
    return {
      mode,
      drops,
      windowMs: STABILITY_WINDOW_MS,
      uptimeRatio: Math.round(this.uptimeRatio(now) * 100) / 100,
      lastDropAgoMs: lastDown ? now - lastDown.at : null,
      meanRecoveryMs: this.recoveries.length
        ? Math.round(this.recoveries.reduce((sum, value) => sum + value, 0) / this.recoveries.length)
        : null,
      slowReads,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  /** Share of the observed span the station was answering. */
  private uptimeRatio(now: number): number {
    const transitions = this.samples.filter((sample) => sample.kind !== 'slow');
    if (transitions.length === 0) return 1;
    const from = Math.max(now - STABILITY_WINDOW_MS, transitions[0].at);
    const span = Math.max(1, now - from);
    let downMs = 0;
    let openedAt: number | null = null;
    for (const sample of transitions) {
      if (sample.kind === 'down' && openedAt == null) openedAt = sample.at;
      if (sample.kind === 'up' && openedAt != null) {
        downMs += sample.at - openedAt;
        openedAt = null;
      }
    }
    if (openedAt != null) downMs += now - openedAt;
    return Math.max(0, Math.min(1, 1 - downMs / span));
  }

  private push(sample: Sample): void {
    this.samples.push(sample);
    if (this.samples.length > MAX_RECORDS) this.samples.shift();
  }

  private prune(now: number): void {
    const from = now - STABILITY_WINDOW_MS;
    this.samples = this.samples.filter((sample) => sample.at >= from);
  }
}

import { describe, expect, it } from 'vitest';
import { StabilityMonitor, STABILITY_WINDOW_MS } from '../server/stability';

const T0 = 1_800_000_000_000;

describe('StabilityMonitor', () => {
  it('calls a fresh link stable and keeps the configured cadence', () => {
    const monitor = new StabilityMonitor(2_000);
    const snapshot = monitor.snapshot(T0);
    expect(snapshot.mode).toBe('stable');
    expect(snapshot.drops).toBe(0);
    expect(snapshot.uptimeRatio).toBe(1);
    expect(monitor.nextPollInterval(T0)).toBeGreaterThanOrEqual(1_800);
    expect(monitor.nextPollInterval(T0)).toBeLessThanOrEqual(2_200);
  });

  it('goes strained after two drops and slows the polls to at least 8 s', () => {
    const monitor = new StabilityMonitor(2_000);
    monitor.recordConnected(T0);
    monitor.recordDrop(T0 + 10_000);
    monitor.recordConnected(T0 + 13_000);
    monitor.recordDrop(T0 + 20_000);
    monitor.recordConnected(T0 + 23_000);

    const snapshot = monitor.snapshot(T0 + 30_000);
    expect(snapshot.mode).toBe('strained');
    expect(snapshot.drops).toBe(2);
    expect(snapshot.uptimeRatio).toBeLessThan(1);
    expect(monitor.nextPollInterval(T0 + 30_000)).toBeGreaterThanOrEqual(7_000);
  });

  it('goes unstable on a drop storm and slows the polls to 20 s', () => {
    const monitor = new StabilityMonitor(2_000);
    for (let index = 0; index < 5; index += 1) {
      const at = T0 + index * 20_000;
      monitor.recordConnected(at);
      monitor.recordDrop(at + 10_000);
    }
    const snapshot = monitor.snapshot(T0 + 100_000);
    expect(snapshot.mode).toBe('unstable');
    expect(snapshot.drops).toBe(5);
    expect(monitor.nextPollInterval(T0 + 100_000)).toBeGreaterThanOrEqual(20_000);
  });

  it('damps reconnect attempts harder the worse the link is, with jitter', () => {
    const calm = new StabilityMonitor(2_000);
    calm.recordConnected(T0);
    const calmDelay = calm.reconnectDelay(1_000, T0 + 1_000);
    expect(calmDelay).toBeGreaterThanOrEqual(850);
    expect(calmDelay).toBeLessThanOrEqual(1_150);

    const storm = new StabilityMonitor(2_000);
    for (let index = 0; index < 5; index += 1) {
      const at = T0 + index * 15_000;
      storm.recordConnected(at);
      storm.recordDrop(at + 5_000);
    }
    const stormDelay = storm.reconnectDelay(1_000, T0 + 70_000);
    expect(stormDelay).toBeGreaterThanOrEqual(4_250);
    expect(stormDelay).toBeLessThanOrEqual(6_500);
    expect(storm.reconnectDelay(40_000, T0 + 70_000)).toBeLessThanOrEqual(45_000);
  });

  it('remembers how long a recovery took and counts slow reads', () => {
    const monitor = new StabilityMonitor(2_000);
    monitor.recordConnected(T0);
    monitor.recordDrop(T0 + 5_000);
    monitor.recordConnected(T0 + 13_000);
    monitor.recordRead(2_400, T0 + 14_000);
    monitor.recordRead(120, T0 + 14_100);

    const snapshot = monitor.snapshot(T0 + 20_000);
    expect(snapshot.meanRecoveryMs).toBe(8_000);
    expect(snapshot.slowReads).toBe(1);
    expect(snapshot.lastDropAgoMs).toBe(15_000);
  });

  it('forgets drops older than the window, so a recovered station is believed again', () => {
    const monitor = new StabilityMonitor(2_000);
    for (let index = 0; index < 5; index += 1) {
      const at = T0 + index * 10_000;
      monitor.recordConnected(at);
      monitor.recordDrop(at + 4_000);
    }
    expect(monitor.snapshot(T0 + 50_000).mode).toBe('unstable');

    const later = T0 + STABILITY_WINDOW_MS + 120_000;
    monitor.recordConnected(later);
    const snapshot = monitor.snapshot(later + 1_000);
    expect(snapshot.drops).toBe(0);
    expect(snapshot.mode).toBe('stable');
  });

  it('starts over after a deliberate disconnect', () => {
    const monitor = new StabilityMonitor(2_000);
    for (let index = 0; index < 4; index += 1) {
      const at = T0 + index * 10_000;
      monitor.recordConnected(at);
      monitor.recordDrop(at + 3_000);
    }
    expect(monitor.snapshot(T0 + 45_000).mode).toBe('unstable');
    monitor.reset();
    const snapshot = monitor.snapshot(T0 + 46_000);
    expect(snapshot.mode).toBe('stable');
    expect(snapshot.uptimeRatio).toBe(1);
  });
});

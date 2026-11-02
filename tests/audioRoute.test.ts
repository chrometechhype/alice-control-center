import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ROUTE_SCRIPT } from '../server/audioRoute.ts';

describe('the headphone route script', () => {
  it('is valid shell', () => {
    const check = spawnSync('sh', ['-n'], { input: ROUTE_SCRIPT, encoding: 'utf8' });
    if (check.error) return; // a machine without a POSIX shell cannot judge it
    expect(check.stderr).toBe('');
  });

  it('carries no TypeScript comments, which the column would try to execute', () => {
    expect(ROUTE_SCRIPT).not.toContain('/**');
    expect(ROUTE_SCRIPT).not.toMatch(/^\s*\* /m);
  });

  it('keeps a softvol stage on the shared Master control, so Alice still sets the headphone volume', () => {
    expect(ROUTE_SCRIPT).toContain('type softvol');
    expect(ROUTE_SCRIPT).toContain('name \\"Master Playback Volume\\"');
    expect(ROUTE_SCRIPT).toContain('set_bt_max');
  });

  it('decides it already switched by its own marker, not by text the stock config contains', () => {
    expect(ROUTE_SCRIPT).toContain('grep -q "pcm.acc_bt_raw" "$VOL"');
    expect(ROUTE_SCRIPT).not.toContain('grep -q "type softvol" "$VOL"');
  });

  it('restarts the capability daemon only when the overlay changed', () => {
    expect(ROUTE_SCRIPT).toContain('[ "$was" = "$now" ] || restart_platformd');
  });
});

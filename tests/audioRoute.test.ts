import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROUTE_SCRIPT } from '../server/audioRoute.ts';

/**
 * The script is shell, so the only honest check of the risky part — reading a firmware's own ALSA
 * config — is to run it. Git Bash ships `sh` and `awk`; a machine without them skips these, exactly
 * as the syntax check above does.
 */
function render(fixture: string, address = 'AA:BB:CC:DD:EE:FF'): string | null {
  const check = spawnSync('sh', ['-c', 'command -v awk'], { encoding: 'utf8' });
  if (check.status !== 0) return null;
  const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-route-')), 'route.sh');
  fs.writeFileSync(script, ROUTE_SCRIPT);
  const run = spawnSync('sh', [script, 'render', fixture, address], { encoding: 'utf8' });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout;
}

const fixture = (name: string) => path.join('tests', 'fixtures', name);

const countDefault = (text: string) => (text.match(/^pcm\.!default \{/gm) ?? []).length;

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

  it('carries no backticks, which would end the template literal it lives in', () => {
    expect(ROUTE_SCRIPT).not.toContain('`');
  });

  it('picks the config this firmware can be steered through instead of assuming one path', () => {
    expect(ROUTE_SCRIPT).toContain('layout_of()');
    expect(ROUTE_SCRIPT).toMatch(/if \[ -e "\$VOL" \]; then\s+echo tmp/);
    expect(ROUTE_SCRIPT).toMatch(/elif \[ -f "\$ETC" \]; then\s+echo etc/);
    expect(ROUTE_SCRIPT).toContain('ACC_NO_LAYOUT');
  });

  it('mounts the copy over the read-only config and takes the mount off again', () => {
    expect(ROUTE_SCRIPT).toContain('mount --bind "$ACOPY" "$ETC"');
    expect(ROUTE_SCRIPT).toContain('umount "$ETC"');
    // Writing into the mounted file, not replacing it: mv would leave the mount on the old inode.
    expect(ROUTE_SCRIPT).toContain('cat /tmp/acc-vol.new > "$ACOPY"');
  });

  it('decides it already switched by its own marker, not by text the stock config contains', () => {
    expect(ROUTE_SCRIPT).toContain('grep -q "pcm.acc_bt_raw" "$target"');
    expect(ROUTE_SCRIPT).not.toContain('grep -q "type softvol" "$target"');
  });

  it('restarts the capability daemon only when the overlay changed', () => {
    expect(ROUTE_SCRIPT).toContain('[ "$was" = "$now" ] || restart_platformd');
  });
});

describe('the chain rendered from a real config', () => {
  it('leaves the Лайт 2 volume file as it was, plus our chain', () => {
    const text = render(fixture('asound-lite2-vol.conf'));
    if (!text) return;
    expect(text).toContain('pcm.speakers {');
    expect(countDefault(text)).toBe(1);
    expect(text).toContain('capture.pcm "multi_capture"');
    expect(text).toContain('name "Master Playback Volume"');
    expect(text).toContain('device "AA:BB:CC:DD:EE:FF"');
    expect(text).toContain('slave.pcm "acc_bt_raw"');
  });

  it('takes the stock default out of a single-file config and keeps its mic and its volume knob', () => {
    const text = render(fixture('asound-single-file.conf'));
    if (!text) return;
    // Two definitions of pcm.!default would leave it to luck which one ALSA obeys.
    expect(countDefault(text)).toBe(1);
    expect(text).toContain('capture.pcm "mic_array"');
    expect(text).toContain('name "Speaker Playback Volume"');
    expect(text).toContain('pcm.mic_array {');
    expect(text).toContain('playback.pcm "acc_bt_out"');
  });

  it('keeps the include line that the Лайт 2 root config uses', () => {
    const text = render(fixture('asound-lite2-etc.conf'));
    if (!text) return;
    expect(countDefault(text)).toBe(1);
    expect(text).toContain('</tmp/asound-vol.conf>');
    expect(text).toContain('capture.pcm "multi_capture"');
  });
});

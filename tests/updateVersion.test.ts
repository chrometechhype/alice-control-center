import { describe, expect, it } from 'vitest';
import { compareVersions } from '../server/update.ts';

/**
 * Every alpha shares the core 1.0.0, so a comparison that drops the `-alpha.N` suffix makes versions
 * in the line look identical: the panel said «установлена актуальная версия» on alpha.3 while alpha.4
 * was out, and the install never downloaded the archive.
 */
describe('version precedence includes the prerelease', () => {
  it('orders alpha releases by their number', () => {
    expect(compareVersions('1.0.0-alpha.4', '1.0.0-alpha.3')).toBe(1);
    expect(compareVersions('v1.0.0-alpha.3', '1.0.0-alpha.4')).toBe(-1);
  });

  it('compares numeric identifiers by value, not as text', () => {
    expect(compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9')).toBe(1);
    expect(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10')).toBe(-1);
  });

  it('keeps a prerelease below its release', () => {
    expect(compareVersions('1.0.0', '1.0.0-alpha.4')).toBe(1);
    expect(compareVersions('1.0.0-alpha.4', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha.9')).toBe(1);
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(1);
  });

  it('ranks a shorter prerelease lower', () => {
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
  });

  it('ignores build metadata and equal versions', () => {
    expect(compareVersions('1.0.0-alpha.4+build.7', '1.0.0-alpha.4')).toBe(0);
    expect(compareVersions('1.0.0-alpha.4', '1.0.0-alpha.4')).toBe(0);
  });

  it('still compares major, minor and patch', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('0.3.0', '1.0.0')).toBe(-1);
  });
});

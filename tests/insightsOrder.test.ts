import { describe, expect, it } from 'vitest';
import { newestFirst } from '../server/insights.ts';

function release(version: string) {
  return { version, downloads: 0, publishedAt: null };
}

describe('newestFirst', () => {
  it('puts alpha.10 above alpha.9 even when GitHub orders by tag string', () => {
    const githubOrder = [
      'v1.0.0-alpha.9',
      'v1.0.0-alpha.8',
      'v1.0.0-alpha.7',
      'v1.0.0-alpha.6',
      'v1.0.0-alpha.10',
      'v1.0.0-alpha.5',
    ].map((tag) => release(tag.replace(/^v/, '')));

    expect(newestFirst(githubOrder).map((item) => item.version)).toEqual([
      '1.0.0-alpha.10',
      '1.0.0-alpha.9',
      '1.0.0-alpha.8',
      '1.0.0-alpha.7',
      '1.0.0-alpha.6',
      '1.0.0-alpha.5',
    ]);
  });

  it('keeps a final release above its alphas', () => {
    const list = [release('1.0.0-alpha.10'), release('1.0.0'), release('0.3.1')];
    expect(newestFirst(list).map((item) => item.version)).toEqual([
      '1.0.0',
      '1.0.0-alpha.10',
      '0.3.1',
    ]);
  });

  it('does not mutate the input', () => {
    const list = [release('1.0.0-alpha.9'), release('1.0.0-alpha.10')];
    newestFirst(list);
    expect(list.map((item) => item.version)).toEqual(['1.0.0-alpha.9', '1.0.0-alpha.10']);
  });
});

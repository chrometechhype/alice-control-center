import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveDownloads, repoInsights } from '../server/insights.ts';

function release(assets: Array<{ name: string; download_count: number }>) {
  return { tag_name: 'v1.0.0-alpha.10', published_at: null, assets };
}

describe('archiveDownloads', () => {
  it('counts the panel archive and ignores the checksum sidecar', () => {
    expect(
      archiveDownloads(
        release([
          { name: 'Alice-Control-Center-1.0.0-alpha.10.zip', download_count: 4 },
          { name: 'Alice-Control-Center-1.0.0-alpha.10.zip.sha256', download_count: 3 },
        ]),
      ),
    ).toBe(4);
  });

  it('adds up several archives', () => {
    expect(
      archiveDownloads(
        release([
          { name: 'Alice-Control-Center-1.0.0-alpha.10.zip', download_count: 2 },
          { name: 'Alice-Control-Center-1.0.0-alpha.10-source.zip', download_count: 5 },
        ]),
      ),
    ).toBe(7);
  });

  it('reads a release with no assets as zero', () => {
    expect(archiveDownloads({ tag_name: 'v1.0.0-alpha.10', published_at: null })).toBe(0);
  });
});

describe('repoInsights', () => {
  let dir = '';

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ACC_DATA_DIR;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('shows the last snapshot when GitHub runs out of quota', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-insights-'));
    const value = {
      repo: 'chrometechhype/alice-control-center',
      totalDownloads: 94,
      releases: [],
      latest: null,
      stars: 11,
      forks: 1,
      watchers: 0,
      checkedAt: Date.now() - 60_000,
    };
    fs.writeFileSync(path.join(dir, 'insights.json'), JSON.stringify({ at: value.checkedAt, value }));
    process.env.ACC_DATA_DIR = dir;
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });

    const fresh = await import('../server/insights.ts');
    const insights = await fresh.repoInsights(true);
    expect(insights.totalDownloads).toBe(94);
    expect(insights.stars).toBe(11);
    expect(insights.refreshError).toBeTruthy();
  });

  it('says how long the GitHub limit lasts instead of returning silently', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-insights-'));
    const resetAt = Math.floor(Date.now() / 1000) + 20 * 60;
    const value = {
      repo: 'chrometechhype/alice-control-center',
      totalDownloads: 94,
      releases: [],
      latest: null,
      stars: 11,
      forks: 1,
      watchers: 0,
      checkedAt: Date.now() - 60_000,
    };
    fs.writeFileSync(path.join(dir, 'insights.json'), JSON.stringify({ at: value.checkedAt, value }));
    process.env.ACC_DATA_DIR = dir;
    vi.resetModules();
    vi.stubGlobal('fetch', async () => {
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-reset': String(resetAt) },
      });
    });

    const fresh = await import('../server/insights.ts');
    const insights = await fresh.repoInsights(true);
    expect(insights.totalDownloads).toBe(94);
    expect(insights.refreshError).toMatch(/ограничил запросы/);
    expect(insights.refreshError).toMatch(/\d+ мин/);
  });
});

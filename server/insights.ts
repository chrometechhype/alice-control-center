import fs from 'node:fs';
import path from 'node:path';
import type { RepoInsights } from '../shared/types.ts';
import { dataDir } from './config.ts';
import { AccError } from './errors.ts';
import { compareVersions, UPDATE_REPO } from './update.ts';

const API_BASE = 'https://api.github.com';
const CACHE_TTL_MS = 10 * 60_000;

interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  published_at: string | null;
  assets?: Array<{ name?: string | null; download_count?: number | null }>;
}

interface GithubRepo {
  stargazers_count?: number;
  forks_count?: number;
  subscribers_count?: number;
}

let cached: { at: number; value: RepoInsights } | null = null;
let inFlight: Promise<RepoInsights> | null = null;

const snapshotFile = path.join(dataDir, 'insights.json');

/**
 * The numbers survive a restart and a GitHub outage: an hourly quota is shared with everyone behind
 * the same address, and a limited request used to empty the strip. What it shows then is the last
 * snapshot, and its own «обновлено» says how old that is.
 */
function loadSnapshot(): { at: number; value: RepoInsights } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as { at?: unknown; value?: unknown };
    if (typeof raw.at !== 'number' || !raw.value) return null;
    return { at: raw.at, value: raw.value as RepoInsights };
  } catch {
    return null;
  }
}

function saveSnapshot(value: RepoInsights): void {
  try {
    fs.writeFileSync(snapshotFile, JSON.stringify({ at: value.checkedAt, value }), { mode: 0o600 });
  } catch {
    // A lost snapshot costs a blank strip after the next restart, never a failed refresh.
  }
}

function headers(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'alice-control-center',
  };
  const token = process.env.ACC_GITHUB_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function github<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { headers: headers(), signal: controller.signal });
    if (!response.ok) {
      // The anonymous quota is 60 requests an hour for the whole shared address, and «обновить»
      // looked broken while it lasted: the numbers stayed old with no explanation.
      const limitReset = Number(response.headers.get('x-ratelimit-reset') ?? 0);
      const limited = response.status === 403 || response.status === 429;
      const waitMinutes =
        limited && Number.isFinite(limitReset) && limitReset > 0
          ? Math.max(1, Math.ceil((limitReset * 1000 - Date.now()) / 60_000))
          : 0;
      throw new AccError(
        'INSIGHTS_FAILED',
        waitMinutes > 0
          ? `GitHub ограничил запросы (60 в час на адрес). Следующая попытка через ${waitMinutes} мин.`
          : limited
            ? 'GitHub ограничил запросы. Попробуйте позже.'
            : `GitHub ответил ошибкой ${response.status}.`,
        502,
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AccError) throw error;
    throw new AccError('INSIGHTS_FAILED', 'Не удалось связаться с API GitHub.', 502);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Only the archive itself counts: GitHub counts the `.sha256` sidecar as a separate download, and
 * every install fetches both, so summing all assets inflated the strip by roughly half.
 */
export function archiveDownloads(release: GithubRelease): number {
  return (release.assets ?? [])
    .filter((asset) => (asset.name ?? '').toLowerCase().endsWith('.zip'))
    .reduce((sum, asset) => sum + (asset.download_count ?? 0), 0);
}

function versionOf(tag: string): string {
  return tag.replace(/^v/, '');
}

/**
 * GitHub lists releases in tag order, so `v1.0.0-alpha.10` arrives after `alpha.6` and the first
 * element is not the newest. The overview needs SemVer order, where `.10` beats `.9`.
 */
export function newestFirst<T extends { version: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => compareVersions(b.version, a.version));
}

async function collect(): Promise<RepoInsights> {
  const [repo, releases] = await Promise.all([
    github<GithubRepo>(`${API_BASE}/repos/${UPDATE_REPO}`),
    github<GithubRelease[]>(`${API_BASE}/repos/${UPDATE_REPO}/releases?per_page=100`),
  ]);
  const list = newestFirst(
    releases
      .filter((release) => !release.draft)
      .map((release) => ({
        version: versionOf(release.tag_name),
        downloads: archiveDownloads(release),
        publishedAt: release.published_at,
      })),
  );
  return {
    repo: UPDATE_REPO,
    totalDownloads: list.reduce((sum, release) => sum + release.downloads, 0),
    releases: list,
    latest: list[0] ?? null,
    stars: repo.stargazers_count ?? 0,
    forks: repo.forks_count ?? 0,
    watchers: repo.subscribers_count ?? 0,
    checkedAt: Date.now(),
  };
}

export async function repoInsights(force = false): Promise<RepoInsights> {
  if (!cached) cached = loadSnapshot();
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const value = await collect();
      cached = { at: Date.now(), value };
      saveSnapshot(value);
      return value;
    } catch (error) {
      // Running out of the hourly GitHub quota must not blank the strip: the numbers already read
      // keep their own `checkedAt`, which says exactly how old they are. The reason travels with
      // them, so «обновить» can say why nothing moved instead of looking broken.
      if (cached) {
        return {
          ...cached.value,
          refreshError: error instanceof AccError ? error.message : 'Не удалось связаться с API GitHub.',
        };
      }
      throw error;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

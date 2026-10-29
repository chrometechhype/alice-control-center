import type { RepoInsights } from '../shared/types.ts';
import { AccError } from './errors.ts';
import { UPDATE_REPO } from './update.ts';

const API_BASE = 'https://api.github.com';
const CACHE_TTL_MS = 10 * 60_000;

interface GithubRelease {
  tag_name: string;
  draft?: boolean;
  published_at: string | null;
  assets?: Array<{ download_count?: number | null }>;
}

interface GithubRepo {
  stargazers_count?: number;
  forks_count?: number;
  subscribers_count?: number;
}

let cached: { at: number; value: RepoInsights } | null = null;
let inFlight: Promise<RepoInsights> | null = null;

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
      throw new AccError(
        'INSIGHTS_FAILED',
        response.status === 403
          ? 'GitHub ограничил запросы. Цифры обновятся позже.'
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

function downloadsOf(release: GithubRelease): number {
  return (release.assets ?? []).reduce((sum, asset) => sum + (asset.download_count ?? 0), 0);
}

function versionOf(tag: string): string {
  return tag.replace(/^v/, '');
}

async function collect(): Promise<RepoInsights> {
  const [repo, releases] = await Promise.all([
    github<GithubRepo>(`${API_BASE}/repos/${UPDATE_REPO}`),
    github<GithubRelease[]>(`${API_BASE}/repos/${UPDATE_REPO}/releases?per_page=100`),
  ]);
  const list = releases
    .filter((release) => !release.draft)
    .map((release) => ({
      version: versionOf(release.tag_name),
      downloads: downloadsOf(release),
      publishedAt: release.published_at,
    }));
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
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const value = await collect();
      cached = { at: Date.now(), value };
      return value;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

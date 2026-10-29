import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import AdmZip from 'adm-zip';
import type { UpdateInfo, UpdateInstallResult } from '../shared/types.ts';
import { dataDir, projectRoot } from './config.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { shutdownForUpdate } from './lifecycle.ts';
import { appSignals } from './signals.ts';

export const UPDATE_REPO = process.env.ACC_GITHUB_REPO?.trim() || 'chrometechhype/alice-control-center';
const API_BASE = 'https://api.github.com';
const WEB_BASE = 'https://github.com';
const RAW_BASE = 'https://raw.githubusercontent.com';
const CACHE_TTL_MS = 15 * 60_000;
const MIN_FORCE_INTERVAL_MS = 60_000;
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_ENTRIES = 4000;
const CONFIRM_WORD = 'ОБНОВИТЬ';

const updatesDir = path.join(dataDir, 'updates');
const cacheFile = path.join(updatesDir, 'cache.json');
const stateFile = path.join(updatesDir, 'state.json');
const stagingRoot = path.join(updatesDir, 'staging');

interface GithubAsset {
  name: string;
  size?: number | null;
  browser_download_url: string;
  digest?: string | null;
}

interface GithubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GithubAsset[];
}

interface CachedUpdate extends UpdateInfo {
  assetName: string | null;
}

interface UpdateState {
  phase: 'staging' | 'applying' | 'done' | 'failed';
  version: string;
  previousVersion: string;
  startedAt: number;
  message: string;
}

let inFlight: Promise<UpdateInfo> | null = null;

function ensureUpdatesDir(): void {
  fs.mkdirSync(updatesDir, { recursive: true });
}

export function currentVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version?.trim() || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/**
 * Semver precedence, prerelease included: 1.0.0-alpha.3 < 1.0.0-alpha.4 < 1.0.0-beta < 1.0.0.
 * Dropping the suffix compared every `1.0.0-alpha.N` as plain 1.0.0, so an alpha.3 panel was told it
 * already had alpha.4 and the install button never downloaded anything.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const one = left.prerelease[index];
    const two = right.prerelease[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;
    const oneNumeric = /^\d+$/.test(one);
    const twoNumeric = /^\d+$/.test(two);
    if (oneNumeric && twoNumeric) return Number(one) > Number(two) ? 1 : -1;
    // A numeric identifier always has lower precedence than an alphanumeric one.
    if (oneNumeric) return -1;
    if (twoNumeric) return 1;
    return one > two ? 1 : -1;
  }
  return 0;
}

function readCache(): CachedUpdate | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedUpdate;
  } catch {
    return null;
  }
}

function writeCache(info: UpdateInfo, assetName: string | null): void {
  ensureUpdatesDir();
  fs.writeFileSync(cacheFile, JSON.stringify({ ...info, assetName }, null, 2));
}

function writeState(state: UpdateState): void {
  ensureUpdatesDir();
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

export function readUpdateState(): UpdateState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as UpdateState;
  } catch {
    return null;
  }
}

function releaseHeaders(): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Alice-Control-Center',
    ...(process.env.ACC_GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.ACC_GITHUB_TOKEN}` }
      : {}),
  };
}

/** Node hides the real reason inside `cause`; the code is what the tester can report. */
function networkCode(error: unknown): string {
  const record = error as { name?: string; cause?: { code?: unknown } } | null;
  if (record?.name === 'AbortError') return 'timeout';
  const code = record?.cause?.code;
  return typeof code === 'string' && /^[A-Z_]{3,40}$/i.test(code) ? code : '';
}

async function githubJson(url: string, timeoutMs = 15_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: releaseHeaders(), signal: controller.signal });
    if (!response.ok) {
      throw new AccError(
        'UPDATE_CHECK_FAILED',
        response.status === 404
          ? 'Релизы проекта пока не опубликованы.'
          : `GitHub ответил ошибкой ${response.status}. Проверьте интернет и повторите позже.`,
        502,
      );
    }
    return await response.json();
  } catch (error) {
    if (error instanceof AccError) throw error;
    const code = networkCode(error);
    throw new AccError(
      'UPDATE_CHECK_FAILED',
      `Не удалось связаться с API GitHub${code ? ` (${code})` : ''}. Проверьте интернет и повторите позже.`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function request(url: string, init: { timeoutMs?: number; method?: string } = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    return await fetch(url, {
      method: init.method ?? 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Alice-Control-Center', Accept: '*/*' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function tagFromReleaseUrl(url: string): string | null {
  const match = /\/releases\/tag\/([^/?#]+)/.exec(url);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

async function remoteSize(url: string): Promise<number | null> {
  try {
    const response = await request(url, { method: 'HEAD', timeoutMs: 8000 });
    await discard(response);
    const length = Number(response.headers.get('content-length') ?? 0);
    return response.ok && length > 0 ? length : null;
  } catch {
    return null;
  }
}

async function releaseNotesFromTag(tag: string): Promise<string | null> {
  const version = tag.replace(/^v/, '');
  try {
    const response = await request(
      `${RAW_BASE}/${UPDATE_REPO}/${encodeURIComponent(tag)}/docs/release-notes/${encodeURIComponent(version)}.md`,
      { timeoutMs: 10_000 },
    );
    if (!response.ok) {
      await discard(response);
      return null;
    }
    return (await response.text()).slice(0, 8000);
  } catch {
    return null;
  }
}

/**
 * `api.github.com` is blocked on some networks while `github.com` itself still loads, so the
 * release is rebuilt from the tag the web redirect lands on. Assets follow the packaging
 * naming convention, and the notes come from the repository instead of the release body.
 */
async function fetchLatestReleaseViaWeb(): Promise<GithubRelease> {
  const start = `${WEB_BASE}/${UPDATE_REPO}/releases/latest`;
  const response = await request(start, { timeoutMs: 20_000 });
  const finalUrl = response.url || start;
  await discard(response);
  if (!response.ok) {
    throw new AccError('UPDATE_CHECK_FAILED', `github.com ответил ошибкой ${response.status}.`, 502);
  }
  const tag = tagFromReleaseUrl(finalUrl);
  if (!tag) {
    throw new AccError('UPDATE_CHECK_FAILED', 'Страница релизов не сообщила номер версии.', 502);
  }
  const version = tag.replace(/^v/, '');
  const assetName = `Alice-Control-Center-${version}.zip`;
  const downloadBase = `${WEB_BASE}/${UPDATE_REPO}/releases/download/${encodeURIComponent(tag)}/`;
  const [size, notes] = await Promise.all([
    remoteSize(`${downloadBase}${assetName}`),
    releaseNotesFromTag(tag),
  ]);
  return {
    tag_name: tag,
    name: null,
    html_url: finalUrl,
    body: notes,
    published_at: null,
    draft: false,
    prerelease: false,
    assets: [
      { name: assetName, size, browser_download_url: `${downloadBase}${assetName}` },
      {
        name: `${assetName}.sha256`,
        size: null,
        browser_download_url: `${downloadBase}${assetName}.sha256`,
      },
    ],
  };
}

async function fetchLatestRelease(): Promise<GithubRelease> {
  try {
    const payload = await githubJson(`${API_BASE}/repos/${UPDATE_REPO}/releases/latest`);
    return payload as GithubRelease;
  } catch (apiError) {
    if (apiError instanceof AccError && apiError.message === 'Релизы проекта пока не опубликованы.') {
      throw apiError;
    }
    try {
      return await fetchLatestReleaseViaWeb();
    } catch {
      const code = networkCode(apiError);
      throw new AccError(
        'UPDATE_CHECK_FAILED',
        `GitHub недоступен из этой сети${code ? ` (${code})` : ''}: не ответили ни api.github.com, ни github.com. Проверьте интернет или VPN и повторите.`,
        502,
      );
    }
  }
}

function releaseAsset(release: GithubRelease): GithubAsset | null {
  const zips = release.assets.filter((asset) => asset.name.toLowerCase().endsWith('.zip'));
  if (!zips.length) return null;
  const version = release.tag_name.replace(/^v/, '');
  return zips.find((asset) => asset.name.includes(version)) ?? zips[0];
}

const NOTE_HEADING = /исправл|нов|featur|fix|added|changed|улучшен/i;

function cleanBullet(line: string): string {
  return line
    .replace(/^[-*+]\s+/, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Release bodies are markdown written for GitHub; the panel shows plain lines. */
export function summarizeRelease(body: string | null): string[] {
  if (!body) return [];
  const lines = body.split(/\r?\n/);
  const bullets: string[] = [];
  let inCode = false;
  let inPreferred = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (heading) {
      inPreferred = NOTE_HEADING.test(heading[1]);
      continue;
    }
    const bullet = cleanBullet(line);
    if (!bullet || bullet.length < 12) continue;
    if (line.trim().startsWith('-') || line.trim().startsWith('*')) {
      if (inPreferred || !bullets.length) bullets.push(bullet.slice(0, 220));
    }
  }
  return [...new Set(bullets)].slice(0, 6);
}

async function buildInfo(release: GithubRelease): Promise<CachedUpdate> {
  const version = currentVersion();
  const latest = release.tag_name.replace(/^v/, '');
  const asset = releaseAsset(release);
  return {
    currentVersion: version,
    latestVersion: latest,
    updateAvailable: compareVersions(latest, version) > 0,
    canInstall: Boolean(asset),
    reason: asset ? undefined : 'В релизе нет ZIP-архива для установки.',
    repo: UPDATE_REPO,
    releaseUrl: release.html_url,
    notes: (release.body ?? '').slice(0, 8000),
    highlights: summarizeRelease(release.body),
    assetSizeBytes: asset?.size ?? null,
    publishedAt: release.published_at,
    checkedAt: Date.now(),
    assetName: asset?.name ?? null,
  };
}

/**
 * The cached record is only trusted for the *latest* version it saw. Comparing it against a
 * stale `currentVersion` is what made the panel shout "есть новая" right after a successful
 * update to that very version.
 */
function withLiveVersion(info: CachedUpdate): UpdateInfo {
  const version = currentVersion();
  const latest = info.latestVersion;
  return {
    ...info,
    currentVersion: version,
    updateAvailable: Boolean(latest) && compareVersions(latest as string, version) > 0,
    // Caches written by older builds have no highlights.
    highlights: Array.isArray(info.highlights) ? info.highlights : [],
  };
}

/** The same release must not fire the `update.available` scenarios on every check. */
let announcedVersion: string | null = null;

function announceUpdate(info: Pick<UpdateInfo, 'updateAvailable' | 'latestVersion'>): void {
  if (!info.updateAvailable || !info.latestVersion) return;
  if (announcedVersion === info.latestVersion) return;
  announcedVersion = info.latestVersion;
  appSignals.emit('update.available', info.latestVersion);
}

export async function checkForUpdates(force = false): Promise<UpdateInfo> {
  const cached = readCache();
  const now = Date.now();
  if (!force && cached?.checkedAt && now - cached.checkedAt < CACHE_TTL_MS) {
    const info = withLiveVersion(cached);
    announceUpdate(info);
    return info;
  }
  if (force && cached?.checkedAt && now - cached.checkedAt < MIN_FORCE_INTERVAL_MS) {
    const info = withLiveVersion(cached);
    announceUpdate(info);
    return info;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const release = await fetchLatestRelease();
      const info = await buildInfo(release);
      writeCache(info, info.assetName);
      announceUpdate(info);
      return info;
    } catch (error) {
      if (cached) {
        const info = {
          ...withLiveVersion(cached),
          checkError: error instanceof Error ? error.message : 'Не удалось проверить обновления',
        } satisfies UpdateInfo;
        announceUpdate(info);
        return info;
      }
      const message = error instanceof Error ? error.message : 'Не удалось проверить обновления';
      return {
        currentVersion: currentVersion(),
        latestVersion: null,
        updateAvailable: false,
        canInstall: false,
        repo: UPDATE_REPO,
        releaseUrl: null,
        notes: '',
        highlights: [],
        assetSizeBytes: null,
        publishedAt: null,
        checkedAt: null,
        checkError: message,
      } satisfies UpdateInfo;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

function isSafeEntry(name: string): boolean {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return false;
  if (/^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function downloadAsset(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AccError('UPDATE_BAD_ASSET', 'Релиз содержит некорректную ссылку на архив.', 502);
  }
  if (parsed.protocol !== 'https:') {
    throw new AccError('UPDATE_BAD_ASSET', 'Архив обновления должен скачиваться по HTTPS.', 502);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(parsed, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Alice-Control-Center' },
    });
    if (!response.ok) {
      throw new AccError('UPDATE_DOWNLOAD_FAILED', `Не удалось скачать обновление (${response.status}).`, 502);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_ZIP_BYTES) {
      throw new AccError('UPDATE_TOO_LARGE', 'Архив обновления больше допустимого размера.', 413);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ZIP_BYTES) {
      throw new AccError('UPDATE_TOO_LARGE', 'Архив обновления больше допустимого размера.', 413);
    }
    return buffer;
  } catch (error) {
    if (error instanceof AccError) throw error;
    throw new AccError(
      error instanceof Error && error.name === 'AbortError' ? 'UPDATE_TIMEOUT' : 'UPDATE_DOWNLOAD_FAILED',
      'Не удалось скачать обновление. Проверьте интернет и повторите.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function expectedDigest(release: GithubRelease, asset: GithubAsset): Promise<string | null> {
  if (asset.digest?.startsWith('sha256:')) return asset.digest.slice(7).toLowerCase();
  const sidecar = release.assets.find(
    (item) => item.name === `${asset.name}.sha256` || item.name === 'sha256sums.txt',
  );
  if (!sidecar) return null;
  const buffer = await downloadAsset(sidecar.browser_download_url);
  const text = buffer.toString('utf8');
  const line = text
    .split(/\r?\n/)
    .find((row) => row.includes(asset.name)) ?? text.split(/\r?\n/)[0];
  const match = /[a-fA-F0-9]{64}/.exec(line ?? '');
  return match ? match[0].toLowerCase() : null;
}

function extractPackageRoot(directory: string): string | null {
  if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
  const children = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory());
  if (children.length === 1) {
    const nested = path.join(directory, children[0].name);
    if (fs.existsSync(path.join(nested, 'package.json'))) return nested;
  }
  return null;
}

function readPackageVersion(directory: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function findApplyScript(): string | null {
  const locations = [
    path.join(projectRoot, 'scripts', 'apply-update.mjs'),
    path.join(projectRoot, 'apply-update.mjs'),
  ];
  return locations.find((file) => fs.existsSync(file)) ?? null;
}

function scheduleShutdown(): void {
  setTimeout(() => shutdownForUpdate(), 900);
}

export async function installUpdate(confirm: string): Promise<UpdateInstallResult> {
  if (confirm !== CONFIRM_WORD) {
    throw new AccError('UPDATE_NOT_CONFIRMED', `Для установки введите «${CONFIRM_WORD}».`, 400);
  }
  const release = await fetchLatestRelease();
  const info = await buildInfo(release);
  if (!info.updateAvailable) {
    throw new AccError('UPDATE_NOT_AVAILABLE', 'Установленная версия уже актуальна.', 409);
  }
  const asset = releaseAsset(release);
  if (!asset) {
    throw new AccError('UPDATE_NO_ASSET', 'В релизе нет ZIP-архива для установки.', 409);
  }
  const expected = await expectedDigest(release, asset);
  if (!expected) {
    throw new AccError(
      'UPDATE_UNVERIFIED',
      'У релиза нет контрольной суммы SHA-256. Установка отменена ради безопасности.',
      409,
    );
  }
  const buffer = await downloadAsset(asset.browser_download_url);
  const actual = sha256(buffer);
  const left = Buffer.from(actual, 'hex');
  const right = Buffer.from(expected, 'hex');
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new AccError('UPDATE_BAD_HASH', 'Контрольная сумма архива не совпала. Установка отменена.', 409);
  }

  ensureUpdatesDir();
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) {
    throw new AccError('UPDATE_BAD_ARCHIVE', 'Архив содержит слишком много файлов.', 400);
  }
  let total = 0;
  for (const entry of entries) {
    if (!isSafeEntry(entry.entryName)) {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
      throw new AccError('UPDATE_BAD_ARCHIVE', 'Архив содержит недопустимые пути.', 400);
    }
    total += Number(entry.header.size) || 0;
  }
  if (total > MAX_ZIP_BYTES) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new AccError('UPDATE_BAD_ARCHIVE', 'Распакованный архив слишком большой.', 413);
  }
  zip.extractAllTo(stagingRoot, true);
  const sourceRoot = extractPackageRoot(stagingRoot);
  if (!sourceRoot) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new AccError('UPDATE_BAD_ARCHIVE', 'В архиве нет package.json — это не ACC.', 400);
  }
  const stagedVersion = readPackageVersion(sourceRoot);
  if (stagedVersion !== info.latestVersion) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new AccError(
      'UPDATE_VERSION_MISMATCH',
      `Версия в архиве (${stagedVersion ?? '?'}) не совпадает с релизом (${info.latestVersion}).`,
      400,
    );
  }
  const script = findApplyScript();
  if (!script) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new AccError('UPDATE_SCRIPT_MISSING', 'Не найден scripts/apply-update.mjs. Обновление отменено.', 500);
  }

  writeState({
    phase: 'staging',
    version: info.latestVersion ?? '0.0.0',
    previousVersion: currentVersion(),
    startedAt: Date.now(),
    message: 'Архив скачан и проверен, панель перезапускается.',
  });
  eventLog.append({
    level: 'info',
    module: 'settings',
    operation: 'update-install',
    result: 'ok',
    message: `Установка обновления ${info.latestVersion}`,
    details: { from: currentVersion(), to: info.latestVersion, asset: asset.name },
  });

  const child = spawn(
    process.execPath,
    [script, sourceRoot, projectRoot, info.latestVersion ?? '0.0.0', currentVersion(), String(process.env.ACC_PORT ?? 8722)],
    {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ACC_UPDATE_STATE: stateFile },
    },
  );
  child.unref();
  scheduleShutdown();
  return {
    status: 'scheduled',
    version: info.latestVersion ?? '0.0.0',
    message: 'Обновление скачано и проверено. Панель перезапускается.',
  };
}

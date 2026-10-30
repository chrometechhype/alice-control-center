import fs from 'node:fs';
import { connectionManager } from './connection.ts';
import { ledPresetsFile, scenariosFile } from './config.ts';
import type {
  AutomationCondition,
  AutomationMetric,
  AutomationScenario,
  LedPreset,
  MetricsSample,
  ScenarioStep,
  ScenarioTriggerConfig,
} from '../shared/types.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { requireZones } from './ledControl.ts';
import { playSceneForSeconds, sleep, stopAnimation } from './ledAnimation.ts';
import { parseAmixerMaster, parseSections } from './parse.ts';
import { buildScene } from './sceneDsl.ts';
import { assertPlayableSoundPath } from './security/paths.ts';
import { appSignals } from './signals.ts';
import { speakWithAlice } from './aliceVoice.ts';
import { playDeviceFile } from './voice.ts';
import { rawToPercent } from './volumeScale.ts';
import { safeErrorMessage } from './util.ts';

const MAX_SCENARIOS = 50;
/** A scenario that runs for longer than this is a mistake, not an animation. */
const MAX_STEP_SECONDS = 300;
/** Wi-Fi, Bluetooth and volume change on their own schedule, so they are polled slower than metrics. */
const WATCH_INTERVAL_MS = 30_000;
/** Chained scenarios stop here instead of walking a cycle forever. */
const MAX_CHAIN_DEPTH = 4;
/** A reboot drops uptime by at least this much; smaller dips are a misread sample. */
const REBOOT_DROP_SEC = 90;
const running = new Set<string>();
let attached = false;
let previousConnectionState = 'disconnected';

interface LegacyAction {
  type: 'notify' | 'diagnostic' | 'ledPreset';
  value?: string;
}

export interface StoredScenario extends Omit<AutomationScenario, 'steps'> {
  action?: LegacyAction;
  steps?: ScenarioStep[];
}

/**
 * Scenarios used to hold exactly one action, which made «замигай красным и скажи «ошибка»»
 * impossible. Old files still on disk are read as a single-step scenario so nothing has to be
 * rebuilt by hand.
 */
export function migrateScenario(stored: StoredScenario): AutomationScenario {
  const { action, ...rest } = stored;
  let steps = rest.steps ?? [];
  if (!steps.length && action) {
    const step: ScenarioStep | null =
      action.type === 'notify'
        ? { kind: 'notify', text: action.value || 'событие получено' }
        : action.type === 'diagnostic'
          ? { kind: 'diagnostic' }
          : legacyPresetStep(action.value);
    steps = step ? [step] : [];
  }
  // Scenarios saved before `triggerConfig` kept the metric condition in a separate field.
  const condition = rest.triggerConfig?.condition ?? rest.condition;
  return {
    ...rest,
    trigger: rest.trigger ?? 'manual',
    steps,
    condition,
    triggerConfig: condition ? { ...rest.triggerConfig, condition } : rest.triggerConfig,
  };
}

function legacyPresetStep(presetId: string | undefined): ScenarioStep | null {
  const preset = loadLedPresets().find((item) => item.id === presetId);
  const frame = preset?.frames[0];
  if (!preset || !frame) return null;
  const seconds = Math.max(1, Math.round((preset.frames.length * 2) / preset.fps));
  const colors = frame.map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  return { kind: 'led', effect: 'solid', colors, fps: preset.fps, seconds };
}

export function loadScenarios(): AutomationScenario[] {
  try {
    const raw = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'));
    return Array.isArray(raw) ? (raw as StoredScenario[]).map(migrateScenario) : [];
  } catch {
    return [];
  }
}

export function saveScenarios(scenarios: AutomationScenario[]): void {
  fs.writeFileSync(scenariosFile, JSON.stringify(scenarios.slice(0, MAX_SCENARIOS), null, 2), {
    mode: 0o600,
  });
}

export function loadLedPresets(): LedPreset[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledPresetsFile, 'utf8'));
    return Array.isArray(raw) ? (raw as LedPreset[]) : [];
  } catch {
    return [];
  }
}

/** Reads the chosen metric out of a sample; `null` means the station did not report it. */
export function metricValue(sample: MetricsSample, metric: AutomationMetric): number | null {
  switch (metric) {
    case 'cpuPct':
      return sample.cpuPct;
    case 'memPct':
      return sample.memPct;
    case 'tempC':
      return sample.tempC;
    case 'dataFreePct': {
      if (!sample.dataTotalBytes) return null;
      const used = sample.dataUsedBytes ?? 0;
      return Math.round(((sample.dataTotalBytes - used) / sample.dataTotalBytes) * 1000) / 10;
    }
    case 'load1':
      return sample.load1;
    case 'wifiRssi':
      return sample.wifiRssi ?? null;
    default:
      return null;
  }
}

export function conditionMatches(condition: AutomationCondition | undefined, sample: MetricsSample): boolean {
  if (!condition) return false;
  const value = metricValue(sample, condition.metric);
  if (value == null || !Number.isFinite(value)) return false;
  return condition.op === '>' ? value > condition.value : value < condition.value;
}

/** `true` when the station restarted between two samples: uptime went backwards by a wide margin. */
export function rebootDetected(previousUptime: number | null, nextUptime: number | null): boolean {
  if (previousUptime == null || nextUptime == null) return false;
  return nextUptime + REBOOT_DROP_SEC < previousUptime;
}

/** ISO weekday of a date: 1 = Monday … 7 = Sunday, matching the saved schedule. */
export function isoWeekday(date: Date): number {
  return ((date.getDay() + 6) % 7) + 1;
}

export function scheduleMatches(
  config: Pick<ScenarioTriggerConfig, 'time' | 'weekdays'>,
  date: Date,
): boolean {
  if (!config.time) return false;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(config.time);
  if (!match) return false;
  const days = config.weekdays?.length ? config.weekdays : [1, 2, 3, 4, 5, 6, 7];
  if (!days.includes(isoWeekday(date))) return false;
  return date.getHours() === Number(match[1]) && date.getMinutes() === Number(match[2]);
}

/** Unique key of a scheduled minute, so a 30-second tick cannot run the same scenario twice. */
export function scheduleMinuteKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
}

export function volumeCrossed(
  previous: number | null,
  next: number | null,
  op: '>' | '<',
  threshold: number,
): boolean {
  if (previous == null || next == null) return false;
  return op === '>' ? previous <= threshold && next > threshold : previous >= threshold && next < threshold;
}

function textMatches(value: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  return value.toLowerCase().includes(pattern.trim().toLowerCase());
}

export function wifiTransitionMatches(
  previousSsid: string | null,
  nextSsid: string | null,
  config: NonNullable<ScenarioTriggerConfig['wifi']>,
): boolean {
  if (config.event === 'connected') {
    return previousSsid == null && nextSsid != null && textMatches(nextSsid, config.ssid);
  }
  if (config.event === 'disconnected') {
    return previousSsid != null && nextSsid == null && textMatches(previousSsid, config.ssid);
  }
  return previousSsid !== nextSsid && nextSsid != null && textMatches(nextSsid, config.ssid);
}

export interface BluetoothDevice {
  mac: string;
  name: string;
}

/** A device is "matching" when its MAC or name contains the configured fragment. */
export function bluetoothTransitionMatches(
  previous: BluetoothDevice[],
  next: BluetoothDevice[],
  config: NonNullable<ScenarioTriggerConfig['bluetooth']>,
): boolean {
  const matches = (device: BluetoothDevice): boolean =>
    !config.match || textMatches(`${device.mac} ${device.name}`, config.match);
  if (config.event === 'connected') {
    return next.some((device) => matches(device) && !previous.some((item) => item.mac === device.mac));
  }
  return previous.some((device) => matches(device) && !next.some((item) => item.mac === device.mac));
}

function ledRecipeFrames(step: Extract<ScenarioStep, { kind: 'led' }>): number[][][] {
  const zones = requireZones().length;
  const recipe = JSON.stringify({
    effect: step.effect,
    colors: step.colors,
    fps: step.fps,
    frames: 16,
    intensity: step.intensity ?? 0.9,
    reverse: step.reverse ?? false,
  });
  // The empty description means "the recipe is already decided" — no word parsing on top of it.
  const scene = buildScene(recipe, zones, '');
  const frames = scene?.frames ?? [];
  if (!frames.length) throw new Error(`Не удалось собрать анимацию из цветов ${step.colors.join(', ')}`);
  return frames;
}

async function executeStep(step: ScenarioStep): Promise<string> {
  switch (step.kind) {
    case 'notify': {
      eventLog.append({
        level: 'info',
        module: 'automation',
        operation: 'notify',
        result: 'ok',
        message: step.text || 'событие получено',
      });
      return 'Записали в журнал';
    }
    case 'diagnostic': {
      const adapter = connectionManager.requireAdapter();
      const command = 'uname -a; df -k / /data; free; cat /proc/loadavg';
      const result = await adapter.exec(command, { timeoutMs: 15_000, maxBytes: 100_000 });
      eventLog.append({
        level: 'warn',
        module: 'automation',
        operation: 'diagnostic',
        result: result.code === 0 ? 'ok' : 'error',
        message: 'Диагностика выполнена',
        details: { output: result.stdout.slice(0, 3000) },
      });
      return 'Диагностика собрана';
    }
    case 'led': {
      const frames = ledRecipeFrames(step);
      const seconds = Math.min(MAX_STEP_SECONDS, Math.max(0.2, step.seconds));
      await playSceneForSeconds(frames, step.fps, seconds);
      return `Кольцо: ${step.effect} ${step.colors.join(' ')} ${seconds.toFixed(1)} с`;
    }
    case 'say': {
      const adapter = connectionManager.requireAdapter();
      const speech = await speakWithAlice(adapter, step.text, { mood: step.mood ?? 'neutral' });
      return speech.completed
        ? `Алиса сказала «${step.text.slice(0, 40)}»`
        : `Алиса начала говорить «${step.text.slice(0, 40)}», конец фразы не подтверждён`;
    }
    case 'sound': {
      const adapter = connectionManager.requireAdapter();
      const remotePath = assertPlayableSoundPath(step.path);
      await playDeviceFile(adapter, remotePath);
      return `Играем ${remotePath.split('/').pop() ?? 'звук'}`;
    }
    case 'pause': {
      await sleep(Math.min(MAX_STEP_SECONDS * 1000, step.seconds * 1000));
      return `Пауза ${step.seconds} с`;
    }
    default:
      return 'Шаг не поддерживается';
  }
}

/**
 * Steps that name an earlier step are started in the same tick: a ring pulse and the spoken warning
 * must land together, not one after the other. Each returned group is executed with `Promise.all`,
 * so every member begins before any of them has awaited the column.
 */
export function planStepGroups(steps: ScenarioStep[]): number[][] {
  const parent = steps.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    let cursor = index;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  steps.forEach((step, index) => {
    const link = step.parallelWith;
    if (!link) return;
    const target = link - 1;
    // A step can only join a step that comes before it — a future step cannot start retroactively.
    if (target < 0 || target >= index) return;
    const own = find(index);
    const other = find(target);
    if (own !== other) parent[own] = other;
  });
  const groups = new Map<number, number[]>();
  steps.forEach((_, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(index);
    else groups.set(root, [index]);
  });
  return [...groups.values()].sort((left, right) => left[0] - right[0]);
}

async function executeScenario(scenario: AutomationScenario): Promise<string> {
  if (!scenario.steps.length) return 'В сценарии нет шагов';
  // Fail with «not connected» instead of letting the first device step complain about LED zones
  // that were never discovered because the column is offline — and wait for the reconnect ladder
  // rather than refusing on a transport that is already being rebuilt.
  if (scenario.steps.some((step) => step.kind !== 'notify' && step.kind !== 'pause'))
    await connectionManager.awaitReady(9_000, { verifyShell: true });
  const notes = new Array<string>(scenario.steps.length).fill('');
  for (const group of planStepGroups(scenario.steps)) {
    const results = await Promise.all(group.map((index) => executeStep(scenario.steps[index])));
    group.forEach((index, position) => {
      notes[index] = results[position];
    });
  }
  return notes.filter(Boolean).join(' · ');
}

export async function runScenario(
  scenarioId: string,
  reason: 'trigger' | 'manual',
): Promise<AutomationScenario> {
  return runScenarioInternal(scenarioId, reason, 0);
}

async function runScenarioInternal(
  scenarioId: string,
  reason: 'trigger' | 'manual',
  depth: number,
): Promise<AutomationScenario> {
  const scenarios = loadScenarios();
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw new AccError('SCENARIO_NOT_FOUND', 'Сценарий не найден', 404);
  if (!scenario.enabled && reason === 'trigger') return scenario;
  if (running.has(scenario.id)) return scenario;
  const now = Date.now();
  if (reason === 'trigger' && now - (scenario.lastRunAt ?? 0) < scenario.cooldownSec * 1000) {
    return scenario;
  }
  running.add(scenario.id);
  let succeeded = false;
  try {
    const result = await executeScenario(scenario);
    scenario.lastRunAt = now;
    scenario.lastResult = result;
    succeeded = true;
    eventLog.append({
      level: 'info',
      module: 'automation',
      operation: 'scenario',
      result: 'ok',
      message: `Сценарий «${scenario.name}» выполнен`,
      details: { scenarioId: scenario.id, steps: scenario.steps.length, result },
    });
  } catch (error) {
    scenario.lastRunAt = now;
    scenario.lastResult = `Ошибка: ${safeErrorMessage(error)}`;
    eventLog.append({
      level: 'error',
      module: 'automation',
      operation: 'scenario',
      result: 'error',
      message: `Сценарий «${scenario.name}» завершился ошибкой`,
      details: { scenarioId: scenario.id, error: safeErrorMessage(error) },
    });
    await stopAnimation().catch(() => undefined);
  } finally {
    running.delete(scenario.id);
    const current = loadScenarios();
    const index = current.findIndex((item) => item.id === scenario.id);
    if (index >= 0) {
      current[index] = scenario;
      saveScenarios(current);
    }
  }
  if (depth < MAX_CHAIN_DEPTH) dispatchAfter(scenario, succeeded, depth);
  return scenario;
}

/** `scenario.done` triggers: one scenario hands the baton to the next one. */
function dispatchAfter(finished: AutomationScenario, succeeded: boolean, depth: number): void {
  for (const candidate of loadScenarios()) {
    if (!candidate.enabled || candidate.trigger !== 'scenario.done') continue;
    if (candidate.triggerConfig?.scenarioId !== finished.id) continue;
    if (candidate.triggerConfig?.onSuccessOnly !== false && !succeeded) continue;
    fire(candidate.id, depth + 1);
  }
}

function fire(scenarioId: string, depth = 0): void {
  void runScenarioInternal(scenarioId, 'trigger', depth).catch(() => undefined);
}

function scenarioCondition(scenario: AutomationScenario): AutomationCondition | undefined {
  return scenario.triggerConfig?.condition ?? scenario.condition;
}

/** Steps that only write to the journal or wait do not need the station. */
function needsStation(scenario: AutomationScenario): boolean {
  return scenario.steps.some((step) => step.kind !== 'notify' && step.kind !== 'pause');
}

let previousUptime: number | null = null;

function handleMetricsSample(sample: MetricsSample): void {
  const reboot = rebootDetected(previousUptime, sample.uptimeSec ?? null);
  previousUptime = sample.uptimeSec ?? previousUptime;
  for (const scenario of loadScenarios()) {
    if (!scenario.enabled) continue;
    if (scenario.trigger === 'metrics') {
      if (conditionMatches(scenarioCondition(scenario), sample)) fire(scenario.id);
    } else if (scenario.trigger === 'station.reboot' && reboot) {
      fire(scenario.id);
    }
  }
}

const scheduleKeys = new Map<string, string>();
const intervalDue = new Map<string, { due: number; minutes: number }>();

function handleClock(now: Date): void {
  for (const scenario of loadScenarios()) {
    if (!scenario.enabled) continue;
    if (scenario.trigger === 'schedule') {
      const config = scenario.triggerConfig;
      if (!config || !scheduleMatches(config, now)) continue;
      // The tick runs every 20 s, so the same minute must not fire twice.
      const key = scheduleMinuteKey(now);
      if (scheduleKeys.get(scenario.id) === key) continue;
      scheduleKeys.set(scenario.id, key);
      fire(scenario.id);
      continue;
    }
    if (scenario.trigger !== 'interval') continue;
    const minutes = Math.max(1, Math.round(scenario.triggerConfig?.everyMinutes ?? 60));
    const state = intervalDue.get(scenario.id);
    if (!state || state.minutes !== minutes) {
      // Count the interval from now, not from the scenario's last run: otherwise a panel restart
      // would immediately fire every interval scenario that has not run for a while.
      intervalDue.set(scenario.id, { due: Date.now() + minutes * 60_000, minutes });
      continue;
    }
    if (Date.now() < state.due) continue;
    state.due = Date.now() + minutes * 60_000;
    fire(scenario.id);
  }
}

const WATCH_SCRIPT = [
  'echo @@VOL',
  'amixer sget Master 2>/dev/null',
  'echo @@WIFI',
  // The interface is not always wlan0 — the same detection the Wi-Fi screen uses.
  'IFACE=""',
  'for i in wlan0 wlp1s0 wlp2s0 wlan1; do',
  '  if wpa_cli -i "$i" status 2>/dev/null | grep -q "^wpa_state="; then IFACE="$i"; break; fi',
  'done',
  '[ -z "$IFACE" ] && IFACE="wlan0"',
  'wpa_cli -i "$IFACE" status 2>/dev/null',
  'echo @@BT',
  'bluetoothctl devices Connected 2>/dev/null',
  'echo @@END',
].join('\n');

interface StationWatch {
  volume: number | null;
  ssid: string | null;
  bluetooth: BluetoothDevice[];
}

let lastWatch: StationWatch | null = null;
let watchInFlight = false;

function readWatch(stdout: string): StationWatch {
  const sections = parseSections(stdout);
  const volume = parseAmixerMaster(sections.VOL ?? '');
  const scale = connectionManager.getInfo()?.volumeScale ?? null;
  const level = volume.raw != null && scale ? rawToPercent(scale, volume.raw) : volume.volumePct;
  const ssid = /^ssid=(.+)$/m.exec(sections.WIFI ?? '')?.[1]?.trim() ?? null;
  const bluetooth: BluetoothDevice[] = [];
  const device = /^Device ([0-9A-F:]{17}) (.+)$/gim;
  for (let match = device.exec(sections.BT ?? ''); match; match = device.exec(sections.BT ?? '')) {
    bluetooth.push({ mac: match[1].toUpperCase(), name: match[2].trim() });
  }
  return { volume: level == null ? null : Math.round(level), ssid, bluetooth };
}

async function pollStationState(): Promise<void> {
  if (watchInFlight) return;
  const scenarios = loadScenarios().filter((scenario) => scenario.enabled && scenario.triggerConfig);
  const volumes = scenarios.filter((scenario) => scenario.trigger === 'volume');
  const wifis = scenarios.filter((scenario) => scenario.trigger === 'wifi');
  const bluetooths = scenarios.filter((scenario) => scenario.trigger === 'bluetooth');
  if (!volumes.length && !wifis.length && !bluetooths.length) return;
  const adapter = connectionManager.getAdapter();
  if (!adapter?.isConnected()) return;
  watchInFlight = true;
  try {
    const result = await adapter.exec(WATCH_SCRIPT, { timeoutMs: 15_000, maxBytes: 60_000 });
    if (!result.stdout.includes('@@END')) return;
    const next = readWatch(result.stdout);
    const previous = lastWatch;
    lastWatch = next;
    // The first reading only sets the baseline — nothing "connected" or "crossed" yet.
    if (!previous) return;
    for (const scenario of volumes) {
      const config = scenario.triggerConfig?.volume;
      if (config && volumeCrossed(previous.volume, next.volume, config.op, config.percent)) fire(scenario.id);
    }
    for (const scenario of wifis) {
      const config = scenario.triggerConfig?.wifi;
      if (config && wifiTransitionMatches(previous.ssid, next.ssid, config)) fire(scenario.id);
    }
    for (const scenario of bluetooths) {
      const config = scenario.triggerConfig?.bluetooth;
      if (config && bluetoothTransitionMatches(previous.bluetooth, next.bluetooth, config)) {
        fire(scenario.id);
      }
    }
  } catch {
    // Watchers are best effort: a missing wpa_cli or a busy station must not flood the journal.
  } finally {
    watchInFlight = false;
  }
}

const pendingAppStart = new Set<string>();

/** `app.start` scenarios with device steps wait for the first connection instead of failing. */
function startAppScenarios(): void {
  for (const scenario of loadScenarios()) {
    if (!scenario.enabled || scenario.trigger !== 'app.start') continue;
    if (needsStation(scenario) && !connectionManager.getAdapter()?.isConnected()) {
      pendingAppStart.add(scenario.id);
    } else {
      fire(scenario.id);
    }
  }
}

function flushAppStart(): void {
  if (!pendingAppStart.size) return;
  for (const id of pendingAppStart) fire(id);
  pendingAppStart.clear();
}

export function initAutomation(): void {
  if (attached) return;
  attached = true;
  connectionManager.getMetricsService().on('sample', handleMetricsSample);
  connectionManager.on('status', (status: { state: string }) => {
    const state = status.state;
    if (state === previousConnectionState) return;
    const wasConnected = previousConnectionState === 'connected';
    previousConnectionState = state;
    if (state === 'connected') {
      for (const scenario of loadScenarios()) {
        if (scenario.enabled && scenario.trigger === 'device.connect') fire(scenario.id);
      }
      flushAppStart();
      return;
    }
    if (!wasConnected) return;
    for (const scenario of loadScenarios()) {
      if (scenario.enabled && scenario.trigger === 'device.disconnect') fire(scenario.id);
    }
  });
  appSignals.on('update.available', (version: string) => {
    eventLog.append({
      level: 'info',
      module: 'automation',
      operation: 'trigger',
      result: 'ok',
      message: `Вышло обновление ${version}`,
    });
    for (const scenario of loadScenarios()) {
      if (scenario.enabled && scenario.trigger === 'update.available') fire(scenario.id);
    }
  });
  setInterval(() => handleClock(new Date()), 20_000).unref();
  setInterval(() => void pollStationState(), WATCH_INTERVAL_MS).unref();
  startAppScenarios();
}

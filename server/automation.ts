import fs from 'node:fs';
import { connectionManager } from './connection.ts';
import { ledPresetsFile, scenariosFile } from './config.ts';
import type { AutomationScenario, LedPreset, MetricsSample, ScenarioStep } from '../shared/types.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { requireZones } from './ledControl.ts';
import { playSceneForSeconds, sleep, stopAnimation } from './ledAnimation.ts';
import { buildScene } from './sceneDsl.ts';
import { assertPlayableSoundPath } from './security/paths.ts';
import { speakWithAlice } from './aliceVoice.ts';
import { playDeviceFile } from './voice.ts';
import { safeErrorMessage } from './util.ts';

const MAX_SCENARIOS = 50;
/** A scenario that runs for longer than this is a mistake, not an animation. */
const MAX_STEP_SECONDS = 300;
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
  if (rest.steps?.length) return { ...rest, steps: rest.steps };
  if (!action) return { ...rest, steps: [] };
  const step: ScenarioStep | null =
    action.type === 'notify'
      ? { kind: 'notify', text: action.value || 'событие получено' }
      : action.type === 'diagnostic'
        ? { kind: 'diagnostic' }
        : legacyPresetStep(action.value);
  return { ...rest, steps: step ? [step] : [] };
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

export function conditionMatches(scenario: AutomationScenario, sample: MetricsSample): boolean {
  const condition = scenario.condition;
  if (!condition) return false;
  const value =
    condition.metric === 'cpuPct' ? sample.cpuPct : condition.metric === 'memPct' ? sample.memPct : sample.tempC;
  if (value == null || !Number.isFinite(value)) return false;
  return condition.op === '>' ? value > condition.value : value < condition.value;
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
      const speech = await speakWithAlice(adapter, step.text);
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
  try {
    const result = await executeScenario(scenario);
    scenario.lastRunAt = now;
    scenario.lastResult = result;
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
  return scenario;
}

export function initAutomation(): void {
  if (attached) return;
  attached = true;
  const metrics = connectionManager.getMetricsService();
  metrics.on('sample', (sample: MetricsSample) => {
    for (const scenario of loadScenarios()) {
      if (!scenario.enabled || scenario.trigger !== 'metrics') continue;
      if (!conditionMatches(scenario, sample)) continue;
      void runScenario(scenario.id, 'trigger').catch(() => undefined);
    }
  });
  connectionManager.on('status', (status: { state: string }) => {
    const state = status.state;
    if (state === previousConnectionState) return;
    const trigger =
      state === 'connected'
        ? 'device.connect'
        : previousConnectionState === 'connected'
          ? 'device.disconnect'
          : null;
    previousConnectionState = state;
    if (!trigger) return;
    for (const scenario of loadScenarios()) {
      if (!scenario.enabled || scenario.trigger !== trigger) continue;
      void runScenario(scenario.id, 'trigger').catch(() => undefined);
    }
  });
  for (const scenario of loadScenarios()) {
    if (scenario.enabled && scenario.trigger === 'app.start') {
      void runScenario(scenario.id, 'trigger').catch(() => undefined);
    }
  }
}

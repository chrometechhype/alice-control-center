import fs from 'node:fs';
import { connectionManager } from './connection.ts';
import { ledPresetsFile, scenariosFile } from './config.ts';
import type { AutomationScenario, LedPreset, MetricsSample } from '../shared/types.ts';
import { eventLog } from './events.ts';
import { applyColors } from './ledControl.ts';
import { safeErrorMessage } from './util.ts';

const MAX_SCENARIOS = 50;
const running = new Set<string>();
let attached = false;
let previousConnectionState = 'disconnected';

export function loadScenarios(): AutomationScenario[] {
  try {
    const raw = JSON.parse(fs.readFileSync(scenariosFile, 'utf8'));
    return Array.isArray(raw) ? (raw as AutomationScenario[]) : [];
  } catch {
    return [];
  }
}

export function saveScenarios(scenarios: AutomationScenario[]): void {
  fs.writeFileSync(scenariosFile, JSON.stringify(scenarios.slice(0, MAX_SCENARIOS), null, 2), {
    mode: 0o600,
  });
}

function loadLedPresets(): LedPreset[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledPresetsFile, 'utf8'));
    return Array.isArray(raw) ? (raw as LedPreset[]) : [];
  } catch {
    return [];
  }
}

function conditionMatches(scenario: AutomationScenario, sample: MetricsSample): boolean {
  const condition = scenario.condition;
  if (!condition) return false;
  const value =
    condition.metric === 'cpuPct' ? sample.cpuPct : condition.metric === 'memPct' ? sample.memPct : sample.tempC;
  if (value == null || !Number.isFinite(value)) return false;
  return condition.op === '>' ? value > condition.value : value < condition.value;
}

async function executeAction(scenario: AutomationScenario): Promise<string> {
  const action = scenario.action;
  if (action.type === 'notify') {
    eventLog.append({
      level: 'info',
      module: 'automation',
      operation: 'notify',
      result: 'ok',
      message: `Сценарий «${scenario.name}»: ${action.value || 'событие получено'}`,
      details: { scenarioId: scenario.id },
    });
    return 'Уведомление записано в журнал';
  }
  if (action.type === 'diagnostic') {
    const adapter = connectionManager.requireAdapter();
    const command = 'uname -a; df -k / /data; free; cat /proc/loadavg';
    const result = await adapter.exec(command, { timeoutMs: 15_000, maxBytes: 100_000 });
    eventLog.append({
      level: 'warn',
      module: 'automation',
      operation: 'diagnostic',
      result: result.code === 0 ? 'ok' : 'error',
      message: `Сценарий «${scenario.name}»: диагностика выполнена`,
      details: { scenarioId: scenario.id, output: result.stdout.slice(0, 3000) },
    });
    return 'Диагностика выполнена';
  }
  if (action.type === 'ledPreset') {
    const preset = loadLedPresets().find((item) => item.id === action.value);
    if (!preset) throw new Error('LED-пресет не найден');
    const frame = preset.frames[0];
    if (!frame) throw new Error('В пресете нет кадров');
    await applyColors(frame);
    eventLog.append({
      level: 'info',
      module: 'automation',
      operation: 'ledPreset',
      result: 'ok',
      message: `Сценарий «${scenario.name}»: применён LED-пресет «${preset.name}»`,
      details: { scenarioId: scenario.id, presetId: preset.id },
    });
    return `Применён пресет «${preset.name}»`;
  }
  return 'Действие не поддерживается';
}

export async function runScenario(
  scenarioId: string,
  reason: 'trigger' | 'manual',
): Promise<AutomationScenario> {
  const scenarios = loadScenarios();
  const scenario = scenarios.find((item) => item.id === scenarioId);
  if (!scenario) throw new Error('Сценарий не найден');
  if (!scenario.enabled && reason === 'trigger') return scenario;
  if (running.has(scenario.id)) return scenario;
  const now = Date.now();
  if (reason === 'trigger' && now - (scenario.lastRunAt ?? 0) < scenario.cooldownSec * 1000) {
    return scenario;
  }
  running.add(scenario.id);
  try {
    const result = await executeAction(scenario);
    scenario.lastRunAt = now;
    scenario.lastResult = result;
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

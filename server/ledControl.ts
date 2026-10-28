import type { LedZone } from '../shared/types.ts';
import { ACTION_READY_WAIT_MS, connectionManager } from './connection.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { ledState, rememberColors, rememberNative, rememberOff } from './ledState.ts';
import { shQuote } from './util.ts';

export function zonesFromCapabilities(): LedZone[] {
  const zones = connectionManager.getCapabilities()?.led.details?.zones;
  if (!Array.isArray(zones)) return [];
  return zones as LedZone[];
}

export function requireZones(): LedZone[] {
  const zones = zonesFromCapabilities();
  if (!zones.length) {
    throw new AccError('LED_UNAVAILABLE', 'Управляемые LED-зоны на этой модели не обнаружены', 409);
  }
  return zones;
}

/**
 * Zones are only known after a probe, so a column that merely dropped its socket would otherwise
 * answer «эта модель не умеет кольцо» — a claim about the hardware, when the truth is that the
 * panel cannot reach it. Readiness comes first, and a deliberate press waits for the ladder.
 */
async function readyZones(): Promise<{ adapter: StationAdapter; zones: LedZone[] }> {
  const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
  return { adapter, zones: requireZones() };
}

/** One colour per zone; a frame shorter than the ring tiles across the remaining zones. */
function colorFor(colors: number[][], index: number): number[] {
  return colors[index % colors.length] ?? [0, 0, 0];
}

function writeLines(zones: LedZone[], colors: number[][]): string[] {
  const lines: string[] = [];
  zones.forEach((zone, index) => {
    const color = colorFor(colors, index);
    for (const device of [zone.red, zone.green, zone.blue]) {
      lines.push(`echo none > ${shQuote(`/sys/class/leds/${device}/trigger`)}`);
    }
    lines.push(`echo ${color[0]} > ${shQuote(`/sys/class/leds/${zone.red}/brightness`)}`);
    lines.push(`echo ${color[1]} > ${shQuote(`/sys/class/leds/${zone.green}/brightness`)}`);
    lines.push(`echo ${color[2]} > ${shQuote(`/sys/class/leds/${zone.blue}/brightness`)}`);
  });
  return lines;
}

function offLines(zones: LedZone[]): string[] {
  const lines: string[] = [];
  for (const zone of zones) {
    for (const device of [zone.red, zone.green, zone.blue]) {
      lines.push(`echo none > ${shQuote(`/sys/class/leds/${device}/trigger`)}`);
      lines.push(`echo 0 > ${shQuote(`/sys/class/leds/${device}/brightness`)}`);
    }
  }
  return lines;
}

function nativeLines(zones: LedZone[]): string[] {
  const lines: string[] = [];
  for (const zone of zones) {
    for (const device of [zone.red, zone.green, zone.blue]) {
      const base = `/sys/class/leds/${device}`;
      lines.push(`echo 0 > ${shQuote(`${base}/brightness`)}`);
      lines.push(`echo led_ring_fb > ${shQuote(`${base}/trigger`)}`);
    }
  }
  return lines;
}

/**
 * What the ring should show once an effect ends: the colours ACC last wrote, or a dark ring if it
 * was switched off, or Alice's own indication when ACC never owned the ring. Without this the last
 * animation frame simply stayed frozen — the «зависла на одном цвете» bug.
 */
export function restoreLines(zones: LedZone[]): string[] {
  const state = ledState();
  if (!state.on) return offLines(zones);
  if (state.colors?.length) return writeLines(zones, state.colors);
  return nativeLines(zones);
}

function readBackScript(zones: LedZone[]): string {
  const devices = zones.flatMap((zone) => [zone.red, zone.green, zone.blue]);
  return devices
    .map((device) => {
      const base = `/sys/class/leds/${device}/brightness`;
      return `echo "${device}|$(cat ${shQuote(base)} 2>/dev/null)"`;
    })
    .join('\n');
}

export interface LedApplyResult {
  colors: number[][];
  /** Channels that did not take the written value — a ring that silently ignores a colour. */
  mismatches: string[];
}

/**
 * The station is not a dumb array of lamps: a stock daemon can re-arm `led_ring_fb` right after the
 * write, and a channel node can refuse a value. Writing is therefore followed by one read-back, so
 * «цвет применён» is only said when the ring actually holds that colour.
 */
export async function applyColors(colors: number[][]): Promise<LedApplyResult> {
  const { adapter, zones } = await readyZones();
  const result = await adapter.exec(writeLines(zones, colors).join('\n'), {
    timeoutMs: 8000,
    maxBytes: 20_000,
  });
  if (result.code !== 0) {
    throw new AccError(
      'LED_WRITE_FAILED',
      result.stderr.trim() || 'Не удалось записать состояние LED',
      502,
    );
  }
  const mismatches = await verify(adapter, zones, colors);
  rememberColors(colors);
  if (mismatches.length) {
    eventLog.append({
      level: 'warn',
      module: 'led',
      operation: 'apply',
      result: 'error',
      message: `LED приняли не все цвета: ${mismatches.join(', ')}`,
      details: { mismatches },
    });
  }
  return { colors, mismatches };
}

async function verify(adapter: StationAdapter, zones: LedZone[], colors: number[][]): Promise<string[]> {
  let stdout = '';
  try {
    const result = await adapter.exec(readBackScript(zones), { timeoutMs: 6000, maxBytes: 20_000 });
    stdout = result.stdout;
  } catch {
    return [];
  }
  const values = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const [path, value] = line.trim().split('|');
    if (!path || value == null) continue;
    values.set(path.slice(path.lastIndexOf('/') + 1), Number(value));
  }
  const mismatches: string[] = [];
  zones.forEach((zone, index) => {
    const color = colorFor(colors, index);
    (['red', 'green', 'blue'] as const).forEach((channel, channelIndex) => {
      const device = zone[channel];
      const actual = values.get(device);
      if (actual == null) return;
      if (actual !== color[channelIndex]) mismatches.push(`зона ${index + 1} · ${channel}`);
    });
  });
  return mismatches;
}

export async function allLedsOff(): Promise<void> {
  const { adapter, zones } = await readyZones();
  const result = await adapter.exec(offLines(zones).join('\n'), { timeoutMs: 8000 });
  if (result.code !== 0) {
    throw new AccError('LED_WRITE_FAILED', result.stderr.trim() || 'Не удалось погасить LED', 502);
  }
  rememberOff();
}

/** Hands the ring back to the stock `led_ring_fb` trigger — Alice's own indication. */
export async function restoreNative(): Promise<void> {
  const { adapter, zones } = await readyZones();
  const result = await adapter.exec(nativeLines(zones).join('\n'), { timeoutMs: 8000 });
  if (result.code !== 0) {
    throw new AccError(
      'LED_WRITE_FAILED',
      result.stderr.trim() || 'Не удалось вернуть управление LED штатному демону',
      502,
    );
  }
  rememberNative();
  eventLog.append({
    level: 'info',
    module: 'led',
    operation: 'restore',
    result: 'ok',
    message: 'Управление LED возвращено штатному триггеру led_ring_fb',
  });
}

/**
 * «Включить» after «Выключить»: the panel wrote the colours down before going dark, so turning the
 * ring back on means putting those colours back. Without them the honest answer is the native
 * trigger — an arbitrary colour would be an invention.
 */
export async function ledPowerOn(): Promise<{ mode: 'colors' | 'native'; result: LedApplyResult | null }> {
  const state = ledState();
  if (state.colors?.length) {
    const result = await applyColors(state.colors);
    return { mode: 'colors', result };
  }
  await restoreNative();
  return { mode: 'native', result: null };
}

export function describeMismatches(result: LedApplyResult): string | undefined {
  if (!result.mismatches.length) return undefined;
  return `Кольцо приняло не все цвета: ${result.mismatches.join(', ')}. Похоже, эта зона не управляется напрямую — проверьте её кнопкой «Проверить кольца».`;
}

import type { LedZone } from '../shared/types.ts';
import { connectionManager } from './connection.ts';
import { AccError } from './errors.ts';
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

export async function applyColors(colors: number[][]): Promise<void> {
  const zones = requireZones();
  const adapter = connectionManager.requireAdapter();
  const triggers: string[] = [];
  const values: string[] = [];
  zones.forEach((zone, index) => {
    const color = colors[index % colors.length] ?? [0, 0, 0];
    for (const device of [zone.red, zone.green, zone.blue]) {
      triggers.push(`echo none > ${shQuote(`/sys/class/leds/${device}/trigger`)}`);
    }
    values.push(`echo ${color[0]} > ${shQuote(`/sys/class/leds/${zone.red}/brightness`)}`);
    values.push(`echo ${color[1]} > ${shQuote(`/sys/class/leds/${zone.green}/brightness`)}`);
    values.push(`echo ${color[2]} > ${shQuote(`/sys/class/leds/${zone.blue}/brightness`)}`);
  });
  const result = await adapter.exec([...triggers, ...values].join('\n'), {
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
}

export async function allLedsOff(): Promise<void> {
  const zones = requireZones();
  const adapter = connectionManager.requireAdapter();
  const triggers: string[] = [];
  const values: string[] = [];
  for (const zone of zones) {
    for (const device of [zone.red, zone.green, zone.blue]) {
      triggers.push(`echo none > ${shQuote(`/sys/class/leds/${device}/trigger`)}`);
      values.push(`echo 0 > ${shQuote(`/sys/class/leds/${device}/brightness`)}`);
    }
  }
  const result = await adapter.exec([...triggers, ...values].join('\n'), { timeoutMs: 8000 });
  if (result.code !== 0) {
    throw new AccError('LED_WRITE_FAILED', result.stderr.trim() || 'Не удалось погасить LED', 502);
  }
}

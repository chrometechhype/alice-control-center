import type { VolumeScale } from '../shared/types.ts';

/**
 * quasar keeps its own loudness scale and writes the ALSA `Master` register through a piecewise
 * table. `amixer sset Master 40%` therefore lands on a register value quasar reads back as ~29 %,
 * which is why the panel and Alice disagreed about the same speaker. Talking to the register in
 * quasar's units makes the two agree without touching anything on the station.
 */
const PERCENT_AT_TOP = 100;

function interpolate(points: Array<{ x: number; y: number }>, x: number): number {
  if (x <= points[0].x) return points[0].y;
  const last = points[points.length - 1];
  if (x >= last.x) return last.y;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (x <= b.x) {
      const span = b.x - a.x || 1;
      return a.y + ((x - a.x) / span) * (b.y - a.y);
    }
  }
  return last.y;
}

/**
 * Reads the `volume_capability` block out of quasar.cfg. The block is a slice of a bigger JSON
 * document, so it is wrapped back into an object before parsing; anything that does not parse
 * leaves the panel on the plain ALSA percentage rather than guessing.
 */
export function parseVolumeCapability(text: string): VolumeScale | null {
  const block = text.trim();
  if (!block) return null;
  let capability: Record<string, unknown> | null = null;
  for (const candidate of [`{${block}}`, `{${block.replace(/,\s*$/, '')}}`]) {
    try {
      capability = JSON.parse(candidate).volume_capability as Record<string, unknown>;
      break;
    } catch {
      capability = null;
    }
  }
  if (!capability) return null;

  const settings = capability.volume_manager_settings as { platformToOutputMap?: string } | undefined;
  const mapText = settings?.platformToOutputMap;
  if (!mapText) return null;
  let map: Record<string, number>;
  try {
    map = JSON.parse(mapText) as Record<string, number>;
  } catch {
    return null;
  }
  const points = Object.entries(map)
    .map(([platform, output]) => ({ x: Number(platform), y: Number(output) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .sort((a, b) => a.x - b.x);
  if (points.length < 2) return null;

  const dbLevels = (capability.volumeDbLevels ?? {}) as Record<string, number[]>;
  const longest = Object.values(dbLevels).reduce(
    (best, levels) => (Array.isArray(levels) && levels.length > best ? levels.length : best),
    0,
  );

  return {
    points: points.map((point) => ({ platform: point.x, output: point.y })),
    topPlatform: points[points.length - 1].x,
    levelCount: Math.max(longest - 1, 1),
  };
}

/** ALSA register value for a percentage on Alice's scale, or null when it cannot be applied. */
export function percentToRaw(scale: VolumeScale, percent: number, max: number | null): number | null {
  if (max == null || max <= 0) return null;
  const raw = interpolate(
    scale.points.map((point) => ({ x: point.platform, y: point.output })),
    (percent / PERCENT_AT_TOP) * scale.topPlatform,
  );
  const ceiling = max;
  if (raw > ceiling + 1) return null; // a table for different hardware: keep the plain percentage
  return Math.round(Math.min(ceiling, Math.max(0, raw)));
}

/** What quasar would call this register value, in its own 0-100 percent. */
export function rawToPercent(scale: VolumeScale, raw: number): number | null {
  const points = scale.points;
  if (raw < points[0].output || raw > points[points.length - 1].output) return null;
  const ascending = points.map((point) => ({ x: point.output, y: point.platform }));
  const platform = interpolate(ascending, raw);
  return Math.round((platform / scale.topPlatform) * PERCENT_AT_TOP);
}

export function percentToLevel(percent: number, scale: VolumeScale): number {
  return Math.round((percent / PERCENT_AT_TOP) * scale.levelCount);
}

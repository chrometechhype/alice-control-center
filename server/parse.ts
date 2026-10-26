import path from 'node:path';
import type { LedZone } from '../shared/types.ts';

export function parseSections(raw: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '';
  for (const line of raw.replace(/\r/g, '').split('\n')) {
    const match = /^@@([A-Z0-9_]+)$/.exec(line.trim());
    if (match) {
      current = match[1];
      sections[current] = '';
      continue;
    }
    if (!current) continue;
    sections[current] += `${sections[current] ? '\n' : ''}${line}`;
  }
  for (const key of Object.keys(sections)) sections[key] = sections[key].trim();
  return sections;
}

export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } {
  const total = /^MemTotal:\s+(\d+)\s*kB/im.exec(text);
  const available = /^MemAvailable:\s+(\d+)\s*kB/im.exec(text);
  const free = /^MemFree:\s+(\d+)\s*kB/im.exec(text);
  const buffers = /^Buffers:\s+(\d+)\s*kB/im.exec(text);
  const cached = /^Cached:\s+(\d+)\s*kB/im.exec(text);
  const totalKb = total ? Number(total[1]) : 0;
  let availableKb = available ? Number(available[1]) : 0;
  if (!available && free) {
    availableKb = Number(free[1]) + Number(buffers?.[1] ?? 0) + Number(cached?.[1] ?? 0);
  }
  return { totalBytes: totalKb * 1024, availableBytes: availableKb * 1024 };
}

export interface CpuTimes {
  total: number;
  idle: number;
}

export function parseCpuStat(text: string): CpuTimes | null {
  const line = /^cpu\s+(.+)$/m.exec(text);
  if (!line) return null;
  const values = line[1].trim().split(/\s+/).map(Number);
  if (values.length < 4 || values.some(Number.isNaN)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3] + (values[4] ?? 0);
  return { total, idle };
}

export function computeCpuPct(previous: CpuTimes | null, current: CpuTimes | null): number | null {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

export function parseUptime(text: string): number | null {
  const match = /^\s*([\d.]+)/.exec(text);
  return match ? Number(match[1]) : null;
}

export function parseLoadavg(text: string): number | null {
  const match = /^\s*([\d.]+)/.exec(text);
  return match ? Number(match[1]) : null;
}

export interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
  mount: string;
}

export function parseDf(text: string): DiskUsage[] {
  const result: DiskUsage[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    if (!/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) continue;
    const total = Number(parts[1]) * 1024;
    const used = Number(parts[2]) * 1024;
    const mount = parts.slice(5).join(' ');
    result.push({ usedBytes: used, totalBytes: total, mount });
  }
  return result;
}

export function pickDisk(disks: DiskUsage[], mount: string): DiskUsage | null {
  return disks.find((disk) => disk.mount === mount) ?? null;
}

export function parseThermal(text: string): number | null {
  let max: number | null = null;
  for (const line of text.split('\n')) {
    const value = Number(line.trim());
    if (!Number.isFinite(value) || value <= 0) continue;
    let celsius = value;
    if (value > 1000) celsius = value / 1000;
    else if (value > 200) celsius = value / 10;
    if (celsius < 5 || celsius > 150) continue;
    if (max == null || celsius > max) max = celsius;
  }
  return max;
}

export function parseLedZones(names: string[]): LedZone[] {
  const zones = new Map<string, LedZone>();
  for (const name of names) {
    const match = /^(?<prefix>[^:]+):(?<color>red|green|blue):ring(?<ring>\d+)$/.exec(name);
    if (!match?.groups) continue;
    const key = `${match.groups.prefix}:${match.groups.ring}`;
    if (zones.has(key)) continue;
    zones.set(key, {
      index: Number(match.groups.ring) - 1,
      prefix: match.groups.prefix,
      ring: Number(match.groups.ring),
      red: `${match.groups.prefix}:red:ring${match.groups.ring}`,
      green: `${match.groups.prefix}:green:ring${match.groups.ring}`,
      blue: `${match.groups.prefix}:blue:ring${match.groups.ring}`,
    });
  }
  return Array.from(zones.values()).sort((a, b) => a.ring - b.ring);
}

function modeStringToNumber(mode: string): number {
  let value = 0;
  const chars = mode.slice(1, 10);
  const bits = [
    0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001,
  ];
  chars.split('').forEach((char, index) => {
    if (char !== '-' && char !== 'S' && char !== 'T') value |= bits[index];
  });
  return value;
}

export interface LsEntry {
  name: string;
  size: number;
  mtimeMs: number;
  mode: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

export function parseLsLong(text: string): LsEntry[] {
  const entries: LsEntry[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || /^total\s+\d+/.test(line)) continue;
    const full =
      /^([-dlpscb])([rwxStTs-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+([+-]\d{4})\s+(.+)$/.exec(
        line,
      );
    const short =
      /^([-dlpscb])([rwxStTs-]{9})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+([A-Z][a-z]{2}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4}))\s+(.+)$/.exec(
        line,
      );
    let type = '';
    let mode = '';
    let size = 0;
    let mtimeMs = 0;
    let name = '';
    if (full) {
      type = full[1];
      mode = full[2];
      size = Number(full[3]);
      const time = full[5].length === 5 ? `${full[5]}:00` : full[5];
      mtimeMs = Date.parse(`${full[4]}T${time}${full[6].slice(0, 3)}:${full[6].slice(3)}`);
      name = full[7];
    } else if (short) {
      type = short[1];
      mode = short[2];
      size = Number(short[3]);
      const parsed = Date.parse(short[4].replace(/\s+/, ' '));
      mtimeMs = Number.isNaN(parsed) ? 0 : parsed;
      name = short[5];
    } else {
      continue;
    }
    const linkSplit = name.split(' -> ');
    const isSymbolicLink = type === 'l' || linkSplit.length > 1;
    const cleanName = linkSplit[0].trim();
    if (!cleanName) continue;
    entries.push({
      name: cleanName,
      size,
      mtimeMs: Number.isNaN(mtimeMs) ? 0 : mtimeMs,
      mode: modeStringToNumber(`${type}${mode}`),
      isDirectory: type === 'd',
      isFile: type === '-',
      isSymbolicLink,
    });
  }
  return entries;
}

export function parseWifiRssi(text: string): number | null {
  for (const line of text.split('\n')) {
    const match = /^\s*\w+:\s+\S+\s+\S+\s+(-?\d+)\.?/.exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value < 0 && value > -100) return value;
  }
  return null;
}

export function parseQuasarFullVersion(text: string): string {
  const match = /Quasar Software Version:\s*(\S+)/.exec(text);
  return match?.[1] ?? '';
}

export interface HciStatus {
  adapter: string | null;
  powered: boolean | null;
  name: string | null;
  address: string | null;
}

export function parseHciConfig(text: string): HciStatus {
  const adapter = /^(hci\d+):/m.exec(text)?.[1] ?? null;
  const address = /BD Address:\s*([0-9A-F:]{17})/i.exec(text)?.[1] ?? null;
  const name = /Name:\s*'([^']*)'/.exec(text)?.[1] ?? null;
  let powered: boolean | null = null;
  if (/UP RUNNING/.test(text)) powered = true;
  else if (/\bDOWN\b/.test(text)) powered = false;
  return { adapter, powered, name, address };
}

export function parseBluetoothctlShow(text: string): {
  alias: string | null;
  name: string | null;
  powered: boolean | null;
  discoverable: boolean | null;
  pairable: boolean | null;
  address: string | null;
} {
  return {
    alias: /^\s*Alias:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
    name: /^\s*Name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null,
    powered: /^\s*Powered:\s*(yes|no)/m.test(text)
      ? /^\s*Powered:\s*yes/m.test(text)
      : null,
    discoverable: /^\s*Discoverable:\s*(yes|no)/m.test(text)
      ? /^\s*Discoverable:\s*yes/m.test(text)
      : null,
    pairable: /^\s*Pairable:\s*(yes|no)/m.test(text)
      ? /^\s*Pairable:\s*yes/m.test(text)
      : null,
    address: /^\s*Controller\s+([0-9A-F:]{17})/im.exec(text)?.[1] ?? null,
  };
}

export interface AmixerMaster {
  volumePct: number | null;
  raw: number | null;
  max: number | null;
  muted: boolean | null;
}

export function parseAmixerMaster(text: string): AmixerMaster {
  const percent = /\[\s*(\d{1,3})%\s*\]/.exec(text);
  const raw = /Playback\s+(\d+)\s*\[/.exec(text) ?? /Front Left:\s*Playback\s+(\d+)/.exec(text);
  const max = /Limits:\s*Playback\s+\d+\s*-\s*(\d+)/.exec(text);
  const muted = /\[off\]/.test(text) ? true : /\[on\]/.test(text) ? false : null;
  return {
    volumePct: percent ? Number(percent[1]) : null,
    raw: raw ? Number(raw[1]) : null,
    max: max ? Number(max[1]) : null,
    muted,
  };
}

export function parseIpAddress(text: string): string | null {  const candidates: string[] = [];
  for (const line of text.split('\n')) {
    const match = /\binet\s+(\d+\.\d+\.\d+\.\d+)\/\d+/.exec(line);
    if (!match) continue;
    if (match[1].startsWith('127.')) continue;
    candidates.push(match[1]);
  }
  return candidates[0] ?? null;
}

export function parseOsRelease(text: string): string {
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1];
  if (pretty) return pretty;
  const name = /^NAME="?([^"\n]+)"?/m.exec(text)?.[1];
  return name ?? 'Buildroot';
}

export function parseCpuModel(cpuinfo: string): string {
  const hardware = /^Hardware\s*:\s*(.+)$/m.exec(cpuinfo)?.[1];
  const model = /^(?:model name|Processor)\s*:\s*(.+)$/m.exec(cpuinfo)?.[1];
  return (hardware || model || 'ARM').trim();
}

export function parseCpuCores(cpuinfo: string): number {
  const processors = cpuinfo.match(/^processor\s*:/gm);
  return processors ? processors.length : 0;
}

export function guessModel(modelRaw: string, hostname: string): string {
  const haystack = `${modelRaw} ${hostname}`.toLowerCase();
  const table: Array<[RegExp, string]> = [
    [/pickle/, 'Станция Мини 3 Про'],
    [/bergamot|mini ?3/, 'Станция Мини 3'],
    [/prune|lite-gen2|lite gen2/, 'Станция Лайт 2'],
    [/mini ?2/, 'Станция Мини 2'],
    [/plum/, 'Станция Лайт 2'],
    [/micro/, 'Станция Лайт'],
    [/cucumber|station midi|station-midi/, 'Станция Миди'],
    [/mango|street/, 'Станция Стрит'],
    [/midi/, 'Станция 2'],
    [/station mini|miniature/, 'Станция Мини'],
    [/hub|saturn/, 'Умный хаб'],
  ];
  for (const [pattern, label] of table) {
    if (pattern.test(haystack)) return label;
  }
  return modelRaw || hostname || 'Неизвестное устройство';
}

export function parseQuasarVersion(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? '';
}

export function parseToolPath(text: string): string | null {
  const line = text.split('\n').map((item) => item.trim()).find(Boolean);
  return line && !line.includes('not found') ? line : null;
}

export function parseYamStatus(text: string): { running: boolean; port: number | null; path: string | null } {
  const running = /\byamd\b/.test(text) || /LISTEN/.test(text);
  const port = /:(\d+)\s/.test(text) ? Number(/:(\d+)\s/.exec(text)?.[1]) : null;
  const pathMatch = /(\/data\/quazar\/yam)/.exec(text);
  return { running, port, path: pathMatch?.[1] ?? null };
}

export function parseLogFiles(names: string[]): string[] {
  return names.filter((name) => /\.log$|\.txt$/.test(name)).sort();
}

export function soundCategory(relativePath: string): string {
  const segments = relativePath.split('/');
  if (segments.length > 1) return segments[0];
  return 'root';
}

export function isSoundFile(name: string): boolean {
  return ['.opus', '.ogg', '.mp3', '.wav', '.flac', '.m4a'].includes(
    path.posix.extname(name).toLowerCase(),
  );
}

export function baseName(remotePath: string): string {
  return remotePath.split('/').filter(Boolean).pop() ?? remotePath;
}

export interface AdbDevice {
  serial: string;
  state: string;
  model: string | null;
  product: string | null;
  transportId: string | null;
}

export function parseAdbDevices(text: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^List of devices/i.test(trimmed) || trimmed.startsWith('*')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...rest] = parts;
    if (!state) continue;
    const attrs: Record<string, string> = {};
    for (const item of rest) {
      const [key, value] = item.split(':');
      if (key && value) attrs[key] = value;
    }
    devices.push({
      serial,
      state,
      model: attrs.model ?? null,
      product: attrs.product ?? null,
      transportId: attrs.transport_id ?? null,
    });
  }
  return devices;
}

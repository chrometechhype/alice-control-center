import path from 'node:path';
import type { LedZone } from '../shared/types.ts';
import { shQuote } from './util.ts';

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
  /** Full path as the shell saw it; only the byte-safe walkers can offer it, `ls` mangles it. */
  path?: string;
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

/**
 * BusyBox `ls` — the only ls on this station — replaces every byte above 0x7f with '?', and no flag,
 * locale or `-b`/`-Q` form changes that. A listing built straight from it therefore hands the UI
 * paths that do not exist, so «проверка кириллицы.wav» comes back as 39 '?' and refuses to open or
 * delete. A shell glob printed with `printf` keeps the raw bytes, so the name is taken from the glob
 * and only the attributes come from `ls`, where mangling is harmless. Costs one `ls` per entry —
 * tens of milliseconds on a directory of this size, and far cheaper than a broken path.
 */
export function dirWalkCommand(remotePath: string, fullTime = true): string {
  const flag = fullTime ? '--full-time ' : '';
  return [
    `d=${shQuote(remotePath)};`,
    'if [ ! -d "$d" ]; then echo "ls: cannot access $d: No such file or directory" >&2; exit 2; fi;',
    'for f in "$d"/* "$d"/.[!.]* "$d"/..?*; do',
    '[ -e "$f" ] || [ -L "$f" ] || continue;',
    'if [ -L "$f" ]; then k=l;',
    'elif [ -d "$f" ]; then k=d;',
    'elif [ -f "$f" ]; then k=f;',
    'else k=o; fi;',
    `a=$(ls -ld ${flag}"$f" 2>/dev/null);`,
    `printf '%s\\t%s\\t%s\\n' "$k" "$a" "$f";`,
    'done',
  ].join(' ');
}

/** Turns one `dirWalkCommand` line into an entry: `ls` attributes plus the byte-safe path. */
export function parseDirWalk(text: string): LsEntry[] {
  const entries: LsEntry[] = [];
  for (const line of text.split('\n')) {
    const kindEnd = line.indexOf('\t');
    const attrsEnd = line.indexOf('\t', kindEnd + 1);
    if (kindEnd < 0 || attrsEnd < 0) continue;
    const fullPath = line.slice(attrsEnd + 1);
    const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
    if (!name) continue;
    const kind = line.slice(0, kindEnd);
    const [attrs] = parseLsLong(line.slice(kindEnd + 1, attrsEnd));
    entries.push(
      attrs
        ? { ...attrs, name, path: fullPath }
        : {
            name,
            path: fullPath,
            size: 0,
            mtimeMs: 0,
            mode: 0,
            isDirectory: kind === 'd',
            isFile: kind === 'f',
            isSymbolicLink: kind === 'l',
          },
    );
  }
  return entries;
}

/** The same walk as `dirWalkCommand`, but descending into subdirectories in one shell pass. */
export function dirTreeCommand(remotePath: string, maxDepth = 4, fullTime = true): string {
  const flag = fullTime ? '--full-time ' : '';
  return [
    `d=${shQuote(remotePath)};`,
    'if [ ! -d "$d" ]; then echo "ls: cannot access $d: No such file or directory" >&2; exit 2; fi;',
    'walk() {',
    'local t=$1 k=$2 f k2 a;',
    'for f in "$t"/* "$t"/.[!.]* "$t"/..?*; do',
    '[ -e "$f" ] || [ -L "$f" ] || continue;',
    'if [ -L "$f" ]; then k2=l;',
    'elif [ -d "$f" ]; then k2=d;',
    'elif [ -f "$f" ]; then k2=f;',
    'else k2=o; fi;',
    `a=$(ls -ld ${flag}"$f" 2>/dev/null);`,
    `printf '%s\\t%s\\t%s\\n' "$k2" "$a" "$f";`,
    `if [ "$k2" = d ] && [ "$k" -lt ${maxDepth} ]; then walk "$f" $((k + 1)); fi;`,
    'done;',
    '};',
    'walk "$d" 1',
  ].join(' ');
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

export const BT_DEVICES_MARK = '@@ACC_DEVICES@@';
export const BT_PAIRED_MARK = '@@ACC_PAIRED@@';
export const BT_CONNECTED_MARK = '@@ACC_CONNECTED@@';

/**
 * One shell line that runs four bluetoothctl commands with markers between them. The caller prefixes
 * only the first one, so every later part spells `bluetoothctl` itself — a bare `devices` would run
 * as a shell command, fail with «not found» and leave the panel with an empty device list.
 */
export function btBatchCommand(): string {
  return `show; echo ${BT_DEVICES_MARK}; bluetoothctl devices;`
    + ` echo ${BT_PAIRED_MARK}; bluetoothctl devices Paired;`
    + ` echo ${BT_CONNECTED_MARK}; bluetoothctl devices Connected`;
}

export interface BtBatch {
  show: string;
  known: string;
  paired: string;
  connected: string;
}

/**
 * The panel asks for `show`, `devices`, `devices Paired` and `devices Connected` in a single exec —
 * one SSH channel instead of four — and splits the answer back apart on the markers it echoed
 * between commands. `paired` is missing when the marker never arrived, and the caller then treats
 * every known device as paired rather than guessing from an empty block.
 */
export function parseBtBatch(stdout: string): BtBatch {
  const parts = stdout.split(
    new RegExp(`${BT_DEVICES_MARK}|${BT_PAIRED_MARK}|${BT_CONNECTED_MARK}`),
  );
  return {
    show: (parts[0] ?? '').trim(),
    known: parts[1] ?? '',
    paired: parts[2] ?? '',
    connected: parts[3] ?? '',
  };
}

/**
 * True when `bluetoothctl devices Paired` ran. An empty block means «no bonded devices» — the honest
 * answer — while an old bluetoothctl prints its usage text instead, which the caller falls back on.
 */
export function bluetoothPairedFilterWorks(batch: BtBatch): boolean {
  return !/too many arguments|usage:|unknown|not supported/i.test(batch.paired);
}

/**
 * `connect` prints «Connection successful» before the link is really up, so the interactive session
 * ends with `info` and its «Connected: yes/no» is the answer the panel reports. Without an info
 * block the successful line is the only evidence there is.
 */
export function bluetoothSessionConnected(stdout: string): boolean {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  if (/Connected:\s*yes/i.test(plain)) return true;
  if (/Connected:\s*no/i.test(plain)) return false;
  return /Connection successful/i.test(plain);
}

/** Pairing is «already done» when BlueZ says so — a second `pair` on a bonded device is not a failure. */
export function bluetoothSessionPaired(stdout: string, fallback: boolean): boolean {
  const plain = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  if (/Pairing successful/i.test(plain)) return true;
  if (/AlreadyExists|already paired/i.test(plain)) return true;
  if (/Failed to pair/i.test(plain)) return false;
  return fallback;
}

/**
 * `bluetoothctl` answers in English, and BlueZ errors are useless without context: «Device XX not
 * available» means BlueZ has no live object for that address, which almost always means the earbuds
 * sleep in the case, are out of range or are held by the phone. The raw text goes to the journal;
 * this is what the person in front of the panel reads, together with the action that fixes it.
 */
export function explainBtFailure(output: string, address: string): string {
  const text = output.trim();
  if (!text) return 'bluetoothctl не ответил — колонка не отвечает.';
  const lower = text.toLowerCase();
  if (lower.includes('not powered'))
    return 'Bluetooth-адаптер колонки выключен. Нажмите «Включить» и повторите.';
  if (lower.includes('alreadyexists') || lower.includes('already paired'))
    return `Устройство ${address} уже сопряжено — повторное сопряжение не нужно, просто нажмите «Подключить».`;
  if (lower.includes('authentication') || lower.includes('pin code'))
    return 'Наушники отклонили сопряжение. Так бывает, когда они уже заняты телефоном: отключите их там и повторите.';
  if (
    lower.includes('host is down') ||
    lower.includes('page timeout') ||
    lower.includes('timed out') ||
    lower.includes('not available')
  )
    return `Колонка не достучалась до ${address}: наушники спят в кейсе, далеко или подключены к телефону. К двум устройствам сразу они не умеют — отключите их на телефоне, поднесите к колонке, нажмите «Сканировать» и повторите.`;
  if (lower.includes('no such device') || lower.includes('invalid arguments'))
    return `Колонка не знает адрес ${address}. Нажмите «Сканировать», чтобы найти устройство заново.`;
  if (lower.includes('not connected')) return `${address} уже отключено — активного соединения нет.`;
  if (lower.includes('busy') || lower.includes('in progress'))
    return 'Адаптер колонки занят другим Bluetooth-действием. Подождите 10-15 секунд и повторите.';
  return `Bluetooth-действие не удалось: ${text.split('\n').filter(Boolean).at(-1) ?? text}`;
}

export interface AmixerMaster {
  volumePct: number | null;
  raw: number | null;
  max: number | null;
  muted: boolean | null;
  /** Some stations ship Master as a pure volume control with no mute switch at all. */
  hasSwitch: boolean;
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
    hasSwitch: /Capabilities:.*pswitch/.test(text),
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
    [/mini[\s_-]*2[\s\S]*clock|мини[\s_-]*2[\s\S]*час/, 'Станция Мини 2 с часами'],
    [/mini[\s_-]*2|мини[\s_-]*2/, 'Станция Мини 2'],
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

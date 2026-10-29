import type {
  WifiConfigNetwork,
  WifiScanEntry,
  WifiSecurity,
  WifiStatus,
} from '../shared/types.ts';
import { AccError } from './errors.ts';
import { shQuote } from './util.ts';

/**
 * The station firmware has no NetworkManager — only wpa_supplicant. The panel therefore reads the
 * same file the daemon reads (`/bkupgrade/data/wpa_supplicant.conf`), edits it in place and asks
 * wpa_cli to reconfigure, so a network switch lands without a reboot.
 */

export const WPA_CONFIG_CANDIDATES = [
  '/bkupgrade/data/wpa_supplicant.conf',
  '/data/misc/wifi/wpa_supplicant.conf',
  '/etc/wpa_supplicant.conf',
] as const;

export const WPA_CONFIG_DEFAULT = WPA_CONFIG_CANDIDATES[0];
const BACKUP_SUFFIX = '.acc-bak';

/** Parses one unquoted or double-quoted wpa_supplicant value. */
function readValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    let out = '';
    for (let index = 1; index < value.length - 1; index += 1) {
      const char = value[index];
      const next = value[index + 1];
      // Only `\\` and `\"` are escapes in wpa_supplicant; any other backslash is literal.
      if (char === '\\' && (next === '\\' || next === '"') && index + 1 < value.length - 1) {
        out += next;
        index += 1;
        continue;
      }
      out += char;
    }
    return out;
  }
  return value;
}

export interface WpaBlock {
  ssid: string | null;
  /** Raw text exactly as it sits in the file, so untouched networks stay byte-for-byte the same. */
  raw: string;
  start: number;
  end: number;
}

export interface ParsedWpaConfig {
  header: string;
  blocks: WpaBlock[];
}

/** Splits the file into its header and `network={…}` blocks without normalising anything. */
export function parseWpaConfig(text: string): ParsedWpaConfig {
  const blocks: WpaBlock[] = [];
  const blockPattern = /^[ \t]*network[ \t]*=[ \t]*\{/gm;
  let match: RegExpExecArray | null;
  let firstStart = -1;
  while ((match = blockPattern.exec(text))) {
    const start = match.index;
    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) break;
    if (firstStart < 0) firstStart = start;
    const raw = text.slice(start, end);
    const ssidMatch = /^[ \t]*ssid[ \t]*=[ \t]*(.+)$/m.exec(raw);
    blocks.push({
      ssid: ssidMatch ? readValue(ssidMatch[1]) : null,
      raw,
      start,
      end,
    });
    blockPattern.lastIndex = end;
  }
  return { header: firstStart >= 0 ? text.slice(0, firstStart) : text, blocks };
}

function blockValue(raw: string, key: string): string | null {
  const match = new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.+)$`, 'm').exec(raw);
  return match ? readValue(match[1]) : null;
}

/** Everything the panel shows about a saved network; `psk` is the real password, never masked here. */
export function parseWpaNetworks(text: string): WifiConfigNetwork[] {
  return parseWpaConfig(text).blocks.map((block, index) => ({
    /** Stable per file: the panel uses it as a list key. */
    id: `${index}-${block.ssid ?? 'hidden'}`,
    ssid: block.ssid ?? '',
    psk: blockValue(block.raw, 'psk'),
    keyMgmt: blockValue(block.raw, 'key_mgmt'),
    priority: Number(blockValue(block.raw, 'priority')) || null,
    hidden: blockValue(block.raw, 'scan_ssid') === '1',
    disabled: blockValue(block.raw, 'disabled') === '1',
  }));
}

/** Masked copy for logs and the debug bundle: the password never leaves the panel in plain text. */
export function maskWpaConfig(text: string): string {
  return text.replace(/^([ \t]*psk[ \t]*=[ \t]*)(.+)$/gim, (_, prefix: string, value: string) => {
    const quoted = /^".*"$/.test(value.trim());
    const secret = quoted ? value.trim().slice(1, -1) : value.trim();
    return `${prefix}"${secret ? '***' : ''}"`;
  });
}

function wpaQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface WifiConnectInput {
  ssid: string;
  password?: string;
  security?: WifiSecurity;
  hidden?: boolean;
  priority?: number;
}

export function validateWifiInput(input: WifiConnectInput): void {
  const ssid = input.ssid;
  if (!ssid.length) throw new AccError('BAD_SSID', 'Название сети пустое', 400);
  if (Buffer.byteLength(ssid, 'utf8') > 32) {
    throw new AccError('BAD_SSID', 'Имя сети Wi-Fi не длиннее 32 байт', 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(ssid)) {
    throw new AccError('BAD_SSID', 'В имени сети есть непечатаемые символы', 400);
  }
  const password = input.password ?? '';
  const open = input.security === 'open';
  if (open && password) throw new AccError('BAD_PASSWORD', 'Для открытой сети пароль не нужен', 400);
  if (!open) {
    const isHexKey = /^[0-9a-fA-F]{64}$/.test(password);
    const isPassphrase = password.length >= 8 && password.length <= 63 && /^[\u0020-\u007e]+$/.test(password);
    if (!isHexKey && !isPassphrase) {
      throw new AccError(
        'BAD_PASSWORD',
        'Пароль WPA — от 8 до 63 печатных символов или 64 шестнадцатеричных знака',
        400,
      );
    }
  }
}

function buildBlock(input: WifiConnectInput): string {
  const security = input.security ?? 'wpa2';
  const lines = ['network={', `    ssid=${wpaQuote(input.ssid)}`];
  if (security === 'open') {
    lines.push('    key_mgmt=NONE');
  } else {
    lines.push(`    psk=${wpaQuote(input.password ?? '')}`);
    lines.push(
      security === 'wpa3'
        ? '    key_mgmt=SAE'
        : security === 'enterprise'
          ? '    key_mgmt=WPA-EAP'
          : '    key_mgmt=WPA-PSK',
    );
  }
  if (input.hidden) lines.push('    scan_ssid=1');
  if (input.priority != null) lines.push(`    priority=${Math.round(input.priority)}`);
  lines.push('}');
  return lines.join('\n');
}

function defaultHeader(): string {
  return ['ctrl_interface=/var/run/wpa_supplicant', 'update_config=1', ''].join('\n');
}

function normaliseHeader(header: string): string {
  const trimmed = header.trim();
  if (!trimmed) return defaultHeader();
  return header.endsWith('\n') ? header : `${header}\n`;
}

/** Adds or replaces the block for `ssid`, leaving every other network untouched. */
export function upsertWpaNetwork(text: string, input: WifiConnectInput): string {
  const parsed = parseWpaConfig(text);
  const header = normaliseHeader(parsed.header);
  const block = buildBlock(input);
  const target = parsed.blocks.findIndex((item) => item.ssid === input.ssid);
  if (target < 0) {
    const tail = parsed.blocks.map((item) => item.raw).join('\n\n');
    return `${header}${tail ? `${tail}\n\n` : ''}${block}\n`;
  }
  const pieces: string[] = [];
  let cursor = 0;
  parsed.blocks.forEach((item, index) => {
    pieces.push(text.slice(cursor, item.start));
    pieces.push(index === target ? block : item.raw);
    cursor = item.end;
  });
  pieces.push(text.slice(cursor));
  return pieces.join('');
}

export function removeWpaNetwork(text: string, ssid: string): string {
  const parsed = parseWpaConfig(text);
  if (!parsed.blocks.some((item) => item.ssid === ssid)) return text;
  const header = normaliseHeader(parsed.header);
  const kept = parsed.blocks.filter((item) => item.ssid !== ssid).map((item) => item.raw);
  return `${header}${kept.length ? `${kept.join('\n\n')}\n` : ''}`;
}

export function parseWpaStatus(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split('\n')) {
    // `ssid=Моя сеть` keeps its spaces: only the key has to look like a key.
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[a-z_]+$/i.test(key)) continue;
    result[key] = line.slice(index + 1).trim();
  }
  return result;
}

function securityFromFlags(flags: string): WifiSecurity {
  if (/WPA3|SAE/i.test(flags)) return 'wpa3';
  if (/WPA2/i.test(flags)) return 'wpa2';
  if (/WPA/i.test(flags)) return 'wpa';
  if (/WEP/i.test(flags)) return 'wep';
  if (/EAP|802\.1X/i.test(flags)) return 'enterprise';
  return 'open';
}

const SECURITY_LABEL: Record<WifiSecurity, string> = {
  open: 'без пароля',
  wep: 'WEP',
  wpa: 'WPA',
  wpa2: 'WPA2',
  wpa3: 'WPA3',
  enterprise: 'предприятие (802.1X)',
};

export function wifiSecurityLabel(security: WifiSecurity): string {
  return SECURITY_LABEL[security];
}

/** `wpa_cli scan_results` is tab separated on this firmware; the header line is skipped by shape. */
export function parseScanResults(text: string): WifiScanEntry[] {
  const bySsid = new Map<string, WifiScanEntry>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}\s/i.test(trimmed)) continue;
    const parts = trimmed.split(/\t+|\s{2,}/).filter(Boolean);
    if (parts.length < 4) continue;
    const bssid = parts[0].toLowerCase();
    const freq = Number(parts[1]) || null;
    const signal = Number(parts[2]);
    const flags = parts[3] ?? '';
    const ssid = parts.slice(4).join(' ').trim();
    if (!ssid) continue;
    const entry: WifiScanEntry = {
      ssid,
      bssid,
      freq,
      signal: Number.isFinite(signal) ? signal : null,
      security: securityFromFlags(flags),
      hidden: false,
    };
    const previous = bySsid.get(ssid);
    if (!previous || (entry.signal ?? -999) > (previous.signal ?? -999)) bySsid.set(ssid, entry);
  }
  return [...bySsid.values()].sort((left, right) => (right.signal ?? -999) - (left.signal ?? -999));
}

export interface WifiReadResult {
  status: WifiStatus;
  configText: string;
}

const SECTION = '@@ACC_';

/**
 * One SSH round-trip for the interface, the config file, the live status and saved networks.
 * The file is read as root, so this is also the only way to know the password the station uses.
 */
export function wifiReadCommand(): string {
  return [
    'IFACE=""',
    'for i in wlan0 wlp1s0 wlp2s0 wlan1; do',
    '  if wpa_cli -i "$i" status 2>/dev/null | grep -q "^wpa_state="; then IFACE="$i"; break; fi',
    'done',
    '[ -z "$IFACE" ] && IFACE="wlan0"',
    'CONF=""',
    'for c in ' + WPA_CONFIG_CANDIDATES.map((path) => shQuote(path)).join(' ') + '; do',
    '  if [ -f "$c" ]; then CONF="$c"; break; fi',
    'done',
    `echo "${SECTION}IFACE"`,
    'echo "$IFACE"',
    `echo "${SECTION}CONF"`,
    'echo "$CONF"',
    `echo "${SECTION}CLI"`,
    'command -v wpa_cli 2>/dev/null || echo ""',
    `echo "${SECTION}STATUS"`,
    'wpa_cli -i "$IFACE" status 2>&1 || true',
    `echo "${SECTION}NETWORKS"`,
    'wpa_cli -i "$IFACE" list_networks 2>&1 || true',
    `echo "${SECTION}FILE"`,
    '[ -n "$CONF" ] && cat "$CONF" 2>/dev/null || true',
    `echo "${SECTION}END"`,
  ].join('\n');
}

function section(text: string, name: string): string {
  const start = text.indexOf(`${SECTION}${name}`);
  if (start < 0) return '';
  const from = text.indexOf('\n', start);
  if (from < 0) return '';
  const next = text.indexOf(SECTION, from + 1);
  return (next < 0 ? text.slice(from + 1) : text.slice(from + 1, next)).trim();
}

export function parseWifiRead(output: string): WifiReadResult {
  const iface = (section(output, 'IFACE').split('\n')[0] || 'wlan0').trim();
  const confPath = (section(output, 'CONF').split('\n')[0] || '').trim();
  const cliPath = (section(output, 'CLI').split('\n')[0] || '').trim();
  const statusRaw = section(output, 'STATUS');
  const status = parseWpaStatus(statusRaw);
  const fileText = section(output, 'FILE');
  const networks = parseWpaNetworks(fileText);
  const ssid = status.ssid ?? '';
  const connectedNetwork = networks.find((network) => network.ssid === ssid) ?? null;
  const state = status.wpa_state ?? '';
  return {
    configText: fileText,
    status: {
      available: Boolean(cliPath),
      cliPath: cliPath || null,
      interface: iface,
      configPath: confPath || null,
      state,
      connected: state === 'COMPLETED' && ssid
        ? {
            ssid,
            /** The station's real password, so «не забыть» needs no extra trip. */
            psk: connectedNetwork?.psk ?? null,
            keyMgmt: status.key_mgmt ?? connectedNetwork?.keyMgmt ?? null,
            bssid: status.bssid ?? null,
            ip: status.ip_address ?? null,
            freq: Number(status.freq) || null,
          }
        : null,
      networks,
      raw: statusRaw,
    },
  };
}

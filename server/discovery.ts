import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface DiscoveredHost {
  ip: string;
  port: number;
  banner: string;
  mac?: string;
  name?: string;
  source: 'mdns' | 'tcp' | 'arp';
}

export interface DiscoverOptions {
  timeoutMs?: number;
  ports?: number[];
  signal?: AbortSignal;
}

const DEFAULT_PORTS = [22, 2222];
const SWEEP_CONCURRENCY = 128;
const SWEEP_TIMEOUT_MS = 400;
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const YANDEX_HINT = /yandex|яндекс|station|станц|quasar|quazar|alice|алис/i;

function localInterfaces(): Array<{ name: string; address: string; netmask: string }> {
  const result: Array<{ name: string; address: string; netmask: string }> = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== 'IPv4' || entry.address.startsWith('169.254.')) continue;
      result.push({ name, address: entry.address, netmask: entry.netmask });
    }
  }
  return result;
}

export function localSubnets(): string[] {
  const subnets = new Set<string>();
  for (const iface of localInterfaces()) {
    if (iface.netmask !== '255.255.255.0') continue;
    subnets.add(`${iface.address.split('.').slice(0, 3).join('.')}.0/24`);
  }
  return [...subnets];
}

/** The interface most likely shared with the station: same /24 as the target host. */
export function interfaceForHost(host: string): { name: string; address: string } | null {
  const prefix = host.split('.').slice(0, 3).join('.');
  for (const iface of localInterfaces()) {
    if (iface.address.split('.').slice(0, 3).join('.') === prefix) {
      return { name: iface.name, address: iface.address };
    }
  }
  return null;
}

function candidateIps(): Map<string, string | undefined> {
  const hosts = new Map<string, string | undefined>();
  for (const iface of localInterfaces()) {
    // Only a plain /24 is worth sweeping; a VPN adapter with an 8-bit mask is not a LAN.
    if (iface.netmask !== '255.255.255.0') continue;
    const prefix = iface.address.split('.').slice(0, 3).join('.');
    for (let last = 1; last <= 254; last += 1) {
      const ip = `${prefix}.${last}`;
      if (ip !== iface.address) hosts.set(ip, undefined);
    }
  }
  return hosts;
}

function runArp(): Promise<string> {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { windowsHide: true, timeout: 4000 }, (_error, stdout) => {
      resolve(stdout ?? '');
    });
  });
}

const ARP_IP_MAC =
  /(\d{1,3}(?:\.\d{1,3}){3})[)\s]*([0-9a-fA-F]{2}(?:[:-][0-9a-fA-F]{2}){5})/g;

/** Parses `arp -a` on Windows and POSIX into ip -> mac. */
export function parseArpTable(text: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const match of text.matchAll(ARP_IP_MAC)) {
    table.set(match[1], match[2].toLowerCase().replace(/:/g, '-'));
  }
  return table;
}

export async function macOfIp(ip: string): Promise<string | undefined> {
  const table = parseArpTable(await runArp());
  return table.get(ip);
}

async function arpTable(): Promise<Map<string, string>> {
  return parseArpTable(await runArp());
}

function connectBanner(ip: string, port: number, timeoutMs: number): Promise<DiscoveredHost | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: ip, port });
    let banner = '';
    let done = false;
    const finish = (value: DiscoveredHost | null): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk) => {
      banner += chunk.toString('utf8');
      if (banner.includes('\n') || banner.length > 120) {
        const line = banner.split(/\r?\n/)[0].trim().slice(0, 120);
        finish(line.startsWith('SSH-') ? { ip, port, banner: line, source: 'tcp' } : null);
      }
    });
    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('close', () => {
      const line = banner.split(/\r?\n/)[0].trim();
      finish(line.startsWith('SSH-') ? { ip, port, banner: line, source: 'tcp' } : null);
    });
  });
}

async function sweep(
  ips: string[],
  ports: number[],
  perHostTimeoutMs: number,
  deadline: number,
): Promise<DiscoveredHost[]> {
  const found: DiscoveredHost[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() > deadline) return;
      const index = cursor;
      cursor += 1;
      if (index >= ips.length) return;
      const ip = ips[index];
      const results = await Promise.all(ports.map((port) => connectBanner(ip, port, perHostTimeoutMs)));
      for (const result of results) {
        if (result) found.push(result);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SWEEP_CONCURRENCY, ips.length) }, () => worker()),
  );
  return found;
}

// --- minimal mDNS (DNS-SD) browser -----------------------------------------

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const encoded = Buffer.from(part, 'utf8');
    buffers.push(Buffer.from([encoded.length]), encoded);
  }
  buffers.push(Buffer.from([0]));
  return Buffer.concat(buffers);
}

function buildQuery(instance: string, unicast: boolean): Buffer {
  const header = Buffer.alloc(12);
  randomBytes(2).copy(header, 0);
  header.writeUInt16BE(unicast ? 0x0100 : 0x0000, 2);
  header.writeUInt16BE(1, 4);
  const question = encodeName(instance);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0);
  tail.writeUInt16BE(1, 2);
  tail[2] = unicast ? 0x80 : 0x00;
  return Buffer.concat([header, question, tail]);
}

function readName(message: Buffer, offset: number, depth = 0): { name: string; next: number } {
  let name = '';
  let cursor = offset;
  let next = offset;
  while (cursor < message.length && depth < 8) {
    const length = message[cursor];
    if (length === 0) {
      cursor += 1;
      next = cursor;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | message[cursor + 1];
      const jumped = readName(message, pointer, depth + 1);
      name = name ? `${name}.${jumped.name}` : jumped.name;
      if (depth === 0) next = cursor + 2;
      cursor = jumped.next;
      break;
    }
    const label = message.subarray(cursor + 1, cursor + 1 + length).toString('utf8');
    name = name ? `${name}.${label}` : label;
    cursor += 1 + length;
    next = cursor;
  }
  return { name, next };
}

interface MdnsRecord {
  name: string;
  type: number;
  target?: string;
  port?: number;
  address?: string;
}

function parseRecords(message: Buffer): MdnsRecord[] {
  if (message.length < 12) return [];
  const counts = {
    answers: message.readUInt16BE(6),
    authority: message.readUInt16BE(8),
    additional: message.readUInt16BE(10),
  };
  const records: MdnsRecord[] = [];
  let cursor = 12;
  const questionName = readName(message, cursor);
  cursor = questionName.next + 4;
  const total = counts.answers + counts.authority + counts.additional;
  for (let index = 0; index < total && cursor < message.length; index += 1) {
    const name = readName(message, cursor);
    cursor = name.next;
    if (cursor + 10 > message.length) break;
    const type = message.readUInt16BE(cursor);
    const dataLength = message.readUInt16BE(cursor + 8);
    const dataStart = cursor + 10;
    const dataEnd = Math.min(dataStart + dataLength, message.length);
    cursor = dataEnd;
    if (type === 12) {
      records.push({ name: name.name, type, target: readName(message, dataStart).name });
    } else if (type === 33) {
      const port = dataStart + 6 <= dataEnd ? message.readUInt16BE(dataStart + 6) : undefined;
      const target = dataStart + 8 <= dataEnd ? readName(message, dataStart + 8).name : undefined;
      records.push({ name: name.name, type, port, target });
    } else if (type === 1 && dataEnd - dataStart === 4) {
      records.push({
        name: name.name,
        type,
        address: [...message.subarray(dataStart, dataEnd)].join('.'),
      });
    }
  }
  return records;
}

function mdnsBrowse(instance: string, timeoutMs: number): Promise<Array<{ name: string; ip: string; port: number }>> {
  return new Promise((resolve) => {
    const hits = new Map<string, { name: string; ip: string; port: number }>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.close();
      resolve([...hits.values()]);
    };

    const handle = (message: Buffer): void => {
      const records = parseRecords(message);
      const instances = new Set(
        records.filter((record) => record.type === 12 && record.target).map((record) => record.target!),
      );
      const addresses = new Map<string, string>();
      for (const record of records) {
        if (record.type === 1 && record.address) addresses.set(record.name.toLowerCase(), record.address);
      }
      for (const record of records) {
        if (record.type !== 33 || !record.target || record.port == null) continue;
        const lowered = record.name.toLowerCase();
        if (!lowered.endsWith(instance.toLowerCase())) continue;
        const ip = addresses.get(record.target.toLowerCase());
        if (!ip) continue;
        hits.set(`${ip}:${record.port}`, {
          name: record.name.replace(new RegExp(`\\.${instance}$`, 'i'), '').trim(),
          ip,
          port: record.port,
        });
      }
      if (instances.size && records.some((record) => record.type === 1)) finish();
    };

    socket.on('message', handle);
    socket.on('error', finish);
    timer = setTimeout(finish, timeoutMs);
    socket.bind(MDNS_PORT, () => {
      try {
        socket.setMulticastTTL(2);
        for (const iface of localInterfaces()) {
          try {
            socket.addMembership(MDNS_GROUP, iface.address);
          } catch {
            // интерфейс не поддерживает групповую рассылку
          }
        }
      } catch {
        finish();
        return;
      }
      const query = buildQuery(instance, false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_GROUP, (error) => {
          if (error) finish();
        });
      }
    });
  });
}

// --- public API -------------------------------------------------------------

/**
 * Finds hosts with an open SSH port on every local /24. mDNS names are a bonus:
 * rooted stations usually answer only the plain TCP sweep.
 */
export async function discoverSshHosts(options: DiscoverOptions = {}): Promise<DiscoveredHost[]> {
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 6000, 1500), 20_000);
  const ports = options.ports ?? DEFAULT_PORTS;
  const deadline = Date.now() + timeoutMs;

  const [arp, mdns] = await Promise.all([
    arpTable(),
    mdnsBrowse('_ssh._tcp.local', Math.min(2500, timeoutMs)),
  ]);

  const hosts: DiscoveredHost[] = [];
  const seen = new Set<string>();
  for (const hit of mdns) {
    const key = `${hit.ip}:${hit.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push({
      ip: hit.ip,
      port: hit.port,
      banner: 'SSH-2.0 (mDNS)',
      name: hit.name,
      mac: arp.get(hit.ip),
      source: 'mdns',
    });
  }

  const remaining = Math.max(900, deadline - Date.now());
  const all = candidateIps();
  const known = [...all.keys()].filter((ip) => arp.has(ip));
  const rest = [...all.keys()].filter((ip) => !arp.has(ip));
  const scored = [...known, ...rest];

  const found = await sweep(scored, ports, Math.min(SWEEP_TIMEOUT_MS, remaining), deadline);
  for (const host of found) {
    const key = `${host.ip}:${host.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hosts.push({ ...host, mac: arp.get(host.ip), name: undefined });
  }

  return hosts.sort((a, b) => {
    const aHint = Number(Boolean((a.name ?? '').match(YANDEX_HINT) || a.banner.match(YANDEX_HINT)));
    const bHint = Number(Boolean((b.name ?? '').match(YANDEX_HINT) || b.banner.match(YANDEX_HINT)));
    return bHint - aHint || a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });
}

function pingArgs(ip: string): string[] {
  return process.platform === 'win32'
    ? ['-n', '1', '-w', '150', ip]
    : ['-c', '1', '-W', '1', ip];
}

/**
 * Is anything listening on that address at all. A saved host that answers nothing means the lease
 * moved, and finding that out in 1.5 s instead of a 10 s handshake timeout is what keeps the
 * reconnect ladder short enough for the panel to look alive.
 */
export function isTcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));
  });
}

function ping(ip: string): Promise<void> {
  return new Promise((resolve) => {
    const child = execFile('ping', pingArgs(ip), { windowsHide: true, timeout: 1500 }, () => resolve());
    child.on('error', () => resolve());
  });
}

async function wakeUp(ips: string[], concurrency = 32): Promise<void> {
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= ips.length) return;
      await ping(ips[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ips.length) }, () => worker()));
}

/** Looks up the address currently bound to a known MAC — how a station reappears after DHCP. */
export async function findIpByMac(mac: string): Promise<string | null> {
  const wanted = mac.toLowerCase().replace(/:/g, '-');
  const match = (table: Map<string, string>): string | null => {
    for (const [ip, entry] of table) {
      if (entry === wanted) return ip;
    }
    return null;
  };
  const cached = match(await arpTable());
  if (cached) return cached;
  // The ARP cache only knows about hosts we have talked to recently.
  await wakeUp([...candidateIps().keys()]);
  return match(await arpTable());
}

export function looksLikeYandex(host: DiscoveredHost): boolean {
  return YANDEX_HINT.test(host.name ?? '') || YANDEX_HINT.test(host.banner);
}

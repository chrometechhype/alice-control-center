import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const FIREWALL_RULE = 'Alice Control Center (panel)';

export interface PanelAddress {
  address: string;
  interface: string;
  netmask: string;
  kind: 'wifi' | 'ethernet' | 'other';
  /** Shares the /24 with the station — the only address a phone on that network can open. */
  reachesStation: boolean;
}

function sameSubnet(a: string, b: string): boolean {
  return a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
}

function classify(name: string): PanelAddress['kind'] {
  const lowered = name.toLowerCase();
  if (/wi-?fi|wireless|беспровод|wlan|airplay/.test(lowered)) return 'wifi';
  if (/ethernet|eth|гигabit|подключ/.test(lowered)) return 'ethernet';
  return 'other';
}

/**
 * Addresses the panel can be reached at from another device, best candidate first.
 * VPN adapters and loopback are dropped: a phone on the hotspot will never route there.
 */
export function panelAddresses(stationHost?: string | null): PanelAddress[] {
  const result: PanelAddress[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== 'IPv4') continue;
      if (entry.netmask !== '255.255.255.0') continue;
      if (entry.address.startsWith('169.254.')) continue;
      result.push({
        address: entry.address,
        interface: name,
        netmask: entry.netmask,
        kind: classify(name),
        reachesStation: Boolean(stationHost && sameSubnet(entry.address, stationHost)),
      });
    }
  }
  return result.sort((a, b) => {
    if (a.reachesStation !== b.reachesStation) return a.reachesStation ? -1 : 1;
    const rank = { wifi: 0, ethernet: 1, other: 2 } as const;
    return rank[a.kind] - rank[b.kind] || a.address.localeCompare(b.address, undefined, { numeric: true });
  });
}

export interface FirewallState {
  supported: boolean;
  ruleExists: boolean;
  category: string | null;
  detail: string;
}

/** Windows-only reading of the inbound rule and the network profile of the active adapter. */
export async function firewallState(port: number): Promise<FirewallState> {
  if (process.platform !== 'win32') {
    return { supported: false, ruleExists: false, category: null, detail: '' };
  }
  let ruleExists = false;
  let category: string | null = null;
  let detail = '';
  try {
    const { stdout } = await run(
      'netsh',
      ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE}`],
      { windowsHide: true, timeout: 8000 },
    );
    ruleExists = /Rule Name/i.test(stdout) && stdout.includes(String(port));
    detail = stdout.slice(0, 400);
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  try {
    const { stdout } = await run(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        'Get-NetConnectionProfile | Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty NetworkCategory',
      ],
      { windowsHide: true, timeout: 8000 },
    );
    category = stdout.trim() || null;
  } catch {
    category = null;
  }
  return { supported: true, ruleExists, category, detail };
}

/**
 * Asks Windows for elevation and opens the inbound port. Nothing is written without the
 * user confirming the UAC prompt.
 */
export async function addFirewallRule(port: number): Promise<void> {
  const script =
    `Start-Process netsh -Verb RunAs -ArgumentList ` +
    `'advfirewall firewall add rule name=\\"${FIREWALL_RULE}\\" dir=in action=allow protocol=TCP localport=${port}';`;
  await run('powershell', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 120_000 });
}

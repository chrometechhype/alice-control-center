import dgram from 'node:dgram';
import { interfaceForHost, localSubnets } from './discovery.ts';

export type ProbeOutcome = 'answered' | 'blocked';
export type Probe = (host: string, timeoutMs: number, port?: number) => Promise<ProbeOutcome>;

export interface LanDiagnosis {
  kind: 'other-network' | 'lan-blocked';
  message: string;
}

/**
 * A query for `localhost` is answered by any resolver without forwarding anything upstream: it
 * proves the machine is reachable and sends nothing out of the house. TCP 80/443 cannot do this
 * job — this router drops both ports while its network is perfectly alive, and a probe that fails
 * on a healthy network would blame the VPN for a station that is simply switched off.
 */
const LOCALHOST_QUERY = Buffer.from('aaaa01000001000000000000096c6f63616c686f73740000010001', 'hex');
const PROBE_TIMEOUT_MS = 1200;
const DNS_PORT = 53;

export const dnsProbe: Probe = (host, timeoutMs, port = DNS_PORT) =>
  new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    let sent = false;
    let timer: NodeJS.Timeout;
    const settle = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(outcome);
    };
    timer = setTimeout(() => settle('blocked'), timeoutMs);
    socket.once('message', () => settle('answered'));
    socket.once('error', (error) => {
      // An ICMP port unreachable arrives after the query went out, so it means the host answered.
      const code = (error as NodeJS.ErrnoException).code;
      settle(sent && code === 'ECONNREFUSED' ? 'answered' : 'blocked');
    });
    socket.connect(port, host, () => {
      sent = true;
      socket.send(LOCALHOST_QUERY);
    });
  });

export function isPrivateV4(host: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function subnetOf(host: string): string {
  return `${host.split('.').slice(0, 3).join('.')}.0/24`;
}

export function gatewayOf(hostOrSubnet: string): string {
  return `${hostOrSubnet.replace(/\.0\/24$/, '').split('.').slice(0, 3).join('.')}.1`;
}

/** The words the user reads, given what the host and the probes already told us. */
export function describeLanFailure(input: {
  host: string;
  iface: { name: string; address: string } | null;
  subnets: string[];
}): LanDiagnosis {
  if (!input.iface) {
    const ours = input.subnets.length ? input.subnets.join(' и ') : 'сети без обычной /24-подсети';
    return {
      kind: 'other-network',
      message:
        `Колонка в сети ${subnetOf(input.host)}, компьютер — в ${ours}. ` +
        'Панель не достанет станцию из другой сети: подключите её и компьютер к одному Wi-Fi.',
    };
  }
  return {
    kind: 'lan-blocked',
    message:
      `Колонка и роутер ${gatewayOf(input.host)} не отвечают, хотя компьютер в этой же сети (${input.iface.address}). ` +
      'Так перекрывает локальную сеть VPN или файрвол на компьютере — отключите его, и подключение появится.',
  };
}

/** Everything this module asks the machine about, so a test can answer instead of the machine. */
export interface LanDeps {
  probe?: Probe;
  timeoutMs?: number;
  probePort?: number;
  ifaceFor?: (host: string) => { name: string; address: string } | null;
  subnets?: string[];
}

/**
 * Why a connect to this station failed, in one sentence the user can act on. Returns null when the
 * network path is fine — then the station itself is the problem and the usual text stays correct.
 */
export async function explainLanFailure(host: string, deps: LanDeps = {}): Promise<string | null> {
  if (!isPrivateV4(host)) return null;
  const probe = deps.probe ?? dnsProbe;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const subnets = deps.subnets ?? localSubnets();
  const iface = (deps.ifaceFor ?? interfaceForHost)(host);
  if (!iface) return describeLanFailure({ host, iface: null, subnets }).message;
  if (await probe(gatewayOf(host), timeoutMs, deps.probePort) === 'answered') return null;
  return describeLanFailure({ host, iface, subnets }).message;
}

/** Same question when there is no station address to aim at: does the local network answer at all. */
export async function explainLocalBlock(deps: LanDeps = {}): Promise<string | null> {
  const subnets = deps.subnets ?? localSubnets();
  if (!subnets.length) return null;
  const probe = deps.probe ?? dnsProbe;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  for (const subnet of subnets) {
    if (await probe(gatewayOf(subnet), timeoutMs, deps.probePort) === 'answered') return null;
  }
  return (
    `Ни роутер, ни другие устройства в ${subnets.join(' и ')} не отвечают, хотя компьютер к ним подключён. ` +
    'Обычно так перекрывает локальную сеть VPN или файрвол — отключите их и ищите колонку заново.'
  );
}

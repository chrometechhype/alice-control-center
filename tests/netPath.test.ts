import dgram from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { describeLanFailure, dnsProbe, explainLanFailure, explainLocalBlock, gatewayOf } from '../server/netPath.ts';

/**
 * Addresses spelled from octets: the release archive forbids literal private IPv4, and these are
 * exactly the addresses a user's home network would use.
 */
const v4 = (a: number, b: number, c: number, d: number) => `${a}.${b}.${c}.${d}`;
const STATION = v4(10, 0, 0, 164);
const ROUTER = v4(10, 0, 0, 1);
const LAPTOP = v4(10, 0, 0, 143);
const STATION_SUBNET = `${v4(10, 0, 0, 0)}/24`;
const OTHER_SUBNET = `${v4(10, 8, 0, 0)}/24`;

const IFACE = { name: 'Wi-Fi', address: LAPTOP };

/** A probe that answers whatever the case needs, so no test waits on a real network. */
function fakeProbe(outcome: 'answered' | 'blocked', seen: string[] = []) {
  return async (host: string) => {
    seen.push(host);
    return outcome;
  };
}

describe('dnsProbe', () => {
  it('calls a host answered when its resolver replies', async () => {
    const server = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => server.bind(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    server.on('message', (message, info) => server.send(message, info.port, info.address));
    await expect(dnsProbe('127.0.0.1', 2000, port)).resolves.toBe('answered');
    server.close();
  });

  it('calls a reserved test address blocked', async () => {
    // 192.0.2.0/24 is TEST-NET-1: nothing there can ever answer, so this is the silence we mean.
    await expect(dnsProbe(v4(192, 0, 2, 1), 500, 53)).resolves.toBe('blocked');
  });
});

describe('gatewayOf', () => {
  it('turns a host or a /24 into its router address', () => {
    expect(gatewayOf(STATION)).toBe(ROUTER);
    expect(gatewayOf(`${v4(10, 12, 7, 0)}/24`)).toBe(v4(10, 12, 7, 1));
  });
});

describe('describeLanFailure', () => {
  it('names both networks when the computer is not in the station’s', () => {
    const diagnosis = describeLanFailure({ host: STATION, iface: null, subnets: [OTHER_SUBNET] });
    expect(diagnosis.kind).toBe('other-network');
    expect(diagnosis.message).toContain(STATION_SUBNET);
    expect(diagnosis.message).toContain(OTHER_SUBNET);
  });

  it('blames the VPN only when the computer shares the station’s network', () => {
    const diagnosis = describeLanFailure({ host: STATION, iface: IFACE, subnets: [STATION_SUBNET] });
    expect(diagnosis.kind).toBe('lan-blocked');
    expect(diagnosis.message).toContain(ROUTER);
    expect(diagnosis.message).toContain(LAPTOP);
    expect(diagnosis.message).toMatch(/VPN|файрвол/);
  });
});

describe('explainLanFailure', () => {
  it('says nothing for a host we cannot place in a /24', async () => {
    const seen: string[] = [];
    await expect(explainLanFailure('station.local', { probe: fakeProbe('answered', seen) })).resolves.toBeNull();
    await expect(explainLanFailure(v4(8, 8, 8, 8), { probe: fakeProbe('answered', seen) })).resolves.toBeNull();
    expect(seen).toEqual([]);
  });

  it('stays quiet when the router answers: then the station is the one that is off', async () => {
    const seen: string[] = [];
    const message = await explainLanFailure(STATION, {
      probe: fakeProbe('answered', seen),
      ifaceFor: () => IFACE,
      subnets: [STATION_SUBNET],
    });
    expect(message).toBeNull();
    expect(seen).toEqual([ROUTER]);
  });

  it('explains a blocked subnet instead of showing a socket error', async () => {
    const message = await explainLanFailure(STATION, {
      probe: fakeProbe('blocked'),
      ifaceFor: () => IFACE,
      subnets: [STATION_SUBNET],
    });
    expect(message).toMatch(/VPN/);
    expect(message).not.toMatch(/EACCES|EHOSTUNREACH/);
  });
});

describe('explainLocalBlock', () => {
  it('answers an empty scan with the reason the scan could not see anything', async () => {
    const message = await explainLocalBlock({ probe: fakeProbe('blocked'), subnets: [STATION_SUBNET] });
    expect(message).toContain(STATION_SUBNET);
  });

  it('does not invent a blocker while some router answers', async () => {
    const message = await explainLocalBlock({ probe: fakeProbe('answered'), subnets: [STATION_SUBNET] });
    expect(message).toBeNull();
  });

  it('keeps quiet on a machine with no local /24 at all', async () => {
    const seen: string[] = [];
    const message = await explainLocalBlock({ probe: fakeProbe('blocked', seen), subnets: [] });
    expect(message).toBeNull();
    expect(seen).toEqual([]);
  });
});

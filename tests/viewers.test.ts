import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { trackViewer, viewerCount } from '../server/viewers.ts';

class FakeSocket extends EventEmitter {}

function open(address: string): FakeSocket {
  const socket = new FakeSocket();
  trackViewer(socket as unknown as WebSocket, address);
  return socket;
}

describe('viewers', () => {
  it('counts two tabs on one device once', () => {
    const first = open('192.168.100.5');
    const second = open('192.168.100.5');
    expect(viewerCount()).toBe(1);
    first.emit('close');
    second.emit('close');
    expect(viewerCount()).toBe(0);
  });

  it('counts two devices separately', () => {
    const phone = open('192.168.100.5');
    const laptop = open('192.168.100.9');
    expect(viewerCount()).toBe(2);
    laptop.emit('close');
    expect(viewerCount()).toBe(1);
    phone.emit('close');
    expect(viewerCount()).toBe(0);
  });

  it('treats IPv6 forms of the same address as one device', () => {
    const v4 = open('192.168.100.5');
    const mapped = open('::ffff:192.168.100.5');
    expect(viewerCount()).toBe(1);
    v4.emit('close');
    mapped.emit('close');
  });

  it('keeps loopback in one bucket', () => {
    const local = open('127.0.0.1');
    const alias = open('::1');
    expect(viewerCount()).toBe(1);
    local.emit('close');
    alias.emit('close');
    expect(viewerCount()).toBe(0);
  });

  it('drops a connection that errored', () => {
    const socket = open('192.168.100.5');
    socket.emit('error', new Error('reset'));
    expect(viewerCount()).toBe(0);
  });
});

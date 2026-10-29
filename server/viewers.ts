import type { WebSocket } from 'ws';

/**
 * Сколько устройств прямо сейчас держат панель открытой на этом сервере. Счёт живёт только здесь:
 * считаются открытые WebSocket-соединения панели по адресу устройства, без имён, вкладок и истории,
 * и никуда не отправляется. Две вкладки на одном телефоне — это одно устройство.
 */
const connections = new Map<WebSocket, string>();

function normalize(address: string | undefined): string {
  if (!address) return 'unknown';
  const plain = address.replace(/^::ffff:/, '');
  if (plain === '::1' || plain.startsWith('127.')) return 'loopback';
  return plain;
}

export function trackViewer(socket: WebSocket, address: string | undefined): void {
  connections.set(socket, normalize(address));
  const forget = (): void => {
    connections.delete(socket);
  };
  socket.once('close', forget);
  socket.once('error', forget);
}

export function viewerCount(): number {
  return new Set(connections.values()).size;
}

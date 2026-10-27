export class AccError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AccError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Words ssh2 and dropbear use when the socket stopped carrying the command, as opposed to the
 * command itself failing. The station drops its own transport every few minutes while it is stuck
 * in its update loop, and the panel has to tell those two apart: one is worth waiting out, the
 * other is an answer.
 */
const TRANSPORT_DEATH =
  /unable to exec|no response from server|channel open failure|open failed|administratively prohibited|resource shortage|waiting for handshake|socket (?:closed|hang ?up)|epipe|econnreset|etimedout|encountered end of file|устройство не подключено/i;

export function isTransportDeath(error: unknown): boolean {
  return error instanceof Error && TRANSPORT_DEATH.test(error.message);
}

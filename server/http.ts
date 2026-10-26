import type { NextFunction, Request, Response } from 'express';
import type { ApiError } from '../shared/types.ts';

export function sendOk<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): void {
  const error: ApiError = { code, message, ...(details === undefined ? {} : { details }) };
  res.status(status).json({ ok: false, error });
}

export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function remoteAddress(req: Request): string {
  return req.socket.remoteAddress ?? 'unknown';
}

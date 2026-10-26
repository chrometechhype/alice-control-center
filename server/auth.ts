import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { AuthStatus } from '../shared/types.ts';
import { getLanToken, getSettings } from './config.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';

const COOKIE_NAME = 'acc_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function isLoopback(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getLanToken()).update(payload).digest('base64url');
}

export function createSessionValue(): string {
  const payload = String(Date.now() + SESSION_TTL_MS);
  return `${payload}.${sign(payload)}`;
}

function verifySessionValue(value: string | undefined): boolean {
  if (!value) return false;
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (expected.length !== signature.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  return Number(payload) > Date.now();
}

function safeTokenEquals(candidate: string): boolean {
  const token = getLanToken();
  if (candidate.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}

export function requestAuthorized(req: Request): boolean {
  if (isLoopback(req)) return true;
  const settings = getSettings();
  if (!settings.lanAccess) return false;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ') && safeTokenEquals(auth.slice(7).trim())) return true;
  return verifySessionValue(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (isLoopback(req)) {
    next();
    return;
  }
  if (!getSettings().lanAccess) {
    throw new AccError('LAN_DISABLED', 'Доступ по локальной сети отключён в настройках', 403);
  }
  if (!requestAuthorized(req)) {
    throw new AccError('UNAUTHORIZED', 'Требуется авторизация', 401);
  }
  next();
}

export function localOnly(req: Request, _res: Response, next: NextFunction): void {
  if (!isLoopback(req)) {
    throw new AccError('LOCAL_ONLY', 'Действие доступно только с компьютера с backend', 403);
  }
  next();
}

export function authStatus(req: Request): AuthStatus {
  const lanEnabled = getSettings().lanAccess;
  return {
    required: lanEnabled && !isLoopback(req),
    authenticated: isLoopback(req) || (lanEnabled && requestAuthorized(req)),
    lanEnabled,
  };
}

export function login(req: Request, res: Response): void {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token || !safeTokenEquals(token)) {
    eventLog.append({
      level: 'warn',
      module: 'auth',
      operation: 'login',
      result: 'error',
      message: 'Неудачная попытка входа с другого устройства',
      details: { address: req.socket.remoteAddress },
    });
    throw new AccError('BAD_TOKEN', 'Неверный токен доступа', 401);
  }
  const value = createSessionValue();
  res.cookie(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  eventLog.append({
    level: 'info',
    module: 'auth',
    operation: 'login',
    result: 'ok',
    message: 'Выполнен вход с удалённого устройства',
    details: { address: req.socket.remoteAddress },
  });
  res.json({ ok: true, data: authStatus(req) });
}

export function logout(req: Request, res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true, data: authStatus(req) });
}

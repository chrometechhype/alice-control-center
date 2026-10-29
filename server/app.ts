import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { ZodError } from 'zod';
import type { WsMessage } from '../shared/types.ts';
import { authStatus, login, logout, requestAuthorized, requireAuth } from './auth.ts';
import { projectRoot } from './config.ts';
import { connectionManager } from './connection.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { sendError, sendOk } from './http.ts';
import { connectionRouter } from './routes/connection.ts';
import { eventsRouter } from './routes/events.ts';
import { settingsRouter } from './routes/settings.ts';
import { systemRouter } from './routes/system.ts';
import { soundsRouter } from './routes/sounds.ts';
import { backupsRouter } from './routes/backups.ts';
import { filesRouter } from './routes/files.ts';
import { terminalRouter } from './routes/terminal.ts';
import { ledRouter } from './routes/led.ts';
import { bluetoothRouter } from './routes/bluetooth.ts';
import { wifiRouter } from './routes/wifi.ts';
import { audioRouter } from './routes/audio.ts';
import { pluginsRouter } from './routes/plugins.ts';
import { automationRouter } from './routes/automation.ts';
import { aiRouter } from './routes/ai.ts';
import { updatesRouter } from './routes/updates.ts';
import { insightsRouter } from './routes/insights.ts';
import { currentVersion } from './update.ts';

let listenersAttached = false;

export interface AppBundle {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  broadcast: (message: WsMessage) => void;
}

export function createApp(): AppBundle {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use(express.json({ limit: '2mb' }));

  const attempts = new Map<string, { count: number; reset: number }>();
  const loginLimiter = (req: Request, res: Response, next: NextFunction) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const record = attempts.get(ip);
    if (record && record.reset > now && record.count >= 10) {
      sendError(res, 429, 'RATE_LIMITED', 'Слишком много попыток входа. Повторите через минуту.');
      return;
    }
    if (!record || record.reset <= now) attempts.set(ip, { count: 1, reset: now + 60_000 });
    else record.count += 1;
    next();
  };

  app.get('/api/health', (_req, res) => {
    sendOk(res, {
      status: 'ok',
      version: currentVersion(),
      uptimeSec: Math.round(process.uptime()),
      connection: connectionManager.getStatus().state,
    });
  });

  app.get('/api/auth/status', (req, res) => {
    sendOk(res, authStatus(req));
  });
  app.post('/api/auth/login', loginLimiter, login);
  app.post('/api/auth/logout', logout);

  app.use('/api', requireAuth);

  app.use('/api/connection', connectionRouter);
  app.use('/api/system', systemRouter);
  app.get('/api/device', (_req, res) => sendOk(res, connectionManager.snapshot()));
  app.use('/api/events', eventsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/sounds', soundsRouter);
  app.use('/api/backups', backupsRouter);
  app.use('/api/files', filesRouter);
  app.use('/api/terminal', terminalRouter);
  app.use('/api/led', ledRouter);
  app.use('/api/bluetooth', bluetoothRouter);
  app.use('/api/wifi', wifiRouter);
  app.use('/api/audio', audioRouter);
  app.use('/api/plugins', pluginsRouter);
  app.use('/api/automation', automationRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/updates', updatesRouter);
  app.use('/api/insights', insightsRouter);

  app.use('/api', (_req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Маршрут не найден');
  });

  const distDir = path.join(projectRoot, 'dist');
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AccError) {
      sendError(res, error.status, error.code, error.message, error.details);
      return;
    }
    if (error instanceof ZodError) {
      sendError(res, 400, 'VALIDATION_ERROR', 'Некорректные входные данные', error.issues);
      return;
    }
    const message = error instanceof Error ? error.message : 'Внутренняя ошибка сервера';
    console.error('[acc] unhandled error:', error);
    sendError(res, 500, 'INTERNAL_ERROR', message);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    if (!requestAuthorized(req as unknown as Request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const broadcast = (message: WsMessage) => {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  wss.on('connection', (ws) => {
    const socket = ws as WebSocket & { isAlive?: boolean };
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.send(JSON.stringify({ type: 'hello', data: connectionManager.snapshot() }));
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as WebSocket & { isAlive?: boolean };
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);
  server.on('close', () => clearInterval(heartbeat));

  if (!listenersAttached) {
    listenersAttached = true;
    eventLog.on('event', (event) => broadcast({ type: 'event', data: event }));
    connectionManager.on('status', (status) =>
      broadcast({ type: 'connection', data: status }),
    );
    connectionManager.on('probe', (probe: { info: unknown; capabilities: unknown; warnings: string[] }) =>
      broadcast({
        type: 'capabilities',
        data: {
          info: probe.info,
          capabilities: probe.capabilities,
          warnings: probe.warnings,
        },
      }),
    );
    connectionManager.on('metrics', (sample) => broadcast({ type: 'metrics', data: sample }));
  }

  return { app, server, wss, broadcast };
}

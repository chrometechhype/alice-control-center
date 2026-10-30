import { Router } from 'express';
import { z } from 'zod';
import { connectionManager } from '../connection.ts';
import { loadConnection } from '../config.ts';
import { AccError } from '../errors.ts';
import { discoverSshHosts, localSubnets } from '../discovery.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { checkHostTools } from '../hostTools.ts';
import { installTool } from '../tools.ts';
import { resetFfmpegProbe } from '../audioConvert.ts';
import { eventLog } from '../events.ts';

const connectionInput = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(2222),
  username: z.string().trim().min(1).max(64).default('root'),
  password: z.string().max(512).optional(),
  privateKeyPath: z.string().trim().max(1024).optional(),
  autoReconnect: z.boolean().default(true),
});

type ConnectionInput = z.infer<typeof connectionInput>;

function buildConfig(input: ConnectionInput) {
  const existing = loadConnection();
  const sameTarget =
    existing &&
    existing.host === input.host &&
    existing.port === input.port &&
    existing.username === input.username;
  const password = input.password !== undefined ? input.password : sameTarget ? existing.password : undefined;
  const privateKeyPath =
    input.privateKeyPath !== undefined
      ? input.privateKeyPath || undefined
      : sameTarget
        ? existing.privateKeyPath
        : undefined;

  if (password === undefined && !privateKeyPath) {
    throw new AccError(
      'CREDENTIALS_REQUIRED',
      'Укажите пароль или путь к приватному SSH-ключу',
      400,
    );
  }

  return {
    transport: 'ssh' as const,
    host: input.host,
    port: input.port,
    username: input.username,
    password,
    privateKeyPath,
    autoReconnect: input.autoReconnect,
    deviceId: existing?.deviceId,
    mac: sameTarget ? existing?.mac : undefined,
  };
}

export const connectionRouter = Router();

connectionRouter.post(
  '/discover',
  asyncRoute(async (req, res) => {
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 6000, 2000), 15000);
    const hosts = await discoverSshHosts({ timeoutMs });
    sendOk(res, { subnets: localSubnets(), hosts });
  }),
);

connectionRouter.get(
  '/status',
  asyncRoute(async (_req, res) => {
    sendOk(res, {
      status: connectionManager.getStatus(),
      config: connectionManager.getPublicConfig(),
      info: connectionManager.getInfo(),
      capabilities: connectionManager.getCapabilities(),
      warnings: connectionManager.getWarnings(),
    });
  }),
);

connectionRouter.get(
  '/transport-stats',
  asyncRoute(async (_req, res) => {
    const adapter = connectionManager.getAdapter();
    sendOk(res, {
      state: connectionManager.getStatus().state,
      transport: adapter?.transport ?? null,
      stats: adapter?.getStats?.() ?? null,
    });
  }),
);

connectionRouter.get(
  '/tools',
  asyncRoute(async (_req, res) => {
    sendOk(res, await checkHostTools());
  }),
);

/** ffmpeg and adb are host tools; asking a Windows user to edit PATH is a dead end. */
connectionRouter.post(
  '/tools/install',
  asyncRoute(async (req, res) => {
    const name = String((req.body as { name?: unknown } | null)?.name ?? '').trim();
    const installed = await installTool(name);
    resetFfmpegProbe();
    eventLog.append({
      level: 'info',
      module: 'system',
      operation: 'tool-install',
      result: 'ok',
      message: `Панель установила ${name}: ${installed.files.join(', ')}`,
      details: { path: installed.path },
    });
    sendOk(res, { path: installed.path, files: installed.files, tools: await checkHostTools() });
  }),
);

connectionRouter.get(
  '/snapshot',
  asyncRoute(async (_req, res) => {
    sendOk(res, connectionManager.snapshot());
  }),
);

connectionRouter.post(
  '/test',
  asyncRoute(async (req, res) => {
    const input = connectionInput.parse(req.body);
    const config = buildConfig(input);
    const probe = await connectionManager.testConnection(config);
    sendOk(res, {
      info: probe.info,
      capabilities: probe.capabilities,
      warnings: probe.warnings,
    });
  }),
);

connectionRouter.post(
  '/connect',
  asyncRoute(async (req, res) => {
    const input = connectionInput.parse(req.body);
    const config = buildConfig(input);
    const snapshot = await connectionManager.connect(config, { persist: true, source: 'api' });
    sendOk(res, snapshot);
  }),
);

connectionRouter.post(
  '/disconnect',
  asyncRoute(async (_req, res) => {
    await connectionManager.disconnect();
    sendOk(res, connectionManager.snapshot());
  }),
);

connectionRouter.post(
  '/reconnect',
  asyncRoute(async (_req, res) => {
    const snapshot = await connectionManager.reconnectNow();
    sendOk(res, snapshot);
  }),
);

connectionRouter.post(
  '/refresh',
  asyncRoute(async (_req, res) => {
    const probe = await connectionManager.refreshProbe();
    sendOk(res, {
      info: probe.info,
      capabilities: probe.capabilities,
      warnings: probe.warnings,
    });
  }),
);

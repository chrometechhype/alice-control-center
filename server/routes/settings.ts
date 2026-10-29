import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { connectionManager } from '../connection.ts';
import {
  getLanToken,
  lanAddresses,
  loadAiConfig,
  publicAiSettings,
  publicSettings,
  rotateLanToken,
  saveAiConfig,
  updateSettings,
} from '../config.ts';
import { localOnly, requireAuth } from '../auth.ts';
import { asyncRoute, sendOk } from '../http.ts';
import { eventLog } from '../events.ts';
import { AccError } from '../errors.ts';
import { addFirewallRule, FIREWALL_RULE, firewallState, panelAddresses } from '../lanAccess.ts';
import { testAiConnection } from '../ai.ts';
import { AI_PROVIDER_PRESETS, type AiProviderId } from '../../shared/types.ts';

export const settingsRouter = Router();

settingsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    sendOk(res, publicSettings());
  }),
);

const patchSchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']).optional(),
    pollIntervalMs: z.number().int().min(2000).max(60_000).optional(),
    lanAccess: z.boolean().optional(),
    autoConnect: z.boolean().optional(),
  })
  .strict();

settingsRouter.patch(
  '/',
  asyncRoute(async (req, res) => {
    const patch = patchSchema.parse(req.body);
    if (patch.lanAccess === true) getLanToken();
    const before = publicSettings();
    updateSettings(patch);
    if (patch.pollIntervalMs && connectionManager.getStatus().state === 'connected') {
      connectionManager.getMetricsService().setIntervalMs(patch.pollIntervalMs);
    }
    if (patch.lanAccess !== undefined && patch.lanAccess !== before.lanAccess) {
      eventLog.append({
        level: patch.lanAccess ? 'warn' : 'info',
        module: 'settings',
        operation: 'lan-access',
        result: 'ok',
        message: patch.lanAccess
          ? 'Доступ по локальной сети включён (требуется перезапуск backend для смены адреса прослушивания)'
          : 'Доступ по локальной сети отключён',
      });
    }
    sendOk(res, publicSettings());
  }),
);

settingsRouter.get(
  '/token',
  localOnly,
  asyncRoute(async (_req, res) => {
    sendOk(res, { token: getLanToken(), lanAddresses: lanAddresses(), port: Number(process.env.ACC_PORT ?? 8722) });
  }),
);

settingsRouter.post(
  '/token/rotate',
  localOnly,
  asyncRoute(async (_req, res) => {
    const token = rotateLanToken();
    eventLog.append({
      level: 'warn',
      module: 'settings',
      operation: 'token-rotate',
      result: 'ok',
      message: 'Токен доступа к панели перевыпущен',
    });
    sendOk(res, { token });
  }),
);

settingsRouter.get(
  '/phone-access',
  localOnly,
  asyncRoute(async (_req, res) => {
    const port = Number(process.env.ACC_PORT ?? 8722);
    const stationHost = connectionManager.getStatus().host ?? null;
    const addresses = panelAddresses(stationHost);
    sendOk(res, {
      port,
      lanAccess: publicSettings().lanAccess,
      listeningOn: publicSettings().lanAccess ? '0.0.0.0' : '127.0.0.1',
      stationHost,
      addresses,
      best: addresses[0]?.address ?? null,
      firewall: await firewallState(port),
    });
  }),
);

settingsRouter.post(
  '/firewall',
  localOnly,
  asyncRoute(async (_req, res) => {
    const port = Number(process.env.ACC_PORT ?? 8722);
    if (process.platform !== 'win32') {
      throw new AccError('FIREWALL_UNSUPPORTED', 'Правило брандмауэра настраивается только в Windows', 400);
    }
    await addFirewallRule(port);
    eventLog.append({
      level: 'warn',
      module: 'settings',
      operation: 'firewall-rule',
      result: 'ok',
      message: `Добавлено правило брандмауэра Windows для порта ${port}`,
      details: { rule: FIREWALL_RULE, port },
    });
    sendOk(res, await firewallState(port));
  }),
);

settingsRouter.get(
  '/lan-qr',
  localOnly,
  asyncRoute(async (req, res) => {
    const port = Number(process.env.ACC_PORT ?? 8722);
    const stationHost = typeof req.query.station === 'string' ? req.query.station : null;
    const candidates = panelAddresses(stationHost);
    const requested = typeof req.query.address === 'string' ? req.query.address : undefined;
    const address = requested
      ? (candidates.find((item) => item.address === requested)?.address ?? null)
      : (candidates[0]?.address ?? lanAddresses()[0] ?? null);
    if (!address) {
      sendOk(res, { dataUrl: null, url: null, addresses: candidates.map((item) => item.address) });
      return;
    }
    const url = `http://${address}:${port}/`;
    const dataUrl = await QRCode.toDataURL(url, {
      margin: 1,
      width: 320,
      color: { dark: '#0b0d10', light: '#ffffff' },
    });
    sendOk(res, { dataUrl, url, addresses: candidates.map((item) => item.address) });
  }),
);

settingsRouter.get(
  '/ai',
  asyncRoute(async (_req, res) => {
    sendOk(res, publicAiSettings());
  }),
);

const aiProviderIds = AI_PROVIDER_PRESETS.map((item) => item.id) as [AiProviderId, ...AiProviderId[]];

const aiSchema = z
  .object({
    provider: z.enum(aiProviderIds),
    baseUrl: z.string().trim().max(500).optional(),
    model: z.string().trim().max(200).optional(),
    apiKey: z.string().trim().max(600).optional(),
    clearKey: z.boolean().optional(),
  })
  .strict();

function validateBaseUrl(value: string): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AccError('BAD_AI_CONFIG', 'Укажите корректный http(s)-адрес ИИ-сервера', 400);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AccError('BAD_AI_CONFIG', 'ИИ-сервер должен использовать http или https', 400);
  }
}

settingsRouter.put(
  '/ai',
  asyncRoute(async (req, res) => {
    const body = aiSchema.parse(req.body);
    const preset = AI_PROVIDER_PRESETS.find((item) => item.id === body.provider);
    const existing = loadAiConfig();
    const baseUrl = (body.baseUrl || preset?.baseUrl || '').trim();
    const model = (body.model || preset?.model || '').trim();
    validateBaseUrl(baseUrl);
    const providerChanged = existing.provider !== body.provider;
    const nextKey = body.apiKey
      ? body.apiKey
      : body.clearKey || providerChanged
        ? undefined
        : existing.apiKey;
    saveAiConfig({
      provider: body.provider,
      baseUrl,
      model,
      ...(nextKey ? { apiKey: nextKey } : {}),
    });
    eventLog.append({
      level: 'info',
      module: 'settings',
      operation: 'ai-provider',
      result: 'ok',
      message: `ИИ-провайдер сохранён: ${preset?.label ?? body.provider}`,
      details: { provider: body.provider, model, hasKey: Boolean(nextKey) },
    });
    sendOk(res, publicAiSettings());
  }),
);

settingsRouter.post(
  '/ai/test',
  asyncRoute(async (_req, res) => {
    const config = loadAiConfig();
    if (!config.baseUrl.trim() || !config.model.trim()) {
      throw new AccError('AI_NOT_CONFIGURED', 'Сначала сохраните адрес сервера и модель', 409);
    }
    const result = await testAiConnection(config);
    eventLog.append({
      level: 'success',
      module: 'settings',
      operation: 'ai-test',
      result: 'ok',
      message: `ИИ отвечает: ${result.model}`,
      details: { model: result.model, ms: result.elapsedMs },
    });
    sendOk(res, result);
  }),
);

settingsRouter.get(
  '/auth-check',
  requireAuth,
  asyncRoute(async (_req, res) => {
    sendOk(res, { ok: true });
  }),
);

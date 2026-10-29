import { Router } from 'express';
import { asyncRoute, sendError, sendOk } from '../http.ts';
import { ownerMode } from '../config.ts';
import { repoInsights } from '../insights.ts';
import { onlineCount, PRESENCE_WINDOW_MS, sendHeartbeat } from '../presence.ts';

export const insightsRouter = Router();

/**
 * Owner-only by design: the numbers are public on GitHub, but the card belongs to whoever runs the
 * repository. Every other panel gets the same 404 as an unknown route, so nothing hints at it.
 */
insightsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    if (!ownerMode()) {
      sendError(res, 404, 'NOT_FOUND', 'Маршрут не найден');
      return;
    }
    sendOk(res, await repoInsights(req.query.force === '1'));
  }),
);

/** Panels that opted in bump a public counter once per window; this reads the current one. */
insightsRouter.get(
  '/presence',
  asyncRoute(async (_req, res) => {
    if (!ownerMode()) {
      sendError(res, 404, 'NOT_FOUND', 'Маршрут не найден');
      return;
    }
    void sendHeartbeat();
    sendOk(res, { online: await onlineCount(), windowSec: PRESENCE_WINDOW_MS / 1000 });
  }),
);

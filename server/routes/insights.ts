import { Router } from 'express';
import { asyncRoute, sendError, sendOk } from '../http.ts';
import { ownerMode } from '../config.ts';
import { repoInsights } from '../insights.ts';
import { onlineCount, PRESENCE_WINDOW_MS, sendHeartbeat } from '../presence.ts';
import { viewerCount } from '../viewers.ts';

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

/**
 * Two different numbers: `viewers` is how many devices hold this panel open right now (local, never
 * sent anywhere), `online` is how many panels in the world opted into the public counter — two
 * people on the same panel are one hit there, which is what made «два человека, а показывает один».
 */
insightsRouter.get(
  '/presence',
  asyncRoute(async (_req, res) => {
    if (!ownerMode()) {
      sendError(res, 404, 'NOT_FOUND', 'Маршрут не найден');
      return;
    }
    // The owner's own panel must be in the window before the counter is read, not after.
    await sendHeartbeat();
    sendOk(res, {
      online: await onlineCount(),
      viewers: viewerCount(),
      windowSec: PRESENCE_WINDOW_MS / 1000,
    });
  }),
);

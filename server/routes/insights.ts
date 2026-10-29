import { Router } from 'express';
import { asyncRoute, sendError, sendOk } from '../http.ts';
import { ownerMode } from '../config.ts';
import { repoInsights } from '../insights.ts';

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

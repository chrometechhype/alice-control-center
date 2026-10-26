import { Router } from 'express';
import { z } from 'zod';
import { eventLog } from '../events.ts';
import { AccError } from '../errors.ts';
import { asyncRoute, sendOk } from '../http.ts';
import type { EventLevel } from '../../shared/types.ts';

export const eventsRouter = Router();

eventsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const level = typeof req.query.level === 'string' ? (req.query.level as EventLevel) : 'all';
    const module = typeof req.query.module === 'string' ? req.query.module : 'all';
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const before = req.query.before ? Number(req.query.before) : undefined;
    sendOk(res, {
      events: eventLog.list({ level, module, query, limit, before }),
      modules: eventLog.modules(),
      total: eventLog.count(),
    });
  }),
);

eventsRouter.get(
  '/export',
  asyncRoute(async (_req, res) => {
    const body = eventLog.toJsonl();
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="acc-events-${new Date().toISOString().slice(0, 10)}.jsonl"`,
    );
    res.send(body);
  }),
);

eventsRouter.post(
  '/clear',
  asyncRoute(async (req, res) => {
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      throw new AccError('CONFIRMATION_REQUIRED', 'Очистка журнала требует подтверждения', 400);
    }
    const removed = eventLog.clear();
    eventLog.append({
      level: 'info',
      module: 'events',
      operation: 'clear',
      result: 'ok',
      message: `Журнал очищен, удалено записей: ${removed}`,
    });
    sendOk(res, { removed });
  }),
);

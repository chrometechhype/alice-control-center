import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, sendOk } from '../http.ts';
import {
  checkForUpdates,
  currentVersion,
  installUpdate,
  readUpdateState,
  UPDATE_REPO,
} from '../update.ts';

export const updatesRouter = Router();

updatesRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    sendOk(res, {
      ...(await checkForUpdates(false)),
      currentVersion: currentVersion(),
      repo: UPDATE_REPO,
      state: readUpdateState(),
    });
  }),
);

updatesRouter.post(
  '/check',
  asyncRoute(async (req, res) => {
    const force = Boolean(req.body?.force);
    sendOk(res, {
      ...(await checkForUpdates(force)),
      currentVersion: currentVersion(),
      repo: UPDATE_REPO,
      state: readUpdateState(),
    });
  }),
);

const installSchema = z
  .object({
    confirm: z.string().max(40),
  })
  .strict();

updatesRouter.post(
  '/install',
  asyncRoute(async (req, res) => {
    const body = installSchema.parse(req.body);
    sendOk(res, await installUpdate(body.confirm));
  }),
);

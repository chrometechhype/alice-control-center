import { Router } from 'express';
import { connectionManager } from '../connection.ts';
import { AccError } from '../errors.ts';
import { asyncRoute, sendOk } from '../http.ts';

export const pluginsRouter = Router();

pluginsRouter.get(
  '/',
  asyncRoute(async (_req, res) => {
    const capabilities = connectionManager.getCapabilities();
    const info = connectionManager.getInfo();
    const yam = capabilities?.yam;
    const yse = capabilities?.yse;
    const yamInstalled = Boolean(yam?.available);
    const yamRunning = Boolean(yam?.details?.running);
    const yamPort = typeof yam?.details?.port === 'number' ? yam.details.port : 8099;
    sendOk(res, {
      yam: {
        installed: yamInstalled,
        running: yamRunning,
        port: yamPort,
        webUrl: yamInstalled && yamRunning && info?.ip ? `http://${info.ip}:${yamPort}` : null,
        note: yamInstalled
          ? 'YAM установлен. Управление пакетами выполняйте в его веб-панели — ACC не дублирует установку.'
          : 'YAM не установлен на устройстве. ACC не скачивает и не запускает сторонние бинарники автоматически.',
        documentation: 'https://github.com/nyakokitsu/yam',
        registry: 'https://github.com/nyakokitsu/yapkg',
      },
      yse: {
        installed: Boolean(yse?.available),
        path: (yse?.details?.path as string | undefined) ?? null,
        note: Boolean(yse?.available)
          ? 'Менеджер пакетов yse найден. Установка пакетов выполняется на самой колонке по SSH.'
          : 'yse не установлен.',
      },
      installationsEnabled: false,
      reason:
        'ACC сознательно не устанавливает сторонние пакеты и демоны: для этого нужен проверенный источник, хеш и отдельный сценарий с подтверждением.',
    });
  }),
);

pluginsRouter.post(
  '/install',
  asyncRoute(async () => {
    throw new AccError(
      'NOT_IMPLEMENTED',
      'Автоматическая установка плагинов и YAM не реализована: требуется проверенный источник и хеш.',
      501,
    );
  }),
);

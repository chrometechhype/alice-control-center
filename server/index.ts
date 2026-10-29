import { createApp } from './app.ts';
import { initAutomation } from './automation.ts';
import { getSettings } from './config.ts';
import { connectionManager } from './connection.ts';
import { eventLog } from './events.ts';
import { setShutdownHandler } from './lifecycle.ts';
import { startPresence } from './presence.ts';

eventLog.init();
initAutomation();
startPresence();

const { server } = createApp();
const settings = getSettings();
const port = Number(process.env.ACC_PORT ?? 8722);
const host = settings.lanAccess ? '0.0.0.0' : '127.0.0.1';

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[acc] Порт ${port} уже занят. Задайте другой через ACC_PORT.`);
  } else {
    console.error('[acc] Ошибка сервера:', error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  console.log('');
  console.log('  Alice Control Center — backend');
  console.log(`  Локально:  http://127.0.0.1:${port}`);
  if (settings.lanAccess) console.log('  LAN-доступ включён (требуется токен)');
  console.log('');
  void connectionManager.init();
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  connectionManager.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};

setShutdownHandler(shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

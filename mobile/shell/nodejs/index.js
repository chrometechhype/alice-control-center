// Boot wrapper for the phone build. The real backend is the esbuild bundle in server.cjs; this file
// only tells it where it lives, because inside an Android app neither the current directory nor
// ./data means anything — the APK is read-only and the only writable place is the app's own files dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let bridge = null;
try {
  bridge = require('bridge');
} catch {
  bridge = null; // `node index.js` on a desktop, for testing the bundle without a phone
}

if (bridge && bridge.app) {
  // Releasing the lock immediately is what keeps the SSH connection alive while the screen is off.
  bridge.app.on('pause', (lock) => lock.release());
  bridge.app.on('resume', (lock) => lock.release());
}

function writableRoot() {
  if (bridge && bridge.app && typeof bridge.app.datadir === 'function') {
    const dir = bridge.app.datadir();
    if (dir) return dir;
  }
  return path.join(os.tmpdir(), 'acc-mobile');
}

const served = path.join(__dirname, 'app');
if (!fs.existsSync(path.join(served, 'index.html'))) {
  console.error('[acc] панель не собрана: отсутствует ' + path.join(served, 'index.html'));
}

process.env.ACC_DATA_DIR = path.join(writableRoot(), 'panel-data');
process.env.ACC_DIST_DIR = served;
process.env.ACC_MOBILE = '1';

console.log(
  `[acc] node ${process.version} на ${process.platform}/${process.arch}, данные в ${process.env.ACC_DATA_DIR}`,
);

require('./server.cjs');

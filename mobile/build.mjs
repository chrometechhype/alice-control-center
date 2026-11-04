// Packs the real panel into the APK: the built SPA becomes the node server's static folder, and the
// server itself becomes one CJS file, because the node runtime inside the app has no tsx and no
// node_modules — anything it needs has to be in that file already.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const mobileDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(mobileDir, '..');
const www = path.join(mobileDir, 'www');
const shell = path.join(mobileDir, 'shell');
const nodeDir = path.join(www, 'nodejs');
const appDir = path.join(nodeDir, 'app');

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

execFileSync(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
  cwd: root,
  stdio: 'inherit',
});

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(shell, www, { recursive: true });
fs.cpSync(path.join(root, 'dist'), appDir, { recursive: true });

const result = await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  outfile: path.join(nodeDir, 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node18'],
  // Optional native accelerators and the app's own bridge: requiring a missing one is how these
  // libraries detect that they are not available, so the bundle must keep the require() calls live.
  external: ['bridge', 'bufferutil', 'utf-8-validate', 'cpu-features', 'nan'],
  define: {
    'process.env.ACC_MOBILE': '"1"',
    'process.env.ACC_APP_VERSION': JSON.stringify(version),
  },
  logLevel: 'info',
});

for (const message of result.warnings ?? []) console.warn('[esbuild]', message.text);

const size = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} МБ`;
console.log(`server.cjs ${size(path.join(nodeDir, 'server.cjs'))}`);
console.log(`панель: ${fs.readdirSync(appDir, { recursive: true }).length} файлов`);

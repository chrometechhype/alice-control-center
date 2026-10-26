import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json: ожидается версия X.Y.Z, получено «${version}»`);
}

const releaseRoot = path.join(root, 'release', 'alice-control-center');
const zipName = `Alice-Control-Center-${version}.zip`;
const zipPath = path.join(root, 'release', zipName);
const checksumPath = `${zipPath}.sha256`;

const files = [
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'LICENSE',
  '.gitignore',
  '.gitattributes',
  'index.html',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vite.config.ts',
  'start.bat',
  'start.sh',
];
const directories = ['dist', 'src', 'server', 'shared', 'public', 'tests', 'docs'];

for (const required of ['dist/index.html', 'scripts/apply-update.mjs']) {
  if (!fs.existsSync(path.join(root, required))) {
    throw new Error(`Не найден ${required}. Сначала выполните npm run build.`);
  }
}

fs.rmSync(releaseRoot, { recursive: true, force: true });
fs.mkdirSync(releaseRoot, { recursive: true });

function copy(relativePath) {
  const source = path.join(root, relativePath);
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, path.join(releaseRoot, relativePath), { recursive: true });
}

for (const file of files) copy(file);
for (const directory of directories) copy(directory);
fs.mkdirSync(path.join(releaseRoot, 'scripts'), { recursive: true });
copy('scripts/apply-update.mjs');

if (process.platform !== 'win32') {
  fs.chmodSync(path.join(releaseRoot, 'start.sh'), 0o755);
}

const allowedAddresses = new Set([
  '10.0.0.1',
  '192.168.1.42',
  '192.168.1.100',
]);
const ipv4 =
  /(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])/g;
const forbidden = [/"password"\s*:\s*"1"/];
const scanExtensions = new Set([
  '.md',
  '.txt',
  '.ts',
  '.vue',
  '.js',
  '.mjs',
  '.json',
  '.html',
  '.css',
  '.sh',
  '.bat',
  '.yml',
  '.yaml',
]);
const leaks = [];
function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scan(full);
      continue;
    }
    if (!scanExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of forbidden) {
      if (pattern.test(text)) leaks.push(`${path.relative(releaseRoot, full)} → ${pattern}`);
    }
    for (const address of text.match(ipv4) ?? []) {
      if (
        !address.startsWith('127.') &&
        address !== '0.0.0.0' &&
        address !== '255.255.255.255' &&
        !allowedAddresses.has(address)
      ) {
        leaks.push(`${path.relative(releaseRoot, full)} → IP ${address}`);
      }
    }
  }
}
scan(releaseRoot);
if (leaks.length) {
  throw new Error(`В релизе найдены приватные данные:\n${leaks.join('\n')}`);
}

const zip = new AdmZip();
zip.addLocalFolder(releaseRoot, 'alice-control-center');
fs.mkdirSync(path.dirname(zipPath), { recursive: true });
zip.writeZip(zipPath);

const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(checksumPath, `${digest}  ${zipName}\n`);

const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`ZIP: ${path.relative(root, zipPath)} (${size} MB)`);
console.log(`SHA-256: ${digest}`);
console.log(`Checksum: ${path.relative(root, checksumPath)}`);

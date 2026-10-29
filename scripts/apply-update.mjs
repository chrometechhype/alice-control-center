import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

const [sourceArg, projectArg, newVersionArg, oldVersionArg, portArg] = process.argv.slice(2);
if (!sourceArg || !projectArg || !newVersionArg) {
  console.error('usage: apply-update.mjs <staged> <project> <newVersion> [oldVersion] [port]');
  process.exit(1);
}

const sourceRoot = path.resolve(sourceArg);
const projectRoot = path.resolve(projectArg);
const newVersion = newVersionArg;
const oldVersion = oldVersionArg || 'unknown';
const port = Number(portArg || process.env.ACC_PORT || 8722);
const dataDir = path.join(projectRoot, 'data');
const updatesDir = path.join(dataDir, 'updates');
const logDir = path.join(dataDir, 'logs');
const logFile = path.join(updatesDir, 'last-update.log');
const stateFile = process.env.ACC_UPDATE_STATE || path.join(updatesDir, 'state.json');
const preserve = new Set(['data', 'node_modules', '.git', 'release', 'shots', '.qoder']);

fs.mkdirSync(updatesDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // ignore logging failures
  }
}

function writeState(phase, message) {
  try {
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify(
        { phase, version: newVersion, previousVersion: oldVersion, startedAt: Date.now(), message },
        null,
        2,
      ),
    );
    fs.renameSync(tmp, stateFile);
  } catch {
    // ignore state failures
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function serverIsUp(timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Alice-Control-Center-updater' },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForOldServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await serverIsUp())) return true;
    await sleep(500);
  }
  return false;
}

function topLevelEntries(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => !preserve.has(entry.name))
    .map((entry) => entry.name);
}

function copyTopLevel(from, to, names) {
  for (const name of names) {
    const source = path.join(from, name);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(to, name), { recursive: true, force: true });
  }
}

function removeTopLevel(root, names) {
  for (const name of names) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
}

function hashFile(file) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * ZIP archives carry no Unix modes, so an update over an installed panel left start.sh without +x
 * and `./start.sh` answered «Permission denied» (issue #3). The copy restores the bit here.
 */
function ensureExecutableScripts(root) {
  if (process.platform === 'win32') return 0;
  let fixed = 0;
  for (const dir of [root, path.join(root, 'scripts')]) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
      try {
        fs.chmodSync(path.join(dir, entry.name), 0o755);
        fixed += 1;
      } catch {
        // A read-only project still runs through `bash start.sh`; nothing else to do here.
      }
    }
  }
  return fixed;
}

function runCommand(command, args) {
  const output = fs.openSync(path.join(logDir, 'update-process.log'), 'a');
  try {
    const result = spawnSync(command, args, {
      cwd: projectRoot,
      shell: process.platform === 'win32',
      stdio: ['ignore', output, output],
      env: process.env,
    });
    return result.status === 0;
  } finally {
    fs.closeSync(output);
  }
}

function startServer() {
  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!fs.existsSync(tsxCli)) {
    log('tsx не найден, запускаю npm install');
    if (!runCommand('npm', ['install', '--no-audit', '--no-fund'])) return false;
  }
  if (!fs.existsSync(tsxCli)) return false;
  const output = fs.openSync(path.join(logDir, 'server.log'), 'a');
  const child = spawn(process.execPath, [tsxCli, 'server/index.ts'], {
    cwd: projectRoot,
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
    env: { ...process.env, ACC_PORT: String(port) },
  });
  fs.closeSync(output);
  child.unref();
  log(`Новый backend запущен, pid ${child.pid ?? '?'}`);
  return true;
}

async function main() {
  log(`Обновление ${oldVersion} → ${newVersion}`);
  writeState('applying', 'Останавливаем панель и сохраняем резервную копию.');
  if (!(await waitForOldServer())) {
    writeState('failed', 'Старый backend не остановился. Обновление отменено.');
    log('Старый backend всё ещё отвечает — отмена.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(updatesDir, `backup-${oldVersion}-${stamp}`);
  const oldNames = topLevelEntries(projectRoot);
  fs.mkdirSync(backupDir, { recursive: true });
  copyTopLevel(projectRoot, backupDir, oldNames);
  log(`Резервная копия: ${backupDir}`);

  const lockBefore = hashFile(path.join(projectRoot, 'package-lock.json'));
  const newNames = topLevelEntries(sourceRoot);
  try {
    copyTopLevel(sourceRoot, projectRoot, newNames);
    log(`Скопировано файлов/каталогов: ${newNames.length}`);
    const scripts = ensureExecutableScripts(projectRoot);
    if (scripts) log(`Права +x восстановлены для ${scripts} скрипт(ов) .sh`);
    const lockAfter = hashFile(path.join(projectRoot, 'package-lock.json'));
    if (lockBefore && lockAfter && lockBefore !== lockAfter) {
      writeState('applying', 'Обновляем зависимости.');
      log('package-lock.json изменился, запускаю npm install');
      if (!runCommand('npm', ['install', '--no-audit', '--no-fund'])) {
        throw new Error('npm install завершился с ошибкой');
      }
    }
    if (!fs.existsSync(path.join(projectRoot, 'dist', 'index.html'))) {
      writeState('applying', 'Собираем frontend.');
      log('dist/index.html отсутствует, запускаю npm run build');
      if (!runCommand('npm', ['run', 'build'])) {
        throw new Error('npm run build завершился с ошибкой');
      }
    }
    if (!startServer()) {
      throw new Error('не удалось запустить новый backend');
    }
    writeState('done', `Панель обновлена до ${newVersion}.`);
    log('Готово.');
    fs.rmSync(sourceRoot, { recursive: true, force: true });
    const backups = fs
      .readdirSync(updatesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
      .map((entry) => path.join(updatesDir, entry.name))
      .sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - 3))) {
      fs.rmSync(old, { recursive: true, force: true });
    }
  } catch (error) {
    log(`ОШИБКА: ${error instanceof Error ? error.message : String(error)}`);
    writeState('failed', 'Обновление не удалось, возвращаем предыдущую версию.');
    try {
      removeTopLevel(projectRoot, newNames);
      copyTopLevel(backupDir, projectRoot, oldNames);
      if (!startServer()) {
        log('Не удалось запустить старый backend автоматически. Запустите start.bat вручную.');
      }
    } catch (restoreError) {
      log(`ОШИБКА ОТКАТА: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
    }
  }
}

await main();

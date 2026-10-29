import fs from 'node:fs';
import path from 'node:path';
import { dataDir, loadConnection, projectRoot } from '../config.ts';
import { SshAdapter } from '../adapters/SshAdapter.ts';
import {
  FULL_DEBUG_COMMANDS,
  renderFullDebugReport,
  reportFileName,
  runFullDebug,
  type FullDebugSection,
} from '../fullDebug.ts';

/**
 * `npm run debug:full` / `start.bat --full-debug`.
 *
 * Отчёт идёт в stdout, ход работы — в stderr: так `> report.txt` даёт чистый файл, а в консоли
 * всё равно видно, какая секция сейчас выполняется. Пароль SSH здесь не печатается нигде.
 */

const FLAG = '--full-debug';

function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function progress(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describe(section: FullDebugSection, position: number): string {
  const head = `[${position}/${FULL_DEBUG_COMMANDS.length}] ${section.title}`;
  if (section.error) return `${head} — ошибка: ${section.error}`;
  const flags = [section.timedOut ? 'таймаут' : '', section.truncated ? 'обрезано' : '']
    .filter(Boolean)
    .join(', ');
  return `${head} — код ${section.code ?? '—'}, ${section.durationMs} мс${flags ? `, ${flags}` : ''}`;
}

async function main(): Promise<number> {
  if (!process.argv.includes(FLAG)) {
    progress(`Полная отладка запускается только с флагом ${FLAG}.`);
    progress(`Например: npm run debug:full  (или start.bat ${FLAG} на Windows)`);
    return 2;
  }

  const connection = loadConnection();
  if (!connection) {
    progress('Станция ещё не подключена: сохраните подключение в панели, затем повторите.');
    return 1;
  }
  if (connection.transport !== 'ssh') {
    progress('Полная отладка работает только по SSH: сохраните настоящее подключение к колонке.');
    return 1;
  }

  const startedAt = Date.now();
  const adapter = new SshAdapter(connection);
  progress(`Колонка: ${connection.username}@${connection.host}:${connection.port}`);

  progress('Подключение по SSH…');
  await adapter.connect();
  progress('Подключено. Собираю диагностику — это может занять до минуты.');

  let position = 0;
  const result = await runFullDebug(
    (command, options) => adapter.exec(command, options),
    {
      onSection: (section) => {
        position += 1;
        progress(describe(section, position));
      },
    },
  );

  try {
    await adapter.disconnect();
  } catch {
    // Отчёт уже собран: обрыв на прощание ничего не отменяет.
  }

  const report = renderFullDebugReport(result, {
    version: version(),
    node: process.version,
    host: connection.host,
    username: connection.username,
    startedAt,
  });

  const reportsDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true, mode: 0o700 });
  const file = path.join(reportsDir, reportFileName(startedAt));
  fs.writeFileSync(file, report, { mode: 0o600 });

  const failed = result.sections.filter((section) => section.error || section.code !== 0).length;
  progress(`Готово: ${result.sections.length} секций, проблемных ${failed}.`);
  progress(`Отчёт: ${file}`);
  process.stdout.write(report);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    progress(`Полная отладка прервалась: ${error instanceof Error ? error.message : 'ошибка'}`);
    process.exitCode = 1;
  });

import type { ExecResult } from './adapters/StationAdapter.ts';
import { maskWpaConfig } from './wifi.ts';

/**
 * «Полная отладка» — один прогон, который собирает всё, что нужно, чтобы понять, почему служба
 * упала или колонка ведёт себя странно: журналы ядра и демонов, снимок памяти, скорость диска,
 * процессы Quasar, сеть и wpa_supplicant.conf с замаскированными паролями.
 *
 * Команды постоянные и не принимают ввод: это не терминал, поэтому белый список здесь не нужен.
 * Каждая секция выполняется отдельно — упавшая команда не должна отменять остальные.
 */

export interface DebugCommand {
  key: string;
  title: string;
  command: string;
  timeoutMs: number;
  maxBytes: number;
}

const LOG_DIRS = '/data/quasar/daemons_logs /data/quasar/logs /data/log';

/** Tails every log the firmware keeps, including the ones a failing daemon writes last. */
const LOG_TAIL = `for d in ${LOG_DIRS}; do
  [ -d "$d" ] || continue
  for f in "$d"/*.log "$d"/*.txt; do
    [ -f "$f" ] || continue
    echo "===== $f ====="
    tail -n 120 "$f" 2>/dev/null
    echo
  done
done`;

const LOG_ERRORS = `for d in ${LOG_DIRS}; do
  [ -d "$d" ] || continue
  for f in "$d"/*.log; do
    [ -f "$f" ] || continue
    hits=$(grep -iE 'crash|panic|fatal|segfault|abort|exception|out of memory|killed' "$f" 2>/dev/null | tail -n 40)
    [ -n "$hits" ] || continue
    echo "===== $f ====="
    echo "$hits"
    echo
  done
done`;

const PROCESS_RSS = `for p in /proc/[0-9]*; do
  [ -r "$p/status" ] || continue
  rss=$(sed -n 's/^VmRSS:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$p/status" 2>/dev/null)
  name=$(sed -n 's/^Name:[[:space:]]*//p' "$p/status" 2>/dev/null)
  [ -n "$rss" ] && echo "$rss \${p#/proc/} $name"
done | sort -rn | head -n 30`;

const QUASAR_PROCESSES = `echo '# Процессы со службой Quasar или YAM в командной строке'
for p in /proc/[0-9]*; do
  cmd=$(tr '\\000' ' ' < "$p/cmdline" 2>/dev/null)
  case "$cmd" in
    *quasar*|*yamd*|*yandex*)
      echo "--- PID \${p#/proc/}: $cmd"
      sed -n 's/^\\(State\\|Threads\\|VmRSS\\|VmSize\\|SigQ\\):/  \\1:/p' "$p/status" 2>/dev/null
      ;;
  esac
done
echo
echo '# Все процессы'
ps 2>/dev/null`;

const DISK_SPEED = `T=/data/.acc-dd-test
echo '# Запись 32 МиБ с fsync'
dd if=/dev/zero of="$T" bs=1048576 count=32 conv=fsync 2>&1
echo
echo '# Чтение 32 МиБ'
dd if="$T" of=/dev/null bs=1048576 2>&1
echo
echo '# Перезапись 32 МиБ без fsync (кэш страниц)'
dd if=/dev/zero of="$T" bs=1048576 count=32 2>&1
rm -f "$T"`;

const MEMORY = `cat /proc/meminfo
echo
echo '# vmstat'
head -n 60 /proc/vmstat 2>/dev/null
echo
echo '# buddyinfo / zoneinfo'
cat /proc/buddyinfo 2>/dev/null
head -n 40 /proc/zoneinfo 2>/dev/null
echo
echo '# Свободная память'
free 2>/dev/null`;

const WPA_CONFIG = `for f in /bkupgrade/data/wpa_supplicant.conf /data/misc/wifi/wpa_supplicant.conf /etc/wpa_supplicant.conf; do
  [ -f "$f" ] || continue
  echo "===== $f ====="
  cat "$f" 2>/dev/null
  echo
done
echo '# wpa_cli status'
wpa_cli -i wlan0 status 2>/dev/null`;

export const FULL_DEBUG_COMMANDS: DebugCommand[] = [
  {
    key: 'kernel',
    title: 'Ядро и загрузка',
    command: 'uname -a; cat /proc/version; uptime; cat /proc/uptime; cat /sys/class/aml_info/reboot_reason 2>/dev/null',
    timeoutMs: 10_000,
    maxBytes: 60_000,
  },
  {
    key: 'dmesg',
    title: 'Сообщения ядра',
    command: 'dmesg 2>/dev/null | tail -n 500',
    timeoutMs: 15_000,
    maxBytes: 400_000,
  },
  {
    key: 'dmesg-errors',
    title: 'Ошибки ядра и убитые процессы',
    command:
      "dmesg 2>/dev/null | grep -iE 'segfault|general protection|oom|out of memory|killed process|panic|call trace|watchdog|quasar|yam' | tail -n 250",
    timeoutMs: 15_000,
    maxBytes: 200_000,
  },
  {
    key: 'logs',
    title: 'Журналы демонов',
    command: LOG_TAIL,
    timeoutMs: 25_000,
    maxBytes: 900_000,
  },
  {
    key: 'log-errors',
    title: 'Ошибки в журналах служб',
    command: LOG_ERRORS,
    timeoutMs: 25_000,
    maxBytes: 300_000,
  },
  {
    key: 'quasar',
    title: 'Процессы Quasar и YAM',
    command: QUASAR_PROCESSES,
    timeoutMs: 20_000,
    maxBytes: 400_000,
  },
  {
    key: 'memory',
    title: 'Дамп ОЗУ: карта памяти ядра',
    command: MEMORY,
    timeoutMs: 15_000,
    maxBytes: 200_000,
  },
  {
    key: 'memory-rss',
    title: 'Дамп ОЗУ: 30 самых тяжёлых процессов',
    command: PROCESS_RSS,
    timeoutMs: 20_000,
    maxBytes: 100_000,
  },
  {
    key: 'disk-speed',
    title: 'Скорость диска (dd)',
    command: DISK_SPEED,
    timeoutMs: 60_000,
    maxBytes: 60_000,
  },
  {
    key: 'storage',
    title: 'Файловые системы и монтирования',
    command: 'df -k 2>/dev/null; mount 2>/dev/null',
    timeoutMs: 15_000,
    maxBytes: 120_000,
  },
  {
    key: 'cpu',
    title: 'CPU и нагрузка',
    command: 'cat /proc/loadavg; nproc 2>/dev/null; top -b -n 1 2>/dev/null | head -n 30',
    timeoutMs: 20_000,
    maxBytes: 80_000,
  },
  {
    key: 'thermal',
    title: 'Температура',
    command:
      'for z in /sys/class/thermal/thermal_zone*; do [ -e "$z/temp" ] || continue; echo "$(cat $z/type 2>/dev/null)|$(cat $z/temp 2>/dev/null)"; done',
    timeoutMs: 10_000,
    maxBytes: 20_000,
  },
  {
    key: 'wifi',
    title: 'Wi-Fi и wpa_supplicant.conf (пароли замаскированы)',
    command: WPA_CONFIG,
    timeoutMs: 15_000,
    maxBytes: 200_000,
  },
  {
    key: 'network',
    title: 'Сеть и открытые порты',
    command: 'ip addr 2>/dev/null; cat /proc/net/wireless 2>/dev/null; netstat -ln 2>/dev/null',
    timeoutMs: 15_000,
    maxBytes: 100_000,
  },
  {
    key: 'bluetooth',
    title: 'Bluetooth',
    command: 'hciconfig -a 2>/dev/null; bluetoothctl show 2>/dev/null',
    timeoutMs: 15_000,
    maxBytes: 60_000,
  },
  {
    key: 'quasar-files',
    title: 'Файлы Quasar на устройстве',
    command: 'ls -la /data/quasar 2>/dev/null; ls -la /data/quasar/daemons_logs 2>/dev/null',
    timeoutMs: 10_000,
    maxBytes: 100_000,
  },
];

export interface FullDebugSection {
  key: string;
  title: string;
  command: string;
  code: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  output: string;
  error?: string;
}

export interface FullDebugResult {
  sections: FullDebugSection[];
  startedAt: number;
  finishedAt: number;
}

export interface FullDebugMeta {
  version: string;
  node: string;
  host: string;
  username: string;
  startedAt: number;
}

export type DebugExec = (
  command: string,
  options: { timeoutMs: number; maxBytes: number },
) => Promise<ExecResult>;

/** The psk never appears in a report, no matter which section happened to print it. */
export function scrubSecrets(text: string): string {
  return maskWpaConfig(text);
}

export async function runFullDebug(
  exec: DebugExec,
  options: { onSection?: (section: FullDebugSection) => void; commands?: DebugCommand[] } = {},
): Promise<FullDebugResult> {
  const startedAt = Date.now();
  const sections: FullDebugSection[] = [];
  for (const item of options.commands ?? FULL_DEBUG_COMMANDS) {
    let section: FullDebugSection;
    try {
      const result = await exec(item.command, { timeoutMs: item.timeoutMs, maxBytes: item.maxBytes });
      const raw = [result.stdout, result.stderr].filter(Boolean).join('\n');
      section = {
        key: item.key,
        title: item.title,
        command: item.command,
        code: result.code,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
        output: scrubSecrets(raw),
      };
    } catch (error) {
      section = {
        key: item.key,
        title: item.title,
        command: item.command,
        code: null,
        durationMs: 0,
        timedOut: false,
        truncated: false,
        output: '',
        error: error instanceof Error ? error.message : 'Команда не выполнилась',
      };
    }
    sections.push(section);
    options.onSection?.(section);
  }
  return { sections, startedAt, finishedAt: Date.now() };
}

function stamp(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function reportFileName(startedAt: number): string {
  return `full-debug-${stamp(startedAt)}.txt`;
}

export function renderFullDebugReport(result: FullDebugResult, meta: FullDebugMeta): string {
  const lines: string[] = [];
  lines.push('Alice Control Center — полная отладка');
  lines.push(`Начало: ${new Date(result.startedAt).toISOString()}`);
  lines.push(`Конец:  ${new Date(result.finishedAt).toISOString()}`);
  lines.push(`Панель: ${meta.version} · Node ${meta.node}`);
  lines.push(`Колонка: ${meta.username}@${meta.host}`);
  lines.push(`Секций: ${result.sections.length}`);
  lines.push('');
  result.sections.forEach((section, index) => {
    const title = `${String(index + 1).padStart(2, '0')}. ${section.title}`;
    lines.push('='.repeat(Math.min(78, Math.max(24, title.length + 8))));
    lines.push(title);
    lines.push('='.repeat(Math.min(78, Math.max(24, title.length + 8))));
    lines.push(`$ ${section.command}`);
    const status = section.error
      ? `ошибка: ${section.error}`
      : `код ${section.code ?? '—'} · ${section.durationMs} мс${section.timedOut ? ' · таймаут' : ''}${section.truncated ? ' · обрезано' : ''}`;
    lines.push(status);
    lines.push('');
    lines.push(section.output.trim() || '(пусто)');
    lines.push('');
  });
  lines.push('Пароли Wi-Fi замаскированы на стороне панели: psk не попадает в отчёт в открытом виде.');
  return `${lines.join('\n')}\n`;
}

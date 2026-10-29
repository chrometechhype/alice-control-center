import type { Capabilities, DeviceInfo } from '../shared/types.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import {
  baseName,
  guessModel,
  parseCpuCores,
  parseCpuModel,
  parseDf,
  parseHciConfig,
  parseIpAddress,
  parseLedZones,
  parseMeminfo,
  parseOsRelease,
  parseQuasarFullVersion,
  parseQuasarVersion,
  parseSections,
  parseThermal,
  parseToolPath,
  parseUptime,
  parseWifiRssi,
  parseYamStatus,
} from './parse.ts';
import { scanSounds } from './sounds.ts';
import { parseVolumeCapability } from './volumeScale.ts';

const PROBE_SCRIPT = `
echo @@UNAME
uname -r 2>/dev/null; uname -m 2>/dev/null; hostname 2>/dev/null
echo @@MODEL
cat /proc/device-tree/model 2>/dev/null; echo
echo @@QUASAR
cat /system/vendor/quasar/VERSION 2>/dev/null; echo
echo @@VOLUME
sed -n '/"volume_capability" : {/,/^   },$/p' /system/vendor/quasar/quasar.cfg 2>/dev/null
echo @@QVERSION
q version 2>/dev/null | grep -E 'Quasar Software Version|Software Revision|Device ID' | head -5
echo @@DEVID
q full-info 2>/dev/null | grep -i 'device id' | head -2
echo @@OS
cat /etc/os-release 2>/dev/null
echo @@MEM
cat /proc/meminfo 2>/dev/null
echo @@UPTIME
cat /proc/uptime 2>/dev/null
echo @@LOADAVG
cat /proc/loadavg 2>/dev/null
echo @@DF
df -k / /data 2>/dev/null
echo @@CPUINFO
cat /proc/cpuinfo 2>/dev/null
echo @@THERMAL
for z in /sys/class/thermal/thermal_zone*; do [ -e "$z/temp" ] || continue; echo "$(cat $z/type 2>/dev/null)|$(cat $z/temp 2>/dev/null)"; done
echo @@LEDS
ls /sys/class/leds 2>/dev/null
echo @@LEDTRIG
for l in /sys/class/leds/*; do [ -e "$l/trigger" ] || continue; n=\${l##*/}; echo "$n|$(cat $l/trigger 2>/dev/null)"; break; done
echo @@BLUETOOTH
ls /sys/class/bluetooth 2>/dev/null
hciconfig -a 2>/dev/null
echo @@WIFI
cat /proc/net/wireless 2>/dev/null
echo @@TOOLS
command -v fastfetch 2>/dev/null
command -v yse 2>/dev/null
command -v socat 2>/dev/null
command -v ffmpeg 2>/dev/null
command -v amixer 2>/dev/null
command -v bluetoothctl 2>/dev/null
command -v hciconfig 2>/dev/null
command -v adb 2>/dev/null
ls -l /data/opt/bin/fastfetch 2>/dev/null
ls -l /data/opt/bin/yse 2>/dev/null
echo @@YAM
ls -d /data/quazar/yam 2>/dev/null
pidof yamd 2>/dev/null
netstat -ln 2>/dev/null | grep 8099
echo @@ADB
pidof adbd 2>/dev/null
ls /data/quasar/activate_adb_quasmodrom /data/quasar/activate_network_adb 2>/dev/null
echo @@LOGS
ls /data/quasar/daemons_logs 2>/dev/null
echo @@SOUNDS
ls /system/vendor/quasar/sounds 2>/dev/null
echo @@SENSORS
ls /sys/bus/iio/devices 2>/dev/null
echo @@FB
ls -l /dev/fb0 2>/dev/null
echo @@FBRES
cat /sys/class/graphics/fb0/virtual_size 2>/dev/null; echo
echo @@IP
ip addr 2>/dev/null
echo @@AUDIO
head -5 /etc/asound.conf 2>/dev/null
echo @@END
`;

export interface ProbeResult {
  info: DeviceInfo;
  capabilities: Capabilities;
  warnings: string[];
  soundFiles: Array<{ path: string; rel: string; size: number; mtimeMs: number }>;
  logs: string[];
}

function capability(available: boolean, reason?: string, details?: Record<string, unknown>): Capabilities['system'] {
  return reason ? { available, reason, details } : { available, details };
}

export async function runProbe(adapter: StationAdapter): Promise<ProbeResult> {
  const { stdout } = await adapter.exec(PROBE_SCRIPT, { timeoutMs: 30_000, maxBytes: 600_000 });
  const sections = parseSections(stdout);
  const warnings: string[] = [];

  const unameLines = (sections.UNAME ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const kernel = unameLines[0] ?? '';
  const arch = unameLines[1] ?? '';
  const hostname = unameLines[2] ?? '';

  const modelRaw = (sections.MODEL ?? '').replace(/\0/g, '').trim();
  const versionText = (sections.QVERSION ?? '').replace(/\0/g, '');
  const firmware = parseQuasarFullVersion(versionText) || parseQuasarVersion(sections.QUASAR ?? '');
  const deviceId =
    /Device ID:\s*(\S+)/i.exec((sections.DEVID ?? '').replace(/\0/g, ''))?.[1] ??
    /Device ID:\s*(\S+)/i.exec(versionText)?.[1];
  const os = parseOsRelease(sections.OS ?? '');
  const mem = parseMeminfo(sections.MEM ?? '');
  const uptimeSec = parseUptime(sections.UPTIME ?? '') ?? 0;
  const cpuinfo = sections.CPUINFO ?? '';
  const cpuModel = parseCpuModel(cpuinfo);
  const cpuCores = parseCpuCores(cpuinfo);
  const disks = parseDf(sections.DF ?? '');
  const ip = parseIpAddress(sections.IP ?? '') ?? undefined;
  const wifiRssi = parseWifiRssi(sections.WIFI ?? '');

  const info: DeviceInfo = {
    hostname,
    modelRaw,
    modelGuess: guessModel(modelRaw, hostname),
    firmware,
    quasarVersion: firmware,
    kernel,
    arch,
    os,
    cpuModel,
    cpuCores,
    totalMemBytes: mem.totalBytes,
    uptimeSec,
    ip,
    wifiRssi,
    deviceId,
    volumeScale: parseVolumeCapability(sections.VOLUME ?? ''),
    collectedAt: Date.now(),
  };

  const thermalZones = (sections.THERMAL ?? '')
    .split('\n')
    .map((line) => line.split('|')[0]?.trim())
    .filter((name): name is string => Boolean(name));

  const ledNames = (sections.LEDS ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const ledZones = parseLedZones(ledNames);
  const triggerRaw = (sections.LEDTRIG ?? '').split('|').slice(1).join('|').trim();
  const defaultTriggers = triggerRaw
    ? triggerRaw.split(/\s+/).map((item) => item.replace(/[[\]]/g, '')).filter(Boolean)
    : [];

  const bluetoothSection = sections.BLUETOOTH ?? '';
  const hci = parseHciConfig(bluetoothSection);
  const sysfsBluetooth = bluetoothSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^hci\d+$/.test(line));
  const hasBluetooth = Boolean(hci.adapter) || sysfsBluetooth.length > 0;
  const btAdapter = hci.adapter ?? sysfsBluetooth[0] ?? null;

  const toolsSection = sections.TOOLS ?? '';
  const toolLines = toolsSection.split('\n').map((line) => line.trim()).filter(Boolean);
  const fastfetchPath =
    parseToolPath(toolLines.find((line) => line.endsWith('/fastfetch') && !line.startsWith('-r')) ?? '') ??
    (toolLines.some((line) => line.startsWith('-rwx') && line.includes('/data/opt/bin/fastfetch'))
      ? '/data/opt/bin/fastfetch'
      : null);
  const ysePath =
    parseToolPath(toolLines.find((line) => line.endsWith('/yse') && !line.startsWith('-r')) ?? '') ??
    (toolLines.some((line) => line.startsWith('-rwx') && line.includes('/data/opt/bin/yse'))
      ? '/data/opt/bin/yse'
      : null);
  const hasSocat = toolLines.some((line) => line.endsWith('/socat'));
  const hasFfmpegOnDevice = toolLines.some((line) => line.endsWith('/ffmpeg'));
  const hasAmixer = toolLines.some((line) => line.endsWith('/amixer'));
  const hasBluetoothctl = toolLines.some((line) => line.endsWith('/bluetoothctl'));
  const hasHciconfig = toolLines.some((line) => line.endsWith('/hciconfig'));

  const yamRaw = sections.YAM ?? '';
  const yam = parseYamStatus(yamRaw);
  const yamDir = yamRaw.split('\n').some((line) => line.trim() === '/data/quazar/yam');

  const adbSection = sections.ADB ?? '';
  const adbRunning = /^\s*\d+\s*$/m.test(adbSection);
  const adbNetwork = /activate_network_adb/.test(adbSection);

  const logsSection = sections.LOGS ?? '';
  const logFiles = logsSection.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.log'));

  const soundsDirs = (sections.SOUNDS ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const soundScan = await scanSounds(adapter);
  if (soundScan.errors.length) warnings.push(`Звуки: ${soundScan.errors[0]}`);
  const soundFiles = soundScan.files.map((file) => ({
    path: file.path,
    rel: file.rel,
    size: file.size,
    mtimeMs: file.mtimeMs,
  }));
  const soundFormats = Array.from(new Set(soundScan.files.map((file) => file.ext))).filter(Boolean);

  let sftpAvailable = false;
  try {
    sftpAvailable = await adapter.supportsSftp();
  } catch {
    sftpAvailable = false;
  }
  if (!sftpAvailable) {
    warnings.push('SFTP-подсистема недоступна — файлы передаются по shell-каналу SSH');
  }

  const fbSection = sections.FB ?? '';
  const framebuffer = /\/dev\/fb0/.test(fbSection);
  const fbResolution = /^(\d+)\s*,\s*(\d+)\s*$/m.exec(sections.FBRES ?? '');

  const sensors = (sections.SENSORS ?? '').split('\n').map((line) => line.trim()).filter(Boolean);

  if (!fastfetchPath) warnings.push('Fastfetch не установлен — доступна штатная системная диагностика');
  if (!hasBluetooth) warnings.push('Bluetooth-адаптер не обнаружен в системе');
  if (!ledZones.length) warnings.push('Управляемые LED через sysfs не обнаружены');
  if (!yamDir) warnings.push('YAM не установлен на устройстве');
  if (!adbRunning) warnings.push('ADB-демон на устройстве не запущен');

  const capabilities: Capabilities = {
    system: capability(Boolean(kernel), undefined, {
      kernel,
      arch,
      diskRoot: disks.find((disk) => disk.mount === '/') ?? null,
      diskData:
        disks.find((disk) => disk.mount === '/data') ??
        disks.find((disk) => disk.mount === '/bkupgrade') ??
        null,
    }),
    sftp: capability(sftpAvailable, sftpAvailable ? undefined : 'SFTP-подсистема недоступна'),
    sounds: capability(
      soundScan.files.length > 0,
      soundScan.files.length ? undefined : 'Файлы звуков не найдены или каталог недоступен',
      {
        count: soundScan.files.length,
        categories: Array.from(new Set(soundScan.files.map((file) => file.category))),
        formats: soundFormats,
        directories: soundsDirs,
      },
    ),
    led: capability(
      ledZones.length > 0,
      ledZones.length
        ? undefined
        : framebuffer
          ? 'LED-кольцо через sysfs не найдено: дисплеем и часами этой модели управляет прошивка, ACC не пишет в её framebuffer'
          : 'LED не обнаружены',
      {
        kind: ledZones.length ? 'sysfs' : framebuffer ? 'framebuffer' : 'none',
        zones: ledZones,
        defaultTriggers,
        currentTrigger: triggerRaw.replace(/[[\]]/g, '').trim(),
        framebuffer: framebuffer
          ? {
              device: '/dev/fb0',
              width: fbResolution ? Number(fbResolution[1]) : null,
              height: fbResolution ? Number(fbResolution[2]) : null,
            }
          : null,
      },
    ),
    bluetooth: capability(
      hasBluetooth,
      hasBluetooth ? undefined : 'Bluetooth-адаптер отсутствует',
      {
        adapter: btAdapter,
        powered: hci.powered,
        name: hci.name,
        alias: hci.name,
        address: hci.address,
        tool: hasBluetoothctl ? 'bluetoothctl' : hasHciconfig ? 'hciconfig' : null,
      },
    ),
    logs: capability(logFiles.length > 0, logFiles.length ? undefined : 'Логи демонов не найдены', {
      files: logFiles,
    }),
    fastfetch: capability(Boolean(fastfetchPath), fastfetchPath ? undefined : 'Fastfetch не установлен', {
      path: fastfetchPath,
    }),
    yam: capability(yamDir, yamDir ? undefined : 'YAM не установлен', {
      path: '/data/quazar/yam',
      running: yam.running,
      port: yam.port ?? 8099,
    }),
    adb: capability(adbRunning, adbRunning ? undefined : 'ADB-демон не запущен', {
      network: adbNetwork,
    }),
    thermal: capability(thermalZones.length > 0, thermalZones.length ? undefined : 'Датчики температуры не найдены', {
      zones: thermalZones,
      currentTempC: parseThermal(
        (sections.THERMAL ?? '')
          .split('\n')
          .map((line) => line.split('|')[1] ?? '')
          .join('\n'),
      ),
    }),
    sensors: capability(sensors.length > 0, sensors.length ? undefined : 'IIO-датчики не найдены', {
      devices: sensors,
    }),
    audio: capability(Boolean(sections.AUDIO), Boolean(sections.AUDIO) ? undefined : 'ALSA-конфигурация не найдена', {
      hasAmixer,
      hasSocat,
      hasFfmpegOnDevice,
    }),
    framebuffer: capability(framebuffer, framebuffer ? undefined : 'Framebuffer /dev/fb0 не найден', {
      width: fbResolution ? Number(fbResolution[1]) : null,
      height: fbResolution ? Number(fbResolution[2]) : null,
    }),
    yse: capability(Boolean(ysePath), ysePath ? undefined : 'Менеджер пакетов yse не установлен', {
      path: ysePath,
    }),
  };

  return {
    info,
    capabilities,
    warnings,
    soundFiles: soundScan.files,
    logs: logFiles,
  };
}

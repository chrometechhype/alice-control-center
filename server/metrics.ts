import { EventEmitter } from 'node:events';
import type { MetricsSample } from '../shared/types.ts';
import type { StationAdapter } from './adapters/StationAdapter.ts';
import { loadConfig } from './config.ts';
import {
  computeCpuPct,
  parseCpuStat,
  parseDf,
  parseLoadavg,
  parseSections,
  parseThermal,
  parseUptime,
  parseWifiRssi,
} from './parse.ts';
import type { CpuTimes } from './parse.ts';

const MAX_HISTORY = 240;

const METRICS_SCRIPT = `
echo @@STAT
cat /proc/stat 2>/dev/null
echo @@MEM
cat /proc/meminfo 2>/dev/null
echo @@UP
cat /proc/uptime 2>/dev/null
echo @@LOAD
cat /proc/loadavg 2>/dev/null
echo @@DF
df -k / /data 2>/dev/null
echo @@THERM
for z in /sys/class/thermal/thermal_zone*; do [ -e "$z/temp" ] || continue; echo "$(cat $z/temp 2>/dev/null)"; done
echo @@WIFI
cat /proc/net/wireless 2>/dev/null
echo @@END
`;

export class MetricsService extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private sampleInFlight = false;
  private previousCpu: CpuTimes | null = null;
  private history: MetricsSample[] = [];
  private lastError: string | null = null;

  constructor(private readonly getAdapter: () => StationAdapter | null) {
    super();
  }

  start(): void {
    this.stop();
    this.previousCpu = null;
    this.sampleInFlight = false;
    const interval = Math.max(2000, loadConfig().settings.pollIntervalMs);
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setIntervalMs(ms: number): void {
    if (this.timer) this.start();
  }

  getHistory(): MetricsSample[] {
    return [...this.history];
  }

  getLast(): MetricsSample | null {
    return this.history.at(-1) ?? null;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  private async tick(): Promise<void> {
    if (this.sampleInFlight) return;
    const adapter = this.getAdapter();
    if (!adapter?.isConnected()) return;
    this.sampleInFlight = true;
    try {
      const { stdout } = await adapter.exec(METRICS_SCRIPT, {
        timeoutMs: 12_000,
        maxBytes: 200_000,
      });
      const sections = parseSections(stdout);
      const cpuNow = parseCpuStat(sections.STAT ?? '');
      const cpuPct = computeCpuPct(this.previousCpu, cpuNow);
      this.previousCpu = cpuNow;

      const memTotalMatch = /^MemTotal:\s+(\d+)\s*kB/im.exec(sections.MEM ?? '');
      const memAvailMatch = /^MemAvailable:\s+(\d+)\s*kB/im.exec(sections.MEM ?? '');
      const memTotal = memTotalMatch ? Number(memTotalMatch[1]) * 1024 : 0;
      let memAvail = memAvailMatch ? Number(memAvailMatch[1]) * 1024 : 0;
      if (!memAvail) {
        const free = /^MemFree:\s+(\d+)\s*kB/im.exec(sections.MEM ?? '');
        const cached = /^Cached:\s+(\d+)\s*kB/im.exec(sections.MEM ?? '');
        memAvail = (Number(free?.[1] ?? 0) + Number(cached?.[1] ?? 0)) * 1024;
      }
      const memUsed = Math.max(0, memTotal - memAvail);

      const disks = parseDf(sections.DF ?? '');
      const rootDisk = disks.find((disk) => disk.mount === '/') ?? null;
      const dataDisk =
        disks.find((disk) => disk.mount === '/data') ??
        disks.find((disk) => disk.mount === '/bkupgrade') ??
        null;

      const sample: MetricsSample = {
        ts: Date.now(),
        cpuPct: cpuPct == null ? null : Math.round(cpuPct * 10) / 10,
        memUsedBytes: memUsed,
        memTotalBytes: memTotal,
        memPct: memTotal ? Math.round((memUsed / memTotal) * 1000) / 10 : 0,
        tempC: parseThermal(sections.THERM ?? ''),
        diskUsedBytes: rootDisk?.usedBytes ?? null,
        diskTotalBytes: rootDisk?.totalBytes ?? null,
        dataUsedBytes: dataDisk?.usedBytes ?? null,
        dataTotalBytes: dataDisk?.totalBytes ?? null,
        load1: parseLoadavg(sections.LOAD ?? ''),
        uptimeSec: parseUptime(sections.UP ?? ''),
        wifiRssi: parseWifiRssi(sections.WIFI ?? ''),
      };

      this.lastError = null;
      this.history.push(sample);
      if (this.history.length > MAX_HISTORY) this.history.shift();
      this.emit('sample', sample);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Ошибка опроса метрик';
      this.emit('error', error);
    } finally {
      this.sampleInFlight = false;
    }
  }
}

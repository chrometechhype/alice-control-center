import type { StationAdapter } from './adapters/StationAdapter.ts';
import { connectionManager } from './connection.ts';
import { eventLog } from './events.ts';

/**
 * The station's own sound (Alice's voice, music, the panel's clips) is played by quasar's media
 * daemon through the ALSA PCM named `default`, and that name resolves to the speaker. The station
 * keeps its ALSA config in a read-only rootfs, but `default` ultimately reads `/tmp/asound-vol.conf`,
 * which is a symlink into `/etc` re-created on every boot. Pointing that file at BlueALSA's A2DP
 * source PCM is therefore a temporary, reboot-safe switch — and it needs the media daemon to be
 * restarted, because a running process keeps the ALSA config it already parsed in memory.
 */
const SCRIPT_PATH = '/tmp/acc-audio-route.sh';
const ROUTE_MARK = '# ACC: Bluetooth headphones output';
const FALLBACK_VOLUME_CONF = '/etc/asound-softvol.conf';

const ROUTE_SCRIPT = String.raw`#!/bin/sh
MARK='# ACC: Bluetooth headphones output'
VOL=/tmp/asound-vol.conf
LINK=/tmp/acc-vol-link.txt
ORIG=/tmp/acc-vol-orig.conf
FALLBACK=` + FALLBACK_VOLUME_CONF + String.raw`

mediad_pid() {
  ps w 2>/dev/null | awk '/maind --mediad/ && !/awk/ {print $1; exit}'
}

restart_mediad() {
  old=$(mediad_pid)
  [ -n "$old" ] || { echo ACC_NO_MEDIAD; return 1; }
  kill -9 "$old" 2>/dev/null
  i=0
  while [ $i -lt 45 ]; do
    sleep 1
    new=$(mediad_pid)
    if [ -n "$new" ] && [ "$new" != "$old" ]; then
      echo "ACC_MEDIAD $new"
      return 0
    fi
    i=$((i+1))
  done
  echo ACC_MEDIAD_TIMEOUT
  return 1
}

remember_original() {
  if [ -L "$VOL" ]; then
    readlink "$VOL" > "$LINK"
    cat "$VOL" > "$ORIG"
  fi
  [ -f "$ORIG" ] || cp "$FALLBACK" "$ORIG" 2>/dev/null
}

case "$1" in
  enable)
    ADDR=$2
    case "$ADDR" in
      [0-9A-F][0-9A-F]:[0-9A-F][0-9A-F]:[0-9A-F][0-9A-F]:[0-9A-F][0-9A-F]:[0-9A-F][0-9A-F]:[0-9A-F][0-9A-F]) ;;
      *) echo ACC_BAD_ADDRESS; exit 2 ;;
    esac
    if ! bluetoothctl info "$ADDR" 2>/dev/null | grep -q "Audio Sink"; then
      echo ACC_NOT_AUDIO
      exit 0
    fi
    ready=0
    i=0
    while [ $i -lt 20 ]; do
      if bluealsa-aplay -L 2>/dev/null | grep -q "DEV=$ADDR,PROFILE=a2dp"; then
        ready=1
        break
      fi
      i=$((i+1))
      sleep 1
    done
    if [ "$ready" != 1 ]; then
      echo ACC_NO_A2DP
      exit 6
    fi
    remember_original
    [ -f "$ORIG" ] || { echo ACC_NO_ORIGINAL; exit 3; }
    if grep -q "$MARK" "$VOL" 2>/dev/null && grep -q "device \"$ADDR\"" "$VOL"; then
      echo ACC_UNCHANGED
      exit 0
    fi
    {
      cat "$ORIG"
      echo ""
      echo "$MARK"
      echo "pcm.acc_bt_out {"
      echo "  type plug"
      echo "  slave.pcm {"
      echo "    type bluealsa"
      echo "    device \"$ADDR\""
      echo "    profile \"a2dp\""
      echo "  }"
      echo "}"
      echo "pcm.!default {"
      echo "  type asym"
      echo "  playback.pcm \"acc_bt_out\""
      echo "  capture.pcm \"multi_capture\""
      echo "}"
    } > /tmp/acc-vol.new 2>/dev/null || { echo ACC_WRITE_FAILED; exit 4; }
    mv -f /tmp/acc-vol.new "$VOL" || { echo ACC_WRITE_FAILED; exit 4; }
    echo ACC_ROUTE_ON
    restart_mediad
    ;;
  disable)
    if ! grep -q "$MARK" "$VOL" 2>/dev/null; then
      echo ACC_OFF
      exit 0
    fi
    target=$(cat "$LINK" 2>/dev/null)
    rm -f "$VOL"
    if [ -n "$target" ]; then
      ln -s "$target" "$VOL"
    elif [ -f "$ORIG" ]; then
      cp "$ORIG" "$VOL"
    else
      ln -s "$FALLBACK" "$VOL" || { echo ACC_RESTORE_FAILED; exit 5; }
    fi
    echo ACC_ROUTE_OFF
    restart_mediad
    ;;
  state)
    if grep -q "$MARK" "$VOL" 2>/dev/null; then
      addr=$(sed -n 's/.*device "\(..:..:..:..:..:..\)".*/\1/p' "$VOL" | head -1)
      echo "ACC_STATE on $addr"
    else
      echo "ACC_STATE off"
    fi
    ;;
esac
`;

export interface AudioRouteResult {
  on: boolean;
  address: string | null;
  /** Whether the media daemon was restarted — without it the new output is not in effect. */
  restarted: boolean;
  /** True when the device has no A2DP sink at all (a keyboard or a mouse), so nothing to route. */
  skipped?: boolean;
  error?: string;
}

let scriptWritten = false;
let cached: { address: string | null; at: number } | null = null;
let switching = false;

const MAC = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

async function ensureScript(adapter: StationAdapter): Promise<void> {
  if (scriptWritten) return;
  await adapter.writeFile(SCRIPT_PATH, Buffer.from(ROUTE_SCRIPT), 0o755);
  scriptWritten = true;
}

async function runRoute(adapter: StationAdapter, args: string, timeoutMs = 120_000): Promise<string> {
  await ensureScript(adapter);
  let result = await adapter.exec(`sh ${SCRIPT_PATH} ${args}`, { timeoutMs, maxBytes: 20_000 });
  let text = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (/No such file|not found/i.test(text)) {
    // The station may have rebooted since the script was written: /tmp is a tmpfs.
    scriptWritten = false;
    await ensureScript(adapter);
    result = await adapter.exec(`sh ${SCRIPT_PATH} ${args}`, { timeoutMs, maxBytes: 20_000 });
    text = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
  }
  return text;
}

/** Reads the station's current route, remembering it so the status poll does not talk to the column. */
export async function audioRouteState(
  adapter: StationAdapter,
  maxAgeMs = 15_000,
): Promise<{ on: boolean; address: string | null }> {
  if (cached && Date.now() - cached.at < maxAgeMs) {
    return { on: Boolean(cached.address), address: cached.address };
  }
  try {
    const text = await runRoute(adapter, 'state', 20_000);
    const match = /ACC_STATE on ([0-9A-F:]{17})/i.exec(text);
    cached = { address: match ? match[1].toUpperCase() : null, at: Date.now() };
  } catch {
    // An unreachable column is not the same as «the route is off»; keep the last known answer.
    cached = cached ?? { address: null, at: Date.now() };
  }
  return { on: Boolean(cached.address), address: cached.address };
}

export async function switchAudioToHeadphones(
  adapter: StationAdapter,
  address: string,
): Promise<AudioRouteResult> {
  if (!MAC.test(address)) {
    return { on: false, address: null, restarted: false, error: 'Некорректный MAC-адрес устройства.' };
  }
  switching = true;
  try {
    const text = await runRoute(adapter, `enable ${address}`);
    if (/ACC_NOT_AUDIO/.test(text)) {
      return { on: false, address, restarted: false, skipped: true };
    }
    if (/ACC_NO_A2DP/.test(text)) {
      cached = null;
      return {
        on: false,
        address,
        restarted: false,
        error: 'Колонка не подняла A2DP-профиль наушников, звук остался в колонке. Отключите наушники и подключите заново.',
      };
    }
    if (/ACC_MEDIAD_TIMEOUT|ACC_NO_MEDIAD/.test(text)) {
      // The file would steer the next media start into a device the daemon cannot use yet.
      await runRoute(adapter, 'disable').catch(() => undefined);
      cached = null;
      return {
        on: false,
        address,
        restarted: false,
        error: 'Звук остался в колонке: медиа-демон станции не перезапустился. Попробуйте ещё раз через минуту.',
      };
    }
    if (/ACC_NO_ORIGINAL|ACC_WRITE_FAILED|ACC_BAD_ADDRESS|ACC_RESTORE_FAILED/.test(text)) {
      cached = null;
      return {
        on: false,
        address,
        restarted: false,
        error: 'Станция не отдала свой файл громкости — переключить вывод не получилось.',
      };
    }
    cached = { address, at: Date.now() };
    return { on: true, address, restarted: /ACC_MEDIAD \d+/.test(text) };
  } finally {
    switching = false;
  }
}

export async function switchAudioToSpeaker(adapter: StationAdapter): Promise<AudioRouteResult> {
  switching = true;
  try {
    const text = await runRoute(adapter, 'disable');
    if (/ACC_RESTORE_FAILED/.test(text)) {
      return {
        on: true,
        address: cached?.address ?? null,
        restarted: false,
        error: 'Не удалось вернуть файл вывода звука. Перезагрузите колонку.',
      };
    }
    const restarted = /ACC_MEDIAD \d+/.test(text);
    const failed = /ACC_MEDIAD_TIMEOUT|ACC_NO_MEDIAD/.test(text);
    cached = null;
    return {
      on: false,
      address: null,
      restarted,
      error: failed
        ? 'Файл вывода восстановлен, но медиа-демон не перезапустился: звук вернётся в колонку после перезапуска станции.'
        : undefined,
    };
  } finally {
    switching = false;
  }
}

/**
 * A pair of earbuds dying in their case must not leave the station mute. While a route is active
 * the watchdog looks at that one device and puts the speaker back when the link is gone.
 */
export function startAudioRouteWatchdog(): void {
  let probed = false;
  const tick = async () => {
    if (switching) return;
    try {
      const adapter = await connectionManager.awaitReady(4_000);
      if (!probed) {
        // The panel may have been restarted while the route was already on the station.
        probed = true;
        await audioRouteState(adapter, 0);
      }
      if (!cached?.address) return;
      const address = cached.address;
      const info = await adapter.exec(`bluetoothctl info ${address} 2>/dev/null | grep -c "Connected: yes"`, {
        timeoutMs: 15_000,
        maxBytes: 2_000,
      });
      if (info.stdout.trim() === '0') {
        eventLog.append({
          level: 'warn',
          module: 'bluetooth',
          operation: 'audio-route',
          result: 'error',
          message: `Наушники ${address} пропали — возвращаем звук в колонку`,
        });
        await switchAudioToSpeaker(adapter);
      }
    } catch {
      // Offline or busy column: the next tick will look again.
    }
  };
  setTimeout(() => void tick(), 20_000).unref();
  setInterval(() => void tick(), 20_000).unref();
}

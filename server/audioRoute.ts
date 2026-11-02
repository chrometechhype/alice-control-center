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

export const ROUTE_SCRIPT = String.raw`#!/bin/sh
MARK='# ACC: Bluetooth headphones output'
VOL=/tmp/asound-vol.conf
LINK=/tmp/acc-vol-link.txt
ORIG=/tmp/acc-vol-orig.conf
FALLBACK=` + FALLBACK_VOLUME_CONF + String.raw`
CFG=/system/vendor/quasar/quasar.cfg
PCFG=/tmp/acc-quasar.cfg
FEATURE='"bluetooth_player",'

is_bound() {
  grep -q "$CFG" /proc/mounts 2>/dev/null
}

platformd_pid() {
  ps w 2>/dev/null | awk '/maind --platformd/ && !/awk/ {print $1; exit}'
}

restart_platformd() {
  old=$(platformd_pid)
  [ -n "$old" ] || { echo ACC_NO_PLATFORMD; return 1; }
  kill -9 "$old" 2>/dev/null
  i=0
  while [ $i -lt 40 ]; do
    sleep 1
    new=$(platformd_pid)
    if [ -n "$new" ] && [ "$new" != "$old" ]; then
      echo "ACC_PLATFORMD $new"
      return 0
    fi
    i=$((i+1))
  done
  echo ACC_PLATFORMD_TIMEOUT
  return 1
}

overlay_enable() {
  if is_bound; then
    echo ACC_OVERLAY_UNCHANGED
    return 0
  fi
  if ! grep -q "$FEATURE" "$CFG" 2>/dev/null; then
    echo ACC_OVERLAY_UNSUPPORTED
    return 0
  fi
  cp "$CFG" "$PCFG" || { echo ACC_OVERLAY_COPY_FAILED; return 1; }
  grep -v "$FEATURE" "$PCFG" > "$PCFG.new" && mv "$PCFG.new" "$PCFG" || { echo ACC_OVERLAY_COPY_FAILED; return 1; }
  grep -q "$FEATURE" "$PCFG" && { echo ACC_OVERLAY_COPY_FAILED; return 1; }
  mount --bind "$PCFG" "$CFG" || { rm -f "$PCFG"; echo ACC_OVERLAY_MOUNT_FAILED; return 1; }
  echo ACC_OVERLAY_ON
}

overlay_disable() {
  if ! is_bound; then
    echo ACC_OVERLAY_OFF
    return 0
  fi
  umount "$CFG" 2>/dev/null || umount -l "$CFG" 2>/dev/null
  if is_bound; then
    echo ACC_OVERLAY_UMOUNT_FAILED
    return 1
  fi
  rm -f "$PCFG"
  echo ACC_OVERLAY_OFF
}

overlay_report() {
  if is_bound; then
    echo ACC_OVERLAY on
  elif grep -q "$FEATURE" "$CFG" 2>/dev/null; then
    echo ACC_OVERLAY off
  else
    echo ACC_OVERLAY unsupported
  fi
}


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

# The headphones keep their own gain (AVRCP absolute volume), and a freshly paired device usually gets
# a low one — «quiet even at maximum». Put it at 0 dB once, so the station's Master control, which is
# what Alice and the panel move, becomes the only volume the listener has to think about.
set_bt_max() {
  nid=$(amixer -D bluealsa controls 2>/dev/null | grep "A2DP Playback Volume" | grep -o "numid=[0-9]*" | head -1 | cut -d= -f2)
  [ -n "$nid" ] || { echo ACC_BT_VOL_SKIPPED; return 0; }
  if amixer -D bluealsa cset numid="$nid" 100% >/dev/null 2>&1; then
    echo "ACC_BT_VOL $nid"
  else
    echo ACC_BT_VOL_FAILED
  fi
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
    if grep -q "$MARK" "$VOL" 2>/dev/null && grep -q "device \"$ADDR\"" "$VOL" && grep -q "pcm.acc_bt_raw" "$VOL"; then
      echo ACC_UNCHANGED
      exit 0
    fi
    {
      cat "$ORIG"
      echo ""
      echo "$MARK"
      echo "pcm.acc_bt_raw {"
      echo "  type plug"
      echo "  slave.pcm {"
      echo "    type bluealsa"
      echo "    device \"$ADDR\""
      echo "    profile \"a2dp\""
      echo "  }"
      echo "}"
      echo "pcm.acc_bt_out {"
      echo "  type softvol"
      echo "  min_dB -60.0"
      echo "  slave.pcm \"acc_bt_raw\""
      echo "  control {"
      echo "    name \"Master Playback Volume\""
      echo "    card 0"
      echo "  }"
      echo "}"
      echo "pcm.!default {"
      echo "  type asym"
      echo "  playback.pcm \"acc_bt_out\""
      echo "  capture.pcm \"multi_capture\""
      echo "}"
    } > /tmp/acc-vol.new 2>/dev/null || { echo ACC_WRITE_FAILED; exit 4; }
    mv -f /tmp/acc-vol.new "$VOL" || { echo ACC_WRITE_FAILED; exit 4; }
    set_bt_max
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
    overlay_report
    ;;
  overlay-on)
    was=$(is_bound && echo bound || echo free)
    overlay_enable || exit 3
    now=$(is_bound && echo bound || echo free)
    # Restarting the capability daemon is what applies the file, and it is a visible hiccup for
    # Alice, so it runs only when the overlay actually changed.
    [ "$was" = "$now" ] || restart_platformd
    ;;
  overlay-off)
    was=$(is_bound && echo bound || echo free)
    overlay_disable || exit 3
    now=$(is_bound && echo bound || echo free)
    [ "$was" = "$now" ] || restart_platformd
    ;;
esac
`;

/** Whether the station has been talked out of seeing the headphones as an external player. */
export type MusicMode = 'on' | 'off' | 'unsupported';

export interface MusicModeResult {
  music: MusicMode;
  /** Whether the capability daemon was restarted — the mode is not in effect until it is. */
  restarted: boolean;
  error?: string;
}

export interface AudioRouteResult {
  on: boolean;
  address: string | null;
  /** Whether the media daemon was restarted — without it the new output is not in effect. */
  restarted: boolean;
  /** True when the device has no A2DP sink at all (a keyboard or a mouse), so nothing to route. */
  skipped?: boolean;
  music?: MusicMode;
  error?: string;
}

/** Last known music mode, so the status poll does not ask the column again every few seconds. */
let music: MusicMode = 'off';
let misses = 0;

export function audioRouteMusicMode(): MusicMode {
  return music;
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

/**
 * Yandex Music only reaches the headphones while the station is convinced no external Bluetooth
 * player is active. Measured on the column: five seconds of our own A2DP stream make `platformd` log
 * «Bluetooth player is playing», take audio focus and post a `bluetooth_play` directive on the very
 * CONTENT_CHANNEL music lives on, and the track dies about 30 ms after it starts.
 *
 * The decision is gated by the `bluetooth_player` entry of `supportedFeatures` in the read-only
 * quasar config, so the mode overlays a copy of that file from /tmp and restarts `platformd`. Nothing
 * is written to the flash, and a reboot takes the station back to stock.
 */
export async function setMusicMode(adapter: StationAdapter, on: boolean): Promise<MusicModeResult> {
  const text = await runRoute(adapter, on ? 'overlay-on' : 'overlay-off', 180_000);
  if (/ACC_OVERLAY_UNSUPPORTED/.test(text)) {
    return {
      music: 'unsupported',
      restarted: false,
      error: 'В конфиге этой прошивки нет внешнего Bluetooth-плеера — применять режим не к чему.',
    };
  }
  if (/ACC_OVERLAY_MOUNT_FAILED|ACC_OVERLAY_COPY_FAILED|ACC_OVERLAY_UMOUNT_FAILED/.test(text)) {
    return { music: 'off', restarted: false, error: 'Станция не позволила подменить свой конфиг — режим не включился.' };
  }
  const restarted = /ACC_PLATFORMD \d+/.test(text);
  if (/ACC_PLATFORMD_TIMEOUT|ACC_NO_PLATFORMD/.test(text)) {
    // An overlay that no running process has read is worse than none: it would apply on the next
    // restart of the assistant, silently and far from this switch.
    if (on) await runRoute(adapter, 'overlay-off', 180_000).catch(() => undefined);
    music = 'off';
    return {
      music: 'off',
      restarted: false,
      error: 'Демон станции не перезапустился за отведённое время, режим не применился. Попробуйте ещё раз через минуту.',
    };
  }
  music = /ACC_OVERLAY_ON|ACC_OVERLAY_UNCHANGED/.test(text) ? 'on' : 'off';
  return { music, restarted };
}

/** Reads the station's current route, remembering it so the status poll does not talk to the column. */
export async function audioRouteState(
  adapter: StationAdapter,
  maxAgeMs = 15_000,
): Promise<{ on: boolean; address: string | null; music: MusicMode }> {
  if (cached && Date.now() - cached.at < maxAgeMs) {
    return { on: Boolean(cached.address), address: cached.address, music };
  }
  try {
    const text = await runRoute(adapter, 'state', 20_000);
    const match = /ACC_STATE on ([0-9A-F:]{17})/i.exec(text);
    cached = { address: match ? match[1].toUpperCase() : null, at: Date.now() };
    const overlay = /ACC_OVERLAY (on|off|unsupported)/i.exec(text);
    if (overlay) music = overlay[1].toLowerCase() as MusicMode;
  } catch {
    // An unreachable column is not the same as «the route is off»; keep the last known answer.
    cached = cached ?? { address: null, at: Date.now() };
  }
  return { on: Boolean(cached.address), address: cached.address, music };
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
      return { on: false, address, restarted: false, skipped: true, music };
    }
    if (/ACC_NO_A2DP/.test(text)) {
      cached = null;
      return {
        on: false,
        address,
        restarted: false,
        music,
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
        music,
        error: 'Звук остался в колонке: медиа-демон станции не перезапустился. Попробуйте ещё раз через минуту.',
      };
    }
    if (/ACC_NO_ORIGINAL|ACC_WRITE_FAILED|ACC_BAD_ADDRESS|ACC_RESTORE_FAILED/.test(text)) {
      cached = null;
      return {
        on: false,
        address,
        restarted: false,
        music,
        error: 'Станция не отдала свой файл громкости — переключить вывод не получилось.',
      };
    }
    cached = { address, at: Date.now() };
    misses = 0;
    if (/ACC_BT_VOL_SKIPPED|ACC_BT_VOL_FAILED/.test(text)) {
      eventLog.append({
        level: 'warn',
        module: 'bluetooth',
        operation: 'audio-route',
        result: 'error',
        message: 'Не удалось выверить громкость наушников — регулирует только колонка',
      });
    }
    return {
      on: true,
      address,
      restarted: /ACC_MEDIAD \d+/.test(text),
      music,
    };
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
        music,
        error: 'Не удалось вернуть файл вывода звука. Перезагрузите колонку.',
      };
    }
    const restarted = /ACC_MEDIAD \d+/.test(text);
    const failed = /ACC_MEDIAD_TIMEOUT|ACC_NO_MEDIAD/.test(text);
    cached = null;
    misses = 0;
    return {
      on: false,
      address: null,
      restarted,
      music,
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
 *
 * One missed sample is not enough: switching the music mode restarts the capability daemon, and the
 * Bluetooth link blips while it comes back. Measured on the column, a single check reverted the whole
 * route out from under a track that had just started playing.
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
      if (info.stdout.trim() !== '0') {
        misses = 0;
        return;
      }
      misses += 1;
      if (misses < 2) return;
      eventLog.append({
        level: 'warn',
        module: 'bluetooth',
        operation: 'audio-route',
        result: 'error',
        message: `Наушники ${address} пропали — возвращаем звук в колонку`,
      });
      await switchAudioToSpeaker(adapter);
    } catch {
      // Offline or busy column: the next tick will look again.
    }
  };
  setTimeout(() => void tick(), 20_000).unref();
  setInterval(() => void tick(), 20_000).unref();
}

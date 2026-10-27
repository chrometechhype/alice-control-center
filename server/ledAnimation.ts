import { ACTION_READY_WAIT_MS, connectionManager } from './connection.ts';
import { AccError } from './errors.ts';
import { eventLog } from './events.ts';
import { requireZones } from './ledControl.ts';

/**
 * Animations run on the station itself: the panel uploads a shell script that writes the LED
 * sysfs nodes in a tight loop, so the picture keeps moving even while the SSH channel is busy or
 * has dropped. One animation lives on the device at a time, which is why the state is module level.
 */

const ANIMATION_SCRIPT = '/tmp/acc-led-anim.sh';
const ANIMATION_PID = '/tmp/acc-led-anim.pid';
const ANIMATION_STOP = '/tmp/acc-led-anim.stop';

export interface AnimationRequest {
  frames: number[][][];
  fps: number;
  repeat: number;
  loop: boolean;
}

export interface AnimationState {
  running: boolean;
  fps?: number;
  frames?: number;
  repeat?: number;
  loop?: boolean;
  durationMs?: number;
  startedAt?: number;
}

let animationTimer: NodeJS.Timeout | null = null;
let animationToken = 0;
let animationState: AnimationState = { running: false };

export function animationStatus(): AnimationState {
  return animationState;
}

function clearAnimationTimer(): void {
  if (animationTimer) clearTimeout(animationTimer);
  animationTimer = null;
}

export async function stopAnimation(): Promise<void> {
  animationToken += 1;
  clearAnimationTimer();
  animationState = { running: false };
  const adapter = connectionManager.getAdapter();
  if (!adapter?.isConnected()) return;
  await adapter
    .exec(
      `touch ${ANIMATION_STOP}; if [ -f ${ANIMATION_PID} ]; then kill "$(cat ${ANIMATION_PID})" 2>/dev/null; fi; rm -f ${ANIMATION_PID}`,
      { timeoutMs: 6000, maxBytes: 2000 },
    )
    .catch(() => undefined);
}

function buildAnimationScript(frames: number[][][], fps: number, repeat: number): string {
  const zones = requireZones();
  const frameUs = Math.max(1000, Math.round(1_000_000 / fps));
  const lines: string[] = [
    '#!/bin/sh',
    `PIDFILE=${ANIMATION_PID}`,
    `STOPFILE=${ANIMATION_STOP}`,
    'echo $$ > "$PIDFILE"',
    'rm -f "$STOPFILE"',
    "trap 'rm -f \"$PIDFILE\"' EXIT",
  ];
  for (const zone of zones) {
    for (const device of [zone.red, zone.green, zone.blue]) {
      lines.push(`printf 'none\\n' > /sys/class/leds/${device}/trigger 2>/dev/null`);
    }
  }
  lines.push('play() {');
  frames.forEach((frame) => {
    lines.push('  [ -f "$STOPFILE" ] && return 1');
    zones.forEach((zone, zoneIndex) => {
      const color = frame[zoneIndex % frame.length] ?? [0, 0, 0];
      lines.push(`  printf '%s\\n' ${color[0]} > /sys/class/leds/${zone.red}/brightness`);
      lines.push(`  printf '%s\\n' ${color[1]} > /sys/class/leds/${zone.green}/brightness`);
      lines.push(`  printf '%s\\n' ${color[2]} > /sys/class/leds/${zone.blue}/brightness`);
    });
    lines.push(`  usleep ${frameUs}`);
  });
  lines.push('  return 0', '}');
  if (repeat > 0) {
    lines.push(`i=0`, `while [ "$i" -lt ${repeat} ]; do`, '  play || break', '  i=$((i+1))', 'done');
  } else {
    lines.push('while :; do', '  play || break', 'done');
  }
  lines.push('rm -f "$PIDFILE"');
  return `${lines.join('\n')}\n`;
}

export function animationDurationMs(frames: number, fps: number, repeat: number): number {
  return Math.round((frames * repeat * 1000) / fps);
}

export async function startAnimation(request: AnimationRequest): Promise<AnimationState> {
  const { frames, fps, loop } = request;
  const repeat = loop ? 0 : Math.max(1, request.repeat);
  const adapter = await connectionManager.awaitReady(ACTION_READY_WAIT_MS, { verifyShell: true });
  requireZones();
  const durationMs = animationDurationMs(frames.length, fps, repeat || 1);

  await stopAnimation();
  const token = ++animationToken;
  const script = buildAnimationScript(frames, fps, repeat);
  await adapter.writeFile(ANIMATION_SCRIPT, Buffer.from(script, 'utf8'), 0o755);
  const launch = await adapter.exec(
    `rm -f ${ANIMATION_STOP}; nohup sh ${ANIMATION_SCRIPT} </dev/null >/tmp/acc-led-anim.log 2>&1 &`,
    { timeoutMs: 8000, maxBytes: 4000 },
  );
  if (launch.code !== 0) {
    throw new AccError(
      'LED_ANIMATION_FAILED',
      launch.stderr.trim() || 'Не удалось запустить анимацию на устройстве',
      502,
    );
  }
  animationState = {
    running: true,
    fps,
    frames: frames.length,
    repeat: loop ? undefined : repeat,
    loop,
    durationMs: loop ? undefined : durationMs,
    startedAt: Date.now(),
  };
  if (!loop) {
    animationTimer = setTimeout(() => {
      animationTimer = null;
      if (token === animationToken) animationState = { running: false };
    }, durationMs + 1500);
  }
  eventLog.append({
    level: 'info',
    module: 'led',
    operation: 'animation',
    result: 'ok',
    message: loop
      ? `Анимация LED запущена без ограничения времени: ${frames.length} кадров, ${fps} fps`
      : `Анимация LED запущена на устройстве: ${frames.length} кадров, ${fps} fps`,
    details: { fps, frames: frames.length, repeat, loop, durationMs: loop ? 0 : durationMs },
  });
  return animationState;
}

/** Plays the scene once through and returns when the station is done with it. */
export async function playSceneForSeconds(
  frames: number[][][],
  fps: number,
  seconds: number,
): Promise<void> {
  const repeat = Math.max(1, Math.ceil((seconds * fps) / frames.length));
  await startAnimation({ frames, fps, repeat, loop: false });
  await sleep(animationDurationMs(frames.length, fps, repeat));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolCheck } from '../shared/types.ts';
import { parseAdbDevices, type AdbDevice } from './parse.ts';

const execFileAsync = promisify(execFile);

async function run(
  file: string,
  args: string[],
  timeout = 6000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 512 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

async function whichTool(name: string): Promise<string | null> {
  const result =
    process.platform === 'win32'
      ? await run('where.exe', [name])
      : await run('sh', ['-c', `command -v ${name}`]);
  const path = result.stdout.split('\n').map((line) => line.trim()).find(Boolean);
  return path ?? null;
}

export interface HostToolsResult {
  tools: ToolCheck[];
  adbDevices: AdbDevice[];
  adbError?: string;
}

export async function checkHostTools(): Promise<HostToolsResult> {
  const tools: ToolCheck[] = [];
  const adbPath = await whichTool('adb');
  let adbDevices: AdbDevice[] = [];
  let adbError: string | undefined;

  if (adbPath) {
    const version = await run(adbPath, ['version']);
    const firstLine = version.stdout.split('\n').map((line) => line.trim()).find(Boolean);
    tools.push({
      name: 'ADB',
      available: version.ok,
      version: firstLine ?? version.stderr.split('\n')[0],
      path: adbPath,
    });
    const devices = await run(adbPath, ['devices', '-l']);
    if (devices.ok) {
      adbDevices = parseAdbDevices(devices.stdout);
    } else {
      adbError = devices.stderr || 'adb devices не выполнился';
    }
  } else {
    tools.push({
      name: 'ADB',
      available: false,
      note: 'Не найден в PATH. Для SSH-подключения не требуется.',
    });
  }

  const sshPath = await whichTool('ssh');
  if (sshPath) {
    const sshVersion = await run(sshPath, ['-V']);
    tools.push({
      name: 'OpenSSH',
      available: true,
      version: (sshVersion.stderr || sshVersion.stdout).split('\n')[0],
      path: sshPath,
    });
  } else {
    tools.push({ name: 'OpenSSH', available: false, note: 'SSH-клиент не найден в PATH' });
  }

  const ffmpegPath = await whichTool('ffmpeg');
  if (ffmpegPath) {
    const version = await run(ffmpegPath, ['-version']);
    tools.push({
      name: 'ffmpeg',
      available: true,
      version: version.stdout.split('\n')[0],
      path: ffmpegPath,
      note: 'Нужен для конвертации пользовательских звуков в Ogg Opus',
    });
  } else {
    tools.push({
      name: 'ffmpeg',
      available: false,
      note: 'Конвертация MP3/WAV в Ogg Opus будет недоступна',
    });
  }

  tools.push({
    name: 'Node.js',
    available: true,
    version: process.version,
    path: process.execPath,
  });

  return { tools, adbDevices, adbError };
}

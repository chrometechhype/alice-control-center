import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.ts';
import { AccError } from './errors.ts';

/**
 * ffmpeg and adb are host tools, not station tools: they run on the computer that serves the panel.
 * Telling people to "install it into PATH" is a dead end on Windows — so the panel fetches an
 * official portable build itself and keeps it next to its own data.
 */

export const toolsDir = path.join(dataDir, 'tools');

interface ToolSpec {
  /** Executable file name inside the archive and on disk. */
  exe: string;
  url: string;
  /** Only these entries are unpacked, so a 90 MB archive does not end up on disk. */
  keep: RegExp;
  /** Some archives keep the binary in a versioned folder; flatten it. */
  label: string;
}

const SPECS: Record<string, ToolSpec> = {
  ffmpeg: {
    exe: 'ffmpeg.exe',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    keep: /(^|\/)bin\/ffmpeg\.exe$/i,
    label: 'ffmpeg',
  },
  adb: {
    exe: 'adb.exe',
    url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    keep: /(^|\/)platform-tools\/(adb|AdbWinApi|AdbWinUsbApi)\.(exe|dll)$/i,
    label: 'platform-tools',
  },
  ssh: {
    exe: 'ssh.exe',
    url: 'https://github.com/PowerShell/Win32-OpenSSH/releases/latest/download/OpenSSH-Win64.zip',
    // ssh.exe is useless without its OpenSSL libraries, so the whole runtime comes along.
    keep: /(^|\/)OpenSSH-Win64\/(ssh|scp|sftp)\.exe$|(^|\/)OpenSSH-Win64\/[^/]+\.dll$/i,
    label: 'OpenSSH',
  },
};

export function localToolPath(name: string): string | null {
  const spec = SPECS[name];
  if (!spec) return null;
  const file = path.join(toolsDir, spec.exe);
  return fs.existsSync(file) ? file : null;
}

export function installedTools(): string[] {
  return Object.keys(SPECS).filter((name) => localToolPath(name));
}

async function download(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw new AccError('TOOL_DOWNLOAD', `Сервер отдал ${response.status} вместо архива`, 502);
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof AccError) throw error;
    throw new AccError(
      'TOOL_DOWNLOAD',
      'Не удалось скачать архив. Проверьте интернет или скачайте вручную и положите в папку data/tools.',
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function installTool(name: string): Promise<{ path: string; files: string[] }> {
  const spec = SPECS[name];
  if (!spec) throw new AccError('TOOL_UNKNOWN', `Неизвестный инструмент: ${name}`, 400);
  if (process.platform !== 'win32') {
    throw new AccError(
      'TOOL_PLATFORM',
      'Автоматическая установка есть только для Windows. На Linux и macOS поставьте пакет через менеджер пакетов.',
      400,
    );
  }

  fs.mkdirSync(toolsDir, { recursive: true });
  const archive = await download(spec.url);

  let zip: AdmZip;
  try {
    zip = new AdmZip(archive);
  } catch {
    throw new AccError('TOOL_ARCHIVE', 'Архив скачался повреждённым. Попробуйте ещё раз.', 502);
  }

  const files: string[] = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !spec.keep.test(entry.entryName)) continue;
    const target = path.join(toolsDir, path.basename(entry.entryName));
    fs.writeFileSync(target, entry.getData());
    files.push(path.basename(target));
  }

  if (!files.length) {
    throw new AccError('TOOL_ARCHIVE', 'В архиве не нашлось нужного файла. Возможно, сменился адрес сборки.', 502);
  }

  const exe = path.join(toolsDir, spec.exe);
  if (!fs.existsSync(exe)) {
    throw new AccError('TOOL_ARCHIVE', `В архиве нет ${spec.exe}`, 502);
  }
  return { path: exe, files };
}

export function toolCatalog(): Array<{ name: string; label: string; url: string; installed: boolean; path: string | null }> {
  return Object.entries(SPECS).map(([name, spec]) => ({
    name,
    label: spec.label,
    url: spec.url,
    installed: Boolean(localToolPath(name)),
    path: localToolPath(name),
  }));
}

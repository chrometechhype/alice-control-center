import path from 'node:path';
import type { FileRoot } from '../../shared/types.ts';
import { AccError } from '../errors.ts';

export const SOUNDS_ROOT = '/system/vendor/quasar/sounds';
export const LED_PATTERNS_ROOT = '/system/vendor/quasar/ledpatterns';
export const INTERNAL_TMP_ROOT = '/data/opt/acc-tmp';
export const YAM_ROOT = '/data/quazar/yam';
export const LOGS_ROOT = '/data/quasar/daemons_logs';

export const FILE_ROOTS: FileRoot[] = [
  { path: '/data/opt', label: 'Пользовательские данные', writable: true },
  { path: '/data/sounds', label: 'Звуки пользователя', writable: true },
  { path: SOUNDS_ROOT, label: 'Системные звуки', writable: false },
  { path: LED_PATTERNS_ROOT, label: 'LED-паттерны', writable: false },
  { path: LOGS_ROOT, label: 'Логи демонов', writable: false },
  { path: YAM_ROOT, label: 'YAM', writable: false },
];

const WRITABLE_ROOTS = ['/data/opt', '/data/sounds'];

function hasTraversal(value: string): boolean {
  return value.split('/').some((segment) => segment === '..');
}

export function normalizeRemotePath(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 4096) {
    throw new AccError('BAD_PATH', 'Некорректный путь');
  }
  if (!input.startsWith('/') || input.includes('\0')) {
    throw new AccError('BAD_PATH', 'Путь должен быть абсолютным');
  }
  if (hasTraversal(input)) {
    throw new AccError('BAD_PATH', 'Переход по «..» запрещён');
  }
  const normalized = path.posix.normalize(input);
  if (normalized === '/') {
    throw new AccError('BAD_PATH', 'Корень файловой системы не доступен');
  }
  return normalized;
}

export function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

export function assertReadablePath(input: unknown): string {
  const remotePath = normalizeRemotePath(input);
  const allowed = FILE_ROOTS.some((root) => isWithin(root.path, remotePath));
  if (!allowed) {
    throw new AccError('PATH_NOT_ALLOWED', 'Каталог не входит в список разрешённых', 403);
  }
  return remotePath;
}

export function assertWritablePath(input: unknown): string {
  const remotePath = normalizeRemotePath(input);
  const allowed = WRITABLE_ROOTS.some((root) => isWithin(root, remotePath));
  if (!allowed) {
    throw new AccError(
      'PATH_NOT_ALLOWED',
      'Запись разрешена только в /data/opt и /data/sounds',
      403,
    );
  }
  return remotePath;
}

export function assertSoundPath(input: unknown): string {
  const remotePath = normalizeRemotePath(input);
  if (!isWithin(SOUNDS_ROOT, remotePath) || remotePath === SOUNDS_ROOT) {
    throw new AccError('PATH_NOT_ALLOWED', 'Звук должен находиться в системном каталоге звуков', 403);
  }
  return remotePath;
}

const DANGEROUS_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.apk', '.elf', '.ko', '.img', '.deb', '.ipk',
  '.run', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.scr', '.jar',
]);

const BINARY_MAGIC: Array<{ name: string; bytes: number[] }> = [
  { name: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'PE', bytes: [0x4d, 0x5a] },
  { name: 'Mach-O', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
];

export function assertSafeUpload(name: string, buffer: Buffer): void {
  const ext = path.posix.extname(name).toLowerCase();
  if (DANGEROUS_EXTENSIONS.has(ext)) {
    throw new AccError('FILE_TYPE_BLOCKED', `Файлы ${ext} загружать в это хранилище нельзя`, 415);
  }
  for (const magic of BINARY_MAGIC) {
    if (magic.bytes.every((byte, index) => buffer[index] === byte)) {
      throw new AccError(
        'FILE_TYPE_BLOCKED',
        `Обнаружен исполняемый формат ${magic.name}, загрузка заблокирована`,
        415,
      );
    }
  }
}

export function isAudioName(name: string): boolean {
  return ['.mp3', '.wav', '.ogg', '.opus', '.flac', '.m4a', '.aac'].includes(
    path.posix.extname(name).toLowerCase(),
  );
}

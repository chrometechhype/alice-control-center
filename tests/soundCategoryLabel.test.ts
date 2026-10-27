import { describe, expect, it } from 'vitest';
import { soundCategoryLabel } from '../src/lib/format.ts';

describe('soundCategoryLabel', () => {
  it('names the language instead of leaving a locale code on screen', () => {
    expect(soundCategoryLabel('ru-RU')).toBe('Русский');
    expect(soundCategoryLabel('ar-EG')).toBe('Арабский');
    expect(soundCategoryLabel('kk-KZ')).toBe('Казахский');
  });

  it('translates the two folder names the station ships with', () => {
    expect(soundCategoryLabel('common')).toBe('Общие');
    expect(soundCategoryLabel('root')).toBe('Без папки');
  });

  it('leaves anything it cannot name exactly as the station calls it', () => {
    expect(soundCategoryLabel('Мои звуки')).toBe('Мои звуки');
    expect(soundCategoryLabel('zz-ZZ')).toBe('zz-ZZ');
    expect(soundCategoryLabel('my-pack')).toBe('my-pack');
    expect(soundCategoryLabel('alarm')).toBe('alarm');
    expect(soundCategoryLabel('')).toBe('');
  });
});

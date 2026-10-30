import { describe, expect, it } from 'vitest';
import { shapeSpeech } from '../server/speechShape.ts';

describe('shapeSpeech', () => {
  it('splits a multi-sentence phrase so every mark survives', () => {
    const { segments } = shapeSpeech('Всё готово. Проверьте колонку! А теперь тише?');
    expect(segments).toEqual(['Всё готово.', 'Проверьте колонку!', 'А теперь тише?']);
  });

  it('keeps a sentence without a trailing mark', () => {
    expect(shapeSpeech('Загрузка завершена').segments).toEqual(['Загрузка завершена']);
  });

  it('does not cut a decimal number in half', () => {
    expect(shapeSpeech('Температура 42.5 градуса').segments).toEqual(['Температура 42.5 градуса']);
  });

  it('replaces latin abbreviations the voice would spell out', () => {
    const [line] = shapeSpeech('Wi-Fi и SSH работают').segments;
    expect(line).toBe('вай-фай и эс-эс-эйч работают');
  });

  it('reads a path as words instead of slashes', () => {
    expect(shapeSpeech('Файл в /data/sounds лежит').segments[0]).toContain('в каталоге звуков');
  });

  it('turns pause markup into punctuation the synthesiser obeys', () => {
    expect(shapeSpeech('Слушай| и запомни|| спасибо').segments).toEqual([
      'Слушай.',
      'и запомни…',
      'спасибо',
    ]);
  });

  it('drops SSML instead of speaking it', () => {
    const shaped = shapeSpeech('<break time="500ms"/> Привет');
    expect(shaped.segments).toEqual(['Привет']);
    expect(shaped.stripped.length).toBeGreaterThan(0);
  });

  it('applies moods without inventing words', () => {
    expect(shapeSpeech('Проверьте колонку', 'brisk').segments).toEqual(['Проверьте колонку!']);
    expect(shapeSpeech('Колонка отключилась, подождите', 'calm').segments).toEqual([
      'Колонка отключилась… подождите.',
    ]);
    expect(shapeSpeech('Утечка воды', 'alert').segments).toEqual(['Утечка воды!']);
    expect(shapeSpeech('Ложись спать, завтра тренировка', 'care').segments).toEqual([
      'Ложись спать, завтра тренировка…',
    ]);
  });

  it('collapses whitespace and stray spaces before marks', () => {
    expect(shapeSpeech('  Привет ,   мир ?  ').segments).toEqual(['Привет, мир?']);
  });

  it('returns nothing for empty or punctuation-only input', () => {
    expect(shapeSpeech('   ').segments).toEqual([]);
  });
});

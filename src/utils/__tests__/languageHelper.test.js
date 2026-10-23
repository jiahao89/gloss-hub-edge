import { describe, it, expect } from 'vitest';
import { 
  findTranslationForLang,
  extractExistingTranslations,
  formatExistingReferenceContext,
  mergeTranslations 
} from '../languageHelper';

describe('findTranslationForLang', () => {
  it('exact match wins', () => {
    expect(findTranslationForLang({ 'EN（英文）': 'hello' }, 'EN（英文）')).toBe('hello');
  });

  it('matches bare code key to decorated target', () => {
    expect(findTranslationForLang({ EN: 'hello' }, 'EN（英文）')).toBe('hello');
  });

  it('matches English name key to decorated target', () => {
    expect(findTranslationForLang({ English: 'hello' }, 'EN（英文）')).toBe('hello');
  });

  it('matches decorated key to bare-code target (reverse direction)', () => {
    expect(findTranslationForLang({ 'EN（英文）': 'hello' }, 'EN')).toBe('hello');
  });

  it('matches Chinese-name-only target (瑞典)', () => {
    expect(findTranslationForLang({ '瑞典语': 'hej' }, '瑞典')).toBe('hej');
  });

  it('skips empty/null values', () => {
    expect(findTranslationForLang({ EN: '', EN_US: null }, 'EN（英文）')).toBeUndefined();
  });

  it('returns undefined for null result or no match', () => {
    expect(findTranslationForLang(null, 'EN（英文）')).toBeUndefined();
    expect(findTranslationForLang({ FR: 'bonjour' }, 'EN（英文）')).toBeUndefined();
  });

  it('does not cross-match unrelated languages', () => {
    // ES must not match target EN via name substring
    expect(findTranslationForLang({ ES: 'hola' }, 'EN（英文）')).toBeUndefined();
  });
});

describe('extractExistingTranslations', () => {
  it('extracts non-empty translations for specified target languages', () => {
    const fields = {
      'CN（中文）': '踏频',
      'EN（英文）': 'Cadence',
      'FR（法）': ' ',
      'DE（德）': 'Trittfrequenz',
      'KW': 'KW_CADENCE'
    };
    const targetLangs = ['EN（英文）', 'FR（法）', 'DE（德）', 'JA（日）'];
    const result = extractExistingTranslations(fields, targetLangs);
    expect(result).toEqual({
      'EN（英文）': 'Cadence',
      'DE（德）': 'Trittfrequenz'
    });
  });

  it('returns empty object when fields or targetLanguages are empty', () => {
    expect(extractExistingTranslations(null, ['EN'])).toEqual({});
    expect(extractExistingTranslations({}, ['EN'])).toEqual({});
    expect(extractExistingTranslations({ EN: 'Hi' }, [])).toEqual({});
  });
});

describe('formatExistingReferenceContext', () => {
  it('formats existing translations into prompt context', () => {
    const existing = {
      'EN（英文）': 'Cadence',
      'DE（德）': 'Trittfrequenz'
    };
    const formatted = formatExistingReferenceContext(existing);
    expect(formatted).toContain('已有现存翻译参考');
    expect(formatted).toContain('EN（英文）="Cadence"');
    expect(formatted).toContain('DE（德）="Trittfrequenz"');
  });

  it('returns empty string if no existing translations', () => {
    expect(formatExistingReferenceContext({})).toBe('');
    expect(formatExistingReferenceContext(null)).toBe('');
  });
});

describe('mergeTranslations', () => {
  const targetLanguages = ['EN（英文）', 'FR（法）', 'DE（德）'];

  it('默认 preserveExisting=true 时，绝不纠正或覆盖已存在的翻译', () => {
    const currentFields = {
      'CN（中文）': '踏频',
      'EN（英文）': 'Cadence', // 已有翻译
      'FR（法）': '',
      'DE（德）': null
    };
    const aiResult = {
      'EN': 'Pedal frequency', // AI 给出了不同的英语翻译
      'FR': 'Cadence FR',
      'DE': 'Trittfrequenz'
    };

    const { updatedFields, changedCount, preservedCount } = mergeTranslations({
      currentFields,
      aiResult,
      targetLanguages,
      preserveExisting: true
    });

    // 默认不纠正已存在的英语翻译
    expect(updatedFields['EN（英文）']).toBe('Cadence');
    // 空白的法语和德语被填入
    expect(updatedFields['FR（法）']).toBe('Cadence FR');
    expect(updatedFields['DE（德）']).toBe('Trittfrequenz');
    expect(preservedCount).toBe(1);
    expect(changedCount).toBe(2);
  });

  it('当 preserveExisting=false 时，允许覆盖所有语种', () => {
    const currentFields = {
      'CN（中文）': '踏频',
      'EN（英文）': 'Cadence',
      'FR（法）': 'Old FR'
    };
    const aiResult = {
      'EN': 'Pedal frequency',
      'FR': 'New FR'
    };

    const { updatedFields, changedCount, preservedCount } = mergeTranslations({
      currentFields,
      aiResult,
      targetLanguages,
      preserveExisting: false
    });

    expect(updatedFields['EN（英文）']).toBe('Pedal frequency');
    expect(updatedFields['FR（法）']).toBe('New FR');
    expect(preservedCount).toBe(0);
    expect(changedCount).toBe(2);
  });
});


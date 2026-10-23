/**
 * Fuzzy-match a translation for a given target language key from an AI result object.
 *
 * The AI may return keys like "EN", "English", "EN（英文）", etc.
 * This helper first tries an exact match, then falls back to language-code
 * prefix matching and Chinese-name substring matching.
 *
 * @param {Object} result - The translation result object (key → translated string).
 * @param {string} targetLang - The target language label, e.g. "EN（英文）".
 * @returns {string|undefined} The matched translation value, or undefined.
 */
export function findTranslationForLang(result, targetLang) {
  if (!result || typeof result !== 'object') return undefined;
  if (result[targetLang] !== undefined) return result[targetLang];

  const codeMatch = String(targetLang).match(/^([A-Za-z]+)/);
  const code = codeMatch ? codeMatch[1].toUpperCase() : '';
  const nameClean = String(targetLang).replace(/^[A-Za-z]+\s*[（(]?/i, '')
                              .replace(/[）)]?$/g, '')
                              .replace(/语|文/g, '')
                              .trim();

  for (const [k, v] of Object.entries(result)) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const kClean = k.replace(/[（()）]/g, '').replace(/语|文/g, '').trim();

    // Extract the code prefix from the key too, so "EN（英文）" matches target "EN".
    // Only short prefixes (≤3 chars) count as codes; longer words are language names.
    const kCodeMatch = k.match(/^([A-Za-z]+)/);
    const kCodeRaw = kCodeMatch ? kCodeMatch[1].toUpperCase() : '';
    const kCode = kCodeRaw.length > 0 && kCodeRaw.length <= 3 ? kCodeRaw : '';
    // Map common English language names to codes, so "English" matches target "EN（英文）"
    const kCodeFromName = ENGLISH_NAME_TO_CODE[kLower(kClean)] || '';

    if (code && (kCode === code || kCodeFromName === code
      || kCode.startsWith(code + '_') || kCode.startsWith(code + '-'))) {
      return v;
    }
    if (nameClean && (kClean.includes(nameClean) || nameClean.includes(kClean))) {
      return v;
    }
  }
  return undefined;
}

function kLower(s) {
  return String(s).toLowerCase().trim();
}

/** Common English language names the AI may return, mapped to ISO-like codes. */
const ENGLISH_NAME_TO_CODE = {
  english: 'EN', chinese: 'CN', 'traditional chinese': 'TC', french: 'FR',
  german: 'DE', spanish: 'ES', italian: 'IT', portuguese: 'PT',
  korean: 'KO', japanese: 'JP', russian: 'RU', polish: 'PL',
  danish: 'DA', czech: 'CZ', swedish: 'SE', norwegian: 'NO', dutch: 'NL',
  thai: 'TH',
};

/**
 * Default target language labels used as fallback when a project
 * has no custom language configuration.
 */
export const DEFAULT_TARGET_LANGUAGES = [
  'EN（英文）', 'FR（法）', 'DE（德）', 'ES（西班牙）', 'IT（意大利）', 'PT（葡萄牙）', 
  'KO（韩）', 'JP（日）', 'RU（俄罗斯）', 'PL（波兰）', 'TC（繁）', 'DA（丹麦）', 
  'CZ(捷克)', '瑞典', '挪威', '荷兰', '泰语'
];

/**
 * Extract existing non-empty translations from a fields or row object.
 *
 * @param {Object} fieldsOrRow - Source fields or row.
 * @param {Array<string>} targetLanguages - List of target languages to check.
 * @returns {Record<string, string>} Map of language label to existing non-empty translation string.
 */
export function extractExistingTranslations(fieldsOrRow = {}, targetLanguages = []) {
  if (!fieldsOrRow || typeof fieldsOrRow !== 'object') return {};
  const existing = {};

  targetLanguages.forEach(lang => {
    const val = fieldsOrRow[lang];
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      existing[lang] = String(val).trim();
    }
  });

  return existing;
}

/**
 * Format existing translations into a reference string for AI context.
 *
 * @param {Record<string, string>} existingTranslations - Map of language label to translation.
 * @returns {string} Formatted context snippet, e.g. "已有现存翻译参考(保持一致，不予纠正): EN（英文）=\"Cadence\"".
 */
export function formatExistingReferenceContext(existingTranslations = {}) {
  if (!existingTranslations || typeof existingTranslations !== 'object') return '';
  const entries = Object.entries(existingTranslations).filter(([, v]) => v && String(v).trim());
  if (entries.length === 0) return '';
  const formatted = entries.map(([lang, val]) => `${lang}="${String(val).trim()}"`).join('; ');
  return `已有现存翻译参考(保持一致，不予纠正): ${formatted}`;
}

/**
 * Merge AI translation results into current fields.
 * If preserveExisting is true (default), any language that already has a non-empty
 * translation will NOT be overwritten or corrected.
 *
 * @param {Object} params
 * @param {Object} params.currentFields - Current fields or row object.
 * @param {Object} params.aiResult - Raw translation result from AI / TM.
 * @param {Array<string>} params.targetLanguages - List of target language labels.
 * @param {boolean} [params.preserveExisting=true] - Whether to preserve existing non-empty translations.
 * @returns {{ updatedFields: Object, changedCount: number, preservedCount: number }}
 */
export function mergeTranslations({ currentFields = {}, aiResult = {}, targetLanguages = [], preserveExisting = true }) {
  const updatedFields = { ...currentFields };
  let changedCount = 0;
  let preservedCount = 0;

  targetLanguages.forEach(lang => {
    const existingVal = currentFields[lang];
    const hasExisting = existingVal !== undefined && existingVal !== null && String(existingVal).trim() !== '';

    if (preserveExisting && hasExisting) {
      preservedCount++;
      return;
    }

    const aiVal = findTranslationForLang(aiResult, lang);
    if (aiVal !== undefined && aiVal !== null && String(aiVal).trim() !== '') {
      updatedFields[lang] = String(aiVal).trim();
      changedCount++;
    }
  });

  return { updatedFields, changedCount, preservedCount };
}


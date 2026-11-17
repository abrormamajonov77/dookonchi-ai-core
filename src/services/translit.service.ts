import { normalizeForSearch, toLatinUz } from '../utils/transliterate';

export class TranslitService {
  static toLatin(text: string): string {
    return toLatinUz(text);
  }

  static generateSearchTokens(text: string): string {
    if (!text) return '';
    const orig = text.toLowerCase().trim();
    const latin = toLatinUz(text).toLowerCase().replace(/['ʻʼ`’]/g, '').trim();
    const phonetic = normalizeForSearch(text);
    const tokens = new Set<string>([
      ...orig.split(/\s+/),
      ...latin.split(/\s+/),
      ...phonetic.split(/\s+/),
    ]);
    return Array.from(tokens).filter(Boolean).join(' ');
  }
}

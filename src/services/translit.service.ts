export class TranslitService {
  private static mapping: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'j', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't',
    'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 's', 'ч': 'ch', 'ш': 'sh', 'щ': 'sh', 'ъ': '', 'ы': 'i', 'ь': '',
    'э': 'e', 'ю': 'yu', 'я': 'ya', 'ў': 'o\'', 'қ': 'q', 'ғ': 'g\'', 'ҳ': 'h',
    
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Е': 'E', 'Ё': 'Yo', 'Ж': 'J', 'З': 'Z', 'И': 'I',
    'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R', 'С': 'S', 'Т': 'T',
    'У': 'U', 'Ф': 'F', 'Х': 'X', 'Ц': 'S', 'Ч': 'Ch', 'Ш': 'Sh', 'Щ': 'Sh', 'Ъ': '', 'Ы': 'I', 'Ь': '',
    'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya', 'Ў': 'O\'', 'Қ': 'Q', 'Ғ': 'G\'', 'Ҳ': 'H'
  };

  /**
   * Converts cyrillic text to latin.
   */
  static toLatin(text: string): string {
    if (!text) return '';
    let result = '';
    // simple character by character replacement, digraphs handled somewhat correctly by the mapping
    // for advanced digraphs we replace multi-chars first
    let temp = text
      .replace(/ш/g, 'sh').replace(/Ш/g, 'Sh')
      .replace(/ч/g, 'ch').replace(/Ч/g, 'Ch')
      .replace(/ю/g, 'yu').replace(/Ю/g, 'Yu')
      .replace(/я/g, 'ya').replace(/Я/g, 'Ya')
      .replace(/ё/g, 'yo').replace(/Ё/g, 'Yo')
      .replace(/ў/g, "o'").replace(/Ў/g, "O'")
      .replace(/ғ/g, "g'").replace(/Ғ/g, "G'")
      .replace(/ц/g, 'ts').replace(/Ц/g, 'Ts');

    for (const char of temp) {
      result += this.mapping[char] ?? char;
    }
    return result;
  }

  /**
   * Generates search tokens (combining lowercased original and transliterated versions)
   */
  static generateSearchTokens(text: string): string {
    if (!text) return '';
    const cleanOrig = text.toLowerCase().trim();
    const cleanLatin = this.toLatin(cleanOrig).toLowerCase().replace(/['`’]/g, '');
    
    // Split into words and keep unique
    const words = [...new Set([...cleanOrig.split(/\s+/), ...cleanLatin.split(/\s+/)])];
    return words.join(' ');
  }
}

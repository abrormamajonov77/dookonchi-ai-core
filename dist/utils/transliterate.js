"use strict";
/**
 * MODUL 3: Central Cyrillic-to-Uzbek-Latin Transliterator & Phonetic Search Normalizer
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.hasCyrillic = hasCyrillic;
exports.toLatinUz = toLatinUz;
exports.normalizeForSearch = normalizeForSearch;
const CYRILLIC_VOWELS = new Set([
    'а', 'е', 'ё', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я', 'ў',
    'А', 'Е', 'Ё', 'И', 'О', 'У', 'Ы', 'Э', 'Ю', 'Я', 'Ў',
]);
const CYRILLIC_SIGNS = new Set(['ъ', 'ь', 'Ъ', 'Ь']);
const BASE_MAP = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ж': 'j', 'з': 'z', 'и': 'i',
    'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r',
    'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'x', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh',
    'щ': 'sh', 'ъ': '', 'ы': 'i', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'ў': "o'", 'қ': 'q', 'ғ': "g'", 'ҳ': 'h',
    'А': 'A', 'Б': 'B', 'В': 'V', 'Г': 'G', 'Д': 'D', 'Ж': 'J', 'З': 'Z', 'И': 'I',
    'Й': 'Y', 'К': 'K', 'Л': 'L', 'М': 'M', 'Н': 'N', 'О': 'O', 'П': 'P', 'Р': 'R',
    'С': 'S', 'Т': 'T', 'У': 'U', 'Ф': 'F', 'Х': 'X', 'Ц': 'Ts', 'Ч': 'Ch', 'Ш': 'Sh',
    'Щ': 'Sh', 'Ъ': '', 'Ы': 'I', 'Ь': '', 'Э': 'E', 'Ю': 'Yu', 'Я': 'Ya',
    'Ў': "O'", 'Қ': 'Q', 'Ғ': "G'", 'Ҳ': 'H',
};
const UPPER_DIGRAPHS = {
    'Ё': 'YO',
    'Ц': 'TS',
    'Ч': 'CH',
    'Ш': 'SH',
    'Щ': 'SH',
    'Ю': 'YU',
    'Я': 'YA',
};
function isCyrillicUpper(ch) {
    if (!ch)
        return false;
    return /[А-ЯЁЎҚҒҲ]/.test(ch);
}
function isCyrillicLetter(ch) {
    if (!ch)
        return false;
    return /[а-яёўқғҳА-ЯЁЎҚҒҲ]/.test(ch);
}
function hasCyrillic(text) {
    return /[а-яёўқғҳА-ЯЁЎҚҒҲ]/.test(text || '');
}
/**
 * Converts any Cyrillic text to Uzbek Latin script accurately.
 * E.g. "Ярко Соус Томат 500гр" -> "Yarko Sous Tomat 500gr"
 *      "Юсуфхон кетчуп" -> "Yusufxon ketchup"
 */
function toLatinUz(text) {
    if (!text)
        return '';
    if (!hasCyrillic(text))
        return text;
    const chars = Array.from(text);
    const out = [];
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const prev = i > 0 ? chars[i - 1] : undefined;
        const next = i + 1 < chars.length ? chars[i + 1] : undefined;
        const isAllCapsContext = isCyrillicUpper(ch) && (isCyrillicUpper(next) || (isCyrillicUpper(prev) && !isCyrillicLetter(next)));
        if (ch === 'е' || ch === 'Е') {
            const isInitialOrAfterVowel = !prev || !isCyrillicLetter(prev) || CYRILLIC_VOWELS.has(prev) || CYRILLIC_SIGNS.has(prev);
            if (ch === 'е') {
                out.push(isInitialOrAfterVowel ? 'ye' : 'e');
            }
            else {
                out.push(isInitialOrAfterVowel ? (isAllCapsContext ? 'YE' : 'Ye') : 'E');
            }
            continue;
        }
        if (ch === 'ё') {
            out.push('yo');
            continue;
        }
        if (ch === 'Ё') {
            out.push(isAllCapsContext ? 'YO' : 'Yo');
            continue;
        }
        if (ch in UPPER_DIGRAPHS && isAllCapsContext) {
            out.push(UPPER_DIGRAPHS[ch]);
            continue;
        }
        out.push(BASE_MAP[ch] ?? ch);
    }
    return out.join('');
}
/**
 * Phonetic and bi-alphabetical normalizer for search queries and index comparison.
 * Converts Cyrillic -> Latin, lowercases, strips apostrophes, and normalizes h -> x.
 */
function normalizeForSearch(query) {
    if (!query)
        return '';
    return toLatinUz(query)
        .toLowerCase()
        .replace(/['ʻʼ`’]/g, '')
        .replace(/(?<![sc])h/g, 'x')
        .replace(/\s+/g, ' ')
        .trim();
}

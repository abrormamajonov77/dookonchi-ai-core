"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranslitService = void 0;
const transliterate_1 = require("../utils/transliterate");
class TranslitService {
    static toLatin(text) {
        return (0, transliterate_1.toLatinUz)(text);
    }
    static generateSearchTokens(text) {
        if (!text)
            return '';
        const orig = text.toLowerCase().trim();
        const latin = (0, transliterate_1.toLatinUz)(text).toLowerCase().replace(/['ʻʼ`’]/g, '').trim();
        const phonetic = (0, transliterate_1.normalizeForSearch)(text);
        const tokens = new Set([
            ...orig.split(/\s+/),
            ...latin.split(/\s+/),
            ...phonetic.split(/\s+/),
        ]);
        return Array.from(tokens).filter(Boolean).join(' ');
    }
}
exports.TranslitService = TranslitService;

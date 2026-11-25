"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CASH_SOURCE_BTN_CANCEL = exports.CASH_SOURCE_BTN_SAFE = exports.CASH_SOURCE_BTN_TODAY = exports.CASH_SOURCE_PROMPT_TEXT = void 0;
exports.cashSourceToPaymentSource = cashSourceToPaymentSource;
exports.paymentSourceToCashSource = paymentSourceToCashSource;
exports.resolveEffectiveCashSource = resolveEffectiveCashSource;
exports.isTodayRegisterCashSource = isTodayRegisterCashSource;
exports.isSafeCashSource = isSafeCashSource;
exports.formatCashSourceBadge = formatCashSourceBadge;
exports.formatCashSourceDisplay = formatCashSourceDisplay;
exports.formatCashSourceZReportNote = formatCashSourceZReportNote;
exports.detectCashSourceFromText = detectCashSourceFromText;
const transliterate_1 = require("./transliterate");
exports.CASH_SOURCE_PROMPT_TEXT = '💰 Bu naqd tovarlar qaysi puldan olindi?';
exports.CASH_SOURCE_BTN_TODAY = '💵 Bugungi kassadan';
exports.CASH_SOURCE_BTN_SAFE = '🔐 Seyfdan (kechagi pul)';
exports.CASH_SOURCE_BTN_CANCEL = '❌ Bekor qilish';
const RE_SAFE_SOURCE = /\b(seyf(?:dan|ga|da|dagi|imdan)?|seif(?:dan|ga|da|dagi)?|kechagi(?:\s+pul(?:dan|i)?|\s+kassa(?:dan)?)?|kecha\s+pul(?:dan)?|eski\s*kassa(?:dan)?|eski\s*pul(?:dan)?|avvalgi\s*pul(?:dan)?|zaxira(?:dan)?)\b/i;
const RE_TODAY_REGISTER_SOURCE = /\b(bugungi\s*(?:kassa(?:dan|da)?|pul(?:dan|i)?|savdo(?:dan)?)|kassa(?:dan|dagi)|kassa\s+pul(?:idan|dan)?|bugungi)\b/i;
function cashSourceToPaymentSource(source) {
    return source === 'SAFE' ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
}
function paymentSourceToCashSource(paymentSource) {
    const norm = String(paymentSource || '').trim().toUpperCase();
    if (norm === 'PREVIOUS_SAFE' || norm === 'SAFE') {
        return 'SAFE';
    }
    return 'TODAY_REGISTER';
}
/**
 * Resolves the effective CashSource for a record, preferring the explicit `cashSource` enum
 * and falling back to legacy `paymentSource` ("TODAY_CASH" / "PREVIOUS_SAFE") so existing
 * historical rows remain 100% compatible.
 */
function resolveEffectiveCashSource(record) {
    const explicit = String(record?.cashSource || '').trim().toUpperCase();
    if (explicit === 'SAFE')
        return 'SAFE';
    if (explicit === 'TODAY_REGISTER')
        return 'TODAY_REGISTER';
    return paymentSourceToCashSource(record?.paymentSource);
}
function isTodayRegisterCashSource(record) {
    return resolveEffectiveCashSource(record) === 'TODAY_REGISTER';
}
function isSafeCashSource(record) {
    return resolveEffectiveCashSource(record) === 'SAFE';
}
function formatCashSourceBadge(cashSource, paymentSource) {
    return resolveEffectiveCashSource({ cashSource, paymentSource }) === 'SAFE'
        ? 'Seyfdan'
        : 'Kassadan';
}
function formatCashSourceDisplay(cashSource, paymentSource) {
    return resolveEffectiveCashSource({ cashSource, paymentSource }) === 'SAFE'
        ? exports.CASH_SOURCE_BTN_SAFE
        : exports.CASH_SOURCE_BTN_TODAY;
}
function formatCashSourceZReportNote(source) {
    return source === 'SAFE'
        ? "Bugungi kassa (Z-otchyot) dan ayirilmadi (Seyfdan / kechagi pul)."
        : "Bugungi Z-otchyot naqd xaridlariga qo'shildi (Bugungi kassadan).";
}
/**
 * Detects explicit cash source keywords in Uzbek (Latin or Cyrillic):
 * - "seyfdan", "kechagi puldan", "eski kassadan" -> SAFE
 * - "bugungi kassadan", "kassadan", "bugungi puldan" -> TODAY_REGISTER
 * - omitted -> cashSource: null, hasExplicitSource: false
 */
function detectCashSourceFromText(rawText) {
    const latin = (0, transliterate_1.toLatinUz)(String(rawText || '')).trim();
    if (!latin) {
        return { cashSource: null, hasExplicitSource: false, paymentSource: 'TODAY_CASH' };
    }
    // Check SAFE before TODAY_REGISTER so "eski kassadan" / "kechagi kassadan" map to SAFE
    if (RE_SAFE_SOURCE.test(latin)) {
        return { cashSource: 'SAFE', hasExplicitSource: true, paymentSource: 'PREVIOUS_SAFE' };
    }
    if (RE_TODAY_REGISTER_SOURCE.test(latin)) {
        return { cashSource: 'TODAY_REGISTER', hasExplicitSource: true, paymentSource: 'TODAY_CASH' };
    }
    return { cashSource: null, hasExplicitSource: false, paymentSource: 'TODAY_CASH' };
}

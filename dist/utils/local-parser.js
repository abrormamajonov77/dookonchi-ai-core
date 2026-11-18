"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanAmount = cleanAmount;
exports.parseTextCommandLocally = parseTextCommandLocally;
const formatters_1 = require("./formatters");
const transliterate_1 = require("./transliterate");
const RE_USD = /(\$|usd\b|usdt\b|dollar|doll\b|dolar\b|sent\b|cent\b)/i;
const RE_SHORT_MLN = /(?:^|[\s+-])(\d+(?:[.,]\d+)?)\s*m(?:ln|illion)?\b/i;
const RE_SHORT_MING = /(?:^|[\s+-])(\d+(?:[.,]\d+)?)\s*k\b/i;
const RE_SOM = /so'?m\b/i;
const RE_PRICE_QUERY = /^(.+?)\s+(?:narxi\s*nechpul|narxi\s*qancha|qancha\s*turadi|nechpul|nechi\s*pul|narxi|narx)\??$/i;
const RE_DEBT_QUERY = /^(.+?)(?:dan|ning)?\s+(?:qancha\s*qarz(?:im|imiz)?(?:\s*bor)?|qarz(?:i|im|imiz)?\s*qancha(?:\s*bo'?ldi)?)\??$/i;
const RE_PREV_SAFE = /\b(kecha(?:gi)?|seyf(?:dan)?|seif(?:dan)?|eski\s*kassa(?:dan)?)\b/i;
const RE_TODAY_CASH = /\b(bugun(?:gi)?|kassa(?:dan)?)\b/i;
const RE_MINUS_SIGN = /(?:^|\s)-\s*\$?\s*\d/;
const RE_PAYMENT_KW = /\b(to'?lov|tolov|tulov|berdim|berdik|to'?ladim|toladim|ayir(?:dim|ing|ib\s*qo'?y|ish)?|minus)\b/i;
const RE_CASH_KW = /\b(naqd(?:ga)?|naqt(?:ga)?|nal|cash)\b/i;
const RE_EXPENSE_KW = /\b(ijara(?:ga)?|elektr(?:ga)?|svet(?:ga)?|gaz(?:ga)?|soliq(?:qa)?|oylik(?:ka)?|tushlik|obed|xarajat)\b/i;
const RE_STRIP_AMT = /(?:[+-]\s*)?\$?\s*\d[\d\s.,_]*(?:\s*(?:(?:mln|million|ming|k|m|usd|usdt|dollar(?:u)?|doll|dolar|sent|cent|so'?m)\b|\$))?/gi;
const RE_STRIP_CENTS = /\b(\d{1,2}\s*(?:sent|cent))\b/gi;
const RE_STRIP_KEYWORDS = /\b(naqd(?:ga)?|naqt(?:ga)?|nal|cash|nasiya(?:ga)?|qarz(?:ga)?|kirim|yuk(?:\s*keldi)?|to'?lov|tolov|tulov|berdim|berdik|to'?ladim|toladim|ayir(?:dim|ing|ish)?|minus|kecha(?:gi)?|pul(?:dan|ga)?|seyf(?:dan)?|seif(?:dan)?|bugun(?:gi)?|kassa(?:dan)?|so'?m|som|usd|usdt|dollar|sent|cent)\b/gi;
const RE_STRIP_CASE_SUFFIX = /([a-zA-Z0-9'ʻʼ]{3,})(?:dan|ga)$/i;
const RE_MULTI_NUM_UNITS = /\d+\s*(?:dona|ta|korobka|kor|sht|kg|gr|litr|up|pachka|blok)\b.*\d/i;
const RE_INCOMING_CASE_HINT = /\b(yuk|keldi|oldi[mk]?|kirim)\b|(?:dan|ga)\s+[+-]?\$?\s*\d/i;
/**
 * MODUL 2.1: Clean and parse numeric amounts including thousands separators ("500.000", "500_000", "1.200.000"),
 * shorthand multipliers ("500k", "1.5m", "1.5 mln"), and USD cents ("102.17$", "102 dollar 17 sent").
 */
function cleanAmount(rawText) {
    if (!rawText || typeof rawText !== 'string') {
        return { amount: 0, currency: 'UZS' };
    }
    const normalized = (0, transliterate_1.toLatinUz)(rawText).replace(/_/g, ' ').trim();
    const isUsd = RE_USD.test(normalized);
    const currency = isUsd ? 'USD' : 'UZS';
    const shortMlnMatch = normalized.match(RE_SHORT_MLN);
    if (shortMlnMatch && !RE_SOM.test(shortMlnMatch[0])) {
        const val = parseFloat(shortMlnMatch[1].replace(',', '.'));
        if (!isNaN(val) && val > 0) {
            return { amount: Number((val * 1_000_000).toFixed(2)), currency };
        }
    }
    const shortMingMatch = normalized.match(RE_SHORT_MING);
    if (shortMingMatch) {
        const val = parseFloat(shortMingMatch[1].replace(',', '.'));
        if (!isNaN(val) && val > 0) {
            return { amount: Number((val * 1_000).toFixed(2)), currency };
        }
    }
    return (0, formatters_1.parseCurrencyAndAmount)(normalized);
}
/**
 * MODUL 2: Instant Local Text Command Parser (<0.001s, 100% AI-free).
 */
function parseTextCommandLocally(rawInput) {
    if (!rawInput || typeof rawInput !== 'string')
        return null;
    const trimmed = rawInput.trim();
    if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\n'))
        return null;
    const latinText = (0, transliterate_1.toLatinUz)(trimmed);
    // 1. Check product price search query
    const priceMatch = latinText.match(RE_PRICE_QUERY);
    if (priceMatch && priceMatch[1].trim().length >= 2 && !/\d/.test(priceMatch[1])) {
        const prodName = priceMatch[1].trim();
        return {
            intent: 'SEARCH_PRODUCT',
            supplierName: prodName,
            name: prodName,
            amount: 0,
            currency: 'UZS',
            paymentSource: 'TODAY_CASH',
            hasExplicitSource: false,
        };
    }
    // 2. Check supplier debt inquiry
    const debtInfoMatch = latinText.match(RE_DEBT_QUERY);
    if (debtInfoMatch && debtInfoMatch[1].trim().length >= 2 && !/\d/.test(debtInfoMatch[1])) {
        const supName = debtInfoMatch[1].trim();
        return {
            intent: 'GET_DEBT_INFO',
            supplierName: supName,
            name: supName,
            amount: 0,
            currency: 'UZS',
            paymentSource: 'TODAY_CASH',
            hasExplicitSource: false,
        };
    }
    if (!/\d/.test(latinText) || RE_MULTI_NUM_UNITS.test(latinText))
        return null;
    const { amount, currency } = cleanAmount(latinText);
    if (!amount || amount <= 0 || isNaN(amount))
        return null;
    const isPreviousSafe = RE_PREV_SAFE.test(latinText);
    const isExplicitToday = RE_TODAY_CASH.test(latinText);
    const paymentSource = isPreviousSafe ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
    const hasExplicitSource = isPreviousSafe || isExplicitToday;
    const hasMinusSign = RE_MINUS_SIGN.test(latinText);
    const hasPaymentKeyword = RE_PAYMENT_KW.test(latinText);
    const hasCashKeyword = RE_CASH_KW.test(latinText);
    const hasExpenseKeyword = RE_EXPENSE_KW.test(latinText);
    const rawNameCleaned = latinText
        .replace(RE_STRIP_AMT, ' ')
        .replace(RE_STRIP_CENTS, ' ')
        .replace(RE_STRIP_KEYWORDS, ' ')
        .replace(/[+$_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const shouldStripCase = hasMinusSign || hasPaymentKeyword || RE_INCOMING_CASE_HINT.test(latinText);
    const supplierName = shouldStripCase
        ? rawNameCleaned.replace(RE_STRIP_CASE_SUFFIX, '$1').trim()
        : rawNameCleaned.trim();
    if (!supplierName || supplierName.length < 2)
        return null;
    if (hasExpenseKeyword && !hasMinusSign) {
        return {
            intent: 'ADD_EXPENSE',
            supplierName,
            name: supplierName,
            amount,
            currency,
            paymentSource,
            hasExplicitSource,
            category: supplierName,
            comment: latinText,
        };
    }
    if (hasCashKeyword) {
        return {
            intent: 'INVOICE_CASH',
            supplierName,
            name: supplierName,
            amount,
            currency,
            paymentType: 'CASH',
            txType: 'INCOMING_GOODS',
            paymentSource,
            hasExplicitSource,
            comment: latinText,
        };
    }
    if (hasMinusSign || hasPaymentKeyword) {
        return {
            intent: 'SUPPLIER_PAYMENT',
            supplierName,
            name: supplierName,
            amount,
            currency,
            txType: 'PAYMENT',
            paymentSource,
            hasExplicitSource,
            comment: latinText,
        };
    }
    return {
        intent: 'INVOICE_CREDIT',
        supplierName,
        name: supplierName,
        amount,
        currency,
        paymentType: 'CREDIT',
        txType: 'INCOMING_GOODS',
        paymentSource,
        hasExplicitSource,
        comment: latinText,
    };
}

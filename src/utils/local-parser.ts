import { parseCurrencyAndAmount } from './formatters';
import { toLatinUz } from './transliterate';

export interface LocalParsedCommand {
  intent:
    | 'INVOICE_CASH'
    | 'INVOICE_CREDIT'
    | 'SUPPLIER_PAYMENT'
    | 'ADD_SUPPLIER_RETURN'
    | 'ADD_EXPENSE'
    | 'SEARCH_PRODUCT'
    | 'GET_DEBT_INFO';
  supplierName: string;
  name: string;
  amount: number;
  currency: 'UZS' | 'USD';
  paymentType?: 'CASH' | 'CREDIT';
  txType?: 'INCOMING_GOODS' | 'PAYMENT' | 'RETURN';
  paymentSource: 'TODAY_CASH' | 'PREVIOUS_SAFE';
  hasExplicitSource: boolean;
  category?: string;
  comment?: string;
  note?: string;
}

const RE_USD = /(\$|usd\b|usdt\b|dollar|doll\b|dolar\b|sent\b|cent\b)/i;
const RE_SHORT_MLN = /(?:^|[\s+-])(\d+(?:[.,]\d+)?)\s*m(?:ln|illion)?\b/i;
const RE_SHORT_MING = /(?:^|[\s+-])(\d+(?:[.,]\d+)?)\s*(?:ming|k)\b/i;
const RE_SOM = /so'?m\b/i;

const RE_ALL_DEBT_QUERY =
  /^(?:barcha\s+|hamma\s+|umumiy\s+|mening\s+|jami\s+)?qarz(?:lar|larim|im|imiz)?(?:\s+(?:qancha|necha\s*pul|nechpul|ro'?yxati|bor))?\??$/i;
const RE_DEBT_QUERY =
  /^(.+?)\s+(?:qancha\s+qarz(?:i|im|imiz|lar|lari)?(?:\s*bor)?|qarz(?:i|im|imiz|lar|lari)?(?:\s+(?:qancha|necha\s*pul|nechpul|bor|bo'?ldi))?|hisob(?:i|imiz)?(?:\s+(?:qancha|necha\s*pul|nechpul|bo'?ldi))?|balans(?:i|imiz)?(?:\s+qancha)?)\??$/i;
const RE_PRICE_QUERY =
  /^(.+?)\s+(?:oxirgi\s+narx(?:i)?|so'?nggi\s+narx(?:i)?|narx(?:i)?\s*(?:nechpul|necha\s*pul|nechi\s*pul|qancha)|qancha\s+turadi|necha\s*pul|nechi\s*pul|nechpul|bahosi|baho|narxi|narx|qancha)\??$/i;

const RE_RETURN_KW = /\b(vozvrat|vazvrat|qaytardim|qaytardik|qaytarish|qaytarildi|qaytdi)\b/i;
const RE_STRIP_RETURN_KW =
  /\b(vozvrat(?:ga)?|vazvrat(?:ga)?|qaytardim|qaytardik|qaytarish|qaytarildi|qaytdi|tovar(?:ni)?)\b/gi;
const RE_PREV_SAFE = /\b(kecha(?:gi)?|seyf(?:dan)?|seif(?:dan)?|eski\s*kassa(?:dan)?)\b/i;
const RE_TODAY_CASH = /\b(bugun(?:gi)?|kassa(?:dan)?)\b/i;
const RE_MINUS_SIGN = /(?:^|\s)-\s*\$?\s*\d/;
const RE_PAYMENT_KW =
  /\b(to'?lov|tolov|tulov|berdim|berdik|to'?ladim|toladim|ayir(?:dim|ing|ib\s*qo'?y|ish)?|minus)\b/i;
const RE_CASH_KW = /\b(naqd(?:ga)?|naqt(?:ga)?|nal|cash)\b/i;
const RE_EXPENSE_KW =
  /\b(ijara(?:ga)?|elektr(?:ga)?|svet(?:ga)?|gaz(?:ga)?|suv(?:ga)?|soliq(?:qa)?|oylik(?:ka)?|tushlik|obed|xarajat|rasxod)\b/i;
const RE_STRIP_AMT =
  /(?:[+-]\s*)?\$?\s*\d[\d\s.,_]*(?:\s*(?:(?:mln|million|ming|k|m|usd|usdt|dollar(?:u)?|doll|dolar|sent|cent|so'?m)\b|\$))?/gi;
const RE_STRIP_CENTS = /\b(\d{1,2}\s*(?:sent|cent))\b/gi;
const RE_STRIP_KEYWORDS =
  /\b(naqd(?:ga)?|naqt(?:ga)?|nal|cash|nasiya(?:ga)?|qarz(?:ga)?|kirim|yuk(?:\s*keldi)?|to'?lov|tolov|tulov|berdim|berdik|to'?ladim|toladim|ayir(?:dim|ing|ish)?|minus|kecha(?:gi)?|pul(?:dan|ga)?|seyf(?:dan)?|seif(?:dan)?|bugun(?:gi)?|kassa(?:dan)?|so'?m|som|usd|usdt|dollar|sent|cent|rasxod|xarajat)\b/gi;
const RE_STRIP_CASE_SUFFIX = /([a-zA-Z0-9'ʻʼ]{3,})(?:dan|ga|qa|ning)$/i;
const RE_MULTI_NUM_UNITS = /\d+\s*(?:dona|ta|korobka|kor|sht|kg|gr|litr|up|pachka|blok)\b.*\d/i;
const RE_INCOMING_CASE_HINT = /\b(yuk|keldi|oldi[mk]?|kirim)\b|(?:dan|ga)\s+[+-]?\$?\s*\d/i;
const RE_NON_PRICE_ACTION_KW =
  /\b(vozvrat|vazvrat|qaytardim|qaytarish|qaytdi|berdim|berdik|to'?ladim|oldim|keldi|naqd|rasxod|xarajat|qarz|hisob|balans)\b/i;

const RE_MONEY_CANDIDATE =
  /(?:^|\s)(\$?\s*(?:\d{1,3}(?:[.,\s_]\d{3})+|\d+(?:[.,]\d{1,2})?)\s*(?:(?:mln|million|ming|k)\b)?(?:\s*(?:\$|usd|usdt|dollar(?:u)?|doll|dolar|so'?m|uzs|som)\b|\$)?)/gi;
const RE_FOLLOWED_BY_UNIT = /^\s*(?:dona|ta|korobka|kor|sht|kg|gr|g|litr|l|ml|up|pachka|blok)\b/i;
const RE_HAS_MONEY_HINT = /(\$|usd\b|usdt\b|dollar|mln\b|million\b|ming\b|\dk\b|so'?m\b|uzs\b|som\b|[.,\s_]\d{3}\b)/i;

function stripUzbekEntitySuffix(raw: string): string {
  return raw
    .trim()
    .replace(/[?!.,:;]+$/g, '')
    .replace(RE_STRIP_CASE_SUFFIX, '$1')
    .trim();
}

/**
 * MODUL 2.1: Clean and parse numeric amounts including thousands separators ("500.000", "500_000", "1.200.000"),
 * shorthand multipliers ("500k", "1.5m", "1.5 mln", "250 ming"), and USD cents ("102.17$", "102 dollar 17 sent").
 */
export function cleanAmount(rawText: string): { amount: number; currency: 'UZS' | 'USD' } {
  if (!rawText || typeof rawText !== 'string') {
    return { amount: 0, currency: 'UZS' };
  }

  const normalized = toLatinUz(rawText).replace(/_/g, ' ').trim();
  const isUsd = RE_USD.test(normalized);
  const currency: 'UZS' | 'USD' = isUsd ? 'USD' : 'UZS';

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

  return parseCurrencyAndAmount(normalized);
}

function parseSupplierReturnLocally(latinText: string): LocalParsedCommand | null {
  if (!RE_RETURN_KW.test(latinText) || !/\d/.test(latinText)) return null;

  const matches = Array.from(latinText.matchAll(RE_MONEY_CANDIDATE));
  if (!matches.length) return null;

  // Prefer the token with explicit currency/multiplier or thousands separator and not followed by item unit ("5 ta")
  let chosen: { token: string; start: number; end: number; score: number } | null = null;
  for (const m of matches) {
    const fullMatch = m[0];
    const token = m[1].trim();
    const tokenOffsetInFull = fullMatch.indexOf(token);
    const start = (m.index ?? 0) + Math.max(0, tokenOffsetInFull);
    const end = start + token.length;
    const afterText = latinText.slice(end);
    const followedByUnit = RE_FOLLOWED_BY_UNIT.test(afterText);
    const hasHint = RE_HAS_MONEY_HINT.test(token);
    const parsed = cleanAmount(token);
    if (!parsed.amount || parsed.amount <= 0) continue;

    const score = (hasHint ? 10 : 0) + (followedByUnit ? -8 : 3) + (parsed.amount >= 1000 ? 2 : 0);
    if (!chosen || score > chosen.score) {
      chosen = { token, start, end, score };
    }
  }

  if (!chosen) return null;
  const { amount, currency } = cleanAmount(chosen.token);
  if (!amount || amount <= 0 || isNaN(amount)) return null;

  const cleanSegment = (seg: string) =>
    seg
      .replace(RE_STRIP_RETURN_KW, ' ')
      .replace(/[+$_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const beforeCleaned = cleanSegment(latinText.slice(0, chosen.start));
  const afterCleaned = cleanSegment(latinText.slice(chosen.end));

  let supplierName = '';
  let note = '';

  if (beforeCleaned.length >= 2) {
    supplierName = stripUzbekEntitySuffix(beforeCleaned);
    note = afterCleaned;
  } else if (afterCleaned.length >= 2) {
    const words = afterCleaned.split(/\s+/);
    const caseIdx = words.findIndex((w) => /(?:ga|dan|qa)$/i.test(w) && w.length >= 4);
    if (caseIdx !== -1) {
      supplierName = stripUzbekEntitySuffix(words[caseIdx]);
      note = words.filter((_, i) => i !== caseIdx).join(' ').trim();
    } else {
      supplierName = stripUzbekEntitySuffix(words[0]);
      note = words.slice(1).join(' ').trim();
    }
  }

  if (!supplierName || supplierName.length < 2) return null;

  return {
    intent: 'ADD_SUPPLIER_RETURN',
    supplierName,
    name: supplierName,
    amount,
    currency,
    txType: 'RETURN',
    paymentSource: 'TODAY_CASH',
    hasExplicitSource: false,
    note: note || undefined,
    comment: note || undefined,
  };
}

/**
 * MODUL 2: Instant Local Text Command Parser (<0.001s, 100% AI-free).
 */
export function parseTextCommandLocally(rawInput: string): LocalParsedCommand | null {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const trimmed = rawInput.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.includes('\n')) return null;

  const latinText = toLatinUz(trimmed);

  // 1. Check general all-debts lookup ("qarzlarim", "barcha qarzlar")
  if (RE_ALL_DEBT_QUERY.test(latinText)) {
    return {
      intent: 'GET_DEBT_INFO',
      supplierName: 'ALL',
      name: 'ALL',
      amount: 0,
      currency: 'UZS',
      paymentSource: 'TODAY_CASH',
      hasExplicitSource: false,
    };
  }

  // 2. Check specific supplier or customer debt inquiry ("Millora qarz", "Millora qarzi qancha", "Millora hisob")
  // Checked BEFORE price lookup so "<name> qarzi qancha" is never misclassified as product price lookup.
  if (!/\d/.test(latinText) && !RE_RETURN_KW.test(latinText)) {
    const debtInfoMatch = latinText.match(RE_DEBT_QUERY);
    if (debtInfoMatch && debtInfoMatch[1].trim().length >= 2) {
      const entityName = stripUzbekEntitySuffix(debtInfoMatch[1]);
      if (entityName.length >= 2 && !/\b(berdim|oldim|to'?ladim|keldi)\b/i.test(entityName)) {
        return {
          intent: 'GET_DEBT_INFO',
          supplierName: entityName,
          name: entityName,
          amount: 0,
          currency: 'UZS',
          paymentSource: 'TODAY_CASH',
          hasExplicitSource: false,
        };
      }
    }
  }

  // 3. Check product price search query ("ole narxi", "makaron qancha", "un oxirgi narxi", "shakar bahosi")
  if (!RE_NON_PRICE_ACTION_KW.test(latinText)) {
    const priceMatch = latinText.match(RE_PRICE_QUERY);
    if (priceMatch) {
      const prodName = priceMatch[1].replace(/[?!.,]+$/g, '').trim();
      const hasLargeRawMoney = /\b\d{4,}\b/.test(prodName);
      if (prodName.length >= 2 && !hasLargeRawMoney) {
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
    }
  }

  // 4. Check supplier return (Vozvrat) command before multi-unit filter
  if (RE_RETURN_KW.test(latinText)) {
    const retParsed = parseSupplierReturnLocally(latinText);
    if (retParsed) return retParsed;
  }

  if (!/\d/.test(latinText) || RE_MULTI_NUM_UNITS.test(latinText)) return null;

  const { amount, currency } = cleanAmount(latinText);
  if (!amount || amount <= 0 || isNaN(amount)) return null;

  const isPreviousSafe = RE_PREV_SAFE.test(latinText);
  const isExplicitToday = RE_TODAY_CASH.test(latinText);
  const paymentSource: 'TODAY_CASH' | 'PREVIOUS_SAFE' = isPreviousSafe ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
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

  const shouldStripCase =
    hasMinusSign || hasPaymentKeyword || hasExpenseKeyword || RE_INCOMING_CASE_HINT.test(latinText);
  const supplierName = shouldStripCase
    ? rawNameCleaned.replace(RE_STRIP_CASE_SUFFIX, '$1').trim()
    : rawNameCleaned.trim();

  if (!supplierName || supplierName.length < 2) return null;

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

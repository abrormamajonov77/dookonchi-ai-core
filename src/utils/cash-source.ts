import { toLatinUz } from './transliterate';

export type CashSourceValue = 'TODAY_REGISTER' | 'SAFE';
export type LegacyPaymentSource = 'TODAY_CASH' | 'PREVIOUS_SAFE';

export const CASH_SOURCE_PROMPT_TEXT = '💰 Bu naqd tovarlar qaysi puldan olindi?';
export const CASH_SOURCE_BTN_TODAY = '💵 Bugungi kassadan';
export const CASH_SOURCE_BTN_SAFE = '🔐 Seyfdan (kechagi pul)';
export const CASH_SOURCE_BTN_CANCEL = '❌ Bekor qilish';

const RE_SAFE_SOURCE =
  /\b(seyf(?:dan|ga|da|dagi|imdan)?|seif(?:dan|ga|da|dagi)?|kechagi(?:\s+pul(?:dan|i)?|\s+kassa(?:dan)?)?|kecha\s+pul(?:dan)?|eski\s*kassa(?:dan)?|eski\s*pul(?:dan)?|avvalgi\s*pul(?:dan)?|zaxira(?:dan)?)\b/i;

const RE_TODAY_REGISTER_SOURCE =
  /\b(bugungi\s*(?:kassa(?:dan|da)?|pul(?:dan|i)?|savdo(?:dan)?)|kassa(?:dan|dagi)|kassa\s+pul(?:idan|dan)?|bugungi)\b/i;

export function cashSourceToPaymentSource(source: CashSourceValue): LegacyPaymentSource {
  return source === 'SAFE' ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
}

export function paymentSourceToCashSource(paymentSource?: string | null): CashSourceValue {
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
export function resolveEffectiveCashSource(record: {
  cashSource?: string | null;
  paymentSource?: string | null;
}): CashSourceValue {
  const explicit = String(record?.cashSource || '').trim().toUpperCase();
  if (explicit === 'SAFE') return 'SAFE';
  if (explicit === 'TODAY_REGISTER') return 'TODAY_REGISTER';
  return paymentSourceToCashSource(record?.paymentSource);
}

export function isTodayRegisterCashSource(record: {
  cashSource?: string | null;
  paymentSource?: string | null;
}): boolean {
  return resolveEffectiveCashSource(record) === 'TODAY_REGISTER';
}

export function isSafeCashSource(record: {
  cashSource?: string | null;
  paymentSource?: string | null;
}): boolean {
  return resolveEffectiveCashSource(record) === 'SAFE';
}

export function formatCashSourceBadge(
  cashSource?: string | null,
  paymentSource?: string | null
): 'Kassadan' | 'Seyfdan' {
  return resolveEffectiveCashSource({ cashSource, paymentSource }) === 'SAFE'
    ? 'Seyfdan'
    : 'Kassadan';
}

export function formatCashSourceDisplay(
  cashSource?: string | null,
  paymentSource?: string | null
): string {
  return resolveEffectiveCashSource({ cashSource, paymentSource }) === 'SAFE'
    ? CASH_SOURCE_BTN_SAFE
    : CASH_SOURCE_BTN_TODAY;
}

export function formatCashSourceZReportNote(source: CashSourceValue): string {
  return source === 'SAFE'
    ? "Bugungi kassa (Z-otchyot) dan ayirilmadi (Seyfdan / kechagi pul)."
    : "Bugungi Z-otchyot naqd xaridlariga qo'shildi (Bugungi kassadan).";
}

export interface DetectedCashSource {
  cashSource: CashSourceValue | null;
  hasExplicitSource: boolean;
  paymentSource: LegacyPaymentSource;
}

/**
 * Detects explicit cash source keywords in Uzbek (Latin or Cyrillic):
 * - "seyfdan", "kechagi puldan", "eski kassadan" -> SAFE
 * - "bugungi kassadan", "kassadan", "bugungi puldan" -> TODAY_REGISTER
 * - omitted -> cashSource: null, hasExplicitSource: false
 */
export function detectCashSourceFromText(rawText: string): DetectedCashSource {
  const latin = toLatinUz(String(rawText || '')).trim();
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

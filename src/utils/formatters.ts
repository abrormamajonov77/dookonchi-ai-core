export const formatSom = (amount: any): string => {
  const num = Number(amount);
  if (isNaN(num)) return "0 so'm";
  const rounded = Number(num.toFixed(2));
  const hasCents = rounded % 1 !== 0;
  return `${new Intl.NumberFormat('en-US', {
    style: 'decimal',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(rounded)} so'm`;
};

export const formatUsd = (amount: any, withUsdtTag = false): string => {
  const num = Number(amount);
  if (isNaN(num)) return withUsdtTag ? '$0.00 (USDT)' : '$0.00';
  const rounded = Number(num.toFixed(2));
  const sign = rounded < 0 ? '-' : '';
  const absFormatted = new Intl.NumberFormat('en-US', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(rounded));
  return `${sign}$${absFormatted}${withUsdtTag ? ' (USDT)' : ''}`;
};

export const formatCurrency = (amount: any, currency: 'UZS' | 'USD' = 'UZS', withUsdtTag = false): string => {
  return currency === 'USD' ? formatUsd(amount, withUsdtTag) : formatSom(amount);
};

export const formatMoney = (amount: any, currency = 'UZS'): string => {
  const num = Number(amount);
  if (isNaN(num) || amount === 'invalid' || amount === null || amount === undefined || amount === '') {
    return `0 ${currency}`;
  }
  if (currency === 'USD' || currency === 'USDT') {
    return formatUsd(num, true);
  }
  return `${formatSom(num)} (${currency})`;
};

export const formatSupplierDebtLine = (name: string, debtUzs: any, debtUsd: any, prefix = '🏢 '): string => {
  const uzs = Number(Number(debtUzs || 0).toFixed(2));
  const usd = Number(Number(debtUsd || 0).toFixed(2));
  const hasUzs = Math.abs(uzs) > 0.001;
  const hasUsd = Math.abs(usd) > 0.001;

  if (hasUzs && hasUsd) {
    return `${prefix}${name}: ${formatSom(uzs)} | 💵 ${formatUsd(usd)}`;
  }
  if (hasUsd) {
    return `${prefix}${name}: 💵 ${formatUsd(usd)}`;
  }
  return `${prefix}${name}: ${formatSom(uzs)}`;
};

export const formatTotalDebtBlock = (totalUzs: any, totalUsd: any): string => {
  const uzs = Number(Number(totalUzs || 0).toFixed(2));
  const usd = Number(Number(totalUsd || 0).toFixed(2));
  return `📊 JAMI QARZ (UZS): ${formatSom(uzs)}\n💵 JAMI QARZ (USD/USDT): ${formatUsd(usd)}`;
};

export const formatDate = (date: Date | string) =>
  new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));

export const formatDateShort = (date: Date | string) =>
  new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(new Date(date));

export const formatCompactAmount = (amount: number, currency: 'UZS' | 'USD' = 'UZS'): string => {
  const num = Number(Number(amount || 0).toFixed(2));
  if (currency === 'USD') {
    return `$${num.toFixed(2)}`;
  }
  return num >= 1_000_000
    ? `${(num / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`
    : num >= 1_000
    ? `${Math.round(num / 1_000)}k`
    : num.toString();
};

export const escapeMarkdown = (text: string): string =>
  text ? text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : '';

const USD_INDICATOR_REGEX = /(\$|usd\b|usdt\b|dollar(?:u|i|da|dan|ga)?\b|doll\b|dolar\b|у\.?\s*е\.?|ye\b|долл(?:ар(?:ов|а)?)?|sent\b|cent\b|цент(?:ов|а)?)/i;

const COMPOUND_USD_CENTS_REGEX = /(\d[\d\s.,]*)\s*(?:\$|usd\b|usdt\b|dollar(?:u|i|da|dan|ga)?\b|doll\b|dolar\b|у\.?\s*е\.?|ye\b|долл(?:ар(?:ов|а)?)?)\s*(?:va\s*|и\s*)?(\d{1,2})\s*(?:sent|cent|цент(?:ов|а)?|tiyin)\b/i;

const ONLY_CENTS_REGEX = /^[^\d]*(\d{1,2})\s*(?:sent|cent|цент(?:ов|а)?)\b/i;

function parseNumericToken(rawNumStr: string, treatSingleSepAsDecimal: boolean): number {
  const cleaned = rawNumStr.trim().replace(/\s+/g, '');
  if (!cleaned) return 0;

  const dotCount = (cleaned.match(/\./g) || []).length;
  const commaCount = (cleaned.match(/,/g) || []).length;

  // Both dot and comma present, e.g. "1,420.55" or "1.420,55"
  if (dotCount > 0 && commaCount > 0) {
    const lastDot = cleaned.lastIndexOf('.');
    const lastComma = cleaned.lastIndexOf(',');
    if (lastDot > lastComma) {
      // Dot is decimal separator: "1,420.55"
      return Number(parseFloat(cleaned.replace(/,/g, '')).toFixed(2)) || 0;
    } else {
      // Comma is decimal separator: "1.420,55"
      return Number(parseFloat(cleaned.replace(/\./g, '').replace(',', '.')).toFixed(2)) || 0;
    }
  }

  // Multiple dots or multiple commas -> thousands separators, e.g. "1.000.000" or "1,000,000"
  if (dotCount > 1 || commaCount > 1) {
    return Number(cleaned.replace(/[.,]/g, '')) || 0;
  }

  // Single dot or single comma
  if (dotCount === 1 || commaCount === 1) {
    const sep = dotCount === 1 ? '.' : ',';
    const [intPart, fracPart] = cleaned.split(sep);
    // If fractional part has 1 or 2 digits (e.g. 102.17, 102,17, 1.5), or if USD / multiplier context
    if (fracPart.length <= 2 || treatSingleSepAsDecimal) {
      const val = parseFloat(`${intPart}.${fracPart}`);
      return isNaN(val) ? 0 : Number(val.toFixed(2));
    }
    // Fractional part has 3 digits (e.g. "500.000" in UZS) -> thousands separator
    return Number(`${intPart}${fracPart}`) || 0;
  }

  const val = parseFloat(cleaned.replace(/[^\d]/g, ''));
  return isNaN(val) ? 0 : Number(val.toFixed(2));
}

export function parseCurrencyAndAmount(input: string): { amount: number; currency: 'UZS' | 'USD' } {
  if (!input || typeof input !== 'string') {
    return { amount: 0, currency: 'UZS' };
  }

  const text = input.trim();
  const isUsd = USD_INDICATOR_REGEX.test(text);
  const currency: 'UZS' | 'USD' = isUsd ? 'USD' : 'UZS';

  // 1. Check compound "102 dollar 17 sent", "102 dollaru 17 sent", "102$ 17 sent"
  const compoundMatch = text.match(COMPOUND_USD_CENTS_REGEX);
  if (compoundMatch) {
    const dollars = parseNumericToken(compoundMatch[1], true);
    const cents = parseInt(compoundMatch[2], 10) || 0;
    const total = Number((dollars + cents / 100).toFixed(2));
    return { amount: total, currency: 'USD' };
  }

  // 2. Check only cents e.g. "50 sent"
  const onlyCentsMatch = text.match(ONLY_CENTS_REGEX);
  if (onlyCentsMatch && !/dollar|\$|usd|usdt/i.test(text)) {
    const cents = parseInt(onlyCentsMatch[1], 10) || 0;
    return { amount: Number((cents / 100).toFixed(2)), currency: 'USD' };
  }

  // 3. Multipliers (mln / ming) — strip "so'm" / "som" first so "'m" is never mistaken for "m" (million)
  const textWithoutSom = text.replace(/so['`’]?m\b/gi, '');
  const isMln = /\b(?:mln|million)\b/i.test(textWithoutSom);
  const isMing = /\b(?:ming|k)\b/i.test(textWithoutSom);

  // Extract the first numeric sequence (digits, spaces, dots, commas)
  const numMatch = text.match(/\d(?:[\d\s.,]*\d)?/);
  if (!numMatch) {
    return { amount: 0, currency };
  }

  const rawNumStr = numMatch[0];
  const baseVal = parseNumericToken(rawNumStr, isUsd || isMln || isMing);

  if (isMln) {
    return { amount: Number((baseVal * 1_000_000).toFixed(2)), currency };
  }
  if (isMing) {
    return { amount: Number((baseVal * 1_000).toFixed(2)), currency };
  }

  return { amount: Number(baseVal.toFixed(2)), currency };
}

export const parseAmount = (rawText: string): number => {
  if (!rawText) return 0;
  return parseCurrencyAndAmount(rawText).amount;
};

export interface DiscountCalculationResult {
  rawTotal: number;
  discountAmount: number;
  finalTotal: number;
  isPercent: boolean;
  percent?: number;
}

export function calculateDiscountedTotal(
  rawTotalInput: number,
  discountInput?: number | string | null
): DiscountCalculationResult {
  const rawTotal = Math.max(0, Number(Number(rawTotalInput || 0).toFixed(2)));
  if (discountInput === undefined || discountInput === null || discountInput === '' || discountInput === 0 || discountInput === '0') {
    return {
      rawTotal,
      discountAmount: 0,
      finalTotal: rawTotal,
      isPercent: false,
    };
  }

  if (typeof discountInput === 'number') {
    const discountAmount = Math.min(rawTotal, Math.max(0, Number(discountInput.toFixed(2))));
    const finalTotal = Math.max(0, Number((rawTotal - discountAmount).toFixed(2)));
    return {
      rawTotal,
      discountAmount,
      finalTotal,
      isPercent: false,
    };
  }

  const str = String(discountInput).trim();
  const percentMatch = str.match(/(\d+(?:[.,]\d+)?)\s*%/);
  if (percentMatch) {
    const percent = parseFloat(percentMatch[1].replace(',', '.'));
    const validPercent = isNaN(percent) ? 0 : Math.max(0, percent);
    const computedDiscount = Number(((rawTotal * validPercent) / 100).toFixed(2));
    const discountAmount = Math.min(rawTotal, computedDiscount);
    const finalTotal = Math.max(0, Number((rawTotal - discountAmount).toFixed(2)));
    return {
      rawTotal,
      discountAmount,
      finalTotal,
      isPercent: true,
      percent: validPercent,
    };
  }

  const { amount } = parseCurrencyAndAmount(str);
  const discountAmount = Math.min(rawTotal, Math.max(0, Number(amount.toFixed(2))));
  const finalTotal = Math.max(0, Number((rawTotal - discountAmount).toFixed(2)));
  return {
    rawTotal,
    discountAmount,
    finalTotal,
    isPercent: false,
  };
}

export const getToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

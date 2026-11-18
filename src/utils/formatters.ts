const INT_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'decimal',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const DEC_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'decimal',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
INT_FORMATTER.format(0);
DEC_FORMATTER.format(0);

export const formatSom = (amount: any): string => {
  const num = Number(amount);
  if (isNaN(num)) return "0 so'm";
  const rounded = Number(num.toFixed(2));
  const hasCents = rounded % 1 !== 0;
  return `${(hasCents ? DEC_FORMATTER : INT_FORMATTER).format(rounded)} so'm`;
};

export const formatUsd = (amount: any, withUsdtTag = false): string => {
  const num = Number(amount);
  if (isNaN(num)) return withUsdtTag ? '$0.00 (USDT)' : '$0.00';
  const rounded = Number(num.toFixed(2));
  const sign = rounded < 0 ? '-' : '';
  const absFormatted = DEC_FORMATTER.format(Math.abs(rounded));
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
  const isMln = /(?:\b|\d)\s*(?:mln|million)\b|\d\s*m\b/i.test(textWithoutSom);
  const isMing = /(?:\b|\d)\s*(?:ming|k)\b/i.test(textWithoutSom);

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

/**
 * 3-MUAMMO & 4-MUAMMO: Smart Amount Parser (`parseSmartAmount`).
 * - Nuqta yoki verguldan keyin 3 ta raqam bo'lsa (masalan: "500.000", "500,000", "5.000", "12.000", "1.371.040"),
 *   uni minglik ajratuvchi sifatida tozalab, butun son qaytaradi (500000, 5000, 12000, 1371040).
 * - Nuqta yoki verguldan keyin 1-2 ta raqam bo'lsa (masalan: "50.17$", "102,17", "224219,38"),
 *   uni o'nlik kasr (sent/tiyin) sifatida saqlab qoladi (50.17, 102.17, 224219.38).
 */
export function parseSmartAmount(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') {
    return isNaN(input) ? 0 : Number(input.toFixed(2));
  }
  const raw = String(input).trim();
  if (!raw) return 0;

  // Check if explicitly formatted with 3-digit thousands group(s): e.g. "500.000", "5.000", "1.371.040", "500,000", "500 000"
  const strippedCurrency = raw
    .replace(/so['`’]?m\b|uzs\b|sum\b|\$|usd\b|usdt\b|dollar(?:u|i|da|dan|ga)?\b/gi, '')
    .trim();

  if (/^[+-]?\d{1,3}(?:[.,\s]\d{3})+$/.test(strippedCurrency)) {
    const sign = strippedCurrency.startsWith('-') ? -1 : 1;
    const digitsOnly = strippedCurrency.replace(/[^\d]/g, '');
    return sign * (Number(digitsOnly) || 0);
  }

  // Check if decimal with 1 or 2 fractional digits: e.g. "50.17", "102,17", "224 219,38", "-59 602,62"
  if (/^[+-]?\d[\d\s]*(?:[.,]\d{1,2})$/.test(strippedCurrency)) {
    const normalized = strippedCurrency.replace(/\s+/g, '').replace(',', '.');
    const val = parseFloat(normalized);
    return isNaN(val) ? 0 : Number(val.toFixed(2));
  }

  return parseCurrencyAndAmount(raw).amount;
}

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
    const discountAmount = Math.min(rawTotal, Math.max(0, Number(Math.abs(discountInput).toFixed(2))));
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

  const amount = Math.abs(parseSmartAmount(str));
  const discountAmount = Math.min(rawTotal, Math.max(0, Number(amount.toFixed(2))));
  const finalTotal = Math.max(0, Number((rawTotal - discountAmount).toFixed(2)));
  return {
    rawTotal,
    discountAmount,
    finalTotal,
    isPercent: false,
  };
}

export interface ReconcileInvoiceTotalsInput {
  rows?: Array<{ lineTotal?: number; totalPrice?: number } | string>;
  itemsSum?: number;
  subtotalBeforeDiscount?: number | null;
  discountPercent?: number | string | null;
  discountAmount?: number | string | null;
  printedFinalTotal?: number | null;
  tableTotals?: number[] | null;
  hasExplicitDiscount?: boolean | null;
}

export interface ReconcileInvoiceTotalsResult {
  rawTotal: number;
  discountPercent: number;
  discountAmount: number;
  finalTotal: number;
  alreadyDeductedOnPaper: boolean;
}

/**
 * 2-MUAMMO: Strict Discount Guard & Double-Discount Prevention (`reconcileInvoiceTotals`).
 * - Agar qog'ozda "Скидка", "Наценка", "Переоценка", "Chegirma", "%" yozuvi bo'lmasa
 *   (discountPercent === 0 && discountAmount === 0 yoki hasExplicitDiscount === false),
 *   qatorlar yig'indisi bilan Itogo o'rtasidagi farqdan ASLO sun'iy skidka (masalan 1.6%) chiqarilmaydi!
 * - Agar qog'ozda haqiqatan skidka yozilgan bo'lsa (masalan Nestle -21% / -59,602.62 -> 224,219.38
 *   yoki 2,000,000 - 5% = 1,900,000), uni ikkinchi marta ayirmaydi.
 * - Agar bitta A4 varaqda 2 ta jadval va 2 ta "Итого" bo'lsa (tableTotals: [1371040, 772432]),
 *   ularni qo'shib umumiy 2,143,472 so'm chiqaradi.
 */
export function reconcileInvoiceTotals(input: ReconcileInvoiceTotalsInput): ReconcileInvoiceTotalsResult {
  let computedItemsSum = Number(input.itemsSum || 0);
  if (!computedItemsSum && Array.isArray(input.rows) && input.rows.length > 0) {
    computedItemsSum = input.rows.reduce((sum: number, r: any) => {
      if (typeof r === 'string') {
        const parts = r.split('|').map((p) => p.trim());
        const lastCol = parts[parts.length - 1] || '0';
        return sum + parseSmartAmount(lastCol);
      }
      return sum + Number(r?.lineTotal ?? r?.totalPrice ?? 0);
    }, 0);
  }
  const itemsSum = Math.max(0, Number(computedItemsSum.toFixed(2)));
  const subtotalBeforeDiscount = Math.max(0, Number(Number(input.subtotalBeforeDiscount || 0).toFixed(2)));

  let multiTableSum = 0;
  if (Array.isArray(input.tableTotals) && input.tableTotals.length > 0) {
    multiTableSum = Number(
      input.tableTotals.reduce((acc, v) => acc + Math.max(0, Number(v || 0)), 0).toFixed(2)
    );
  }
  const printedFinalTotal = Math.max(
    0,
    Number(Number(multiTableSum > 0 ? multiTableSum : input.printedFinalTotal || 0).toFixed(2))
  );

  let discountPercent = 0;
  if (typeof input.discountPercent === 'number') {
    discountPercent = Math.max(0, Math.abs(input.discountPercent));
  } else if (typeof input.discountPercent === 'string') {
    const m = input.discountPercent.match(/(\d+(?:[.,]\d+)?)/);
    if (m) discountPercent = Math.abs(parseFloat(m[1].replace(',', '.')) || 0);
  }

  let explicitDiscountAmount = 0;
  if (typeof input.discountAmount === 'number') {
    explicitDiscountAmount = Math.max(0, Number(Math.abs(input.discountAmount).toFixed(2)));
  } else if (typeof input.discountAmount === 'string') {
    const str = input.discountAmount.trim();
    if (str.includes('%') && !discountPercent) {
      const m = str.match(/(\d+(?:[.,]\d+)?)\s*%/);
      if (m) discountPercent = Math.abs(parseFloat(m[1].replace(',', '.')) || 0);
    } else {
      explicitDiscountAmount = Math.abs(parseSmartAmount(str));
    }
  }

  // STRICT DISCOUNT GUARD: If paper has NO explicit discount, NEVER invent a fake discount from row difference!
  const hasExplicitDiscount =
    input.hasExplicitDiscount === false
      ? false
      : discountPercent > 0 || explicitDiscountAmount > 0;

  if (!hasExplicitDiscount) {
    const authoritativeTotal =
      printedFinalTotal > 0
        ? printedFinalTotal
        : subtotalBeforeDiscount > 0
        ? subtotalBeforeDiscount
        : itemsSum;
    return {
      rawTotal: authoritativeTotal,
      discountPercent: 0,
      discountAmount: 0,
      finalTotal: authoritativeTotal,
      alreadyDeductedOnPaper: false,
    };
  }

  // 1. Determine rawTotal before discount when an explicit discount DOES exist
  let rawTotal = 0;
  if (subtotalBeforeDiscount > 0 && printedFinalTotal > 0 && subtotalBeforeDiscount > printedFinalTotal) {
    rawTotal = subtotalBeforeDiscount;
  } else if (itemsSum > 0 && printedFinalTotal > 0 && printedFinalTotal < itemsSum) {
    rawTotal = Math.max(subtotalBeforeDiscount, itemsSum);
  } else if (subtotalBeforeDiscount > 0) {
    rawTotal = Math.max(subtotalBeforeDiscount, itemsSum);
  } else if (itemsSum > 0) {
    rawTotal = itemsSum;
  } else {
    rawTotal = printedFinalTotal;
  }
  rawTotal = Number(rawTotal.toFixed(2));

  const tolerance = rawTotal >= 10_000 ? 100 : Math.min(1, Number((rawTotal * 0.005).toFixed(2)));

  // 2. When both explicitDiscountAmount > 0 and discountPercent > 0 (e.g. Nestle: 283,822 - 21% (-59,602.62) = 224,219.38)
  if (explicitDiscountAmount > 0 && discountPercent > 0) {
    const expectedFinal = Math.max(0, Number((rawTotal - explicitDiscountAmount).toFixed(2)));
    if (
      printedFinalTotal > 0 &&
      (Math.abs(printedFinalTotal - expectedFinal) <= tolerance || printedFinalTotal < rawTotal)
    ) {
      const finalTotal =
        Math.abs(printedFinalTotal - expectedFinal) <= tolerance ? expectedFinal : printedFinalTotal;
      const discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));
      return {
        rawTotal,
        discountPercent,
        discountAmount,
        finalTotal,
        alreadyDeductedOnPaper: true,
      };
    }
    return {
      rawTotal,
      discountPercent,
      discountAmount: Math.min(rawTotal, explicitDiscountAmount),
      finalTotal: expectedFinal,
      alreadyDeductedOnPaper: false,
    };
  }

  // 3. Double-Deduction Prevention when discountPercent > 0
  if (discountPercent > 0) {
    const expectedDiscount = Number(((rawTotal * discountPercent) / 100).toFixed(2));
    const expectedFinal = Math.max(0, Number((rawTotal - expectedDiscount).toFixed(2)));
    const aiPutFinalInSubtotal =
      itemsSum > 0 && subtotalBeforeDiscount > 0 && Math.abs(subtotalBeforeDiscount - expectedFinal) <= tolerance;

    if (
      (printedFinalTotal > 0 &&
        (Math.abs(printedFinalTotal - expectedFinal) <= tolerance || printedFinalTotal < rawTotal)) ||
      aiPutFinalInSubtotal
    ) {
      const finalTotal =
        aiPutFinalInSubtotal || Math.abs(printedFinalTotal - expectedFinal) <= tolerance
          ? expectedFinal
          : printedFinalTotal;
      const discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));
      return {
        rawTotal,
        discountPercent,
        discountAmount,
        finalTotal,
        alreadyDeductedOnPaper: true,
      };
    }

    return {
      rawTotal,
      discountPercent,
      discountAmount: expectedDiscount,
      finalTotal: expectedFinal,
      alreadyDeductedOnPaper: false,
    };
  }

  // 4. Double-Deduction Prevention when explicitDiscountAmount > 0
  const expectedDiscount = Math.min(rawTotal, explicitDiscountAmount);
  const expectedFinal = Math.max(0, Number((rawTotal - expectedDiscount).toFixed(2)));
  const aiPutFinalInSubtotal =
    itemsSum > 0 && subtotalBeforeDiscount > 0 && Math.abs(subtotalBeforeDiscount - expectedFinal) <= tolerance;

  if (
    (printedFinalTotal > 0 &&
      (Math.abs(printedFinalTotal - expectedFinal) <= tolerance || printedFinalTotal < rawTotal)) ||
    aiPutFinalInSubtotal
  ) {
    const finalTotal =
      aiPutFinalInSubtotal || Math.abs(printedFinalTotal - expectedFinal) <= tolerance
        ? expectedFinal
        : printedFinalTotal;
    const discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));
    const inferredPercent = rawTotal > 0 ? Number(((discountAmount / rawTotal) * 100).toFixed(2)) : 0;
    return {
      rawTotal,
      discountPercent: inferredPercent,
      discountAmount,
      finalTotal,
      alreadyDeductedOnPaper: true,
    };
  }

  const inferredPercent = rawTotal > 0 ? Number(((expectedDiscount / rawTotal) * 100).toFixed(2)) : 0;
  return {
    rawTotal,
    discountPercent: inferredPercent,
    discountAmount: expectedDiscount,
    finalTotal: expectedFinal,
    alreadyDeductedOnPaper: false,
  };
}

export const getToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export function getTashkentDayRange(now: Date = new Date()): { startOfDay: Date; endOfDay: Date; dateKey: Date } {
  // Tashkent is UTC+5
  const tashkentOffsetMs = 5 * 60 * 60 * 1000;
  const tashkentTime = new Date(now.getTime() + tashkentOffsetMs);
  const year = tashkentTime.getUTCFullYear();
  const month = tashkentTime.getUTCMonth();
  const day = tashkentTime.getUTCDate();

  const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - tashkentOffsetMs);
  const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - tashkentOffsetMs);
  const dateKey = new Date(Date.UTC(year, month, day));
  return { startOfDay, endOfDay, dateKey };
}

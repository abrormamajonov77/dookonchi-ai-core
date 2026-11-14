"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getToday = exports.parseAmount = exports.escapeMarkdown = exports.formatCompactAmount = exports.formatDateShort = exports.formatDate = exports.formatTotalDebtBlock = exports.formatSupplierDebtLine = exports.formatMoney = exports.formatCurrency = exports.formatUsd = exports.formatSom = void 0;
exports.parseCurrencyAndAmount = parseCurrencyAndAmount;
exports.calculateDiscountedTotal = calculateDiscountedTotal;
exports.reconcileInvoiceTotals = reconcileInvoiceTotals;
exports.getTashkentDayRange = getTashkentDayRange;
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
const formatSom = (amount) => {
    const num = Number(amount);
    if (isNaN(num))
        return "0 so'm";
    const rounded = Number(num.toFixed(2));
    const hasCents = rounded % 1 !== 0;
    return `${(hasCents ? DEC_FORMATTER : INT_FORMATTER).format(rounded)} so'm`;
};
exports.formatSom = formatSom;
const formatUsd = (amount, withUsdtTag = false) => {
    const num = Number(amount);
    if (isNaN(num))
        return withUsdtTag ? '$0.00 (USDT)' : '$0.00';
    const rounded = Number(num.toFixed(2));
    const sign = rounded < 0 ? '-' : '';
    const absFormatted = DEC_FORMATTER.format(Math.abs(rounded));
    return `${sign}$${absFormatted}${withUsdtTag ? ' (USDT)' : ''}`;
};
exports.formatUsd = formatUsd;
const formatCurrency = (amount, currency = 'UZS', withUsdtTag = false) => {
    return currency === 'USD' ? (0, exports.formatUsd)(amount, withUsdtTag) : (0, exports.formatSom)(amount);
};
exports.formatCurrency = formatCurrency;
const formatMoney = (amount, currency = 'UZS') => {
    const num = Number(amount);
    if (isNaN(num) || amount === 'invalid' || amount === null || amount === undefined || amount === '') {
        return `0 ${currency}`;
    }
    if (currency === 'USD' || currency === 'USDT') {
        return (0, exports.formatUsd)(num, true);
    }
    return `${(0, exports.formatSom)(num)} (${currency})`;
};
exports.formatMoney = formatMoney;
const formatSupplierDebtLine = (name, debtUzs, debtUsd, prefix = '🏢 ') => {
    const uzs = Number(Number(debtUzs || 0).toFixed(2));
    const usd = Number(Number(debtUsd || 0).toFixed(2));
    const hasUzs = Math.abs(uzs) > 0.001;
    const hasUsd = Math.abs(usd) > 0.001;
    if (hasUzs && hasUsd) {
        return `${prefix}${name}: ${(0, exports.formatSom)(uzs)} | 💵 ${(0, exports.formatUsd)(usd)}`;
    }
    if (hasUsd) {
        return `${prefix}${name}: 💵 ${(0, exports.formatUsd)(usd)}`;
    }
    return `${prefix}${name}: ${(0, exports.formatSom)(uzs)}`;
};
exports.formatSupplierDebtLine = formatSupplierDebtLine;
const formatTotalDebtBlock = (totalUzs, totalUsd) => {
    const uzs = Number(Number(totalUzs || 0).toFixed(2));
    const usd = Number(Number(totalUsd || 0).toFixed(2));
    return `📊 JAMI QARZ (UZS): ${(0, exports.formatSom)(uzs)}\n💵 JAMI QARZ (USD/USDT): ${(0, exports.formatUsd)(usd)}`;
};
exports.formatTotalDebtBlock = formatTotalDebtBlock;
const formatDate = (date) => new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
exports.formatDate = formatDate;
const formatDateShort = (date) => new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(new Date(date));
exports.formatDateShort = formatDateShort;
const formatCompactAmount = (amount, currency = 'UZS') => {
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
exports.formatCompactAmount = formatCompactAmount;
const escapeMarkdown = (text) => text ? text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : '';
exports.escapeMarkdown = escapeMarkdown;
const USD_INDICATOR_REGEX = /(\$|usd\b|usdt\b|dollar(?:u|i|da|dan|ga)?\b|doll\b|dolar\b|у\.?\s*е\.?|ye\b|долл(?:ар(?:ов|а)?)?|sent\b|cent\b|цент(?:ов|а)?)/i;
const COMPOUND_USD_CENTS_REGEX = /(\d[\d\s.,]*)\s*(?:\$|usd\b|usdt\b|dollar(?:u|i|da|dan|ga)?\b|doll\b|dolar\b|у\.?\s*е\.?|ye\b|долл(?:ар(?:ов|а)?)?)\s*(?:va\s*|и\s*)?(\d{1,2})\s*(?:sent|cent|цент(?:ов|а)?|tiyin)\b/i;
const ONLY_CENTS_REGEX = /^[^\d]*(\d{1,2})\s*(?:sent|cent|цент(?:ов|а)?)\b/i;
function parseNumericToken(rawNumStr, treatSingleSepAsDecimal) {
    const cleaned = rawNumStr.trim().replace(/\s+/g, '');
    if (!cleaned)
        return 0;
    const dotCount = (cleaned.match(/\./g) || []).length;
    const commaCount = (cleaned.match(/,/g) || []).length;
    // Both dot and comma present, e.g. "1,420.55" or "1.420,55"
    if (dotCount > 0 && commaCount > 0) {
        const lastDot = cleaned.lastIndexOf('.');
        const lastComma = cleaned.lastIndexOf(',');
        if (lastDot > lastComma) {
            // Dot is decimal separator: "1,420.55"
            return Number(parseFloat(cleaned.replace(/,/g, '')).toFixed(2)) || 0;
        }
        else {
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
function parseCurrencyAndAmount(input) {
    if (!input || typeof input !== 'string') {
        return { amount: 0, currency: 'UZS' };
    }
    const text = input.trim();
    const isUsd = USD_INDICATOR_REGEX.test(text);
    const currency = isUsd ? 'USD' : 'UZS';
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
const parseAmount = (rawText) => {
    if (!rawText)
        return 0;
    return parseCurrencyAndAmount(rawText).amount;
};
exports.parseAmount = parseAmount;
function calculateDiscountedTotal(rawTotalInput, discountInput) {
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
/**
 * MODUL 2: Double-Discount Guard (`reconcileInvoiceTotals`).
 * Prevents deducting a discount a second time when `printedFinalTotal` on the paper receipt
 * already has the discount subtracted (e.g. 2,000,000 - 5% = 1,900,000 printed on receipt).
 */
function reconcileInvoiceTotals(input) {
    let computedItemsSum = Number(input.itemsSum || 0);
    if (!computedItemsSum && Array.isArray(input.rows) && input.rows.length > 0) {
        computedItemsSum = input.rows.reduce((sum, r) => {
            if (typeof r === 'string') {
                const parts = r.split('|').map((p) => p.trim());
                const lastCol = parts[parts.length - 1] || '0';
                return sum + parseCurrencyAndAmount(lastCol).amount;
            }
            return sum + Number(r?.lineTotal ?? r?.totalPrice ?? 0);
        }, 0);
    }
    const itemsSum = Math.max(0, Number(computedItemsSum.toFixed(2)));
    const subtotalBeforeDiscount = Math.max(0, Number(Number(input.subtotalBeforeDiscount || 0).toFixed(2)));
    const printedFinalTotal = Math.max(0, Number(Number(input.printedFinalTotal || 0).toFixed(2)));
    let discountPercent = 0;
    if (typeof input.discountPercent === 'number') {
        discountPercent = Math.max(0, input.discountPercent);
    }
    else if (typeof input.discountPercent === 'string') {
        const m = input.discountPercent.match(/(\d+(?:[.,]\d+)?)/);
        if (m)
            discountPercent = parseFloat(m[1].replace(',', '.')) || 0;
    }
    let explicitDiscountAmount = 0;
    if (typeof input.discountAmount === 'number') {
        explicitDiscountAmount = Math.max(0, Number(input.discountAmount.toFixed(2)));
    }
    else if (typeof input.discountAmount === 'string') {
        const str = input.discountAmount.trim();
        if (str.includes('%') && !discountPercent) {
            const m = str.match(/(\d+(?:[.,]\d+)?)\s*%/);
            if (m)
                discountPercent = parseFloat(m[1].replace(',', '.')) || 0;
        }
        else {
            explicitDiscountAmount = parseCurrencyAndAmount(str).amount;
        }
    }
    // 1. Determine rawTotal before discount
    let rawTotal = 0;
    if (itemsSum > 0 && printedFinalTotal > 0 && printedFinalTotal < itemsSum) {
        rawTotal = Math.max(subtotalBeforeDiscount, itemsSum);
    }
    else if (subtotalBeforeDiscount > 0) {
        rawTotal = Math.max(subtotalBeforeDiscount, itemsSum);
    }
    else if (itemsSum > 0) {
        rawTotal = itemsSum;
    }
    else {
        rawTotal = printedFinalTotal;
    }
    rawTotal = Number(rawTotal.toFixed(2));
    // 2. Double-Deduction Prevention when discountPercent > 0
    if (discountPercent > 0) {
        // If rawTotal was only populated from printedFinalTotal (no itemsSum and no subtotalBeforeDiscount),
        // kept as rawTotal; otherwise rawTotal is the pre-discount sum (e.g. 2,000,000).
        const expectedDiscount = Number(((rawTotal * discountPercent) / 100).toFixed(2));
        const expectedFinal = Math.max(0, Number((rawTotal - expectedDiscount).toFixed(2)));
        if (printedFinalTotal > 0 &&
            (Math.abs(printedFinalTotal - expectedFinal) <= 1 || printedFinalTotal < rawTotal)) {
            // Discount was ALREADY subtracted on the paper receipt! Do NOT deduct 5% a second time.
            const finalTotal = Math.abs(printedFinalTotal - expectedFinal) <= 1 ? expectedFinal : printedFinalTotal;
            const discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));
            return {
                rawTotal,
                discountPercent,
                discountAmount,
                finalTotal,
                alreadyDeductedOnPaper: true,
            };
        }
        // Printed final total equals rawTotal or is 0 -> deduct once
        return {
            rawTotal,
            discountPercent,
            discountAmount: expectedDiscount,
            finalTotal: expectedFinal,
            alreadyDeductedOnPaper: false,
        };
    }
    // 3. Double-Deduction Prevention when explicitDiscountAmount > 0
    if (explicitDiscountAmount > 0) {
        const expectedDiscount = Math.min(rawTotal, explicitDiscountAmount);
        const expectedFinal = Math.max(0, Number((rawTotal - expectedDiscount).toFixed(2)));
        if (printedFinalTotal > 0 &&
            (Math.abs(printedFinalTotal - expectedFinal) <= 1 || printedFinalTotal < rawTotal)) {
            const finalTotal = Math.abs(printedFinalTotal - expectedFinal) <= 1 ? expectedFinal : printedFinalTotal;
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
    // 4. If printedFinalTotal < rawTotal even without explicit discount field
    if (printedFinalTotal > 0 && printedFinalTotal < rawTotal) {
        const discountAmount = Number((rawTotal - printedFinalTotal).toFixed(2));
        const inferredPercent = rawTotal > 0 ? Number(((discountAmount / rawTotal) * 100).toFixed(2)) : 0;
        return {
            rawTotal,
            discountPercent: inferredPercent,
            discountAmount,
            finalTotal: printedFinalTotal,
            alreadyDeductedOnPaper: true,
        };
    }
    return {
        rawTotal,
        discountPercent: 0,
        discountAmount: 0,
        finalTotal: rawTotal,
        alreadyDeductedOnPaper: false,
    };
}
const getToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};
exports.getToday = getToday;
function getTashkentDayRange(now = new Date()) {
    // Tashkent is UTC+5
    const tashkentOffsetMs = 5 * 60 * 60 * 1000;
    const tashkentTime = new Date(now.getTime() + tashkentOffsetMs);
    const year = tashkentTime.getUTCFullYear();
    const month = tashkentTime.getUTCMonth();
    const day = tashkentTime.getUTCDate();
    const startOfDay = new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - tashkentOffsetMs);
    const endOfDay = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - tashkentOffsetMs);
    const dateKey = (0, exports.getToday)();
    return { startOfDay, endOfDay, dateKey };
}

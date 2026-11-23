import { describe, it, expect } from 'vitest';
import { formatMoney, formatDate, formatCompactAmount, escapeMarkdown, parseAmount } from '../src/utils/formatters';
import { levenshteinDistance, fuzzyMatch } from '../src/utils/fuzzy';

describe('formatters', () => {
  it('formats money in UZS correctly', () => {
    const formatted = formatMoney(1250000, 'UZS');
    expect(formatted).toContain('1');
    expect(formatted).toContain('250');
    expect(formatted).toContain('000');
    expect(formatted).toContain('UZS');
  });

  it('formats money in USD correctly', () => {
    const formatted = formatMoney(500.5, 'USD');
    expect(formatted).toContain('500');
    expect(formatted).toContain('USD');
  });

  it('handles invalid numbers gracefully in formatMoney', () => {
    expect(formatMoney('invalid', 'UZS')).toBe('0 UZS');
    expect(formatMoney(NaN, 'UZS')).toBe('0 UZS');
  });

  it('formats compact amounts correctly', () => {
    expect(formatCompactAmount(500)).toBe('500');
    expect(formatCompactAmount(1500)).toBe('2k');
    expect(formatCompactAmount(2000000)).toBe('2M');
    expect(formatCompactAmount(1250000)).toBe('1.25M');
  });

  it('escapes Markdown special characters', () => {
    const raw = 'Product *Name* [1] (test) #1';
    const escaped = escapeMarkdown(raw);
    expect(escaped).toBe('Product \\*Name\\* \\[1\\] \\(test\\) \\#1');
  });

  it('handles empty text in escapeMarkdown', () => {
    expect(escapeMarkdown('')).toBe('');
  });

  it('parses amount strings correctly', () => {
    expect(parseAmount('500000')).toBe(500000);
    expect(parseAmount('1.000.000')).toBe(1000000);
    expect(parseAmount('500 ming')).toBe(500000);
    expect(parseAmount('1 mln')).toBe(1000000);
    expect(parseAmount('1.5 mln')).toBe(1500000);
    expect(parseAmount('200$')).toBe(200);
  });
});

describe('fuzzy matching', () => {
  it('calculates levenshtein distance accurately', () => {
    expect(levenshteinDistance('shakar', 'shakar')).toBe(0);
    expect(levenshteinDistance('shakar', 'shkar')).toBe(1);
    expect(levenshteinDistance('olma', 'olcha')).toBe(2);
    expect(levenshteinDistance('olma', 'anor')).toBe(4);
  });

  it('finds best fuzzy match within threshold', () => {
    const choices = ['Donya', 'Shedevr', 'Shakar', 'Un'];
    expect(fuzzyMatch('shkar', choices)).toBe('Shakar');
    expect(fuzzyMatch('Dony', choices)).toBe('Donya');
  });

  it('returns original input when distance exceeds threshold', () => {
    const choices = ['Donya', 'Shedevr', 'Shakar'];
    expect(fuzzyMatch('CocaCola', choices, 2)).toBe('CocaCola');
  });
});

import {
  getPaymentSourceConfirmationKeyboard,
  getFuzzySupplierSuggestionKeyboard,
  getInvoiceConfirmationKeyboard,
  getDiscountConfirmationKeyboard,
  getSavedInvoiceCardKeyboard,
  getDuplicateInvoiceWarningKeyboard,
  getSupplierCardKeyboard,
  getSupplierCategoryListKeyboard,
  getSupplierRecordDetailKeyboard,
  getSupplierRecordDeleteConfirmKeyboard,
  getSupplierReturnCurrencyKeyboard,
} from '../src/bot/keyboards/inline';
import { reconcileInvoiceTotals, getTashkentDayRange, parseCurrencyAndAmount } from '../src/utils/formatters';
import { parseTextCommandLocally } from '../src/utils/local-parser';
import { sanitizeMdV1, truncateForTelegram } from '../src/utils/telegram';

describe('Telegram callback_data 64-byte & edge-case regressions', () => {
  it('keeps every callback_data button <= 64 bytes even with 36-char UUIDs', () => {
    const uuid = 'ab29d075-2870-4513-8f8c-05afb6f35709';
    const uuid2 = '8f53eb90-fff3-430e-b029-9c20012590db';
    const keyboards = [
      getPaymentSourceConfirmationKeyboard(`spay_${uuid}`),
      getPaymentSourceConfirmationKeyboard(`v_${uuid}`),
      getFuzzySupplierSuggestionKeyboard(uuid2, 'Dinar kalbasa', 'Diner', `inv_${uuid}`),
      getFuzzySupplierSuggestionKeyboard(uuid2, 'Dinar kalbasa', 'Diner', uuid),
      getInvoiceConfirmationKeyboard(`i_${uuid}`, 'table', 'UZS'),
      getDiscountConfirmationKeyboard(`i_${uuid}`, 100000, false, 'USD'),
      getSavedInvoiceCardKeyboard(uuid, uuid2, 'photo_id', uuid),
      getDuplicateInvoiceWarningKeyboard(uuid),
      getSupplierCardKeyboard(uuid),
      getSupplierCategoryListKeyboard(
        uuid,
        'C',
        [{ id: uuid2, date: new Date(), amount: 500000, currency: 'UZS', note: 'Nakladnoy' }],
        2,
        10,
        () => '23.11.2026'
      ),
      getSupplierRecordDetailKeyboard('C', uuid2, uuid, 'photo_file_id'),
      getSupplierRecordDeleteConfirmKeyboard('V', uuid2),
      getSupplierReturnCurrencyKeyboard(uuid),
    ];

    for (const kb of keyboards) {
      for (const row of kb.inline_keyboard) {
        for (const btn of row) {
          if ('callback_data' in btn && btn.callback_data) {
            expect(Buffer.byteLength(btn.callback_data, 'utf8')).toBeLessThanOrEqual(64);
          }
        }
      }
    }
  });

  it('parses spaceless shorthands 500k/500ming/1.5m without mistaking 500gr or 500ml', () => {
    expect(parseCurrencyAndAmount('500k').amount).toBe(500000);
    expect(parseCurrencyAndAmount('500ming').amount).toBe(500000);
    expect(parseCurrencyAndAmount('1.5m').amount).toBe(1500000);
    expect(parseCurrencyAndAmount('500gr').amount).toBe(500);
    expect(parseCurrencyAndAmount('500ml').amount).toBe(500);
  });

  it('does not confuse USD < $100 tolerance in reconcileInvoiceTotals', () => {
    const manualUsd = reconcileInvoiceTotals({
      subtotalBeforeDiscount: 100,
      discountPercent: 5,
      printedFinalTotal: 90,
    });
    expect(manualUsd.finalTotal).toBe(90);
    expect(manualUsd.discountAmount).toBe(10);

    const exactUsd = reconcileInvoiceTotals({
      subtotalBeforeDiscount: 100,
      discountPercent: 5,
      printedFinalTotal: 95,
    });
    expect(exactUsd.finalTotal).toBe(95);
    expect(exactUsd.discountAmount).toBe(5);
    expect(exactUsd.alreadyDeductedOnPaper).toBe(true);
  });

  it('computes UTC+5 Tashkent dateKey even during 00:00-04:59 Tashkent (previous UTC day)', () => {
    const lateUtc = new Date('2026-11-18T21:30:00.000Z'); // 2026-11-19 02:30 Tashkent
    const { dateKey } = getTashkentDayRange(lateUtc);
    expect(dateKey.toISOString().slice(0, 10)).toBe('2026-11-19');
  });

  it('handles cash expenses, incoming -dan suffix, and avoids quantity-as-money on multi-number lines', () => {
    const exp = parseTextCommandLocally('Svetga 200.000 naqd berdim');
    expect(exp?.intent).toBe('ADD_EXPENSE');
    expect(exp?.amount).toBe(200000);

    const inc = parseTextCommandLocally('Milterdan +500.000');
    expect(inc?.intent).toBe('INVOICE_CREDIT');
    expect(inc?.supplierName).toBe('Milter');

    const itemLine = parseTextCommandLocally('Ketchup 2 korobka 240.000');
    expect(itemLine).toBeNull();
  });

  it('sanitizes Markdown v1 metacharacters and closes truncated code fences', () => {
    expect(sanitizeMdV1('Tallinskaya * HISLAT _ [1] `test`')).toBe('Tallinskaya  HISLAT  1 test');
    const longBlock = '```\n' + 'x'.repeat(4200) + '\n```';
    const truncated = truncateForTelegram(longBlock, 3950);
    expect(truncated.length).toBeLessThanOrEqual(3950);
    expect((truncated.match(/```/g) || []).length % 2).toBe(0);
  });
});


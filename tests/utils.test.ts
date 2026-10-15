import { describe, it, expect } from 'vitest';
import { formatMoney, formatDate, formatCompactAmount, escapeMarkdown } from '../src/utils/formatters';
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

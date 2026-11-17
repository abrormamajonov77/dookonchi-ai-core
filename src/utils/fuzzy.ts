import { normalizeForSearch } from './transliterate';

export function levenshteinDistance(a: string, b: string): number {
  const s1 = a.toLowerCase().trim();
  const s2 = b.toLowerCase().trim();
  if (s1 === s2) return 0;
  if (!s1.length) return s2.length;
  if (!s2.length) return s1.length;

  const m = Array.from({ length: s2.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= s1.length; j++) m[0][j] = j;
  for (let i = 1; i <= s2.length; i++) {
    for (let j = 1; j <= s1.length; j++) {
      m[i][j] =
        s2[i - 1] === s1[j - 1]
          ? m[i - 1][j - 1]
          : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
    }
  }
  return m[s2.length][s1.length];
}

export function calculateSimilarity(a: string, b: string): number {
  const n1 = normalizeForSearch(a);
  const n2 = normalizeForSearch(b);
  if (!n1 && !n2) return 1;
  if (!n1 || !n2) return 0;
  if (n1 === n2) return 1;
  const maxLen = Math.max(n1.length, n2.length);
  const dist = levenshteinDistance(n1, n2);
  return Number(((maxLen - dist) / maxLen).toFixed(4));
}

export function fuzzyMatch(input: string, choices: string[], threshold = 3): string {
  let best = input;
  let min = Infinity;
  for (const c of choices) {
    const d = levenshteinDistance(input.toLowerCase(), c.toLowerCase());
    if (d < min) [min, best] = [d, c];
  }
  return min <= threshold ? best : input;
}

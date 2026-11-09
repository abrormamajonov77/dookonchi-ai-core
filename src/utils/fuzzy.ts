export function levenshteinDistance(a: string, b: string): number {
  const m = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j++) m[0][j] = j;
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      m[i][j] = b[i - 1] === a[j - 1] ? m[i - 1][j - 1] : Math.min(m[i - 1][j - 1] + 1, m[i][j - 1] + 1, m[i - 1][j] + 1);
  return m[b.length][a.length];
}

export function fuzzyMatch(input: string, choices: string[], threshold = 3): string {
  let best = input, min = Infinity;
  for (const c of choices) {
    const d = levenshteinDistance(input.toLowerCase(), c.toLowerCase());
    if (d < min) [min, best] = [d, c];
  }
  return min <= threshold ? best : input;
}

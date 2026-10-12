export function formatMoney(amount: number | string | any, currency = 'UZS') {
  const num = Number(amount);
  if (isNaN(num)) return `0 ${currency}`;
  return new Intl.NumberFormat('uz-UZ', { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(num) + ` ${currency}`;
}

export function formatDate(date: Date | string) {
  const d = new Date(date);
  return new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(d);
}

export function formatCompactAmount(amount: number): string {
  if (amount >= 1_000_000) return (amount / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
  if (amount >= 1_000) return Math.round(amount / 1_000) + 'k';
  return amount.toString();
}

export function escapeMarkdown(text: string): string {
  if (!text) return '';
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

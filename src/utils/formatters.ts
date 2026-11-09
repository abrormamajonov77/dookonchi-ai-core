export const formatMoney = (amount: any, currency = 'UZS') => {
  const num = Number(amount);
  return isNaN(num) ? `0 ${currency}` : `${new Intl.NumberFormat('uz-UZ', { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(num)} ${currency}`;
};

export const formatDate = (date: Date | string) =>
  new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));

export const formatDateShort = (date: Date | string) =>
  new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(new Date(date));

export const formatCompactAmount = (amount: number): string =>
  amount >= 1_000_000 ? `${(amount / 1_000_000).toFixed(2).replace(/\.00$/, '')}M` : amount >= 1_000 ? `${Math.round(amount / 1_000)}k` : amount.toString();

export const escapeMarkdown = (text: string): string =>
  text ? text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : '';

export const parseAmount = (rawText: string): number => {
  if (!rawText) return 0;
  const isMln = /mln|million|m\b/i.test(rawText);
  const isMing = /ming|k\b/i.test(rawText);
  if (isMln) {
    const num = parseFloat(rawText.replace(/[^\d.,]/g, '').replace(',', '.'));
    return isNaN(num) ? 0 : Math.round(num * 1_000_000);
  }
  if (isMing) {
    const num = parseFloat(rawText.replace(/[^\d.,]/g, '').replace(',', '.'));
    return isNaN(num) ? 0 : Math.round(num * 1_000);
  }
  return Number(rawText.replace(/[\s.,]+/g, '').replace(/\D/g, '')) || 0;
};

export const getToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

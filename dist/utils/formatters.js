"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getToday = exports.parseAmount = exports.escapeMarkdown = exports.formatCompactAmount = exports.formatDateShort = exports.formatDate = exports.formatMoney = void 0;
const formatMoney = (amount, currency = 'UZS') => {
    const num = Number(amount);
    return isNaN(num) ? `0 ${currency}` : `${new Intl.NumberFormat('uz-UZ', { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(num)} ${currency}`;
};
exports.formatMoney = formatMoney;
const formatDate = (date) => new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
exports.formatDate = formatDate;
const formatDateShort = (date) => new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(new Date(date));
exports.formatDateShort = formatDateShort;
const formatCompactAmount = (amount) => amount >= 1_000_000 ? `${(amount / 1_000_000).toFixed(2).replace(/\.00$/, '')}M` : amount >= 1_000 ? `${Math.round(amount / 1_000)}k` : amount.toString();
exports.formatCompactAmount = formatCompactAmount;
const escapeMarkdown = (text) => text ? text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1') : '';
exports.escapeMarkdown = escapeMarkdown;
const parseAmount = (rawText) => {
    if (!rawText)
        return 0;
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
exports.parseAmount = parseAmount;
const getToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
};
exports.getToday = getToday;

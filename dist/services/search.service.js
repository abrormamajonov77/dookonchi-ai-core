"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectPriceIncreases = exports.SearchService = void 0;
exports.formatDotDate = formatDotDate;
exports.formatArrivalDateTime = formatArrivalDateTime;
exports.formatPriceDiffLine = formatPriceDiffLine;
exports.formatProductPriceTrackerCard = formatProductPriceTrackerCard;
exports.findPriceIncreasesAgainstHistory = findPriceIncreasesAgainstHistory;
exports.formatPriceIncreaseAlertsBlock = formatPriceIncreaseAlertsBlock;
const fuse_js_1 = __importDefault(require("fuse.js"));
const client_1 = require("@prisma/client");
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
const transliterate_1 = require("../utils/transliterate");
const formatters_1 = require("../utils/formatters");
function formatDotDate(date) {
    const d = new Date(date);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
}
function formatArrivalDateTime(date, now = new Date()) {
    const d = new Date(date);
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const isToday = d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    if (isToday) {
        return `Bugun, ${hh}:${min}`;
    }
    return `${formatDotDate(d)}, ${hh}:${min}`;
}
function formatPriceDiffLine(currentPrice, previousPrice, currency) {
    if (previousPrice === null || previousPrice === undefined || isNaN(previousPrice)) {
        return { priceDiff: 0, diffStatus: 'UNCHANGED', diffText: "O'zgarmadi ⚪️" };
    }
    const diff = Number((Number(currentPrice) - Number(previousPrice)).toFixed(2));
    if (diff > 0) {
        return {
            priceDiff: diff,
            diffStatus: 'INCREASED',
            diffText: `+${(0, formatters_1.formatCurrency)(diff, currency)} QIMMATLADI 🔴`,
        };
    }
    if (diff < 0) {
        return {
            priceDiff: diff,
            diffStatus: 'DECREASED',
            diffText: `-${(0, formatters_1.formatCurrency)(Math.abs(diff), currency)} ARZONLADI 🟢`,
        };
    }
    return { priceDiff: 0, diffStatus: 'UNCHANGED', diffText: "O'zgarmadi ⚪️" };
}
function formatProductPriceTrackerCard(params) {
    const { priceDiff, diffStatus, diffText } = formatPriceDiffLine(params.currentPrice, params.previousPrice, params.currency);
    const qtyNum = Number(params.quantity);
    const qtyStr = Number.isInteger(qtyNum) ? String(qtyNum) : String(Number(qtyNum.toFixed(3)));
    const unitStr = (0, transliterate_1.toLatinUz)((params.unit || 'dona').trim());
    const prodName = (0, transliterate_1.toLatinUz)(params.productName);
    const supName = (0, transliterate_1.toLatinUz)(params.supplierName);
    const prevLine = params.previousPrice !== null && params.previousDate
        ? `${(0, formatters_1.formatCurrency)(params.previousPrice, params.currency)} (${formatDotDate(params.previousDate)})`
        : "Ma'lumot yo'q (Birinchi kirim)";
    const formattedCard = `📦 Mahsulot: ${prodName}\n` +
        `🚚 Ta'minotchi: ${supName}\n` +
        `🕒 Oxirgi kelgan vaqti: ${formatArrivalDateTime(params.latestDate)}\n` +
        `💰 Hozirgi kelish narxi: ${(0, formatters_1.formatCurrency)(params.currentPrice, params.currency)} (Soni: ${qtyStr} ${unitStr})\n` +
        `📊 Oldingi partiya narxi: ${prevLine}\n` +
        `📈 Farqi: ${diffText}`;
    return { formattedCard, priceDiff, diffStatus, diffText };
}
class SearchService {
    static async searchProductsWithPriceDiff(query, ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const rawTrimmed = query.replace(/(ni|ga|dan|da|ning)$/i, '').trim();
        const latinQuery = (0, transliterate_1.toLatinUz)(rawTrimmed).trim();
        const cleanQuery = (0, transliterate_1.normalizeForSearch)(rawTrimmed);
        if (!cleanQuery)
            return [];
        // 1. Direct ILIKE search on InvoiceItem + Product + Supplier isolated by ownerId
        let matchedInvoiceItems = await prisma_1.prisma.invoiceItem.findMany({
            where: {
                ownerId: cleanOwnerId,
                OR: [
                    { rawName: { contains: latinQuery, mode: 'insensitive' } },
                    { rawName: { contains: rawTrimmed, mode: 'insensitive' } },
                    { normalizedName: { contains: cleanQuery, mode: 'insensitive' } },
                    { product: { name: { contains: latinQuery, mode: 'insensitive' } } },
                    { product: { searchTokens: { contains: cleanQuery, mode: 'insensitive' } } },
                    { supplier: { name: { contains: latinQuery, mode: 'insensitive' } } },
                ],
            },
            orderBy: [{ createdAt: 'desc' }, { invoice: { createdAt: 'desc' } }],
            include: {
                product: { select: { id: true, name: true } },
                supplier: { select: { id: true, name: true } },
                invoice: { select: { id: true, supplierId: true, createdAt: true, supplier: { select: { id: true, name: true } } } },
            },
            take: 100,
        });
        // 2. Phonetic & Fuzzy fallback if ILIKE returned 0 items
        if (matchedInvoiceItems.length === 0) {
            const recentItems = await prisma_1.prisma.invoiceItem.findMany({
                where: { ownerId: cleanOwnerId },
                orderBy: [{ createdAt: 'desc' }],
                include: {
                    product: { select: { id: true, name: true } },
                    supplier: { select: { id: true, name: true } },
                    invoice: { select: { id: true, supplierId: true, createdAt: true, supplier: { select: { id: true, name: true } } } },
                },
                take: 250,
            });
            const directPhoneticHits = recentItems.filter((it) => {
                const key = (0, transliterate_1.normalizeForSearch)(`${it.rawName || ''} ${it.product?.name || ''} ${it.supplier?.name || it.invoice?.supplier?.name || ''}`);
                return key.includes(cleanQuery);
            });
            if (directPhoneticHits.length > 0) {
                matchedInvoiceItems = directPhoneticHits;
            }
            else {
                const fuseDocs = recentItems.map((it) => ({
                    item: it,
                    searchName: (0, transliterate_1.normalizeForSearch)(`${it.rawName || it.product?.name || ''} ${it.supplier?.name || it.invoice?.supplier?.name || ''}`),
                }));
                const fuseHits = new fuse_js_1.default(fuseDocs, {
                    keys: ['searchName'],
                    threshold: 0.35,
                    ignoreLocation: true,
                }).search(cleanQuery);
                matchedInvoiceItems = fuseHits.map((h) => h.item.item);
            }
        }
        if (matchedInvoiceItems.length === 0)
            return [];
        const productIds = Array.from(new Set(matchedInvoiceItems.map((i) => i.productId)));
        const normNames = Array.from(new Set(matchedInvoiceItems
            .map((i) => i.normalizedName || (0, transliterate_1.normalizeForSearch)(i.rawName || i.product.name))
            .filter(Boolean)));
        const allHistoryItems = await prisma_1.prisma.invoiceItem.findMany({
            where: {
                ownerId: cleanOwnerId,
                OR: [
                    { productId: { in: productIds } },
                    { normalizedName: { in: normNames } },
                ],
            },
            orderBy: [{ createdAt: 'desc' }, { invoice: { createdAt: 'desc' } }],
            include: {
                product: { select: { id: true, name: true } },
                supplier: { select: { id: true, name: true } },
                invoice: { select: { id: true, supplierId: true, createdAt: true, supplier: { select: { id: true, name: true } } } },
            },
        });
        const groups = new Map();
        for (const row of allHistoryItems) {
            const pName = (0, transliterate_1.toLatinUz)(row.rawName || row.product?.name || "Noma'lum");
            const normKey = (0, transliterate_1.normalizeForSearch)(row.normalizedName || pName);
            const cur = (row.currency || 'UZS');
            const groupKey = `${normKey}::${cur}`;
            const list = groups.get(groupKey) || [];
            list.push(row);
            groups.set(groupKey, list);
        }
        const results = [];
        for (const [, history] of groups.entries()) {
            history.sort((a, b) => {
                const tA = new Date(a.createdAt || a.invoice.createdAt).getTime();
                const tB = new Date(b.createdAt || b.invoice.createdAt).getTime();
                return tB - tA;
            });
            const latest = history[0];
            const previous = history.length > 1 ? history[1] : null;
            const productName = (0, transliterate_1.toLatinUz)(latest.rawName || latest.product?.name || "Noma'lum");
            const supplierName = (0, transliterate_1.toLatinUz)(latest.supplier?.name || latest.invoice?.supplier?.name || "Noma'lum ta'minotchi");
            const supplierId = latest.supplierId || latest.invoice?.supplierId;
            const latestDate = latest.createdAt || latest.invoice.createdAt;
            const currentPrice = Number(latest.unitPrice);
            const previousPrice = previous ? Number(previous.unitPrice) : null;
            const previousDate = previous ? previous.createdAt || previous.invoice.createdAt : null;
            const quantity = Number(latest.quantity);
            const unit = (0, transliterate_1.toLatinUz)(latest.unit || 'dona');
            const currency = (latest.currency || 'UZS');
            const cardInfo = formatProductPriceTrackerCard({
                productName,
                supplierName,
                latestDate,
                currentPrice,
                quantity,
                unit,
                previousPrice,
                previousDate,
                currency,
            });
            results.push({
                type: 'ITEM',
                id: supplierId || latest.invoiceId,
                supplierId,
                invoiceId: latest.invoiceId,
                productName,
                partyName: supplierName,
                date: latestDate,
                unitPrice: currentPrice,
                previousPrice,
                previousDate,
                priceDiff: cardInfo.priceDiff,
                diffStatus: cardInfo.diffStatus,
                diffText: cardInfo.diffText,
                quantity,
                unit,
                currency,
                formattedCard: cardInfo.formattedCard,
                isCash: false,
            });
        }
        return results;
    }
    static async multiSearch(query, ownerId = env_1.env.OWNER_TELEGRAM_ID) {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        const cleanQuery = (0, transliterate_1.normalizeForSearch)(query.replace(/(ni|ga|dan|da|ning)$/i, '').trim());
        const [productItems, allSuppliers, allDebts, recentTx] = await Promise.all([
            this.searchProductsWithPriceDiff(query, cleanOwnerId),
            prisma_1.prisma.supplier.findMany({
                where: { ownerId: cleanOwnerId, isActive: true },
                select: { id: true, name: true, debtUzs: true, debtUsd: true },
            }),
            prisma_1.prisma.customerDebt.findMany({
                where: { ownerId: cleanOwnerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
                select: { id: true, customerName: true, amount: true, paidAmount: true, currency: true },
            }),
            prisma_1.prisma.supplierTransaction.findMany({
                where: { ownerId: cleanOwnerId, receiptData: { not: client_1.Prisma.DbNull } },
                take: 50,
                orderBy: { date: 'desc' },
                select: {
                    id: true,
                    supplierId: true,
                    type: true,
                    amount: true,
                    currency: true,
                    date: true,
                    description: true,
                    receiptData: true,
                    supplier: { select: { name: true } },
                },
            }),
        ]);
        const supplierDocs = allSuppliers.map((s) => ({
            id: s.id,
            name: (0, transliterate_1.toLatinUz)(s.name),
            searchName: (0, transliterate_1.normalizeForSearch)(s.name),
            debtUzs: Number(s.debtUzs),
            debtUsd: Number(s.debtUsd),
            amountText: (0, formatters_1.formatSupplierDebtLine)((0, transliterate_1.toLatinUz)(s.name), s.debtUzs, s.debtUsd, '').replace(/^[^:]+:\s*/, ''),
            type: 'SUPPLIER',
        }));
        const groupedDebts = {};
        for (const d of allDebts) {
            const rem = Number(d.amount) - Number(d.paidAmount);
            if (rem > 0) {
                const cName = (0, transliterate_1.toLatinUz)(d.customerName);
                groupedDebts[cName] ??= { sum: 0, firstId: d.id, currency: d.currency };
                groupedDebts[cName].sum += rem;
            }
        }
        const customerDocs = Object.entries(groupedDebts).map(([name, d]) => ({
            id: d.firstId,
            name,
            searchName: (0, transliterate_1.normalizeForSearch)(name),
            amount: d.sum,
            amountText: (0, formatters_1.formatCurrency)(d.sum, d.currency),
            type: 'CUSTOMER',
        }));
        const txDocs = recentTx.map((tx) => {
            const typeLabel = tx.type === 'INCOMING_GOODS' ? 'kirim' : tx.type === 'RETURN' ? 'vozvrat' : "to'lov";
            const name = (0, transliterate_1.toLatinUz)(`${tx.supplier.name} ${typeLabel} ${tx.description || ''}`.trim());
            return {
                id: tx.id,
                name,
                searchName: (0, transliterate_1.normalizeForSearch)(name),
                amount: Number(tx.amount),
                currency: tx.currency,
                type: 'TRANSACTION',
                date: tx.date,
                supplierId: tx.supplierId,
            };
        });
        const opts = { keys: ['searchName'], threshold: 0.35, ignoreLocation: true, includeScore: true };
        const top5 = (list) => {
            const exactSub = list.filter((x) => x.searchName.includes(cleanQuery));
            if (exactSub.length > 0) {
                return exactSub.slice(0, 5).map((item) => ({ item, score: 0 }));
            }
            return new fuse_js_1.default(list, opts).search(cleanQuery).slice(0, 5);
        };
        const matchedSuppliers = top5(supplierDocs).map((r) => ({
            type: 'SUPPLIER',
            id: r.item.id,
            name: r.item.name,
            amountText: r.item.amountText,
            score: r.score,
        }));
        for (const item of productItems) {
            if (item.supplierId && !matchedSuppliers.some((s) => s.id === item.supplierId)) {
                const sup = allSuppliers.find((s) => s.id === item.supplierId);
                if (sup) {
                    matchedSuppliers.push({
                        type: 'SUPPLIER',
                        id: sup.id,
                        name: (0, transliterate_1.toLatinUz)(sup.name),
                        amountText: (0, formatters_1.formatSupplierDebtLine)((0, transliterate_1.toLatinUz)(sup.name), sup.debtUzs, sup.debtUsd, '').replace(/^[^:]+:\s*/, ''),
                    });
                }
            }
        }
        return {
            items: productItems,
            suppliers: matchedSuppliers,
            customers: top5(customerDocs).map((r) => ({
                type: 'CUSTOMER',
                id: r.item.id,
                name: r.item.name,
                amountText: r.item.amountText,
                score: r.score,
            })),
            transactions: top5(txDocs).map((r) => ({
                type: 'TRANSACTION',
                id: r.item.supplierId,
                name: `${(0, formatters_1.formatDateShort)(r.item.date)} — ${r.item.name}`,
                amountText: (0, formatters_1.formatCompactAmount)(r.item.amount, r.item.currency),
                extraInfo: r.item.id,
                score: r.score,
            })),
        };
    }
    /**
     * Compares extracted invoice items against the most recent previous InvoiceItem prices
     * for the same ownerId (exact normalized match + fuzzy fallback) and returns price-increase alerts.
     */
    static async detectPriceIncreases(ownerId, items, defaultCurrency = 'UZS') {
        const cleanOwnerId = String(ownerId || env_1.env.OWNER_TELEGRAM_ID).trim();
        if (!Array.isArray(items) || items.length === 0)
            return [];
        const validItems = items.filter((it) => !it?.isCrossedOut && Number(it?.unitPrice || 0) > 0);
        if (validItems.length === 0)
            return [];
        const historicalItems = await prisma_1.prisma.invoiceItem.findMany({
            where: { ownerId: cleanOwnerId },
            orderBy: [{ createdAt: 'desc' }, { invoice: { createdAt: 'desc' } }],
            select: {
                rawName: true,
                normalizedName: true,
                unitPrice: true,
                currency: true,
                createdAt: true,
                product: { select: { name: true } },
            },
            take: 1000,
        });
        return findPriceIncreasesAgainstHistory(validItems, historicalItems, defaultCurrency);
    }
}
exports.SearchService = SearchService;
function extractNumericTokens(text) {
    const matches = (0, transliterate_1.normalizeForSearch)(text).match(/\d+(?:[.,]\d+)?/g);
    return matches ? matches.map((m) => m.replace(',', '.')) : [];
}
function hasCompatibleNumericTokens(a, b) {
    const numsA = extractNumericTokens(a);
    const numsB = extractNumericTokens(b);
    if (numsA.length === 0 && numsB.length === 0)
        return true;
    if (numsA.length !== numsB.length)
        return false;
    return numsA.every((n, i) => n === numsB[i]);
}
function findPriceIncreasesAgainstHistory(extractedItems, historicalItems, defaultCurrency = 'UZS') {
    if (!extractedItems.length || !historicalItems.length)
        return [];
    // Build map of most recent price per (normalizedName, currency)
    const sortedHistory = [...historicalItems].sort((a, b) => {
        const tA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return tB - tA;
    });
    const latestByKey = new Map();
    const histByCurrency = { UZS: [], USD: [] };
    for (const row of sortedHistory) {
        const unitPrice = Number(row.unitPrice || 0);
        if (unitPrice <= 0)
            continue;
        const displayName = (0, transliterate_1.toLatinUz)((row.rawName || row.product?.name || '').trim());
        const normName = (0, transliterate_1.normalizeForSearch)(row.normalizedName || displayName);
        if (!normName || normName.length < 2)
            continue;
        const cur = row.currency === 'USD' ? 'USD' : 'UZS';
        const key = `${normName}::${cur}`;
        if (!latestByKey.has(key)) {
            const entry = { displayName: displayName || normName, normName, unitPrice, currency: cur };
            latestByKey.set(key, entry);
            histByCurrency[cur].push(entry);
        }
    }
    const fuseByCurrency = {
        UZS: new fuse_js_1.default(histByCurrency.UZS, {
            keys: ['normName'],
            threshold: 0.25,
            ignoreLocation: true,
            includeScore: true,
        }),
        USD: new fuse_js_1.default(histByCurrency.USD, {
            keys: ['normName'],
            threshold: 0.25,
            ignoreLocation: true,
            includeScore: true,
        }),
    };
    const alertsByKey = new Map();
    for (const item of extractedItems) {
        if (item.isCrossedOut)
            continue;
        const newPrice = Number(Number(item.unitPrice || 0).toFixed(2));
        if (newPrice <= 0)
            continue;
        const productName = (0, transliterate_1.toLatinUz)((item.rawName || item.productName || '').trim());
        const normName = (0, transliterate_1.normalizeForSearch)(item.normalizedName || productName);
        if (!normName || normName.length < 2)
            continue;
        const cur = (item.currency || defaultCurrency) === 'USD' ? 'USD' : 'UZS';
        const exactKey = `${normName}::${cur}`;
        let matched = latestByKey.get(exactKey);
        if (!matched && histByCurrency[cur].length > 0) {
            const fuseHits = fuseByCurrency[cur].search(normName);
            for (const hit of fuseHits) {
                if ((hit.score ?? 1) <= 0.25 && hasCompatibleNumericTokens(normName, hit.item.normName)) {
                    matched = hit.item;
                    break;
                }
            }
        }
        if (!matched || matched.unitPrice <= 0)
            continue;
        const { priceDiff, diffStatus } = formatPriceDiffLine(newPrice, matched.unitPrice, cur);
        if (diffStatus === 'INCREASED' && priceDiff > 0) {
            const percentIncrease = Number(((priceDiff / matched.unitPrice) * 100).toFixed(1));
            const alertKey = `${matched.normName}::${cur}`;
            const existing = alertsByKey.get(alertKey);
            if (!existing || percentIncrease > existing.percentIncrease) {
                alertsByKey.set(alertKey, {
                    productName: productName || matched.displayName,
                    matchedProductName: matched.displayName,
                    oldPrice: matched.unitPrice,
                    newPrice,
                    diffAmount: priceDiff,
                    percentIncrease,
                    currency: cur,
                });
            }
        }
    }
    return Array.from(alertsByKey.values());
}
function formatPriceIncreaseAlertsBlock(alerts, sanitizeName) {
    if (!Array.isArray(alerts) || alerts.length === 0)
        return '';
    const lines = ['⚠️ Narx oshdi:'];
    for (const alert of alerts.slice(0, 15)) {
        const cleanName = sanitizeName ? sanitizeName(alert.productName) : alert.productName;
        const oldStr = (0, formatters_1.formatCurrency)(alert.oldPrice, alert.currency);
        const newStr = (0, formatters_1.formatCurrency)(alert.newPrice, alert.currency);
        const pctStr = Number.isInteger(alert.percentIncrease)
            ? String(alert.percentIncrease)
            : String(alert.percentIncrease).replace(/\.0$/, '');
        lines.push(`• ${cleanName}: ${oldStr} ➡️ ${newStr} (+${pctStr}%)`);
    }
    if (alerts.length > 15) {
        lines.push(`• ... va yana ${alerts.length - 15} ta mahsulot`);
    }
    return lines.join('\n');
}
exports.detectPriceIncreases = SearchService.detectPriceIncreases.bind(SearchService);

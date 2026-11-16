"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchService = void 0;
exports.formatDotDate = formatDotDate;
exports.formatArrivalDateTime = formatArrivalDateTime;
exports.formatPriceDiffLine = formatPriceDiffLine;
exports.formatProductPriceTrackerCard = formatProductPriceTrackerCard;
const fuse_js_1 = __importDefault(require("fuse.js"));
const client_1 = require("@prisma/client");
const prisma_1 = require("../database/prisma");
const env_1 = require("../config/env");
const translit_service_1 = require("./translit.service");
const formatters_1 = require("../utils/formatters");
const toKey = (s) => translit_service_1.TranslitService.toLatin(s || '').toLowerCase().trim();
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
    const unitStr = (params.unit || 'dona').trim();
    const prevLine = params.previousPrice !== null && params.previousDate
        ? `${(0, formatters_1.formatCurrency)(params.previousPrice, params.currency)} (${formatDotDate(params.previousDate)})`
        : "Ma'lumot yo'q (Birinchi kirim)";
    const formattedCard = `📦 Mahsulot: ${params.productName}\n` +
        `🚚 Ta'minotchi: ${params.supplierName}\n` +
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
        const cleanQuery = toKey(rawTrimmed);
        if (!cleanQuery)
            return [];
        // 1. Direct ILIKE search on InvoiceItem + Product isolated by ownerId
        let matchedInvoiceItems = await prisma_1.prisma.invoiceItem.findMany({
            where: {
                ownerId: cleanOwnerId,
                OR: [
                    { rawName: { contains: rawTrimmed, mode: 'insensitive' } },
                    { normalizedName: { contains: cleanQuery, mode: 'insensitive' } },
                    { product: { name: { contains: rawTrimmed, mode: 'insensitive' } } },
                    { product: { searchTokens: { contains: cleanQuery, mode: 'insensitive' } } },
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
        // 2. Fuzzy fallback if ILIKE returned 0 items
        if (matchedInvoiceItems.length === 0) {
            const recentItems = await prisma_1.prisma.invoiceItem.findMany({
                where: { ownerId: cleanOwnerId },
                orderBy: [{ createdAt: 'desc' }],
                include: {
                    product: { select: { id: true, name: true } },
                    supplier: { select: { id: true, name: true } },
                    invoice: { select: { id: true, supplierId: true, createdAt: true, supplier: { select: { id: true, name: true } } } },
                },
                take: 200,
            });
            const fuseDocs = recentItems.map((it) => ({
                item: it,
                searchName: toKey(it.rawName || it.product?.name || ''),
            }));
            const fuseHits = new fuse_js_1.default(fuseDocs, {
                keys: ['searchName'],
                threshold: 0.35,
                ignoreLocation: true,
            }).search(cleanQuery);
            matchedInvoiceItems = fuseHits.map((h) => h.item.item);
        }
        if (matchedInvoiceItems.length === 0)
            return [];
        const productIds = Array.from(new Set(matchedInvoiceItems.map((i) => i.productId)));
        const normNames = Array.from(new Set(matchedInvoiceItems.map((i) => (i.normalizedName || toKey(i.rawName || i.product.name))).filter(Boolean)));
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
            const pName = row.rawName || row.product?.name || "Noma'lum";
            const normKey = row.normalizedName || toKey(pName);
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
            const productName = latest.rawName || latest.product?.name || "Noma'lum";
            const supplierName = latest.supplier?.name || latest.invoice?.supplier?.name || "Noma'lum ta'minotchi";
            const supplierId = latest.supplierId || latest.invoice?.supplierId;
            const latestDate = latest.createdAt || latest.invoice.createdAt;
            const currentPrice = Number(latest.unitPrice);
            const previousPrice = previous ? Number(previous.unitPrice) : null;
            const previousDate = previous ? previous.createdAt || previous.invoice.createdAt : null;
            const quantity = Number(latest.quantity);
            const unit = latest.unit || 'dona';
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
        const cleanQuery = toKey(query.replace(/(ni|ga|dan|da|ning)$/i, '').trim());
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
            name: s.name,
            searchName: toKey(s.name),
            debtUzs: Number(s.debtUzs),
            debtUsd: Number(s.debtUsd),
            amountText: (0, formatters_1.formatSupplierDebtLine)(s.name, s.debtUzs, s.debtUsd, '').replace(/^[^:]+:\s*/, ''),
            type: 'SUPPLIER',
        }));
        const groupedDebts = {};
        for (const d of allDebts) {
            const rem = Number(d.amount) - Number(d.paidAmount);
            if (rem > 0) {
                groupedDebts[d.customerName] ??= { sum: 0, firstId: d.id, currency: d.currency };
                groupedDebts[d.customerName].sum += rem;
            }
        }
        const customerDocs = Object.entries(groupedDebts).map(([name, d]) => ({
            id: d.firstId,
            name,
            searchName: toKey(name),
            amount: d.sum,
            amountText: (0, formatters_1.formatCurrency)(d.sum, d.currency),
            type: 'CUSTOMER',
        }));
        const txDocs = recentTx.map((tx) => {
            const name = `${tx.supplier.name} ${tx.type === 'INCOMING_GOODS' ? 'kirim' : "to'lov"} ${tx.description || ''}`.trim();
            return {
                id: tx.id,
                name,
                searchName: toKey(name),
                amount: Number(tx.amount),
                currency: tx.currency,
                type: 'TRANSACTION',
                date: tx.date,
                supplierId: tx.supplierId,
            };
        });
        const opts = { keys: ['searchName'], threshold: 0.35, ignoreLocation: true, includeScore: true };
        const top5 = (list) => new fuse_js_1.default(list, opts).search(cleanQuery).slice(0, 5);
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
                        name: sup.name,
                        amountText: (0, formatters_1.formatSupplierDebtLine)(sup.name, sup.debtUzs, sup.debtUsd, '').replace(/^[^:]+:\s*/, ''),
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
}
exports.SearchService = SearchService;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchService = void 0;
const fuse_js_1 = __importDefault(require("fuse.js"));
const client_1 = require("@prisma/client");
const prisma_1 = require("../database/prisma");
const translit_service_1 = require("./translit.service");
const formatters_1 = require("../utils/formatters");
const toKey = (s) => translit_service_1.TranslitService.toLatin(s).toLowerCase();
class SearchService {
    static async multiSearch(query) {
        const cleanQuery = toKey(query.replace(/(ni|ga|dan|da|ning)$/i, '').trim());
        const [allSuppliers, allDebts, recentTx, recentCash, allProducts] = await Promise.all([
            prisma_1.prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true, debtUzs: true } }),
            prisma_1.prisma.customerDebt.findMany({
                where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
                select: { id: true, customerName: true, amount: true, paidAmount: true }
            }),
            prisma_1.prisma.supplierTransaction.findMany({
                where: { receiptData: { not: client_1.Prisma.DbNull } },
                take: 50,
                orderBy: { date: 'desc' },
                select: { id: true, supplierId: true, type: true, amount: true, date: true, description: true, receiptData: true, supplier: { select: { name: true } } }
            }),
            prisma_1.prisma.cashTransaction.findMany({
                where: { items: { not: null } },
                take: 50,
                orderBy: { createdAt: 'desc' },
                select: { id: true, partyName: true, items: true, createdAt: true }
            }),
            prisma_1.prisma.product.findMany({
                take: 50,
                orderBy: { updatedAt: 'desc' },
                select: {
                    id: true,
                    name: true,
                    lastPrice: true,
                    updatedAt: true,
                    invoiceItems: {
                        take: 1,
                        orderBy: { invoice: { createdAt: 'desc' } },
                        select: { quantity: true, invoice: { select: { supplierId: true, createdAt: true, supplier: { select: { name: true } } } } }
                    }
                }
            })
        ]);
        const supplierDocs = allSuppliers.map(s => ({ id: s.id, name: s.name, searchName: toKey(s.name), amount: Number(s.debtUzs), type: 'SUPPLIER' }));
        const groupedDebts = {};
        for (const d of allDebts) {
            const rem = Number(d.amount) - Number(d.paidAmount);
            if (rem > 0) {
                groupedDebts[d.customerName] ??= { sum: 0, firstId: d.id };
                groupedDebts[d.customerName].sum += rem;
            }
        }
        const customerDocs = Object.entries(groupedDebts).map(([name, d]) => ({ id: d.firstId, name, searchName: toKey(name), amount: d.sum, type: 'CUSTOMER' }));
        const txDocs = recentTx.map(tx => {
            const name = `${tx.supplier.name} ${tx.type === 'INCOMING_GOODS' ? 'kirim' : "to'lov"} ${tx.description || ''}`.trim();
            return { id: tx.id, name, searchName: toKey(name), amount: Number(tx.amount), type: 'TRANSACTION', date: tx.date, supplierId: tx.supplierId };
        });
        const itemDocs = [];
        const pushItem = (id, productName, partyName, date, unitPrice, quantity, isCash) => itemDocs.push({ type: 'ITEM', id, productName, searchName: toKey(productName), partyName, date, unitPrice, quantity, isCash });
        for (const tx of recentTx) {
            const items = tx.receiptData?.items;
            if (Array.isArray(items))
                items.forEach((i) => pushItem(tx.supplierId, i.productName, tx.supplier.name, tx.date, i.unitPrice, i.quantity, false));
        }
        for (const tx of recentCash) {
            try {
                const items = tx.items ? JSON.parse(tx.items) : null;
                if (Array.isArray(items))
                    items.forEach((i) => pushItem(tx.id, i.productName, `${tx.partyName} (Naqd)`, tx.createdAt, i.unitPrice, i.quantity, true));
            }
            catch { }
        }
        for (const prod of allProducts) {
            const last = prod.invoiceItems?.[0];
            pushItem(last?.invoice?.supplierId || prod.id, prod.name, last?.invoice?.supplier?.name || 'Katalog', last?.invoice?.createdAt || prod.updatedAt, Number(prod.lastPrice), last ? Number(last.quantity) : 1, false);
        }
        const opts = { keys: ['searchName'], threshold: 0.35, ignoreLocation: true, includeScore: true };
        const top5 = (list) => new fuse_js_1.default(list, opts).search(cleanQuery).slice(0, 5);
        const mapEntity = (r) => ({ type: r.item.type, id: r.item.id, name: r.item.name, amountText: `${(0, formatters_1.formatCompactAmount)(r.item.amount)} UZS`, score: r.score });
        return {
            suppliers: top5(supplierDocs).map(mapEntity),
            customers: top5(customerDocs).map(mapEntity),
            transactions: top5(txDocs).map(r => ({ type: r.item.type, id: r.item.supplierId, name: `${(0, formatters_1.formatDateShort)(r.item.date)} — ${r.item.name}`, amountText: `${(0, formatters_1.formatCompactAmount)(r.item.amount)} UZS`, extraInfo: r.item.id, score: r.score })),
            items: top5(itemDocs).map(r => ({ ...r.item, score: r.score }))
        };
    }
}
exports.SearchService = SearchService;

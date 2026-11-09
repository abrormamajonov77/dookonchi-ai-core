import Fuse from 'fuse.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { TranslitService } from './translit.service';
import { formatCompactAmount, formatDateShort } from '../utils/formatters';

export interface SearchResult {
  type: 'SUPPLIER' | 'CUSTOMER' | 'TRANSACTION';
  id: string;
  name: string;
  amountText: string;
  extraInfo?: string;
  score?: number;
}

export interface ItemSearchResult {
  type: 'ITEM';
  id: string;
  productName: string;
  partyName: string;
  date: Date;
  unitPrice: number;
  quantity: number;
  isCash: boolean;
  score?: number;
}

const toKey = (s: string) => TranslitService.toLatin(s).toLowerCase();

export class SearchService {
  static async multiSearch(query: string) {
    const cleanQuery = toKey(query.replace(/(ni|ga|dan|da|ning)$/i, '').trim());
    const [allSuppliers, allDebts, recentTx, recentCash, allProducts] = await Promise.all([
      prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true, debtUzs: true } }),
      prisma.customerDebt.findMany({
        where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        select: { id: true, customerName: true, amount: true, paidAmount: true }
      }),
      prisma.supplierTransaction.findMany({
        where: { receiptData: { not: Prisma.DbNull } },
        take: 50,
        orderBy: { date: 'desc' },
        select: { id: true, supplierId: true, type: true, amount: true, date: true, description: true, receiptData: true, supplier: { select: { name: true } } }
      }),
      prisma.cashTransaction.findMany({
        where: { items: { not: null } },
        take: 50,
        orderBy: { createdAt: 'desc' },
        select: { id: true, partyName: true, items: true, createdAt: true }
      }),
      prisma.product.findMany({
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

    const supplierDocs = allSuppliers.map(s => ({ id: s.id, name: s.name, searchName: toKey(s.name), amount: Number(s.debtUzs), type: 'SUPPLIER' as const }));
    const groupedDebts: Record<string, { sum: number; firstId: string }> = {};
    for (const d of allDebts) {
      const rem = Number(d.amount) - Number(d.paidAmount);
      if (rem > 0) {
        groupedDebts[d.customerName] ??= { sum: 0, firstId: d.id };
        groupedDebts[d.customerName].sum += rem;
      }
    }
    const customerDocs = Object.entries(groupedDebts).map(([name, d]) => ({ id: d.firstId, name, searchName: toKey(name), amount: d.sum, type: 'CUSTOMER' as const }));
    const txDocs = recentTx.map(tx => {
      const name = `${tx.supplier.name} ${tx.type === 'INCOMING_GOODS' ? 'kirim' : "to'lov"} ${tx.description || ''}`.trim();
      return { id: tx.id, name, searchName: toKey(name), amount: Number(tx.amount), type: 'TRANSACTION' as const, date: tx.date, supplierId: tx.supplierId };
    });

    const itemDocs: any[] = [];
    const pushItem = (id: string, productName: string, partyName: string, date: Date, unitPrice: number, quantity: number, isCash: boolean) =>
      itemDocs.push({ type: 'ITEM', id, productName, searchName: toKey(productName), partyName, date, unitPrice, quantity, isCash });

    for (const tx of recentTx) {
      const items = (tx.receiptData as any)?.items;
      if (Array.isArray(items)) items.forEach((i: any) => pushItem(tx.supplierId, i.productName, tx.supplier.name, tx.date, i.unitPrice, i.quantity, false));
    }
    for (const tx of recentCash) {
      try {
        const items = tx.items ? JSON.parse(tx.items) : null;
        if (Array.isArray(items)) items.forEach((i: any) => pushItem(tx.id, i.productName, `${tx.partyName} (Naqd)`, tx.createdAt, i.unitPrice, i.quantity, true));
      } catch { }
    }
    for (const prod of allProducts) {
      const last = prod.invoiceItems?.[0];
      pushItem(last?.invoice?.supplierId || prod.id, prod.name, last?.invoice?.supplier?.name || 'Katalog', last?.invoice?.createdAt || prod.updatedAt, Number(prod.lastPrice), last ? Number(last.quantity) : 1, false);
    }

    const opts = { keys: ['searchName'], threshold: 0.35, ignoreLocation: true, includeScore: true };
    const top5 = <T>(list: T[]) => new Fuse(list, opts).search(cleanQuery).slice(0, 5);
    const mapEntity = (r: any): SearchResult => ({ type: r.item.type, id: r.item.id, name: r.item.name, amountText: `${formatCompactAmount(r.item.amount)} UZS`, score: r.score });

    return {
      suppliers: top5(supplierDocs).map(mapEntity),
      customers: top5(customerDocs).map(mapEntity),
      transactions: top5(txDocs).map(r => ({ type: r.item.type, id: r.item.supplierId, name: `${formatDateShort(r.item.date)} — ${r.item.name}`, amountText: `${formatCompactAmount(r.item.amount)} UZS`, extraInfo: r.item.id, score: r.score })),
      items: top5(itemDocs).map(r => ({ ...r.item, score: r.score }) as ItemSearchResult)
    };
  }
}

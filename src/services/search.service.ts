import Fuse from 'fuse.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { env } from '../config/env';
import { normalizeForSearch, toLatinUz } from '../utils/transliterate';
import { formatCompactAmount, formatCurrency, formatDateShort, formatSupplierDebtLine } from '../utils/formatters';

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
  supplierId?: string;
  invoiceId?: string;
  productName: string;
  partyName: string;
  date: Date;
  unitPrice: number;
  previousPrice: number | null;
  previousDate: Date | null;
  priceDiff: number;
  diffStatus: 'INCREASED' | 'DECREASED' | 'UNCHANGED';
  diffText: string;
  quantity: number;
  unit: string;
  currency: 'UZS' | 'USD';
  formattedCard: string;
  isCash: boolean;
  score?: number;
}

export function formatDotDate(date: Date | string): string {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function formatArrivalDateTime(date: Date | string, now: Date = new Date()): string {
  const d = new Date(date);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return `Bugun, ${hh}:${min}`;
  }
  return `${formatDotDate(d)}, ${hh}:${min}`;
}

export function formatPriceDiffLine(
  currentPrice: number,
  previousPrice: number | null,
  currency: 'UZS' | 'USD'
): { priceDiff: number; diffStatus: 'INCREASED' | 'DECREASED' | 'UNCHANGED'; diffText: string } {
  if (previousPrice === null || previousPrice === undefined || isNaN(previousPrice)) {
    return { priceDiff: 0, diffStatus: 'UNCHANGED', diffText: "O'zgarmadi ⚪️" };
  }
  const diff = Number((Number(currentPrice) - Number(previousPrice)).toFixed(2));
  if (diff > 0) {
    return {
      priceDiff: diff,
      diffStatus: 'INCREASED',
      diffText: `+${formatCurrency(diff, currency)} QIMMATLADI 🔴`,
    };
  }
  if (diff < 0) {
    return {
      priceDiff: diff,
      diffStatus: 'DECREASED',
      diffText: `-${formatCurrency(Math.abs(diff), currency)} ARZONLADI 🟢`,
    };
  }
  return { priceDiff: 0, diffStatus: 'UNCHANGED', diffText: "O'zgarmadi ⚪️" };
}

export function formatProductPriceTrackerCard(params: {
  productName: string;
  supplierName: string;
  latestDate: Date;
  currentPrice: number;
  quantity: number;
  unit: string;
  previousPrice: number | null;
  previousDate: Date | null;
  currency: 'UZS' | 'USD';
}): { formattedCard: string; priceDiff: number; diffStatus: 'INCREASED' | 'DECREASED' | 'UNCHANGED'; diffText: string } {
  const { priceDiff, diffStatus, diffText } = formatPriceDiffLine(
    params.currentPrice,
    params.previousPrice,
    params.currency
  );
  const qtyNum = Number(params.quantity);
  const qtyStr = Number.isInteger(qtyNum) ? String(qtyNum) : String(Number(qtyNum.toFixed(3)));
  const unitStr = toLatinUz((params.unit || 'dona').trim());
  const prodName = toLatinUz(params.productName);
  const supName = toLatinUz(params.supplierName);
  const prevLine =
    params.previousPrice !== null && params.previousDate
      ? `${formatCurrency(params.previousPrice, params.currency)} (${formatDotDate(params.previousDate)})`
      : "Ma'lumot yo'q (Birinchi kirim)";

  const formattedCard =
    `📦 Mahsulot: ${prodName}\n` +
    `🚚 Ta'minotchi: ${supName}\n` +
    `🕒 Oxirgi kelgan vaqti: ${formatArrivalDateTime(params.latestDate)}\n` +
    `💰 Hozirgi kelish narxi: ${formatCurrency(params.currentPrice, params.currency)} (Soni: ${qtyStr} ${unitStr})\n` +
    `📊 Oldingi partiya narxi: ${prevLine}\n` +
    `📈 Farqi: ${diffText}`;

  return { formattedCard, priceDiff, diffStatus, diffText };
}

export class SearchService {
  static async searchProductsWithPriceDiff(
    query: string,
    ownerId: string = env.OWNER_TELEGRAM_ID
  ): Promise<ItemSearchResult[]> {
    const cleanOwnerId = String(ownerId || env.OWNER_TELEGRAM_ID).trim();
    const rawTrimmed = query.replace(/(ni|ga|dan|da|ning)$/i, '').trim();
    const latinQuery = toLatinUz(rawTrimmed).trim();
    const cleanQuery = normalizeForSearch(rawTrimmed);
    if (!cleanQuery) return [];

    // 1. Direct ILIKE search on InvoiceItem + Product + Supplier isolated by ownerId
    let matchedInvoiceItems = await prisma.invoiceItem.findMany({
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
      const recentItems = await prisma.invoiceItem.findMany({
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
        const key = normalizeForSearch(
          `${it.rawName || ''} ${it.product?.name || ''} ${it.supplier?.name || it.invoice?.supplier?.name || ''}`
        );
        return key.includes(cleanQuery);
      });

      if (directPhoneticHits.length > 0) {
        matchedInvoiceItems = directPhoneticHits;
      } else {
        const fuseDocs = recentItems.map((it) => ({
          item: it,
          searchName: normalizeForSearch(
            `${it.rawName || it.product?.name || ''} ${it.supplier?.name || it.invoice?.supplier?.name || ''}`
          ),
        }));
        const fuseHits = new Fuse(fuseDocs, {
          keys: ['searchName'],
          threshold: 0.35,
          ignoreLocation: true,
        }).search(cleanQuery);

        matchedInvoiceItems = fuseHits.map((h) => h.item.item);
      }
    }

    if (matchedInvoiceItems.length === 0) return [];

    const productIds = Array.from(new Set(matchedInvoiceItems.map((i) => i.productId)));
    const normNames = Array.from(
      new Set(
        matchedInvoiceItems
          .map((i) => i.normalizedName || normalizeForSearch(i.rawName || i.product.name))
          .filter(Boolean)
      )
    );

    const allHistoryItems = await prisma.invoiceItem.findMany({
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

    const groups = new Map<string, typeof allHistoryItems>();
    for (const row of allHistoryItems) {
      const pName = toLatinUz(row.rawName || row.product?.name || "Noma'lum");
      const normKey = normalizeForSearch(row.normalizedName || pName);
      const cur = (row.currency || 'UZS') as 'UZS' | 'USD';
      const groupKey = `${normKey}::${cur}`;
      const list = groups.get(groupKey) || [];
      list.push(row);
      groups.set(groupKey, list);
    }

    const results: ItemSearchResult[] = [];

    for (const [, history] of groups.entries()) {
      history.sort((a, b) => {
        const tA = new Date(a.createdAt || a.invoice.createdAt).getTime();
        const tB = new Date(b.createdAt || b.invoice.createdAt).getTime();
        return tB - tA;
      });

      const latest = history[0];
      const previous = history.length > 1 ? history[1] : null;

      const productName = toLatinUz(latest.rawName || latest.product?.name || "Noma'lum");
      const supplierName = toLatinUz(
        latest.supplier?.name || latest.invoice?.supplier?.name || "Noma'lum ta'minotchi"
      );
      const supplierId = latest.supplierId || latest.invoice?.supplierId;
      const latestDate = latest.createdAt || latest.invoice.createdAt;
      const currentPrice = Number(latest.unitPrice);
      const previousPrice = previous ? Number(previous.unitPrice) : null;
      const previousDate = previous ? previous.createdAt || previous.invoice.createdAt : null;
      const quantity = Number(latest.quantity);
      const unit = toLatinUz(latest.unit || 'dona');
      const currency = (latest.currency || 'UZS') as 'UZS' | 'USD';

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

  static async multiSearch(query: string, ownerId: string = env.OWNER_TELEGRAM_ID) {
    const cleanOwnerId = String(ownerId || env.OWNER_TELEGRAM_ID).trim();
    const cleanQuery = normalizeForSearch(query.replace(/(ni|ga|dan|da|ning)$/i, '').trim());

    const [productItems, allSuppliers, allDebts, recentTx] = await Promise.all([
      this.searchProductsWithPriceDiff(query, cleanOwnerId),
      prisma.supplier.findMany({
        where: { ownerId: cleanOwnerId, isActive: true },
        select: { id: true, name: true, debtUzs: true, debtUsd: true },
      }),
      prisma.customerDebt.findMany({
        where: { ownerId: cleanOwnerId, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        select: { id: true, customerName: true, amount: true, paidAmount: true, currency: true },
      }),
      prisma.supplierTransaction.findMany({
        where: { ownerId: cleanOwnerId, receiptData: { not: Prisma.DbNull } },
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
      name: toLatinUz(s.name),
      searchName: normalizeForSearch(s.name),
      debtUzs: Number(s.debtUzs),
      debtUsd: Number(s.debtUsd),
      amountText: formatSupplierDebtLine(toLatinUz(s.name), s.debtUzs, s.debtUsd, '').replace(/^[^:]+:\s*/, ''),
      type: 'SUPPLIER' as const,
    }));

    const groupedDebts: Record<string, { sum: number; firstId: string; currency: 'UZS' | 'USD' }> = {};
    for (const d of allDebts) {
      const rem = Number(d.amount) - Number(d.paidAmount);
      if (rem > 0) {
        const cName = toLatinUz(d.customerName);
        groupedDebts[cName] ??= { sum: 0, firstId: d.id, currency: d.currency };
        groupedDebts[cName].sum += rem;
      }
    }
    const customerDocs = Object.entries(groupedDebts).map(([name, d]) => ({
      id: d.firstId,
      name,
      searchName: normalizeForSearch(name),
      amount: d.sum,
      amountText: formatCurrency(d.sum, d.currency),
      type: 'CUSTOMER' as const,
    }));

    const txDocs = recentTx.map((tx) => {
      const name = toLatinUz(
        `${tx.supplier.name} ${tx.type === 'INCOMING_GOODS' ? 'kirim' : "to'lov"} ${tx.description || ''}`.trim()
      );
      return {
        id: tx.id,
        name,
        searchName: normalizeForSearch(name),
        amount: Number(tx.amount),
        currency: tx.currency,
        type: 'TRANSACTION' as const,
        date: tx.date,
        supplierId: tx.supplierId,
      };
    });

    const opts = { keys: ['searchName'], threshold: 0.35, ignoreLocation: true, includeScore: true };
    const top5 = <T extends { searchName: string }>(list: T[]) => {
      const exactSub = list.filter((x) => x.searchName.includes(cleanQuery));
      if (exactSub.length > 0) {
        return exactSub.slice(0, 5).map((item) => ({ item, score: 0 }));
      }
      return new Fuse(list, opts).search(cleanQuery).slice(0, 5);
    };

    const matchedSuppliers: SearchResult[] = top5(supplierDocs).map((r: any) => ({
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
            name: toLatinUz(sup.name),
            amountText: formatSupplierDebtLine(toLatinUz(sup.name), sup.debtUzs, sup.debtUsd, '').replace(
              /^[^:]+:\s*/,
              ''
            ),
          });
        }
      }
    }

    return {
      items: productItems,
      suppliers: matchedSuppliers,
      customers: top5(customerDocs).map((r: any) => ({
        type: 'CUSTOMER' as const,
        id: r.item.id,
        name: r.item.name,
        amountText: r.item.amountText,
        score: r.score,
      })),
      transactions: top5(txDocs).map((r: any) => ({
        type: 'TRANSACTION' as const,
        id: r.item.supplierId,
        name: `${formatDateShort(r.item.date)} — ${r.item.name}`,
        amountText: formatCompactAmount(r.item.amount, r.item.currency),
        extraInfo: r.item.id,
        score: r.score,
      })),
    };
  }
}

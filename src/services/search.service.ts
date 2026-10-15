import Fuse from 'fuse.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';
import { TranslitService } from './translit.service';
import { formatCompactAmount } from '../utils/formatters';

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
  id: string; // ID to link to (e.g. supplier ID)
  productName: string;
  partyName: string;
  date: Date;
  unitPrice: number;
  quantity: number;
  isCash: boolean;
  score?: number;
}

export class SearchService {
  static async multiSearch(query: string): Promise<{ 
    suppliers: SearchResult[], 
    customers: SearchResult[], 
    transactions: SearchResult[],
    items: ItemSearchResult[]
  }> {
    // 1. Stemming & Normalization
    const stemmedQuery = query.replace(/(ni|ga|dan|da|ning)$/i, '').trim();
    const cleanQuery = TranslitService.toLatin(stemmedQuery).toLowerCase();

    // 2. Fetch all searchable entities
    const [allSuppliers, allDebts, recentTransactions, recentCashTransactions, allProducts] = await Promise.all([
      prisma.supplier.findMany({ where: { isActive: true } }),
      prisma.customerDebt.findMany({ where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] } } }),
      prisma.supplierTransaction.findMany({
        where: { receiptData: { not: Prisma.DbNull } },
        take: 50, // Fetch top 50 recent
        orderBy: { date: 'desc' },
        include: { supplier: true }
      }),
      prisma.cashTransaction.findMany({
        where: { items: { not: null } },
        take: 50,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.product.findMany({
        take: 50,
        orderBy: { updatedAt: 'desc' },
        include: {
          invoiceItems: {
            take: 1,
            orderBy: { invoice: { createdAt: 'desc' } },
            include: {
              invoice: {
                include: { supplier: true }
              }
            }
          }
        }
      })
    ]);

    // 3. Prepare items for Fuse
    const supplierDocs = allSuppliers.map(s => ({
      id: s.id,
      name: s.name,
      searchName: TranslitService.toLatin(s.name).toLowerCase(),
      amount: Number(s.debtUzs),
      type: 'SUPPLIER' as const
    }));

    const groupedDebts: Record<string, { sum: number, firstId: string }> = {};
    for (const debt of allDebts) {
      const remaining = Number(debt.amount) - Number(debt.paidAmount);
      if (remaining <= 0) continue;
      if (!groupedDebts[debt.customerName]) {
        groupedDebts[debt.customerName] = { sum: 0, firstId: debt.id };
      }
      groupedDebts[debt.customerName].sum += remaining;
    }
    const customerDocs = Object.entries(groupedDebts).map(([name, data]) => ({
      id: data.firstId,
      name,
      searchName: TranslitService.toLatin(name).toLowerCase(),
      amount: data.sum,
      type: 'CUSTOMER' as const
    }));

    const transactionDocs = recentTransactions.map(tx => {
      const txName = `${tx.supplier.name} ${tx.type === 'INCOMING_GOODS' ? 'kirim' : 'to\'lov'} ${tx.description || ''}`.trim();
      return {
        id: tx.id,
        name: txName,
        searchName: TranslitService.toLatin(txName).toLowerCase(),
        amount: Number(tx.amount),
        type: 'TRANSACTION' as const,
        date: tx.date,
        supplierId: tx.supplierId
      };
    });

    const itemDocs: any[] = [];
    
    // Parse SupplierTransaction items
    recentTransactions.forEach(tx => {
       if (tx.receiptData && typeof tx.receiptData === 'object') {
          const receipt = tx.receiptData as any;
          if (Array.isArray(receipt.items)) {
             receipt.items.forEach((item: any) => {
               itemDocs.push({
                 type: 'ITEM',
                 id: tx.supplierId, 
                 productName: item.productName,
                 searchName: TranslitService.toLatin(item.productName).toLowerCase(),
                 partyName: tx.supplier.name,
                 date: tx.date,
                 unitPrice: item.unitPrice,
                 quantity: item.quantity,
                 isCash: false
               });
             });
          }
       }
    });

    // Parse CashTransaction items
    recentCashTransactions.forEach(tx => {
       if (tx.items) {
          try {
             const items = JSON.parse(tx.items);
             if (Array.isArray(items)) {
                items.forEach((item: any) => {
                  itemDocs.push({
                    type: 'ITEM',
                    id: tx.id, // For cash tx, there's no supplier, just use its own id
                    productName: item.productName,
                    searchName: TranslitService.toLatin(item.productName).toLowerCase(),
                    partyName: tx.partyName + ' (Naqd)',
                    date: tx.createdAt,
                    unitPrice: item.unitPrice,
                    quantity: item.quantity,
                    isCash: true
                  });
                });
             }
          } catch(e) {}
       }
    });

    // Parse Product catalog items
    allProducts.forEach(prod => {
      const lastInvoiceItem = prod.invoiceItems?.[0];
      const supplierName = lastInvoiceItem?.invoice?.supplier?.name || "Katalog";
      const supplierId = lastInvoiceItem?.invoice?.supplierId || prod.id;
      const date = lastInvoiceItem?.invoice?.createdAt || prod.updatedAt;
      const unitPrice = Number(prod.lastPrice);
      const quantity = lastInvoiceItem ? Number(lastInvoiceItem.quantity) : 1;

      itemDocs.push({
        type: 'ITEM',
        id: supplierId,
        productName: prod.name,
        searchName: TranslitService.toLatin(prod.name).toLowerCase(),
        partyName: supplierName,
        date: date,
        unitPrice: unitPrice,
        quantity: quantity,
        isCash: false
      });
    });

    // 4. Initialize Fuse for each category
    const fuseOptions = {
      keys: ['searchName'],
      threshold: 0.35, // Allows typos
      ignoreLocation: true,
      includeScore: true
    };

    const fuseSuppliers = new Fuse(supplierDocs, fuseOptions);
    const fuseCustomers = new Fuse(customerDocs, fuseOptions);
    const fuseTransactions = new Fuse(transactionDocs, fuseOptions);
    const fuseItems = new Fuse(itemDocs, fuseOptions);

    // 5. Perform search
    const supResults = fuseSuppliers.search(cleanQuery).slice(0, 5).map(res => ({
      type: res.item.type,
      id: res.item.id,
      name: res.item.name,
      amountText: `${formatCompactAmount(res.item.amount)} UZS`,
      score: res.score
    }));

    const custResults = fuseCustomers.search(cleanQuery).slice(0, 5).map(res => ({
      type: res.item.type,
      id: res.item.id,
      name: res.item.name,
      amountText: `${formatCompactAmount(res.item.amount)} UZS`,
      score: res.score
    }));

    const txResults = fuseTransactions.search(cleanQuery).slice(0, 5).map(res => {
      const dateStr = new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(res.item.date);
      return {
        type: res.item.type,
        id: res.item.supplierId, 
        name: `${dateStr} — ${res.item.name}`,
        amountText: `${formatCompactAmount(res.item.amount)} UZS`,
        extraInfo: res.item.id, 
        score: res.score
      };
    });

    const itemResults = fuseItems.search(cleanQuery).slice(0, 5).map(res => ({
      type: res.item.type,
      id: res.item.id,
      productName: res.item.productName,
      partyName: res.item.partyName,
      date: res.item.date,
      unitPrice: res.item.unitPrice,
      quantity: res.item.quantity,
      isCash: res.item.isCash,
      score: res.score
    }));

    return {
      suppliers: supResults,
      customers: custResults,
      transactions: txResults,
      items: itemResults as ItemSearchResult[]
    };
  }
}

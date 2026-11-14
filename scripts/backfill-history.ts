import { prisma } from '../src/database/prisma';
import { parseVerbatimTableToItems } from '../src/services/ai.service';
import { TranslitService } from '../src/services/translit.service';

async function backfill() {
  const [supCount, invCount, itemCount, txCount] = await Promise.all([
    prisma.supplier.count(),
    prisma.invoice.count(),
    prisma.invoiceItem.count(),
    prisma.supplierTransaction.count(),
  ]);
  console.log('📊 Current DB counts:', { supCount, invCount, itemCount, txCount });

  // Backfill historical SupplierTransactions into Invoice & InvoiceItem for Product Search & Discount Editing
  const txs = await prisma.supplierTransaction.findMany({
    where: { type: 'INCOMING_GOODS' },
    orderBy: { date: 'asc' },
  });

  let backfilledInvoices = 0;
  let backfilledItems = 0;

  for (const tx of txs) {
    let invoiceId = tx.invoiceId;
    const rData = (tx.receiptData as any) || {};
    const tableText = String(rData.verbatimText || rData.table_text || tx.formattedReceipt || '');

    if (!invoiceId) {
      // Find matching invoice or create one so discount/total/currency edit buttons work on old receipts too
      let inv = await prisma.invoice.findFirst({
        where: {
          supplierId: tx.supplierId,
          totalAmount: tx.amount,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (!inv) {
        inv = await prisma.invoice.create({
          data: {
            supplierId: tx.supplierId,
            totalAmount: tx.amount,
            originalAmount: tx.originalAmount ?? tx.amount,
            discountAmount: tx.discountAmount ?? 0,
            currency: tx.currency,
            verbatimText: tableText || null,
            createdAt: tx.date,
          },
        });
        backfilledInvoices++;
      }
      invoiceId = inv.id;
      await prisma.supplierTransaction.update({
        where: { id: tx.id },
        data: { invoiceId },
      });
    }

    // Check if this invoice has items in InvoiceItem
    const existingItemsCount = await prisma.invoiceItem.count({ where: { invoiceId } });
    if (existingItemsCount === 0 && tableText.includes('|')) {
      const parsedItems = parseVerbatimTableToItems(tableText, tx.currency);
      for (const item of parsedItems) {
        const itemName = item.rawName || item.productName;
        const normName = item.normalizedName || TranslitService.toLatin(itemName).toLowerCase().trim();
        const searchTokens = TranslitService.generateSearchTokens(itemName);

        let product = await prisma.product.findFirst({
          where: {
            OR: [
              { name: { equals: itemName, mode: 'insensitive' } },
              { searchTokens: { contains: normName, mode: 'insensitive' } },
            ],
          },
        });

        if (!product) {
          product = await prisma.product.create({
            data: {
              name: itemName,
              searchTokens,
              lastPrice: item.unitPrice,
              currency: item.currency,
              createdAt: tx.date,
              updatedAt: tx.date,
            },
          });
        } else {
          await prisma.product.update({
            where: { id: product.id },
            data: { lastPrice: item.unitPrice, currency: item.currency, updatedAt: tx.date },
          });
        }

        await prisma.invoiceItem.create({
          data: {
            invoiceId,
            supplierId: tx.supplierId,
            productId: product.id,
            rawName: itemName,
            normalizedName: normName,
            quantity: item.quantity,
            unit: item.unit || 'dona',
            unitPrice: item.unitPrice,
            totalPrice: item.lineTotal,
            lineTotal: item.lineTotal,
            currency: item.currency,
            createdAt: tx.date,
          },
        });
        backfilledItems++;
      }
    }
  }

  // Also ensure existing InvoiceItems have supplierId, rawName, normalizedName populated
  const incompleteItems = await prisma.invoiceItem.findMany({
    where: { OR: [{ rawName: null }, { normalizedName: null }, { supplierId: null }] },
    include: { product: true, invoice: true },
  });

  for (const it of incompleteItems) {
    const rName = it.rawName || it.product.name;
    const nName = it.normalizedName || TranslitService.toLatin(rName).toLowerCase().trim();
    await prisma.invoiceItem.update({
      where: { id: it.id },
      data: {
        rawName: rName,
        normalizedName: nName,
        supplierId: it.supplierId || it.invoice.supplierId,
        lineTotal: it.lineTotal ?? it.totalPrice,
        createdAt: it.invoice.createdAt,
      },
    });
  }

  console.log('✅ Backfill completed:', {
    backfilledInvoices,
    backfilledItems,
    updatedIncompleteItems: incompleteItems.length,
  });
  await prisma.$disconnect();
}

backfill().catch((e) => {
  console.error(e);
  process.exit(1);
});


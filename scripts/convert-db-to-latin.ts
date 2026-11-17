import '../src/config/env';
import { prisma } from '../src/database/prisma';
import { hasCyrillic, normalizeForSearch, toLatinUz } from '../src/utils/transliterate';
import { TranslitService } from '../src/services/translit.service';
import { SupplierService } from '../src/services/supplier.service';
import { invalidateCache } from '../src/utils/cache';

export async function convertDatabaseToLatin() {
  await prisma.$connect();
  console.log('🔧 Ensuring paymentSource columns and indexes exist in PostgreSQL...');
  const ddlStatements = [
    `ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "paymentSource" TEXT NOT NULL DEFAULT 'TODAY_CASH'`,
    `ALTER TABLE "SupplierPayment" ADD COLUMN IF NOT EXISTS "paymentSource" TEXT NOT NULL DEFAULT 'TODAY_CASH'`,
    `ALTER TABLE "SupplierTransaction" ADD COLUMN IF NOT EXISTS "paymentSource" TEXT NOT NULL DEFAULT 'TODAY_CASH'`,
    `ALTER TABLE "CashTransaction" ADD COLUMN IF NOT EXISTS "paymentSource" TEXT NOT NULL DEFAULT 'TODAY_CASH'`,
    `CREATE INDEX IF NOT EXISTS "Invoice_ownerId_paymentSource_createdAt_idx" ON "Invoice"("ownerId", "paymentSource", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "SupplierPayment_ownerId_paymentSource_createdAt_idx" ON "SupplierPayment"("ownerId", "paymentSource", "createdAt")`,
    `CREATE INDEX IF NOT EXISTS "SupplierTransaction_ownerId_paymentSource_date_idx" ON "SupplierTransaction"("ownerId", "paymentSource", "date")`,
  ];
  for (const sql of ddlStatements) {
    await prisma.$executeRawUnsafe(sql);
  }
  console.log('✅ paymentSource columns and indexes verified.');

  console.log('🔄 Scanning database for Cyrillic strings and converting to Uzbek Latin (toLatinUz)...');

  // 1. Suppliers
  const suppliers = await prisma.supplier.findMany();
  let suppliersUpdated = 0;
  let suppliersMerged = 0;

  for (const s of suppliers) {
    if (!hasCyrillic(s.name)) continue;
    const latinName = toLatinUz(s.name).trim();
    if (!latinName || latinName === s.name) continue;

    // Check if another supplier for the same ownerId already has this Latin name
    const existingTarget = await prisma.supplier.findFirst({
      where: {
        ownerId: s.ownerId,
        id: { not: s.id },
        name: { equals: latinName, mode: 'insensitive' },
      },
    });

    if (existingTarget) {
      await SupplierService.mergeSuppliers(s.id, existingTarget.id, s.ownerId);
      suppliersMerged++;
    } else {
      await prisma.supplier.update({
        where: { id: s.id },
        data: { name: latinName },
      });
      suppliersUpdated++;
    }
  }

  // 2. Products
  const products = await prisma.product.findMany();
  let productsUpdated = 0;
  for (const p of products) {
    if (!hasCyrillic(p.name)) continue;
    const latinName = toLatinUz(p.name).trim();
    const searchTokens = TranslitService.generateSearchTokens(latinName);
    await prisma.product.update({
      where: { id: p.id },
      data: { name: latinName, searchTokens },
    });
    productsUpdated++;
  }

  // 3. InvoiceItems
  const invoiceItems = await prisma.invoiceItem.findMany();
  let itemsUpdated = 0;
  for (const it of invoiceItems) {
    const rawHasCyr = hasCyrillic(it.rawName || '');
    const normHasCyr = hasCyrillic(it.normalizedName || '');
    const unitHasCyr = hasCyrillic(it.unit || '');
    if (!rawHasCyr && !normHasCyr && !unitHasCyr) continue;

    const latinRaw = toLatinUz(it.rawName || '').trim();
    const latinNorm = normalizeForSearch(latinRaw || it.normalizedName || '');
    const latinUnit = toLatinUz(it.unit || 'dona').trim() || 'dona';

    await prisma.invoiceItem.update({
      where: { id: it.id },
      data: {
        rawName: latinRaw || it.rawName,
        normalizedName: latinNorm || it.normalizedName,
        unit: latinUnit,
      },
    });
    itemsUpdated++;
  }

  // 4. Invoices (verbatimText)
  const invoices = await prisma.invoice.findMany({
    where: { verbatimText: { not: null } },
    select: { id: true, verbatimText: true },
  });
  let invoicesUpdated = 0;
  for (const inv of invoices) {
    if (!inv.verbatimText || !hasCyrillic(inv.verbatimText)) continue;
    await prisma.invoice.update({
      where: { id: inv.id },
      data: { verbatimText: toLatinUz(inv.verbatimText) },
    });
    invoicesUpdated++;
  }

  // 5. CustomerDebts
  const customerDebts = await prisma.customerDebt.findMany();
  let customersUpdated = 0;
  for (const cd of customerDebts) {
    if (!hasCyrillic(cd.customerName) && !hasCyrillic(cd.itemsSummary || '')) continue;
    await prisma.customerDebt.update({
      where: { id: cd.id },
      data: {
        customerName: toLatinUz(cd.customerName).trim(),
        itemsSummary: cd.itemsSummary ? toLatinUz(cd.itemsSummary) : null,
      },
    });
    customersUpdated++;
  }

  invalidateCache();
  console.log('✅ Cyrillic-to-Latin database migration completed:', {
    suppliersUpdated,
    suppliersMerged,
    productsUpdated,
    itemsUpdated,
    invoicesUpdated,
    customersUpdated,
  });
}

if (require.main === module) {
  convertDatabaseToLatin()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error('❌ Error in convert-db-to-latin.ts:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}

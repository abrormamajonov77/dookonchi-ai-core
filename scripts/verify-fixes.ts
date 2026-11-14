import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prisma } from '../src/database/prisma';
import { SupplierService } from '../src/services/supplier.service';
import { SearchService } from '../src/services/search.service';
import { ImageService } from '../src/services/image.service';
import { normalizeVerbatimInvoice } from '../src/services/ai.service';
import {
  calculateDiscountedTotal,
  formatSupplierDebtLine,
  formatTotalDebtBlock,
  parseCurrencyAndAmount,
} from '../src/utils/formatters';

const TEST_SUPPLIER_NAMES = [
  'Milter Mayanez',
  'Milter',
  'E2E_MultiCurr_Supplier',
  'E2E_Discount_Supplier',
  'E2E_Marvari_Supplier',
];

async function cleanup() {
  await Promise.all([
    prisma.supplier.deleteMany({ where: { name: { in: TEST_SUPPLIER_NAMES } } }),
    prisma.product.deleteMany({ where: { name: { contains: 'Marvari shokolad', mode: 'insensitive' } } }),
  ]);
}

async function runVerification() {
  console.log('🚀 Starting 0-to-100% E2E Verification Suite (6 Modules)...\n');
  await cleanup();

  try {
    // =========================================================================
    // TEST 1: Supplier Rename & Merge
    // =========================================================================
    const created = await SupplierService.createInvoiceWithItems({
      supplierName: 'Milter Mayanez',
      invoiceNo: 'INV-MM-01',
      rawTotal: 600000,
      discountInput: 0,
      currency: 'UZS',
      items: [{ rawName: 'Mayanez 500g', quantity: 20, unit: 'dona', unitPrice: 30000, lineTotal: 600000 }],
    });
    assert.equal(created.supplier.name, 'Milter Mayanez');

    const renameRes = await SupplierService.checkOrRenameSupplier(created.supplier.id, 'Milter');
    assert.equal(renameRes.status, 'RENAMED');
    assert.equal(renameRes.supplier?.name, 'Milter');

    const linkedInvoices = await prisma.invoice.findMany({ where: { supplierId: created.supplier.id } });
    assert.equal(linkedInvoices.length, 1);
    assert.equal(linkedInvoices[0].id, created.invoice.id);

    const dupCreated = await SupplierService.createInvoiceWithItems({
      supplierName: 'Milter Mayanez',
      invoiceNo: 'INV-MM-02',
      rawTotal: 150.25,
      discountInput: 0,
      currency: 'USD',
      items: [{ rawName: 'Import Sous', quantity: 5, unit: 'korobka', unitPrice: 30.05, lineTotal: 150.25, currency: 'USD' }],
    });
    const conflictCheck = await SupplierService.checkOrRenameSupplier(dupCreated.supplier.id, 'Milter');
    assert.equal(conflictCheck.status, 'MERGE_REQUIRED');

    const merged = await SupplierService.mergeSuppliers(dupCreated.supplier.id, created.supplier.id);
    assert.equal(merged.name, 'Milter');
    assert.equal(Number(merged.debtUzs), 600000);
    assert.equal(Number(merged.debtUsd), 150.25);
    console.log('✅ Test 1 (Supplier Rename & Merge): PASS');

    // =========================================================================
    // TEST 2: Discount Auto & Manual Override
    // =========================================================================
    const discCreated = await SupplierService.createInvoiceWithItems({
      supplierName: 'E2E_Discount_Supplier',
      invoiceNo: 'INV-DISC-01',
      rawTotal: 1000000,
      discountInput: 50000,
      currency: 'UZS',
      items: [{ rawName: "Kungaboqar yog'i 5L", quantity: 10, unit: 'dona', unitPrice: 100000, lineTotal: 1000000 }],
    });
    assert.equal(Number(discCreated.invoice.totalAmount), 950000);
    assert.equal(Number(discCreated.supplier.debtUzs), 950000);

    const afterPercent = await SupplierService.updateInvoiceDiscount(discCreated.invoice.id, '10%');
    assert.equal(afterPercent.discountAmount, 100000);
    assert.equal(afterPercent.finalTotal, 900000);
    assert.equal(Number(afterPercent.supplier.debtUzs), 900000);

    const afterOverride = await SupplierService.overrideInvoiceTotal(discCreated.invoice.id, 880000);
    assert.equal(afterOverride.finalTotal, 880000);
    assert.equal(Number(afterOverride.supplier.debtUzs), 880000);
    console.log('✅ Test 2 (Discount Auto & Manual Override): PASS');

    // =========================================================================
    // TEST 3: USD / USDT & Cents Accounting
    // =========================================================================
    assert.deepEqual(parseCurrencyAndAmount('102 dollaru 17 sent'), { amount: 102.17, currency: 'USD' });
    assert.deepEqual(parseCurrencyAndAmount('102.17$'), { amount: 102.17, currency: 'USD' });
    assert.deepEqual(parseCurrencyAndAmount('102,17 USDT'), { amount: 102.17, currency: 'USD' });

    const uzsInv = await SupplierService.createInvoiceWithItems({
      supplierName: 'E2E_MultiCurr_Supplier',
      invoiceNo: 'INV-UZS-500K',
      rawTotal: 500000,
      currency: 'UZS',
      items: [{ rawName: 'Un 50kg', quantity: 2, unit: 'qop', unitPrice: 250000, lineTotal: 500000, currency: 'UZS' }],
    });
    const usdInv = await SupplierService.createInvoiceWithItems({
      supplierId: uzsInv.supplier.id,
      supplierName: 'E2E_MultiCurr_Supplier',
      invoiceNo: 'INV-USD-102',
      rawTotal: 102.17,
      currency: 'USD',
      items: [{ rawName: 'Kofe Jacobs', quantity: 1, unit: 'korobka', unitPrice: 102.17, lineTotal: 102.17, currency: 'USD' }],
    });
    assert.equal(Number(usdInv.supplier.debtUzs), 500000);
    assert.equal(Number(usdInv.supplier.debtUsd), 102.17);

    const debtLine = formatSupplierDebtLine(usdInv.supplier.name, usdInv.supplier.debtUzs, usdInv.supplier.debtUsd);
    assert.ok(debtLine.includes("500,000 so'm"));
    assert.ok(debtLine.includes('$102.17'));

    const totalBlock = formatTotalDebtBlock(usdInv.supplier.debtUzs, usdInv.supplier.debtUsd);
    assert.ok(totalBlock.includes("📊 JAMI QARZ (UZS): 500,000 so'm"));
    assert.ok(totalBlock.includes('💵 JAMI QARZ (USD/USDT): $102.17'));
    console.log('✅ Test 3 (USD / USDT & Cents Accounting): PASS');

    // =========================================================================
    // TEST 4: Verbatim OCR Format
    // =========================================================================
    const mockRawOcr = {
      supplier: 'Osiyo Savdo',
      invoiceNo: 'NK-7788',
      currency: 'UZS',
      rawTotal: 1190000,
      discount: 40000,
      verbatimText: [
        '| № | Mahsulot nomi | Soni | Narxi | Summasi |',
        '|---|---|---|---|---|',
        "| 1 | Marvari shokolad | 10 korobka | 45,000 so'm | 450,000 so'm |",
        "| 2 | Alpen Gold 90g | 20 dona | 12,000 so'm | 240,000 so'm |",
        "| 3 | Snickers Super | 50 dona | 10,000 so'm | 500,000 so'm |",
      ].join('\n'),
    };
    const normalized = normalizeVerbatimInvoice(mockRawOcr);
    assert.equal(normalized.items.length, 3);
    assert.equal(normalized.items[0].rawName, 'Marvari shokolad');
    assert.equal(normalized.items[0].quantity, 10);
    assert.equal(normalized.items[0].unitPrice, 45000);
    assert.equal(normalized.items[0].lineTotal, 450000);
    assert.ok(normalized.verbatimText.includes('Marvari shokolad'));
    assert.ok(normalized.verbatimText.includes('Alpen Gold 90g'));
    assert.ok(normalized.verbatimText.includes('Snickers Super'));
    console.log('✅ Test 4 (Verbatim OCR Format): PASS');

    // =========================================================================
    // TEST 5: Product Search & Price Diff
    // =========================================================================
    const t1 = new Date('2026-11-10T10:00:00Z');
    const t2 = new Date('2026-11-14T09:30:00Z');
    const b1 = await SupplierService.createInvoiceWithItems({
      supplierName: 'E2E_Marvari_Supplier',
      rawTotal: 440000,
      currency: 'UZS',
      createdAt: t1,
      items: [{ rawName: 'Marvari shokolad', quantity: 10, unit: 'korobka', unitPrice: 44000, lineTotal: 440000, currency: 'UZS' }],
    });
    await SupplierService.createInvoiceWithItems({
      supplierId: b1.supplier.id,
      supplierName: 'E2E_Marvari_Supplier',
      rawTotal: 450000,
      currency: 'UZS',
      createdAt: t2,
      items: [{ rawName: 'Marvari shokolad', quantity: 10, unit: 'korobka', unitPrice: 45000, lineTotal: 450000, currency: 'UZS' }],
    });
    await SupplierService.createInvoiceWithItems({
      supplierId: b1.supplier.id,
      supplierName: 'E2E_Marvari_Supplier',
      rawTotal: 100,
      currency: 'USD',
      createdAt: t1,
      items: [{ rawName: 'Marvari shokolad', quantity: 10, unit: 'korobka', unitPrice: 10.0, lineTotal: 100.0, currency: 'USD' }],
    });
    await SupplierService.createInvoiceWithItems({
      supplierId: b1.supplier.id,
      supplierName: 'E2E_Marvari_Supplier',
      rawTotal: 115,
      currency: 'USD',
      createdAt: t2,
      items: [{ rawName: 'Marvari shokolad', quantity: 10, unit: 'korobka', unitPrice: 11.5, lineTotal: 115.0, currency: 'USD' }],
    });

    const searchRes = await SearchService.multiSearch('marvari');
    const uzsItem = searchRes.items.find((i) => i.currency === 'UZS' && i.productName === 'Marvari shokolad');
    const usdItem = searchRes.items.find((i) => i.currency === 'USD' && i.productName === 'Marvari shokolad');
    assert.ok(uzsItem && uzsItem.formattedCard.includes("+1,000 so'm QIMMATLADI 🔴"));
    assert.ok(usdItem && usdItem.formattedCard.includes('+$1.50 QIMMATLADI 🔴'));
    console.log('✅ Test 5 (Product Search & Price Diff): PASS');

    // =========================================================================
    // TEST 6: Sharp Speed Pipeline (<200KB & <150ms)
    // =========================================================================
    const rawPixels = Buffer.alloc(800 * 600 * 3, 240);
    const rawImg = await sharp(rawPixels, { raw: { width: 800, height: 600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    await ImageService.optimizeForFastOCR(rawImg);

    const start = performance.now();
    const compressed = await ImageService.optimizeForFastOCR(rawImg);
    const elapsedMs = performance.now() - start;
    const sizeKB = compressed.byteLength / 1024;
    assert.ok(sizeKB < 200, `Expected <200KB, got ${sizeKB.toFixed(2)}KB`);
    assert.ok(elapsedMs < 150, `Expected <150ms, got ${elapsedMs.toFixed(2)}ms`);
    console.log(`✅ Test 6 (Sharp Speed Pipeline): PASS (${sizeKB.toFixed(1)} KB in ${elapsedMs.toFixed(2)} ms)`);

    console.log('\n🎉 ALL 6 E2E TESTS PASSED 100%! ✅');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

runVerification().catch((err) => {
  console.error('❌ E2E Verification failed:', err);
  process.exit(1);
});

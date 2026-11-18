import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

let sampleRawInvoiceImage: Buffer;

async function cleanupTestData() {
  // Delete suppliers first so cascade removes linked InvoiceItem before deleting Product
  await prisma.supplier.deleteMany({
    where: { name: { in: TEST_SUPPLIER_NAMES } },
  });
  await prisma.invoiceItem.deleteMany({
    where: { product: { name: { contains: 'Marvari shokolad', mode: 'insensitive' } } },
  });
  await prisma.product.deleteMany({
    where: { name: { contains: 'Marvari shokolad', mode: 'insensitive' } },
  });
}

describe('MODUL 7: Full E2E Verification Suite (Tests 1 - 6)', () => {
  beforeAll(async () => {
    await cleanupTestData();

    const width = 800;
    const height = 600;
    const rawPixels = Buffer.alloc(width * height * 3, 245);
    for (let y = 60; y < 540; y += 40) {
      for (let x = 40; x < 760; x++) {
        const idx = (y * width + x) * 3;
        rawPixels[idx] = 25;
        rawPixels[idx + 1] = 25;
        rawPixels[idx + 2] = 25;
      }
    }
    sampleRawInvoiceImage = await sharp(rawPixels, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 92 })
      .toBuffer();

    await ImageService.optimizeForFastOCR(sampleRawInvoiceImage);
  }, 60000);

  afterAll(async () => {
    await cleanupTestData();
  }, 60000);

  it(
    'Test 1 (Supplier Rename & Merge): renames "Milter Mayanez" to "Milter" without breaking invoice links, and merges duplicates in $transaction',
    async () => {
      // 1. Create "Milter Mayanez" with an invoice
      const created = await SupplierService.createInvoiceWithItems({
        supplierName: 'Milter Mayanez',
        invoiceNo: 'INV-MM-01',
        rawTotal: 600000,
        discountInput: 0,
        currency: 'UZS',
        items: [{ rawName: 'Mayanez 500g', quantity: 20, unit: 'dona', unitPrice: 30000, lineTotal: 600000 }],
      });

      expect(created.supplier.name).toBe('Milter Mayanez');
      expect(Number(created.supplier.debtUzs)).toBe(600000);

      // 2. Rename "Milter Mayanez" -> "Milter" when "Milter" does not exist yet
      const renameRes = await SupplierService.checkOrRenameSupplier(created.supplier.id, 'Milter');
      expect(renameRes.status).toBe('RENAMED');
      if (renameRes.status === 'RENAMED') {
        expect(renameRes.supplier.id).toBe(created.supplier.id);
        expect(renameRes.supplier.name).toBe('Milter');
      }

      // Verify invoice link (supplierId FK) is 100% preserved
      const linkedInvoices = await prisma.invoice.findMany({ where: { supplierId: created.supplier.id } });
      expect(linkedInvoices.length).toBe(1);
      expect(linkedInvoices[0].id).toBe(created.invoice.id);
      expect(Number(linkedInvoices[0].totalAmount)).toBe(600000);

      // 3. Test Fuzzy Merge when another supplier ("Milter Mayanez") is renamed to existing "Milter"
      const secondCreated = await SupplierService.createInvoiceWithItems({
        supplierName: 'Milter Mayanez',
        invoiceNo: 'INV-MM-02',
        rawTotal: 150.25,
        discountInput: 0,
        currency: 'USD',
        items: [
          {
            rawName: 'Import Sous',
            quantity: 5,
            unit: 'korobka',
            unitPrice: 30.05,
            lineTotal: 150.25,
            currency: 'USD',
          },
        ],
      });

      const conflictCheck = await SupplierService.checkOrRenameSupplier(secondCreated.supplier.id, 'Milter');
      expect(conflictCheck.status).toBe('MERGE_REQUIRED');

      const mergedSupplier = await SupplierService.mergeSuppliers(
        secondCreated.supplier.id,
        created.supplier.id
      );
      expect(mergedSupplier.name).toBe('Milter');
      expect(Number(mergedSupplier.debtUzs)).toBe(600000);
      expect(Number(mergedSupplier.debtUsd)).toBe(150.25);

      const allMilterInvoices = await prisma.invoice.findMany({ where: { supplierId: mergedSupplier.id } });
      expect(allMilterInvoices.length).toBe(2);
    },
    60000
  );

  it(
    'Test 2 (Discount Auto & Manual Override): applies 50,000 UZS, 10% discount, and 880,000 UZS manual override with synchronous supplier balance updates',
    async () => {
      // 1. Create a 1,000,000 so'm invoice with 50,000 so'm discount -> 950,000 so'm
      const created = await SupplierService.createInvoiceWithItems({
        supplierName: 'E2E_Discount_Supplier',
        invoiceNo: 'INV-DISC-01',
        rawTotal: 1000000,
        discountInput: 50000,
        currency: 'UZS',
        items: [
          { rawName: "Kungaboqar yog'i 5L", quantity: 10, unit: 'dona', unitPrice: 100000, lineTotal: 1000000 },
        ],
      });

      expect(Number(created.invoice.originalAmount)).toBe(1000000);
      expect(Number(created.invoice.discountAmount)).toBe(50000);
      expect(Number(created.invoice.totalAmount)).toBe(950000);
      expect(Number(created.supplier.debtUzs)).toBe(950000);

      // 2. Apply 10% discount -> discountAmount = 100,000, finalTotal = 900,000, supplier debtUzs = 900,000
      const afterPercent = await SupplierService.updateInvoiceDiscount(created.invoice.id, '10%');
      expect(afterPercent.discountAmount).toBe(100000);
      expect(afterPercent.finalTotal).toBe(900000);
      expect(Number(afterPercent.supplier.debtUzs)).toBe(900000);

      // 3. Apply Manual Override to 880,000 so'm -> finalTotal = 880,000, supplier debtUzs = 880,000
      const afterOverride = await SupplierService.overrideInvoiceTotal(created.invoice.id, 880000);
      expect(afterOverride.finalTotal).toBe(880000);
      expect(afterOverride.discountAmount).toBe(120000);
      expect(Number(afterOverride.supplier.debtUzs)).toBe(880000);

      // Also verify deterministic math helper directly
      const mathCheck = calculateDiscountedTotal(1000000, '5%');
      expect(mathCheck.discountAmount).toBe(50000);
      expect(mathCheck.finalTotal).toBe(950000);
    },
    60000
  );

  it(
    "Test 3 (USD / USDT & Cents Accounting): parses USD/USDT/cents accurately and displays UZS (500,000 so'm) and USD ($102.17) separately without losing cents",
    async () => {
      // 1. Verify parser on required inputs
      const p1 = parseCurrencyAndAmount('102 dollaru 17 sent');
      expect(p1).toEqual({ amount: 102.17, currency: 'USD' });

      const p2 = parseCurrencyAndAmount('102.17$');
      expect(p2).toEqual({ amount: 102.17, currency: 'USD' });

      const p3 = parseCurrencyAndAmount('102,17 USDT');
      expect(p3).toEqual({ amount: 102.17, currency: 'USD' });

      const p4 = parseCurrencyAndAmount('102 dollar 17 sent');
      expect(p4).toEqual({ amount: 102.17, currency: 'USD' });

      // 2. Record both UZS (500,000 so'm) and USD ($102.17) invoices for the same supplier
      const uzsInv = await SupplierService.createInvoiceWithItems({
        supplierName: 'E2E_MultiCurr_Supplier',
        invoiceNo: 'INV-UZS-500K',
        rawTotal: 500000,
        discountInput: 0,
        currency: 'UZS',
        items: [
          { rawName: 'Un 50kg', quantity: 2, unit: 'qop', unitPrice: 250000, lineTotal: 500000, currency: 'UZS' },
        ],
      });

      const usdInv = await SupplierService.createInvoiceWithItems({
        supplierId: uzsInv.supplier.id,
        supplierName: 'E2E_MultiCurr_Supplier',
        invoiceNo: 'INV-USD-102',
        rawTotal: 102.17,
        discountInput: 0,
        currency: 'USD',
        items: [
          {
            rawName: 'Kofe Jacobs',
            quantity: 1,
            unit: 'korobka',
            unitPrice: 102.17,
            lineTotal: 102.17,
            currency: 'USD',
          },
        ],
      });

      expect(Number(usdInv.supplier.debtUzs)).toBe(500000);
      expect(Number(usdInv.supplier.debtUsd)).toBe(102.17);

      // 3. Verify Debtors list line & Total Debt summary show UZS and USD separately with exact cents
      const line = formatSupplierDebtLine(
        usdInv.supplier.name,
        usdInv.supplier.debtUzs,
        usdInv.supplier.debtUsd
      );
      expect(line).toContain("500,000 so'm");
      expect(line).toContain('$102.17');

      const totalBlock = formatTotalDebtBlock(usdInv.supplier.debtUzs, usdInv.supplier.debtUsd);
      expect(totalBlock).toContain("📊 JAMI QARZ (UZS): 500,000 so'm");
      expect(totalBlock).toContain('💵 JAMI QARZ (USD/USDT): $102.17');

      const fullReport = await SupplierService.getFormattedDebtorsReport(1, 50);
      expect(fullReport.text).toContain("500,000 so'm");
      expect(fullReport.text).toContain('$102.17');
      expect(fullReport.text).toContain('📊 JAMI QARZ (UZS):');
      expect(fullReport.text).toContain('💵 JAMI QARZ (USD/USDT):');
    },
    60000
  );

  it('Test 4 (Verbatim OCR Format): preserves 100% of rows with product name, quantity/unit, unit price, and line total', () => {
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
    expect(normalized.items).toHaveLength(3);
    expect(normalized.rawTotal).toBe(1190000);
    expect(normalized.discountAmount).toBe(40000);
    expect(normalized.finalTotal).toBe(1150000);

    expect(normalized.items[0]).toMatchObject({
      rawName: 'Marvari shokolad',
      quantity: 10,
      unit: 'korobka',
      unitPrice: 45000,
      lineTotal: 450000,
    });
    expect(normalized.items[1]).toMatchObject({
      rawName: 'Alpen Gold 90g',
      quantity: 20,
      unit: 'dona',
      unitPrice: 12000,
      lineTotal: 240000,
    });
    expect(normalized.items[2]).toMatchObject({
      rawName: 'Snickers Super',
      quantity: 50,
      unit: 'dona',
      unitPrice: 10000,
      lineTotal: 500000,
    });

    expect(normalized.verbatimText).toContain('Marvari shokolad');
    expect(normalized.verbatimText).toContain('10 korobka');
    expect(normalized.verbatimText).toContain("45,000 so'm");
    expect(normalized.verbatimText).toContain("450,000 so'm");
    expect(normalized.verbatimText).toContain('Alpen Gold 90g');
    expect(normalized.verbatimText).toContain('Snickers Super');
    expect(normalized.verbatimText).toContain("500,000 so'm");
  });

  it(
    'Test 5 (Product Search & Price Diff): returns product first on "marvari" search and accurately calculates +1,000 so\'m QIMMATLADI 🔴 and +$1.50 QIMMATLADI 🔴',
    async () => {
      const t1 = new Date('2026-11-10T10:00:00Z');
      const t2 = new Date('2026-11-14T09:30:00Z');

      const batch1Uzs = await SupplierService.createInvoiceWithItems({
        supplierName: 'E2E_Marvari_Supplier',
        invoiceNo: 'MV-UZS-1',
        rawTotal: 440000,
        currency: 'UZS',
        createdAt: t1,
        items: [
          {
            rawName: 'Marvari shokolad',
            quantity: 10,
            unit: 'korobka',
            unitPrice: 44000,
            lineTotal: 440000,
            currency: 'UZS',
          },
        ],
      });

      await SupplierService.createInvoiceWithItems({
        supplierId: batch1Uzs.supplier.id,
        supplierName: 'E2E_Marvari_Supplier',
        invoiceNo: 'MV-UZS-2',
        rawTotal: 450000,
        currency: 'UZS',
        createdAt: t2,
        items: [
          {
            rawName: 'Marvari shokolad',
            quantity: 10,
            unit: 'korobka',
            unitPrice: 45000,
            lineTotal: 450000,
            currency: 'UZS',
          },
        ],
      });

      await SupplierService.createInvoiceWithItems({
        supplierId: batch1Uzs.supplier.id,
        supplierName: 'E2E_Marvari_Supplier',
        invoiceNo: 'MV-USD-1',
        rawTotal: 100,
        currency: 'USD',
        createdAt: t1,
        items: [
          {
            rawName: 'Marvari shokolad',
            quantity: 10,
            unit: 'korobka',
            unitPrice: 10.0,
            lineTotal: 100.0,
            currency: 'USD',
          },
        ],
      });

      await SupplierService.createInvoiceWithItems({
        supplierId: batch1Uzs.supplier.id,
        supplierName: 'E2E_Marvari_Supplier',
        invoiceNo: 'MV-USD-2',
        rawTotal: 115,
        currency: 'USD',
        createdAt: t2,
        items: [
          {
            rawName: 'Marvari shokolad',
            quantity: 10,
            unit: 'korobka',
            unitPrice: 11.5,
            lineTotal: 115.0,
            currency: 'USD',
          },
        ],
      });

      const searchRes = await SearchService.multiSearch('marvari');
      expect(searchRes.items.length).toBeGreaterThanOrEqual(2);

      const uzsItem = searchRes.items.find((i) => i.currency === 'UZS' && i.productName === 'Marvari shokolad');
      const usdItem = searchRes.items.find((i) => i.currency === 'USD' && i.productName === 'Marvari shokolad');

      expect(uzsItem).toBeDefined();
      expect(uzsItem!.unitPrice).toBe(45000);
      expect(uzsItem!.previousPrice).toBe(44000);
      expect(uzsItem!.priceDiff).toBe(1000);
      expect(uzsItem!.formattedCard).toContain('📦 Mahsulot: Marvari shokolad');
      expect(uzsItem!.formattedCard).toContain("+1,000 so'm QIMMATLADI 🔴");

      expect(usdItem).toBeDefined();
      expect(usdItem!.unitPrice).toBe(11.5);
      expect(usdItem!.previousPrice).toBe(10.0);
      expect(usdItem!.priceDiff).toBe(1.5);
      expect(usdItem!.formattedCard).toContain('📦 Mahsulot: Marvari shokolad');
      expect(usdItem!.formattedCard).toContain('+$1.50 QIMMATLADI 🔴');
    },
    120000
  );

  it(
    'Test 6 (Sharp Speed Pipeline): compresses invoice image to <200KB in <150ms in-memory',
    async () => {
      const startTime = performance.now();
      const optimizedBuffer = await ImageService.optimizeForFastOCR(sampleRawInvoiceImage);
      const elapsedMs = performance.now() - startTime;

      const sizeKB = optimizedBuffer.byteLength / 1024;
      expect(sizeKB).toBeGreaterThan(0);
      expect(sizeKB).toBeLessThan(200);
      expect(elapsedMs).toBeLessThan(150);
    },
    30000
  );
});

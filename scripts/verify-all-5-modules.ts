import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prisma } from '../src/database/prisma';
import { ImageService } from '../src/services/image.service';
import {
  buildVerbatimTableText,
  normalizeVerbatimInvoice,
  parseCompactScannerRows,
} from '../src/services/ai.service';
import { reconcileInvoiceTotals, getTashkentDayRange } from '../src/utils/formatters';
import { SupplierService } from '../src/services/supplier.service';
import { ReportService } from '../src/services/report.service';
import { buildEditableInvoiceText, buildPendingPreviewMessage } from '../src/bot/handlers/invoice';

async function createSynthetic2MbPhotoBuffer(): Promise<Buffer> {
  // Generate a realistic receipt-like RGB image (white paper with horizontal dark text bands)
  const width = 1200;
  const height = 1600;
  const channels = 3;
  const rawPixels = Buffer.alloc(width * height * channels, 242);
  for (let y = 40; y < height - 40; y += 28) {
    for (let x = 60; x < width - 60; x++) {
      if ((x % 17) < 11) {
        const idx = (y * width + x) * channels;
        rawPixels[idx] = 25;
        rawPixels[idx + 1] = 25;
        rawPixels[idx + 2] = 25;
      }
    }
  }
  const baseJpeg = await sharp(rawPixels, { raw: { width, height, channels } })
    .jpeg({ quality: 95 })
    .toBuffer();

  // Warm up Sharp pipeline once so libvips threadpool is initialized
  await ImageService.optimizeForFastOCR(baseJpeg);
  return Buffer.from(baseJpeg);
}

async function main() {
  console.log('====================================================================');
  console.log('🚀 SMARTBAQQOL AI CORE — 5-MODULE E2E VERIFICATION SUITE');
  console.log('====================================================================\n');

  const cleanupSupplierIds: string[] = [];
  const cleanupInvoiceIds: string[] = [];
  const cleanupProductIds: string[] = [];

  try {
    // ====================================================================
    // TEST 1: Scanner Speed (<150ms, <60KB) & Compact Rows Parser (<0.005s)
    // ====================================================================
    console.log('▶ TEST 1: <= 5s Real Skaner Apparati (Sharp <150ms & <60KB + Compact Rows <5ms)...');
    const freshInputBuffer = Buffer.from(await createSynthetic2MbPhotoBuffer());
    const t0 = performance.now();
    const scannedBuffer = await ImageService.optimizeForFastOCR(freshInputBuffer);
    const elapsedMs = performance.now() - t0;
    const sizeKb = scannedBuffer.byteLength / 1024;

    assert.ok(elapsedMs < 150, `Expected Sharp scanner optimization < 150ms, got ${elapsedMs.toFixed(2)}ms`);
    assert.ok(sizeKb < 60, `Expected scanned buffer < 60KB, got ${sizeKb.toFixed(2)}KB`);

    const compactRows = [
      '1|Marvari shokolad|10 kor|45000|450000',
      '2|Milter Mayonez 500g|20 dona|15000|300000',
      '3|Kungaboqar yog 5L|25 dona|50000|1250000',
    ];
    // Warm up V8 JIT once
    buildVerbatimTableText(parseCompactScannerRows(['1|Warmup|1 dona|1000|1000'], 'UZS'), 'UZS');

    const p0 = performance.now();
    const parsedItems = parseCompactScannerRows(compactRows, 'UZS');
    const verbatimTable = buildVerbatimTableText(parsedItems, 'UZS');
    const parseElapsedMs = performance.now() - p0;

    assert.equal(parsedItems.length, 3);
    assert.equal(parsedItems[0].rawName, 'Marvari shokolad');
    assert.equal(parsedItems[0].lineTotal, 450000);
    assert.ok(verbatimTable.includes('Marvari shokolad'));
    assert.ok(parseElapsedMs < 5, `Expected compact rows parser < 5ms (0.005s), got ${parseElapsedMs.toFixed(3)}ms`);
    console.log(
      `  ✅ TEST 1 PASS (Sharp: ${elapsedMs.toFixed(1)}ms, Size: ${sizeKb.toFixed(1)}KB, Rows Parser: ${parseElapsedMs.toFixed(3)}ms)\n`
    );

    // ====================================================================
    // TEST 2: Double-Discount Guard (`reconcileInvoiceTotals`)
    // ====================================================================
    console.log('▶ TEST 2: Double-Discount Guard (reconcileInvoiceTotals)...');
    const reconciled = reconcileInvoiceTotals({
      itemsSum: 2000000,
      subtotalBeforeDiscount: 2000000,
      discountPercent: 5,
      discountAmount: 100000,
      printedFinalTotal: 1900000,
    });

    assert.equal(reconciled.rawTotal, 2000000, 'rawTotal must be 2,000,000');
    assert.equal(reconciled.discountAmount, 100000, 'discountAmount must be 100,000');
    assert.equal(reconciled.finalTotal, 1900000, 'finalTotal must be 1,900,000 (NOT 1,805,000!)');
    assert.equal(reconciled.alreadyDeductedOnPaper, true);

    const normalizedInv = normalizeVerbatimInvoice({
      supplierName: 'Milter',
      invoiceNumber: '145',
      currency: 'UZS',
      rows: compactRows,
      subtotalBeforeDiscount: 2000000,
      discountPercent: 5,
      discountAmount: 100000,
      printedFinalTotal: 1900000,
    });
    assert.equal(normalizedInv.rawTotal, 2000000);
    assert.equal(normalizedInv.discountAmount, 100000);
    assert.equal(normalizedInv.finalTotal, 1900000);

    const { editableText } = buildEditableInvoiceText(normalizedInv);
    const previewMsg = buildPendingPreviewMessage(normalizedInv, editableText);
    assert.ok(previewMsg.includes("📦 Tovarlarning asl summasi: **2,000,000 so'm**"));
    assert.ok(previewMsg.includes("🏷 Skidka (5%): **-100,000 so'm**"));
    assert.ok(previewMsg.includes("💰 Skidkadan keyingi yakuniy summa (Itogo): **1,900,000 so'm**"));
    console.log(
      `  ✅ TEST 2 PASS (rawTotal: ${reconciled.rawTotal}, discountAmount: ${reconciled.discountAmount}, finalTotal: ${reconciled.finalTotal})\n`
    );

    // ====================================================================
    // TEST 3: Anti-Duplicate Invoice Guard (imageHash & contentFingerprint)
    // ====================================================================
    console.log('▶ TEST 3: Anti-Duplicate Invoice Guard (Stage 1 imageHash & Stage 2 contentFingerprint)...');
    const uniqueSuffix = Date.now().toString();
    const dupSupplierName = `E2E_Dup_Milter_${uniqueSuffix}`;
    const testImageHash = SupplierService.computeImageHash(Buffer.from(`dup-image-${uniqueSuffix}`));

    // 1st save -> should succeed and add 1,900,000 to debt
    const firstSave = await SupplierService.createInvoiceWithItems({
      supplierName: dupSupplierName,
      invoiceNo: 'DUP-145',
      rawTotal: 2000000,
      discountInput: '5%',
      printedFinalTotal: 1900000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: testImageHash,
      items: parsedItems,
    });
    assert.equal(firstSave.isDuplicate, false);
    cleanupSupplierIds.push(firstSave.supplier.id);
    cleanupInvoiceIds.push(firstSave.invoice.id);
    assert.equal(Number(firstSave.supplier.debtUzs), 1900000);

    // 2nd save with same imageHash -> MUST be blocked!
    const secondSaveByHash = await SupplierService.createInvoiceWithItems({
      supplierName: dupSupplierName,
      invoiceNo: 'DUP-145',
      rawTotal: 2000000,
      discountInput: '5%',
      printedFinalTotal: 1900000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: testImageHash,
      items: parsedItems,
    });
    assert.equal(secondSaveByHash.isDuplicate, true, 'Duplicate imageHash must be blocked');
    assert.equal(secondSaveByHash.duplicateStage, 'IMAGE_HASH');
    assert.ok(
      secondSaveByHash.warningText?.includes(
        '⛔️ DIQQAT! Bu nakladnoy oldin kiritilgan, ikkinchi marta kiritish mumkin emas!'
      )
    );

    // 3rd save with a DIFFERENT imageHash (re-photographed) but SAME contentFingerprint -> MUST be blocked!
    const differentImageHash = SupplierService.computeImageHash(Buffer.from(`rephoto-${uniqueSuffix}`));
    const thirdSaveByFingerprint = await SupplierService.createInvoiceWithItems({
      supplierName: dupSupplierName,
      invoiceNo: 'DUP-145-REPHOTO',
      rawTotal: 2000000,
      discountInput: '5%',
      printedFinalTotal: 1900000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: differentImageHash,
      items: parsedItems,
    });
    assert.equal(thirdSaveByFingerprint.isDuplicate, true, 'Duplicate contentFingerprint must be blocked');
    assert.equal(thirdSaveByFingerprint.duplicateStage, 'CONTENT_FINGERPRINT');

    // Verify supplier debt was NOT incremented a second or third time
    const checkSupAfterDup = await prisma.supplier.findUnique({ where: { id: firstSave.supplier.id } });
    assert.equal(Number(checkSupAfterDup?.debtUzs), 1900000, 'Supplier debt must remain 1,900,000');
    console.log('  ✅ TEST 3 PASS (Both Stage 1 imageHash and Stage 2 contentFingerprint blocked duplicates)\n');

    // ====================================================================
    // TEST 4: 100% Cash vs. Credit Ratio & Trend Analysis (Weekly / Monthly)
    // ====================================================================
    console.log('▶ TEST 4: 100% Cash vs. Credit Ratio (40% Cash / 60% Credit + Progress Bar + Trend)...');
    const analytics = ReportService.calculateCashVsCreditAnalytics({
      cashTotal: 8000000,
      creditTotal: 12000000,
    });

    assert.equal(analytics.grandTotal, 20000000);
    assert.equal(analytics.cashPercent, 40);
    assert.equal(analytics.creditPercent, 60);
    assert.equal(analytics.cashPercent + analytics.creditPercent, 100);
    assert.equal(analytics.progressBar, '[🟩🟩🟩🟩🟧🟧🟧🟧🟧🟧]');
    assert.equal(analytics.diffAmount, 4000000);
    assert.equal(analytics.diffPercent, 20);
    assert.ok(analytics.formattedBlock.includes('📦 Jami olingan yuklar (100%): 20,000,000 so\'m'));
    assert.ok(analytics.formattedBlock.includes('├── 💵 Naqdga olingan: 8,000,000 so\'m (40%)'));
    assert.ok(analytics.formattedBlock.includes('└── 📝 Nasiyaga (qarzga) olingan: 12,000,000 so\'m (60%)'));
    assert.ok(analytics.formattedBlock.includes('[🟩🟩🟩🟩🟧🟧🟧🟧🟧🟧] (40% Naqd / 60% Nasiya)'));
    assert.ok(
      analytics.formattedBlock.includes(
        "🧭 YO'NALISH VA TAFOVUT: Nasiya xaridlar naqd xaridlardan 4,000,000 so'mga (20% ga) ko'p. Do'kon aylanmasida nasiya ulushi ustunlik qilmoqda."
      )
    );
    console.log('  ✅ TEST 4 PASS (40% Naqd + 60% Nasiya = 100%, [🟩🟩🟩🟩🟧🟧🟧🟧🟧🟧], diff: 4,000,000 / 20%)\n');

    // ====================================================================
    // TEST 5: Z-Report 5-Part Total Daily Sales Calculation
    // ====================================================================
    console.log('▶ TEST 5: 5-Column Daily Z-Otchyot Auto-Aggregation (13,000,000 so\'m)...');
    // Use a dedicated isolated test date (e.g., 2026-11-14 12:00 Tashkent time or isolated date if running live)
    // Wait: let's test with a dedicated date `testNow` so any existing today records don't collide, OR check today's baseline!
    const testNow = new Date('2026-11-14T14:00:00+05:00');
    const { startOfDay, endOfDay, dateKey } = getTashkentDayRange(testNow);

    // Clean any previous test records on `testNow`
    await prisma.zReport.deleteMany({ where: { date: dateKey } });

    // Create 2 Cash Invoices totaling 1,500,000 so'm (800,000 + 700,000) on `testNow`
    const zSupName = `E2E_ZReport_Sup_${uniqueSuffix}`;
    const cashInv1 = await SupplierService.createInvoiceWithItems({
      supplierName: zSupName,
      invoiceNo: `Z-CASH-1-${uniqueSuffix}`,
      rawTotal: 800000,
      currency: 'UZS',
      paymentType: 'CASH',
      paidCashAmount: 800000,
      creditAmount: 0,
      createdAt: new Date(startOfDay.getTime() + 3600_000),
      forceOverrideDuplicate: true,
    });
    cleanupSupplierIds.push(cashInv1.supplier.id);
    cleanupInvoiceIds.push(cashInv1.invoice.id);

    const cashInv2 = await SupplierService.createInvoiceWithItems({
      supplierId: cashInv1.supplier.id,
      supplierName: zSupName,
      invoiceNo: `Z-CASH-2-${uniqueSuffix}`,
      rawTotal: 700000,
      currency: 'UZS',
      paymentType: 'CASH',
      paidCashAmount: 700000,
      creditAmount: 0,
      createdAt: new Date(startOfDay.getTime() + 7200_000),
      forceOverrideDuplicate: true,
    });
    cleanupInvoiceIds.push(cashInv2.invoice.id);

    // Verify CASH invoices did NOT increase supplier debt
    const supAfterCash = await prisma.supplier.findUnique({ where: { id: cashInv1.supplier.id } });
    assert.equal(Number(supAfterCash?.debtUzs), 0, 'CASH invoices must NOT increase supplier debt');

    // Create 3 Supplier Payments totaling 2,000,000 so'm (1,000,000 + 500,000 + 500,000) on `testNow`
    const pay1 = await SupplierService.recordSupplierPayment({
      supplierId: cashInv1.supplier.id,
      supplierName: zSupName,
      amount: 1000000,
      currency: 'UZS',
      comment: 'Z-Report E2E Payment 1',
      createdAt: new Date(startOfDay.getTime() + 10800_000),
    });
    const pay2 = await SupplierService.recordSupplierPayment({
      supplierId: cashInv1.supplier.id,
      supplierName: zSupName,
      amount: 500000,
      currency: 'UZS',
      comment: 'Z-Report E2E Payment 2',
      createdAt: new Date(startOfDay.getTime() + 14400_000),
    });
    const pay3 = await SupplierService.recordSupplierPayment({
      supplierId: cashInv1.supplier.id,
      supplierName: zSupName,
      amount: 500000,
      currency: 'UZS',
      comment: 'Z-Report E2E Payment 3',
      createdAt: new Date(startOfDay.getTime() + 18000_000),
    });

    // Account for any pre-existing non-test invoices/payments on that date (if any)
    const [allDayCashInvs, allDayPayments] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          currency: 'UZS',
          paidCashAmount: { gt: 0 },
          id: { notIn: [cashInv1.invoice.id, cashInv2.invoice.id] },
        },
        select: { paidCashAmount: true },
      }),
      prisma.supplierPayment.findMany({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          currency: 'UZS',
          id: { notIn: [pay1.payment.id, pay2.payment.id, pay3.payment.id] },
        },
        select: { amount: true },
      }),
    ]);
    const otherCashSum = allDayCashInvs.reduce((s, i) => s + Number(i.paidCashAmount || 0), 0);
    const otherPaySum = allDayPayments.reduce((s, p) => s + Number(p.amount || 0), 0);

    const zReport = await ReportService.generateAndSaveZReport({
      terminalAmount: 3500000,
      clickAmount: 2000000,
      cashRemainingInDrawer: 4000000,
      now: testNow,
    });

    assert.equal(zReport.dailyCashPurchasesUzs - otherCashSum, 1500000, 'Daily cash purchases must equal 1,500,000');
    assert.equal(
      zReport.dailySupplierPaymentsUzs - otherPaySum,
      2000000,
      'Daily supplier payments must equal 2,000,000'
    );
    assert.equal(
      zReport.totalDailySalesUzs - otherCashSum - otherPaySum,
      13000000,
      'Total daily sales (1+2+3+4+5) must equal 13,000,000'
    );
    assert.ok(zReport.formattedText.includes('🧾 KUNLIK Z-OTCHYOT (KASSA YOPILISHI)'));
    assert.ok(zReport.formattedText.includes("1️⃣ 💳 Terminal: 3,500,000 so'm"));
    assert.ok(zReport.formattedText.includes("2️⃣ 📱 Click / O'tkazma: 2,000,000 so'm"));
    assert.ok(zReport.formattedText.includes("3️⃣ 💵 Kassadagi qoldiq naqd pul: 4,000,000 so'm"));
    assert.ok(zReport.formattedText.includes('💰 BUGUNGI JAMI SAVDO (1+2+3+4+5):'));

    // Cleanup ZReport & DailyRegister for testNow
    await prisma.zReport.deleteMany({ where: { date: dateKey } });
    await prisma.dailyRegister.deleteMany({ where: { date: dateKey, totalDailySalesUzs: zReport.totalDailySalesUzs } });

    console.log(
      `  ✅ TEST 5 PASS (Terminal: 3.5M + Click: 2M + Cash: 4M + CashPurchases: 1.5M + SupplierPayments: 2M = 13,000,000 so'm)\n`
    );

    console.log('====================================================================');
    console.log('🎉 ALL 5 E2E TESTS PASSED (5/5 PASS ✅) — ZERO ERRORS!');
    console.log('====================================================================');
  } finally {
    // Clean up test suppliers, invoices, cash transactions, payments, and products
    if (cleanupInvoiceIds.length > 0) {
      const items = await prisma.invoiceItem.findMany({
        where: { invoiceId: { in: cleanupInvoiceIds } },
        select: { productId: true },
      });
      for (const it of items) {
        if (it.productId) cleanupProductIds.push(it.productId);
      }
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: cleanupInvoiceIds } } });
      await prisma.supplierTransaction.deleteMany({ where: { invoiceId: { in: cleanupInvoiceIds } } });
      await prisma.invoice.deleteMany({ where: { id: { in: cleanupInvoiceIds } } });
    }
    if (cleanupSupplierIds.length > 0) {
      const sups = await prisma.supplier.findMany({
        where: { id: { in: cleanupSupplierIds } },
        select: { name: true },
      });
      const supNames = sups.map((s) => s.name);
      if (supNames.length > 0) {
        await prisma.cashTransaction.deleteMany({ where: { partyName: { in: supNames } } });
      }
      await prisma.supplierPayment.deleteMany({ where: { supplierId: { in: cleanupSupplierIds } } });
      await prisma.supplierTransaction.deleteMany({ where: { supplierId: { in: cleanupSupplierIds } } });
      await prisma.supplier.deleteMany({ where: { id: { in: cleanupSupplierIds } } });
    }
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ E2E Verification Failed:', err);
  process.exit(1);
});


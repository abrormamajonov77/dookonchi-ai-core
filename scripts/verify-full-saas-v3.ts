import assert from 'node:assert';
import sharp from 'sharp';
import { prisma } from '../src/database/prisma';
import { SubscriptionService, parseSubscriptionDuration } from '../src/services/subscription.service';
import { SupplierService } from '../src/services/supplier.service';
import { ExportService } from '../src/services/export.service';
import { ImageService } from '../src/services/image.service';
import { ReportService } from '../src/services/report.service';
import { SearchService } from '../src/services/search.service';
import { parseCompactScannerRows, buildVerbatimTableText } from '../src/services/ai.service';
import { reconcileInvoiceTotals } from '../src/utils/formatters';

const TEST_OWNER_A = '900000001_TEST_USER_A';
const TEST_OWNER_B = '900000002_TEST_USER_B';
const TEST_OWNER_C = '900000003_TEST_USER_C';

async function cleanupTestOwners() {
  const testOwners = [TEST_OWNER_A, TEST_OWNER_B, TEST_OWNER_C];
  await Promise.all([
    prisma.invoiceItem.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.supplierTransaction.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.supplierPayment.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.invoice.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.product.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.supplier.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.cashTransaction.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.customerDebt.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.expense.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.dailyRegister.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.zReport.deleteMany({ where: { ownerId: { in: testOwners } } }),
    prisma.subscriptionPayment.deleteMany({ where: { userTelegramId: { in: testOwners } } }),
    prisma.user.deleteMany({ where: { telegramId: { in: testOwners } } }),
  ]);
}

async function runAllTests() {
  console.log('🚀 Starting E2E Verification Suite: scripts/verify-full-saas-v3.ts\n');
  await cleanupTestOwners();

  try {
    // ========================================================================
    // TEST 1: Multi-Tenant Isolation & Admin Approval SMS
    // ========================================================================
    console.log('🔹 Running TEST 1: Multi-Tenant Isolation & Admin Approval SMS...');
    const regA = await SubscriptionService.registerOrGetUser({
      telegramId: TEST_OWNER_A,
      fullName: 'User A Store',
      username: 'user_a_store',
    });
    await SubscriptionService.grantSubscription({
      telegramId: TEST_OWNER_A,
      baseDays: 365,
      bonusDays: 0,
      planName: '1 Yillik',
    });

    const regB = await SubscriptionService.registerOrGetUser({
      telegramId: TEST_OWNER_B,
      fullName: 'User B Newcomer',
      username: 'user_b_new',
    });

    assert.strictEqual(regB.user.status, 'PENDING', 'New User_B must initially be PENDING');
    assert.strictEqual(regB.user.role, 'STORE_OWNER', 'New User_B role must be STORE_OWNER (never SELLER)');

    // Create Supplier & Invoice for User_A
    await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_A,
      supplierName: 'Milter Exclusive A',
      rawTotal: 5_000_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      items: [{ rawName: 'Shokolad A', quantity: 10, unit: 'kor', unitPrice: 500_000, lineTotal: 5_000_000 }],
    });

    // Verify User_B sees 0 suppliers, 0 invoices, and 0 search results from User_A
    const reportB = await SupplierService.getFormattedDebtorsReport(1, 10, TEST_OWNER_B);
    const searchB = await SearchService.searchProductsWithPriceDiff('Shokolad', TEST_OWNER_B);
    const invoicesBCount = await prisma.invoice.count({ where: { ownerId: TEST_OWNER_B } });

    assert.strictEqual(reportB.suppliers.length, 0, 'User_B must see 0 suppliers of User_A');
    assert.strictEqual(reportB.totalUzs, 0, 'User_B total UZS debt must be 0');
    assert.strictEqual(searchB.length, 0, 'User_B product search must not leak User_A products');
    assert.strictEqual(invoicesBCount, 0, 'User_B invoice count must be 0');

    // Super-Admin approves User_B and verifies automatic Bot-SMS delivery
    let sentSmsTo = '';
    let sentSmsText = '';
    const approvalResult = await SubscriptionService.grantSubscription({
      telegramId: TEST_OWNER_B,
      baseDays: 30,
      bonusDays: 0,
      planName: '1 Oylik',
      sendSms: async (targetId, text) => {
        sentSmsTo = targetId;
        sentSmsText = text;
      },
    });

    assert.strictEqual(approvalResult.user.status, 'ACTIVE', 'User_B must become ACTIVE after admin approval');
    assert.strictEqual(sentSmsTo, TEST_OWNER_B, 'Bot-SMS must be sent to User_B telegramId');
    assert.ok(
      sentSmsText.includes('Tabriklaymiz! Admin tomonidan sizga botdan foydalanish uchun ruxsat berildi!'),
      'Bot-SMS must contain the congratulatory approval message'
    );
    void regA;
    console.log('✅ TEST 1 PASSED: Multi-Tenant Isolation & Admin Approval Bot-SMS verified!\n');

    // ========================================================================
    // TEST 2: Multi-Month Tariffs, Bonus Days & Payment Screenshot Flow
    // ========================================================================
    console.log('🔹 Running TEST 2: Multi-Month Tariffs, Bonus Days & Payment Screenshot Flow...');
    const fixedNow = new Date('2026-11-16T10:00:00.000Z');

    // 2A. 3 oy + 15 kun bonus (105 kun)
    const grant105 = await SubscriptionService.grantSubscription({
      telegramId: TEST_OWNER_C,
      baseDays: 90,
      bonusDays: 15,
      planName: '3 Oylik',
      now: fixedNow,
      extendFromExisting: false,
    });
    const expected105 = new Date(fixedNow.getTime() + 105 * 24 * 60 * 60 * 1000);
    assert.strictEqual(grant105.totalDays, 105, '3 oy + 15 kun bonus must equal 105 days');
    assert.strictEqual(grant105.user.bonusDaysGranted, 15, 'bonusDaysGranted must be 15');
    assert.strictEqual(
      grant105.expiresAt.getTime(),
      expected105.getTime(),
      'subscriptionExpiresAt must be exactly +105 days'
    );
    assert.ok(grant105.smsText.includes('BONUS!'), 'Bonus tariff SMS must highlight BONUS');

    // 2B. Custom "4 oy + 20 kun bonus" (140 kun)
    const parsed140 = parseSubscriptionDuration('4 oy + 20 kun bonus');
    assert.strictEqual(parsed140.baseDays, 120, '4 oy must parse to 120 baseDays');
    assert.strictEqual(parsed140.bonusDays, 20, '20 kun bonus must parse to 20 bonusDays');
    assert.strictEqual(parsed140.totalDays, 140, 'Total days for "4 oy + 20 kun bonus" must be 140');

    const grant140 = await SubscriptionService.grantCustomSubscriptionText({
      telegramId: TEST_OWNER_C,
      customText: '4 oy + 20 kun bonus',
      now: fixedNow,
      extendFromExisting: false,
    });
    const expected140 = new Date(fixedNow.getTime() + 140 * 24 * 60 * 60 * 1000);
    assert.strictEqual(grant140.totalDays, 140, 'Granted custom totalDays must be 140');
    assert.strictEqual(grant140.user.bonusDaysGranted, 20, 'bonusDaysGranted must be 20');
    assert.strictEqual(
      grant140.expiresAt.getTime(),
      expected140.getTime(),
      'subscriptionExpiresAt must be +140 days'
    );

    // 2C. SystemSettings & SubscriptionPayment screenshot approval flow
    const oldSettings = await SubscriptionService.getSystemSettings();
    const updatedSettings = await SubscriptionService.updateSystemSettings({
      paymentCardNumber: '8600 9999 8888 7777',
      paymentCardHolder: 'TEST ADMIN',
      monthlyPriceUzs: 120000,
    });
    assert.strictEqual(updatedSettings.paymentCardNumber, '8600 9999 8888 7777');
    assert.strictEqual(Number(updatedSettings.monthlyPriceUzs), 120000);

    const pendingPay = await SubscriptionService.submitPaymentScreenshot({
      userTelegramId: TEST_OWNER_C,
      screenshotFileId: 'test_screenshot_file_id_123',
    });
    assert.strictEqual(pendingPay.status, 'PENDING');

    let payApprovedSms = '';
    const approvedPay = await SubscriptionService.approvePaymentScreenshot({
      paymentId: pendingPay.id,
      baseDays: 90,
      bonusDays: 15,
      planName: '3 Oylik',
      monthsGranted: 3,
      now: fixedNow,
      extendFromExisting: false,
      sendSms: async (_tid, txt) => {
        payApprovedSms = txt;
      },
    });
    assert.strictEqual(approvedPay.payment.status, 'APPROVED');
    assert.strictEqual(Number(approvedPay.payment.amountUzs), 360000, '3 months * 120,000 UZS = 360,000 UZS');
    assert.ok(payApprovedSms.includes('Tabriklaymiz!'), 'Payment approval must trigger Bot-SMS');

    // Restore original SystemSettings
    await SubscriptionService.updateSystemSettings({
      paymentCardNumber: oldSettings.paymentCardNumber,
      paymentCardHolder: oldSettings.paymentCardHolder,
      monthlyPriceUzs: Number(oldSettings.monthlyPriceUzs),
    });
    console.log('✅ TEST 2 PASSED: Multi-Month Tariffs, Bonus Days & Payment Screenshot Flow verified!\n');

    // ========================================================================
    // TEST 3: Excel / CSV & PDF Export (Strictly Isolated by ownerId)
    // ========================================================================
    console.log('🔹 Running TEST 3: Excel / CSV & PDF Export...');
    await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_B,
      supplierName: 'Bravo Distribution B',
      rawTotal: 1_200_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      items: [{ rawName: 'Choy B', quantity: 5, unit: 'quti', unitPrice: 240_000, lineTotal: 1_200_000 }],
    });

    const exportA = await ExportService.exportOwnerDatabase(TEST_OWNER_A);
    const exportB = await ExportService.exportOwnerDatabase(TEST_OWNER_B);

    assert.ok(exportA.excelText.includes('Milter Exclusive A'), 'User_A Excel must contain User_A supplier');
    assert.ok(!exportA.excelText.includes('Bravo Distribution B'), 'User_A Excel must NOT contain User_B supplier');
    assert.ok(exportB.excelText.includes('Bravo Distribution B'), 'User_B Excel must contain User_B supplier');
    assert.ok(!exportB.excelText.includes('Milter Exclusive A'), 'User_B Excel must NOT contain User_A supplier');
    assert.ok(exportA.pdfBuffer.subarray(0, 5).toString('utf8') === '%PDF-', 'PDF buffer must have valid %PDF- header');
    assert.ok(exportB.pdfText.includes('Bravo Distribution B'), 'User_B PDF must contain User_B supplier');
    assert.ok(!exportB.pdfText.includes('Milter Exclusive A'), 'User_B PDF must NOT contain User_A supplier');
    console.log('✅ TEST 3 PASSED: Excel (.csv) & PDF Export multi-tenant isolation verified!\n');

    // ========================================================================
    // TEST 4: Scanner Speed & Format (<60 KB, <150 ms, <0.001s table assembly)
    // ========================================================================
    console.log('🔹 Running TEST 4: Scanner Speed & Compact Parser Format...');
    const syntheticRawImage = await sharp({
      create: {
        width: 1200,
        height: 1600,
        channels: 3,
        background: { r: 242, g: 242, b: 240 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Warm up sharp pipeline & V8 JIT once
    await ImageService.optimizeForFastOCR(syntheticRawImage);
    buildVerbatimTableText(parseCompactScannerRows(['1|Warmup|1 dona|1000|1000'], 'UZS'), 'UZS');

    const freshInputBuffer = Buffer.from(syntheticRawImage);
    const t0 = performance.now();
    const scannedBuf = await ImageService.optimizeForFastOCR(freshInputBuffer);
    const elapsedScannerMs = performance.now() - t0;
    const sizeKb = scannedBuf.byteLength / 1024;

    assert.ok(sizeKb < 60, `Scanned image must be < 60 KB (got ${sizeKb.toFixed(2)} KB)`);
    assert.ok(elapsedScannerMs < 150, `Scanner optimization must finish in < 150 ms (got ${elapsedScannerMs.toFixed(2)} ms)`);

    const compactRows = [
      '1|Marvari shokolad|10 kor|45000|450000',
      '2|Milter Mayonez 500g|20 dona|15000|300000',
      '3|Kungaboqar yogi 1L|50 dona|25000|1250000',
    ];
    const p0 = performance.now();
    const parsedItems = parseCompactScannerRows(compactRows, 'UZS');
    const verbatimTable = buildVerbatimTableText(parsedItems, 'UZS');
    const elapsedParseMs = performance.now() - p0;

    assert.strictEqual(parsedItems.length, 3, 'Must parse 3 compact rows');
    assert.ok(verbatimTable.includes('Marvari shokolad') && verbatimTable.includes('1,250,000 so\'m'));
    assert.ok(elapsedParseMs < 5, `Compact row parsing & table assembly must be ultra-fast (<5ms, got ${elapsedParseMs.toFixed(3)}ms)`);
    console.log(
      `✅ TEST 4 PASSED: Scanner size=${sizeKb.toFixed(1)}KB, speed=${elapsedScannerMs.toFixed(1)}ms, parser=${elapsedParseMs.toFixed(3)}ms!\n`
    );

    // ========================================================================
    // TEST 5: Double-Discount Guard (reconcileInvoiceTotals)
    // ========================================================================
    console.log('🔹 Running TEST 5: Double-Discount Guard (reconcileInvoiceTotals)...');
    const reconciledCase1 = reconcileInvoiceTotals({
      rows: [
        { lineTotal: 1_200_000 },
        { lineTotal: 800_000 },
      ],
      subtotalBeforeDiscount: 2_000_000,
      discountPercent: 5,
      discountAmount: 100_000,
      printedFinalTotal: 1_900_000,
    });
    assert.strictEqual(reconciledCase1.rawTotal, 2_000_000, 'rawTotal must be 2,000,000');
    assert.strictEqual(reconciledCase1.discountAmount, 100_000, 'discountAmount must be 100,000');
    assert.strictEqual(
      reconciledCase1.finalTotal,
      1_900_000,
      'finalTotal must be 1,900,000 (NOT 1,805,000 double-discounted!)'
    );

    // Also test when AI mistakenly puts 1,900,000 into subtotalBeforeDiscount while itemsSum is 2,000,000
    const reconciledCase2 = reconcileInvoiceTotals({
      rows: [
        { lineTotal: 1_000_000 },
        { lineTotal: 1_000_000 },
      ],
      subtotalBeforeDiscount: 1_900_000,
      discountPercent: 5,
      printedFinalTotal: 1_900_000,
    });
    assert.strictEqual(reconciledCase2.rawTotal, 2_000_000, 'rawTotal must recover 2,000,000 from itemsSum');
    assert.strictEqual(reconciledCase2.discountAmount, 100_000, 'discountAmount must be 100,000');
    assert.strictEqual(reconciledCase2.finalTotal, 1_900_000, 'finalTotal must be 1,900,000');
    console.log('✅ TEST 5 PASSED: Double-Discount Guard verified (2,000,000 - 5% = 1,900,000)!\n');

    // ========================================================================
    // TEST 6: Anti-Duplicate Guard (ImageHash & ContentFingerprint)
    // ========================================================================
    console.log('🔹 Running TEST 6: Anti-Duplicate Invoice Guard...');
    const testHash = ImageService.getImageHash(Buffer.from('unique-invoice-image-bytes-v3'));
    const dupItems = [
      { rawName: 'Coca Cola 1.5L', quantity: 20, unit: 'dona', unitPrice: 10_000, lineTotal: 200_000 },
    ];

    const firstSave = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_A,
      supplierName: 'Coca Cola Bottlers',
      rawTotal: 200_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: testHash,
      items: dupItems,
    });
    assert.strictEqual(firstSave.isDuplicate, false, 'First submission must succeed');

    // 6A. Duplicate by exact imageHash
    const secondSaveSameHash = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_A,
      supplierName: 'Coca Cola Bottlers',
      rawTotal: 200_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: testHash,
      items: dupItems,
    });
    assert.strictEqual(secondSaveSameHash.isDuplicate, true, 'Second submission with same imageHash must be blocked');
    assert.strictEqual(secondSaveSameHash.duplicateStage, 'IMAGE_HASH');

    // 6B. Duplicate by contentFingerprint (re-photographed invoice with different imageHash)
    const secondSaveSameContent = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_A,
      supplierName: 'Coca Cola Bottlers',
      rawTotal: 200_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: ImageService.getImageHash(Buffer.from('rephotographed-different-bytes-v3')),
      items: dupItems,
    });
    assert.strictEqual(
      secondSaveSameContent.isDuplicate,
      true,
      'Second submission with same contentFingerprint must be blocked'
    );
    assert.strictEqual(secondSaveSameContent.duplicateStage, 'CONTENT_FINGERPRINT');
    assert.ok(
      secondSaveSameContent.warningText?.includes('DIQQAT! Bu nakladnoy oldin kiritilgan'),
      'Warning text must match anti-duplicate specification'
    );
    console.log('✅ TEST 6 PASSED: Anti-Duplicate Guard (Stage 1 ImageHash & Stage 2 ContentFingerprint) verified!\n');

    // ========================================================================
    // TEST 7: Weekly/Monthly Cash vs Credit 100% & 5-Column Z-Report
    // ========================================================================
    console.log('🔹 Running TEST 7: Weekly/Monthly Cash vs Credit 100% & 5-Column Z-Report...');
    // Clear User_C invoices/payments for clean math check
    await prisma.invoice.deleteMany({ where: { ownerId: TEST_OWNER_C } });
    await prisma.supplierPayment.deleteMany({ where: { ownerId: TEST_OWNER_C } });

    // 7A. 4,000,000 UZS Cash & 6,000,000 UZS Credit -> 40% Cash | 60% Credit (100% Total)
    const analytics = ReportService.calculateCashVsCreditAnalytics({
      cashTotal: 4_000_000,
      creditTotal: 6_000_000,
      cashCount: 2,
      creditCount: 3,
      prevCreditPercent: 50,
    });
    assert.strictEqual(analytics.grandTotal, 10_000_000);
    assert.strictEqual(analytics.cashPercent, 40, 'Cash share must be 40%');
    assert.strictEqual(analytics.creditPercent, 60, 'Credit share must be 60%');
    assert.strictEqual(analytics.cashPercent + analytics.creditPercent, 100, 'Total share must be 100%');
    assert.strictEqual(analytics.progressBar, '[🟩🟩🟩🟩🟧🟧🟧🟧🟧🟧]');
    assert.ok(analytics.formattedBlock.includes('40% Naqd / 60% Nasiya'));

    // 7B. 5-Column Z-Report:
    // Terminal (2,000,000) + Click (1,500,000) + Cash in Drawer (2,500,000)
    // + Daily Cash Purchases (2,000,000) + Daily Supplier Payments (2,000,000) = 10,000,000 UZS
    await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_C,
      supplierName: 'Naqd Yuk Taminotchi',
      rawTotal: 2_000_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CASH',
      paidCashAmount: 2_000_000,
      creditAmount: 0,
      items: [{ rawName: 'Un 50kg', quantity: 10, unit: 'qop', unitPrice: 200_000, lineTotal: 2_000_000 }],
    });

    await SupplierService.recordSupplierPayment({
      ownerId: TEST_OWNER_C,
      supplierName: 'Nasiya Taminotchi',
      amount: 2_000_000,
      currency: 'UZS',
      note: 'Qarzdan tolov',
    });

    const zRep = await ReportService.generateAndSaveZReport({
      ownerId: TEST_OWNER_C,
      terminalAmount: 2_000_000,
      clickAmount: 1_500_000,
      cashRemainingInDrawer: 2_500_000,
    });

    assert.strictEqual(zRep.terminalAmount, 2_000_000);
    assert.strictEqual(zRep.clickAmount, 1_500_000);
    assert.strictEqual(zRep.cashRemainingInDrawer, 2_500_000);
    assert.strictEqual(zRep.dailyCashPurchasesUzs, 2_000_000);
    assert.strictEqual(zRep.dailySupplierPaymentsUzs, 2_000_000);
    assert.strictEqual(
      zRep.totalDailySalesUzs,
      10_000_000,
      '5-Column Z-Report totalDailySalesUzs must equal 10,000,000 UZS'
    );
    assert.ok(zRep.formattedText.includes('10,000,000 so\'m'));
    console.log('✅ TEST 7 PASSED: 40%/60% Cash vs Credit Analytics & 10,000,000 UZS 5-Column Z-Report verified!\n');

    console.log('🎉 ALL 7 E2E TESTS IN verify-full-saas-v3.ts PASSED 100% (PASS ✅)!');
  } finally {
    console.log('🧹 Cleaning up temporary test records from database...');
    await cleanupTestOwners();
    await prisma.$disconnect();
    console.log('✅ Test cleanup complete.');
  }
}

runAllTests().catch(async (err) => {
  console.error('❌ E2E Verification Failed:', err);
  await cleanupTestOwners().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});

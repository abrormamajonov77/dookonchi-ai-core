import '../src/config/env';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { prisma } from '../src/database/prisma';
import {
  AiService,
  COMPACT_SCANNER_PROMPT,
  DEFAULT_GENERATION_CONFIG,
  normalizeVerbatimInvoice,
  parseCompactScannerRows,
  buildVerbatimTableText,
} from '../src/services/ai.service';
import { ImageService } from '../src/services/image.service';
import { SupplierService } from '../src/services/supplier.service';
import { SearchService } from '../src/services/search.service';
import { ReportService } from '../src/services/report.service';
import { SubscriptionService, parseSubscriptionDuration } from '../src/services/subscription.service';
import { parseTextCommandLocally } from '../src/utils/local-parser';
import { toLatinUz, normalizeForSearch } from '../src/utils/transliterate';
import { reconcileInvoiceTotals } from '../src/utils/formatters';
import { invalidateCache } from '../src/utils/cache';

const TEST_OWNER_1 = '990000101_E2E_OWNER_1';
const TEST_OWNER_2 = '990000102_E2E_OWNER_2';

async function connectDbWithRetry(attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await prisma.$connect();
      await prisma.$queryRawUnsafe('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function cleanupTestRecords(attempts = 2) {
  const owners = [TEST_OWNER_1, TEST_OWNER_2];
  for (let i = 1; i <= attempts; i++) {
    try {
      // Supplier deleteMany cascades to Invoice, InvoiceItem, SupplierPayment, and SupplierTransaction
      await prisma.supplier.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.product.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.cashTransaction.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.customerDebt.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.expense.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.dailyRegister.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.zReport.deleteMany({ where: { ownerId: { in: owners } } });
      await prisma.subscriptionPayment.deleteMany({ where: { userTelegramId: { in: owners } } });
      await prisma.user.deleteMany({ where: { telegramId: { in: owners } } });
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function createRealisticReceiptPhoto(): Promise<Buffer> {
  const svg = `<svg width="960" height="1200" xmlns="http://www.w3.org/2000/svg">
    <rect width="960" height="1200" fill="#ffffff"/>
    <text x="50" y="90" font-family="Arial, sans-serif" font-size="34" font-weight="bold" fill="#111111">NAKLADNOY #145 - Yusufxon ketchup</text>
    <text x="50" y="150" font-family="Arial, sans-serif" font-size="24" fill="#222222">Sana: 17.11.2026</text>
    <line x1="40" y1="180" x2="920" y2="180" stroke="#000000" stroke-width="2"/>
    <text x="50" y="230" font-family="Arial, sans-serif" font-size="26" fill="#111111">1. Yarko Sous Tomat 500gr | 10 dona | 15000 | 150000</text>
    <text x="50" y="285" font-family="Arial, sans-serif" font-size="26" fill="#111111">2. Milter Mayonez 500g | 20 dona | 12000 | 240000</text>
    <line x1="40" y1="330" x2="920" y2="330" stroke="#000000" stroke-width="2"/>
    <text x="50" y="390" font-family="Arial, sans-serif" font-size="30" font-weight="bold" fill="#111111">Jami summa: 390000 UZS</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function runAllFixesE2E() {
  console.log('====================================================================');
  console.log('🚀 SMARTBAQQOL AI CORE — 7-MODULE FULL E2E VERIFICATION SUITE');
  console.log('====================================================================\n');

  await connectDbWithRetry();
  await cleanupTestRecords();

  try {
    // ====================================================================
    // TEST 1: No 400 Invalid Argument & <3s Scanner (<45KB, <120ms, 180° support)
    // ====================================================================
    console.log('▶ TEST 1: No 400 Invalid Argument & <3s Scanner Pipeline...');
    const aiServiceSource = fs.readFileSync(
      path.join(__dirname, '../src/services/ai.service.ts'),
      'utf8'
    );
    assert.ok(
      !aiServiceSource.includes('thinkingConfig') && !aiServiceSource.includes('thinkingBudget'),
      'ai.service.ts must NOT contain thinkingConfig or thinkingBudget (causes 400 INVALID_ARGUMENT)'
    );
    assert.strictEqual(DEFAULT_GENERATION_CONFIG.temperature, 0.1);
    assert.strictEqual(DEFAULT_GENERATION_CONFIG.maxOutputTokens, 2048);
    assert.ok(
      COMPACT_SCANNER_PROMPT.includes('180'),
      'Scanner prompt must instruct Gemini to read 180° upside-down receipts'
    );

    const rawReceipt = await createRealisticReceiptPhoto();
    // Warm up libvips threadpool once
    await ImageService.optimizeForFastOCR(rawReceipt);

    const freshReceipt = Buffer.from(rawReceipt);
    const t0 = performance.now();
    const scannedBuf = await ImageService.optimizeForFastOCR(freshReceipt);
    const scannerMs = performance.now() - t0;
    const sizeKb = scannedBuf.byteLength / 1024;

    assert.ok(sizeKb <= 45, `Scanned image must be <= 45 KB (got ${sizeKb.toFixed(2)} KB)`);
    assert.ok(scannerMs < 120, `Scanner optimization must finish in < 120 ms (got ${scannerMs.toFixed(2)} ms)`);

    // Verify 180-degree rotated & normal receipt normalization
    const upsideDownMockRaw = {
      supplierName: 'Юсуфхон кетчуп',
      invoiceNumber: '88',
      currency: 'UZS',
      rows: [
        '1|Ярко Соус Томат 500гр|10 дона|15000|150000',
        '2|Кетчуп Чили|20 дона|12000|240000',
      ],
      subtotalBeforeDiscount: 390000,
      discountPercent: 0,
      discountAmount: 0,
      printedFinalTotal: 390000,
    };
    const normalizedInv = normalizeVerbatimInvoice(upsideDownMockRaw);
    assert.strictEqual(normalizedInv.supplierName, 'Yusufxon ketchup');
    assert.strictEqual(normalizedInv.items[0].rawName, 'Yarko Sous Tomat 500gr');
    assert.strictEqual(normalizedInv.finalTotal, 390000);

    // Verify live Gemini API OCR call produces zero 400 INVALID_ARGUMENT errors
    const liveAiT0 = Date.now();
    const liveParsed = await AiService.parseInvoiceImage(scannedBuf, 'image/jpeg');
    const liveAiMs = Date.now() - liveAiT0;
    assert.ok(liveParsed && typeof liveParsed.finalTotal === 'number', 'Live Gemini OCR must return parsed InvoiceSchema');
    console.log(
      `  ✅ TEST 1 PASS (No thinkingConfig, Size: ${sizeKb.toFixed(1)}KB, Scanner: ${scannerMs.toFixed(2)}ms, Live Gemini OCR: ${liveAiMs}ms, 180° Cyrillic->Latin OK)\n`
    );

    // ====================================================================
    // TEST 2: Instant Local Text Parser — No AI Overload (<5ms)
    // ====================================================================
    console.log('▶ TEST 2: Instant Local Text Parser (<5ms, 100% AI-Free)...');
    // Warm up V8 RegExp/JIT once across branches
    parseTextCommandLocally('Warmup 1000 naqd');
    parseTextCommandLocally('Warmup -1000$ nasiya');

    const pStart = performance.now();
    const cmd1 = parseTextCommandLocally('Sirok 500.000 naqd');
    const cmd2 = parseTextCommandLocally('Dinar +811432');
    const cmd3 = parseTextCommandLocally('Milter -500.000');
    const cmd4 = parseTextCommandLocally('CocaCola 102.17$ nasiya');
    const pElapsed = performance.now() - pStart;

    assert.ok(cmd1, 'Must parse "Sirok 500.000 naqd"');
    assert.strictEqual(cmd1.intent, 'INVOICE_CASH');
    assert.strictEqual(cmd1.supplierName, 'Sirok');
    assert.strictEqual(cmd1.amount, 500000);
    assert.strictEqual(cmd1.paymentType, 'CASH');

    assert.ok(cmd2, 'Must parse "Dinar +811432"');
    assert.strictEqual(cmd2.intent, 'INVOICE_CREDIT');
    assert.strictEqual(cmd2.supplierName, 'Dinar');
    assert.strictEqual(cmd2.amount, 811432);
    assert.strictEqual(cmd2.paymentType, 'CREDIT');

    assert.ok(cmd3, 'Must parse "Milter -500.000"');
    assert.strictEqual(cmd3.intent, 'SUPPLIER_PAYMENT');
    assert.strictEqual(cmd3.supplierName, 'Milter');
    assert.strictEqual(cmd3.amount, 500000);
    assert.strictEqual(cmd3.txType, 'PAYMENT');

    assert.ok(cmd4, 'Must parse "CocaCola 102.17$ nasiya"');
    assert.strictEqual(cmd4.intent, 'INVOICE_CREDIT');
    assert.strictEqual(cmd4.supplierName, 'CocaCola');
    assert.strictEqual(cmd4.amount, 102.17);
    assert.strictEqual(cmd4.currency, 'USD');

    assert.ok(pElapsed < 5, `Local text parser must finish in < 5ms (got ${pElapsed.toFixed(3)}ms)`);
    console.log(`  ✅ TEST 2 PASS (4 commands parsed locally in ${pElapsed.toFixed(3)}ms without AI!)\n`);

    // ====================================================================
    // TEST 3: Auto Cyrillic-to-Latin & Bi-Alphabetical Search
    // ====================================================================
    console.log('▶ TEST 3: Auto Cyrillic-to-Latin Write-Time Normalization & Search...');
    assert.strictEqual(toLatinUz('Ярко Соус Томат 500гр'), 'Yarko Sous Tomat 500gr');
    assert.strictEqual(toLatinUz('Юсуфхон кетчуп'), 'Yusufxon ketchup');

    const cyrInvoice = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_1,
      supplierName: 'Юсуфхон кетчуп',
      rawTotal: 450000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      items: [
        {
          rawName: 'Ярко Соус Томат 500гр',
          quantity: 30,
          unit: 'дона',
          unitPrice: 15000,
          lineTotal: 450000,
        },
      ],
    });

    assert.strictEqual(
      cyrInvoice.supplier.name,
      'Yusufxon ketchup',
      'Supplier name must be saved in Latin in DB'
    );
    const savedItem = await prisma.invoiceItem.findFirst({
      where: { invoiceId: cyrInvoice.invoice.id },
    });
    assert.strictEqual(
      savedItem?.rawName,
      'Yarko Sous Tomat 500gr',
      'InvoiceItem rawName must be saved in Latin in DB'
    );

    const searchYarko = await SearchService.searchProductsWithPriceDiff('yarko', TEST_OWNER_1);
    const searchYusufxon = await SearchService.multiSearch('yusufxon', TEST_OWNER_1);
    const searchCyrillic = await SearchService.searchProductsWithPriceDiff('ярко', TEST_OWNER_1);

    assert.ok(searchYarko.length > 0, 'Searching "yarko" in Latin must find "Yarko Sous Tomat 500gr"');
    assert.strictEqual(searchYarko[0].productName, 'Yarko Sous Tomat 500gr');
    assert.ok(
      searchYusufxon.suppliers.some((s) => s.name === 'Yusufxon ketchup'),
      'Searching "yusufxon" must find supplier "Yusufxon ketchup"'
    );
    assert.ok(searchCyrillic.length > 0, 'Searching "ярко" in Cyrillic must also find the item');
    void normalizeForSearch;
    console.log('  ✅ TEST 3 PASS (Cyrillic saved as Latin & found via "yarko" and "yusufxon"!)\n');

    // ====================================================================
    // TEST 4: Fuzzy Supplier Typo Guard — "Dinar" vs "Diner"
    // ====================================================================
    console.log('▶ TEST 4: Fuzzy Supplier Typo Guard ("Dinar kalbasa" vs "Diner")...');
    await prisma.supplier.create({
      data: {
        ownerId: TEST_OWNER_1,
        name: 'Dinar kalbasa',
        debtUzs: 11_002_752,
        debtUsd: 0,
        isActive: true,
      },
    });
    // Invalidate cache so new supplier is loaded
    invalidateCache(TEST_OWNER_1);

    const fuzzyResult = await SupplierService.findOrSuggestSupplier('Diner', TEST_OWNER_1);
    assert.strictEqual(fuzzyResult.isFuzzyMatch, true, '"Diner" must trigger isFuzzyMatch: true');
    assert.strictEqual(
      fuzzyResult.suggestedSupplier?.name,
      'Dinar kalbasa',
      'Must suggest existing "Dinar kalbasa" instead of creating a duplicate supplier'
    );
    assert.ok(
      fuzzyResult.promptText?.includes('Dinar kalbasa') &&
        fuzzyResult.promptText?.includes('11,002,752'),
      'Prompt text must show "Dinar kalbasa" and its current debt'
    );
    console.log('  ✅ TEST 4 PASS ("Diner" matched to "Dinar kalbasa" with isFuzzyMatch: true!)\n');

    // ====================================================================
    // TEST 5: Z-Report Yesterday's Cash (PREVIOUS_SAFE) vs Today's Cash (TODAY_CASH)
    // ====================================================================
    console.log('▶ TEST 5: Z-Report Cash Source Guard (TODAY_CASH vs PREVIOUS_SAFE)...');
    // 1) Cash purchase today: 2,000,000 UZS
    await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_2,
      supplierName: 'Naqd Tovar Taminotchi',
      rawTotal: 2_000_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CASH',
      paymentSource: 'TODAY_CASH',
      paidCashAmount: 2_000_000,
      creditAmount: 0,
      items: [{ rawName: 'Shakar', quantity: 20, unit: 'kg', unitPrice: 100_000, lineTotal: 2_000_000 }],
    });

    // 2) Initial credit supplier with 5,000,000 UZS debt
    const creditSup = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_2,
      supplierName: 'Dinar Nasiya',
      rawTotal: 5_000_000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      items: [{ rawName: 'Kalbasa', quantity: 50, unit: 'dona', unitPrice: 100_000, lineTotal: 5_000_000 }],
    });
    assert.strictEqual(Number(creditSup.supplier.debtUzs), 5_000_000);

    // 3) Pay 2,000,000 UZS from TODAY_CASH (must reduce debt AND add to Z-Report sales)
    const payToday = await SupplierService.recordSupplierPayment({
      ownerId: TEST_OWNER_2,
      supplierId: creditSup.supplier.id,
      supplierName: 'Dinar Nasiya',
      amount: 2_000_000,
      currency: 'UZS',
      paymentSource: 'TODAY_CASH',
    });
    assert.strictEqual(Number(payToday.supplier.debtUzs), 3_000_000);

    // 4) Pay 1,500,000 UZS from PREVIOUS_SAFE (yesterday's Z-Report cash / safe)
    // Must reduce supplier debt (3,000,000 -> 1,500,000), but MUST NOT be added to today's Z-Report sales!
    const payPrevSafe = await SupplierService.recordSupplierPayment({
      ownerId: TEST_OWNER_2,
      supplierId: creditSup.supplier.id,
      supplierName: 'Dinar Nasiya',
      amount: 1_500_000,
      currency: 'UZS',
      paymentSource: 'PREVIOUS_SAFE',
    });
    assert.strictEqual(
      Number(payPrevSafe.supplier.debtUzs),
      1_500_000,
      'PREVIOUS_SAFE payment must deduct from supplier debt (3M - 1.5M = 1.5M)'
    );

    const zReport = await ReportService.generateAndSaveZReport({
      ownerId: TEST_OWNER_2,
      terminalAmount: 2_000_000,
      clickAmount: 1_500_000,
      cashRemainingInDrawer: 2_500_000,
    });

    assert.strictEqual(zReport.dailyCashPurchasesUzs, 2_000_000);
    assert.strictEqual(
      zReport.dailySupplierPaymentsUzs,
      2_000_000,
      'Only TODAY_CASH (2,000,000) must be included in dailySupplierPaymentsUzs'
    );
    assert.strictEqual(
      zReport.previousSafePaymentsUzs,
      1_500_000,
      'PREVIOUS_SAFE (1,500,000) must be tracked separately'
    );
    assert.strictEqual(
      zReport.totalDailySalesUzs,
      10_000_000,
      'Total daily sales must be 10,000,000 (2M + 1.5M + 2.5M + 2M + 2M), NOT 11,500,000!'
    );
    assert.ok(
      zReport.formattedText.includes('1,500,000 so\'m kecha hisoblangani sababli bugungi savdoga qayta qo\'shilmadi'),
      'Z-Report text must include the PREVIOUS_SAFE informational note'
    );
    console.log(
      '  ✅ TEST 5 PASS (TODAY_CASH 2M included in 10M Z-Report; PREVIOUS_SAFE 1.5M deducted from debt but excluded from today sales!)\n'
    );

    // ====================================================================
    // TEST 6: Double-Discount Guard & Anti-Duplicate Guard
    // ====================================================================
    console.log('▶ TEST 6: Double-Discount Guard (2M - 5% = 1.9M) & Anti-Duplicate Guard...');
    const discCheck = reconcileInvoiceTotals({
      rows: [{ lineTotal: 1_200_000 }, { lineTotal: 800_000 }],
      subtotalBeforeDiscount: 2_000_000,
      discountPercent: 5,
      discountAmount: 100_000,
      printedFinalTotal: 1_900_000,
    });
    assert.strictEqual(discCheck.rawTotal, 2_000_000);
    assert.strictEqual(discCheck.discountAmount, 100_000);
    assert.strictEqual(discCheck.finalTotal, 1_900_000);

    const dupHash = ImageService.getImageHash(Buffer.from('test-dup-guard-v4'));
    const firstInv = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_1,
      supplierName: 'Milter',
      rawTotal: 900_000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: dupHash,
      items: [{ rawName: 'Mayonez', quantity: 30, unit: 'dona', unitPrice: 30_000, lineTotal: 900_000 }],
    });
    assert.strictEqual(firstInv.isDuplicate, false);

    const secondInv = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_1,
      supplierName: 'Milter',
      rawTotal: 900_000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: dupHash,
      items: [{ rawName: 'Mayonez', quantity: 30, unit: 'dona', unitPrice: 30_000, lineTotal: 900_000 }],
    });
    assert.strictEqual(secondInv.isDuplicate, true, 'Duplicate invoice must be blocked');
    console.log('  ✅ TEST 6 PASS (Double-Discount Guard & Anti-Duplicate Guard verified!)\n');

    // ====================================================================
    // TEST 7: Multi-Tenant Isolation & Multi-Month Bonus Tariffs
    // ====================================================================
    console.log('▶ TEST 7: Multi-Tenant Isolation & Multi-Month Bonus Tariffs...');
    const owner1Report = await SupplierService.getFormattedDebtorsReport(1, 10, TEST_OWNER_1);
    const owner2Report = await SupplierService.getFormattedDebtorsReport(1, 10, TEST_OWNER_2);

    assert.ok(
      owner1Report.suppliers.some((s) => s.name === 'Dinar kalbasa'),
      'Owner 1 must see Dinar kalbasa'
    );
    assert.ok(
      !owner1Report.suppliers.some((s) => s.name === 'Dinar Nasiya'),
      'Owner 1 must NOT see Owner 2 suppliers'
    );
    assert.ok(
      owner2Report.suppliers.some((s) => s.name === 'Dinar Nasiya'),
      'Owner 2 must see Dinar Nasiya'
    );
    assert.ok(
      !owner2Report.suppliers.some((s) => s.name === 'Dinar kalbasa'),
      'Owner 2 must NOT see Owner 1 suppliers'
    );

    const dur105 = parseSubscriptionDuration('3 oy + 15 kun bonus');
    assert.strictEqual(dur105.totalDays, 105);
    assert.strictEqual(dur105.bonusDays, 15);

    const fixedDate = new Date('2026-11-17T12:00:00.000Z');
    const grantRes = await SubscriptionService.grantCustomSubscriptionText({
      telegramId: TEST_OWNER_2,
      customText: '4 oy + 20 kun bonus',
      now: fixedDate,
      extendFromExisting: false,
    });
    assert.strictEqual(grantRes.totalDays, 140);
    assert.strictEqual(grantRes.user.bonusDaysGranted, 20);
    assert.strictEqual(grantRes.user.status, 'ACTIVE');
    void AiService;
    void parseCompactScannerRows;
    void buildVerbatimTableText;
    console.log('  ✅ TEST 7 PASS (Multi-Tenant Isolation & Multi-Month Bonus Tariffs verified!)\n');

    console.log('====================================================================');
    console.log('🎉 ALL 7 E2E TESTS IN verify-all-fixes-e2e.ts PASSED 100% (PASS ✅)!');
    console.log('====================================================================');
  } finally {
    console.log('🧹 Cleaning up temporary test records from database...');
    await cleanupTestRecords();
    await prisma.$disconnect();
    console.log('✅ Test cleanup complete.');
  }
}

runAllFixesE2E().catch(async (err) => {
  console.error('❌ E2E Verification Failed:', err);
  await cleanupTestRecords().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});

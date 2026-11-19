/**
 * 4-BOSQICH: SaaS Production Full-Stack Deep Audit E2E Stress-Test Suite (`scripts/saas-full-audit-e2e.ts`)
 * Verifies all 10 production SaaS scenarios end-to-end against PostgreSQL / Prisma:
 *  - TEST 1: Multi-Tenant Zero-Leak Isolation (Admin, Tenant_X, Tenant_Y + cross-tenant mutation attack block)
 *  - TEST 2: SaaS Onboarding, Multi-Month Bonus (3m+15d = 105d, custom 4m+20d = 140d), 3-day reminder, Expiry & Renewal
 *  - TEST 3: Concurrent Load / Stress Test (10 parallel users + concurrent atomic balance updates, 0 drift)
 *  - TEST 4: Instant Local Text Parser (<5ms) & Makiz 500.000 / $50.17 Payment Accuracy
 *  - TEST 5: Fuzzy Match Supplier Guard ("Dinar" vs "Diner")
 *  - TEST 6: OCR 30s Timeout, No thinkingConfig, Natural Color OCR JPEG & Background Latin + Bi-Alphabet Search
 *  - TEST 7: Zero-Hallucination, Strict Discount Guard (No fake 1.6%), Double-Discount Guard (-5%, -21%) & 2-Table A4
 *  - TEST 8: Handwritten Receipt ("GAZVADA - 5.000") & 2-Stage Anti-Duplicate Guard (ImageHash + ContentFingerprint)
 *  - TEST 9: 5-Column Daily Z-Report (10,000,000 so'm) & Yesterday Safe Cash Guard (PREVIOUS_SAFE excluded)
 *  - TEST 10: Weekly/Monthly 100% Cash vs Credit Analytics (40% Naqd / 60% Nasiya) & Excel/PDF/HTML Export
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { prisma } from '../src/database/prisma';
import {
  COMPACT_SCANNER_PROMPT,
  DEFAULT_GENERATION_CONFIG,
  OCR_TIMEOUT_MS,
  normalizeVerbatimInvoice,
  parseCompactScannerRows,
  retryOnceOnTimeout,
} from '../src/services/ai.service';
import { ImageService } from '../src/services/image.service';
import { SupplierService } from '../src/services/supplier.service';
import { SubscriptionService } from '../src/services/subscription.service';
import { SearchService } from '../src/services/search.service';
import { ReportService } from '../src/services/report.service';
import { ExportService } from '../src/services/export.service';
import { parseCurrencyAndAmount, parseSmartAmount, reconcileInvoiceTotals } from '../src/utils/formatters';
import { parseTextCommandLocally } from '../src/utils/local-parser';
import { toLatinUz } from '../src/utils/transliterate';
import { invalidateCache } from '../src/utils/cache';

const TENANT_ADMIN = '9998880001';
const TENANT_X = '9998880002';
const TENANT_Y = '9998880003';
const TENANT_ONBOARD = '9998880004';
const TENANT_ZREP = '9998880005';
const TENANT_WEEKLY = '9998880006';
const CONCURRENT_TENANTS = Array.from({ length: 10 }, (_, i) => `99988810${String(i).padStart(2, '0')}`);

const ALL_TEST_OWNERS = [
  TENANT_ADMIN,
  TENANT_X,
  TENANT_Y,
  TENANT_ONBOARD,
  TENANT_ZREP,
  TENANT_WEEKLY,
  ...CONCURRENT_TENANTS,
];

async function cleanupAllTestOwners() {
  await prisma.subscriptionPayment
    .deleteMany({ where: { userTelegramId: { in: ALL_TEST_OWNERS } } })
    .catch(() => {});
  await prisma.supplierPayment.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.supplierTransaction.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.invoiceItem.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.invoice.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.cashTransaction.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.customerDebt.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.expense.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.zReport.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.dailyRegister.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.supplier.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.product.deleteMany({ where: { ownerId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { telegramId: { in: ALL_TEST_OWNERS } } }).catch(() => {});
  for (const id of ALL_TEST_OWNERS) {
    invalidateCache(id);
  }
}

async function createSampleReceiptBuffer(): Promise<Buffer> {
  const svg = `
    <svg width="900" height="1200" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ebe7dc"/>
      <text x="40" y="90" font-size="34" fill="#111111" font-family="Arial">НАКЛАДНАЯ №777</text>
      <text x="40" y="160" font-size="26" fill="#222222" font-family="Arial">1. Ярко Кетчуп 500гр - 10 x 45.000 = 450.000</text>
      <text x="40" y="230" font-size="30" fill="#111111" font-family="Arial">ИТОГО: 450 000 сум</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  console.log('====================================================================');
  console.log('🛡  SMARTBAQQOL SAAS — 10/10 FULL PRODUCTION AUDIT E2E SUITE');
  console.log('====================================================================\n');

  await prisma.$connect();
  await cleanupAllTestOwners();

  try {
    // ====================================================================
    // TEST 1: Multi-Tenant Zero-Leak (Admin, Tenant_X, Tenant_Y + Attack Guard)
    // ====================================================================
    console.log('▶ TEST 1 (Multi-Tenant Zero-Leak)...');
    const [admInv, xInv, yInv] = await Promise.all([
      SupplierService.createInvoiceWithItems({
        ownerId: TENANT_ADMIN,
        supplierName: 'AdminSecretSupplier',
        rawTotal: 900000,
        currency: 'UZS',
        paymentType: 'CREDIT',
        items: [{ rawName: 'AdminSecretOlma', quantity: 10, unit: 'kg', unitPrice: 90000, lineTotal: 900000 }],
        forceOverrideDuplicate: true,
      }),
      SupplierService.createInvoiceWithItems({
        ownerId: TENANT_X,
        supplierName: 'TenantXSupplier',
        rawTotal: 1500000,
        currency: 'UZS',
        paymentType: 'CREDIT',
        items: [{ rawName: 'TenantXShakar', quantity: 100, unit: 'kg', unitPrice: 15000, lineTotal: 1500000 }],
        forceOverrideDuplicate: true,
      }),
      SupplierService.createInvoiceWithItems({
        ownerId: TENANT_Y,
        supplierName: 'TenantYSupplier',
        rawTotal: 2500000,
        currency: 'UZS',
        paymentType: 'CREDIT',
        items: [{ rawName: 'TenantYYog', quantity: 50, unit: 'litr', unitPrice: 50000, lineTotal: 2500000 }],
        forceOverrideDuplicate: true,
      }),
    ]);

    await ReportService.generateAndSaveZReport({
      ownerId: TENANT_X,
      terminalAmount: 1000000,
      clickAmount: 500000,
      cashRemainingInDrawer: 500000,
    });
    await ReportService.generateAndSaveZReport({
      ownerId: TENANT_Y,
      terminalAmount: 9000000,
      clickAmount: 0,
      cashRemainingInDrawer: 0,
    });

    // 1A: Suppliers list isolation
    const xDebtors = await SupplierService.getFormattedDebtorsReport(1, 20, TENANT_X);
    assert.ok(xDebtors.text.includes('TenantXSupplier'), 'Tenant_X must see own supplier');
    assert.ok(!xDebtors.text.includes('TenantYSupplier'), 'Tenant_X must NEVER see Tenant_Y supplier');
    assert.ok(!xDebtors.text.includes('AdminSecretSupplier'), 'Tenant_X must NEVER see Admin supplier');
    assert.strictEqual(xDebtors.totalUzs, 1500000);

    // 1B: Search isolation
    const xSearchYog = await SearchService.multiSearch('TenantYYog', TENANT_X);
    assert.strictEqual(xSearchYog.items.length, 0, 'Tenant_X search must return 0 Tenant_Y items');
    assert.strictEqual(xSearchYog.suppliers.length, 0, 'Tenant_X search must return 0 Tenant_Y suppliers');

    const xSearchOwn = await SearchService.multiSearch('TenantXShakar', TENANT_X);
    assert.strictEqual(xSearchOwn.items.length, 1, 'Tenant_X must find own product');

    // 1C: Export isolation
    const xExport = await ExportService.exportOwnerDatabase(TENANT_X);
    assert.ok(xExport.excelText.includes('TenantXSupplier'));
    assert.ok(!xExport.excelText.includes('TenantYSupplier'), 'Excel export must have 0 leak of Tenant_Y');
    assert.ok(!xExport.excelText.includes('AdminSecretSupplier'), 'Excel export must have 0 leak of Admin');
    assert.ok(!xExport.pdfText.includes('TenantYSupplier'), 'PDF export must have 0 leak of Tenant_Y');
    assert.strictEqual(xExport.zReports.length, 1);
    assert.strictEqual(Number(xExport.zReports[0].totalDailySalesUzs), 2000000);

    // 1D: Cross-tenant mutation attacks MUST be blocked
    let renameBlocked = false;
    try {
      await SupplierService.checkOrRenameSupplier(yInv.supplier.id, 'HackedName', TENANT_X);
    } catch {
      renameBlocked = true;
    }
    assert.ok(renameBlocked, 'Cross-tenant supplier rename MUST throw error');

    let mergeBlocked = false;
    try {
      await SupplierService.mergeSuppliers(yInv.supplier.id, xInv.supplier.id, TENANT_X);
    } catch {
      mergeBlocked = true;
    }
    assert.ok(mergeBlocked, 'Cross-tenant supplier merge MUST throw error');

    let discountBlocked = false;
    try {
      await SupplierService.updateInvoiceDiscount(yInv.invoice.id, '50%', TENANT_X);
    } catch {
      discountBlocked = true;
    }
    assert.ok(discountBlocked, 'Cross-tenant invoice discount update MUST throw error');

    assert.ok(admInv.invoice.id && xInv.invoice.id && yInv.invoice.id);
    console.log('  ✅ PASS: 3 tenants 100% isolated (suppliers, search, Z-report, Excel/PDF) & cross-tenant attacks blocked!\n');

    // ====================================================================
    // TEST 2: SaaS Onboarding, Multi-Month Bonus & Expiry (Data Preserved)
    // ====================================================================
    console.log('▶ TEST 2 (SaaS Onboarding, Multi-Month Bonus & Expiry)...');
    const reg = await SubscriptionService.registerOrGetUser({
      telegramId: TENANT_ONBOARD,
      fullName: 'Alisher Savdo',
      username: 'alisher_shop',
      phone: '+998901112233',
    });
    assert.strictEqual(reg.isNew, true);
    assert.strictEqual(reg.user.status, 'PENDING');
    assert.strictEqual(reg.user.role, 'STORE_OWNER');

    // Admin grants 3 months + 15 days bonus (105 days)
    const sentSmsList: Array<{ to: string; text: string }> = [];
    const baseNow = new Date('2026-11-19T06:00:00.000Z');
    const grant3m = await SubscriptionService.grantSubscription({
      telegramId: TENANT_ONBOARD,
      baseDays: 90,
      bonusDays: 15,
      planName: '3 Oylik',
      now: baseNow,
      extendFromExisting: false,
      sendSms: async (to, text) => {
        sentSmsList.push({ to, text });
      },
    });
    assert.strictEqual(grant3m.totalDays, 105);
    assert.strictEqual(grant3m.user.status, 'ACTIVE');
    assert.strictEqual(sentSmsList.length, 1);
    assert.ok(sentSmsList[0].text.includes('105 kun'));

    // Admin grants custom "4 oy + 20 kun bonus" (140 days)
    const grantCustom = await SubscriptionService.grantCustomSubscriptionText({
      telegramId: TENANT_ONBOARD,
      customText: '4 oy + 20 kun bonus',
      now: baseNow,
      extendFromExisting: false,
      sendSms: async (to, text) => {
        sentSmsList.push({ to, text });
      },
    });
    assert.strictEqual(grantCustom.baseDays, 120);
    assert.strictEqual(grantCustom.bonusDays, 20);
    assert.strictEqual(grantCustom.totalDays, 140);
    assert.strictEqual(grantCustom.user.status, 'ACTIVE');

    // Store personal business data for this user before expiry
    await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_ONBOARD,
      supplierName: 'OnboardSupplier',
      rawTotal: 750000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      forceOverrideDuplicate: true,
    });

    // Test 3-day warning reminder (only sent once per day)
    await prisma.user.update({
      where: { telegramId: TENANT_ONBOARD },
      data: {
        subscriptionExpiresAt: new Date(baseNow.getTime() + 2 * 24 * 60 * 60 * 1000),
        lastReminderSentAt: null,
      },
    });
    const reminderMessages: string[] = [];
    await SubscriptionService.checkExpiringAndExpiredSubscriptions(async (to, text) => {
      if (to === TENANT_ONBOARD) reminderMessages.push(text);
    }, baseNow);
    await SubscriptionService.checkExpiringAndExpiredSubscriptions(async (to, text) => {
      if (to === TENANT_ONBOARD) reminderMessages.push(text);
    }, baseNow);
    assert.strictEqual(reminderMessages.length, 1, '3-day reminder must not duplicate on same day');

    // Simulate expiry -> EXPIRED status, data 100% preserved
    await prisma.user.update({
      where: { telegramId: TENANT_ONBOARD },
      data: { subscriptionExpiresAt: new Date(baseNow.getTime() - 60_000) },
    });
    await SubscriptionService.checkExpiringAndExpiredSubscriptions(async () => {}, baseNow);
    const expiredUser = await prisma.user.findUnique({ where: { telegramId: TENANT_ONBOARD } });
    assert.strictEqual(expiredUser?.status, 'EXPIRED');

    // Screenshot submission + Admin 1-click renewal restores ACTIVE without data loss
    const payReceipt = await SubscriptionService.submitPaymentScreenshot({
      userTelegramId: TENANT_ONBOARD,
      screenshotFileId: 'test_file_id_12345',
    });
    const renewed = await SubscriptionService.approvePaymentScreenshot({
      paymentId: payReceipt.id,
      baseDays: 30,
      bonusDays: 0,
      planName: '1 Oylik',
      monthsGranted: 1,
    });
    assert.strictEqual(renewed.user.status, 'ACTIVE');
    const preservedSuppliers = await prisma.supplier.count({ where: { ownerId: TENANT_ONBOARD } });
    assert.strictEqual(preservedSuppliers, 1, 'Personal database must remain 100% intact after expiry & renewal');
    console.log('  ✅ PASS: PENDING -> 105d & 140d Bonus -> 3-day Reminder -> EXPIRED -> Renewed ACTIVE (0 data loss)!\n');

    // ====================================================================
    // TEST 3: Concurrent Load / Stress Test (10 Parallel Users + Atomic Balance)
    // ====================================================================
    console.log('▶ TEST 3 (Concurrent Load / Stress Test — 10 Parallel Users)...');
    const tStress0 = performance.now();
    await Promise.all(
      CONCURRENT_TENANTS.map(async (tenantId, idx) => {
        const creditAmt = 1000000 + idx * 10000;
        const payAmt = 250000;
        await SupplierService.createInvoiceWithItems({
          ownerId: tenantId,
          supplierName: 'StressSupplier',
          rawTotal: creditAmt,
          currency: 'UZS',
          paymentType: 'CREDIT',
          forceOverrideDuplicate: true,
        });
        // Run 2 simultaneous payments on the SAME supplier to verify atomic decrement (0 lost updates!)
        await Promise.all([
          SupplierService.recordSupplierPayment({
            ownerId: tenantId,
            supplierName: 'StressSupplier',
            amount: payAmt,
            currency: 'UZS',
            paymentSource: 'TODAY_CASH',
          }),
          SupplierService.recordSupplierPayment({
            ownerId: tenantId,
            supplierName: 'StressSupplier',
            amount: payAmt,
            currency: 'UZS',
            paymentSource: 'TODAY_CASH',
          }),
        ]);
      })
    );
    const stressMs = performance.now() - tStress0;

    // Verify all 10 parallel tenants have exact debtUzs === creditAmt - 500,000 (0 so'm drift!)
    for (let i = 0; i < CONCURRENT_TENANTS.length; i++) {
      const tenantId = CONCURRENT_TENANTS[i];
      const expectedDebt = 1000000 + i * 10000 - 500000;
      const sup = await prisma.supplier.findFirst({ where: { ownerId: tenantId, name: 'StressSupplier' } });
      assert.ok(sup, `StressSupplier must exist for ${tenantId}`);
      assert.strictEqual(
        Number(sup.debtUzs),
        expectedDebt,
        `Tenant ${tenantId} debt must be exact (${expectedDebt}), got ${sup.debtUzs}`
      );
    }
    console.log(
      `  ✅ PASS: 10 parallel users (30 concurrent DB transactions) finished in ${stressMs.toFixed(0)} ms with 0 so'm balance drift!\n`
    );

    // ====================================================================
    // TEST 4: Instant Local Text Parser (<5ms) & Makiz 500.000 / $50.17 Payment
    // ====================================================================
    console.log('▶ TEST 4 (Instant Local Text Parser & Makiz 500.000 Payment)...');
    // Warm up regex engine across all 3 branches once
    parseTextCommandLocally('Sirok 500.000 naqd');
    parseTextCommandLocally('Dinar +811432');
    parseTextCommandLocally('Milter -500.000');

    const tLocal0 = performance.now();
    const pCash = parseTextCommandLocally('Sirok 500.000 naqd');
    const pCredit = parseTextCommandLocally('Dinar +811432');
    const pPay = parseTextCommandLocally('Milter -500.000');
    const localMs = performance.now() - tLocal0;

    assert.ok(localMs < 5, `Local parser must run in <5ms (got ${localMs.toFixed(3)}ms)`);
    assert.strictEqual(pCash?.intent, 'INVOICE_CASH');
    assert.strictEqual(pCash?.supplierName, 'Sirok');
    assert.strictEqual(pCash?.amount, 500000);

    assert.strictEqual(pCredit?.intent, 'INVOICE_CREDIT');
    assert.strictEqual(pCredit?.supplierName, 'Dinar');
    assert.strictEqual(pCredit?.amount, 811432);

    assert.strictEqual(pPay?.intent, 'SUPPLIER_PAYMENT');
    assert.strictEqual(pPay?.supplierName, 'Milter');
    assert.strictEqual(pPay?.amount, 500000);

    // Unified number/currency parser verification across all formats
    assert.strictEqual(parseSmartAmount('500.000'), 500000);
    assert.strictEqual(parseSmartAmount('500,000'), 500000);
    assert.strictEqual(parseSmartAmount('500 000'), 500000);
    assert.strictEqual(parseSmartAmount('$102.17'), 102.17);
    assert.strictEqual(parseCurrencyAndAmount('102 dollaru 17 sent').amount, 102.17);
    assert.strictEqual(parseCurrencyAndAmount('102 dollaru 17 sent').currency, 'USD');
    assert.strictEqual(parseCurrencyAndAmount('50 USDT').amount, 50);
    assert.strictEqual(parseCurrencyAndAmount('50 USDT').currency, 'USD');

    // Makiz 500.000 UZS & $50.17 USD payment test in Postgres
    const makiz = await prisma.supplier.create({
      data: { ownerId: TENANT_X, name: 'Makiz', debtUzs: 1200000, debtUsd: 100.17, isActive: true },
    });
    const payUzs = await SupplierService.recordSupplierPayment({
      ownerId: TENANT_X,
      supplierId: makiz.id,
      supplierName: 'Makiz',
      amount: parseSmartAmount('500.000'),
      currency: 'UZS',
      paymentSource: 'TODAY_CASH',
    });
    const payUsd = await SupplierService.recordSupplierPayment({
      ownerId: TENANT_X,
      supplierId: makiz.id,
      supplierName: 'Makiz',
      amount: parseSmartAmount('$50.17'),
      currency: 'USD',
      paymentSource: 'TODAY_CASH',
    });
    assert.strictEqual(Number(payUzs.supplier.debtUzs), 700000);
    assert.strictEqual(Number(payUsd.supplier.debtUsd), 50);
    console.log(
      `  ✅ PASS: 3 local commands parsed in ${localMs.toFixed(3)} ms, Makiz 500.000 UZS & $50.17 USD saved accurately!\n`
    );

    // ====================================================================
    // TEST 5: Fuzzy Match "Dinar" vs "Diner"
    // ====================================================================
    console.log('▶ TEST 5 (Fuzzy Match "Dinar" vs "Diner")...');
    await prisma.supplier.create({
      data: { ownerId: TENANT_X, name: 'Dinar', debtUzs: 811432, debtUsd: 0, isActive: true },
    });
    invalidateCache(TENANT_X);
    const fuzzyRes = await SupplierService.findOrSuggestSupplier('Diner', TENANT_X);
    assert.strictEqual(fuzzyRes.status, 'FUZZY_MATCH', '"Diner" must fuzzy-match existing "Dinar"');
    assert.strictEqual(fuzzyRes.suggestedSupplier?.name, 'Dinar');
    assert.ok(fuzzyRes.promptText?.includes('Dinar'));
    console.log('  ✅ PASS: "Diner" suggested existing "Dinar" (0 duplicate supplier created)!\n');

    // ====================================================================
    // TEST 6: OCR 30s Timeout, HD Xerox 1800px & Background Latin + Search
    // ====================================================================
    console.log('▶ TEST 6 (OCR Timeout, HD Xerox & Background Latin)...');
    assert.strictEqual(OCR_TIMEOUT_MS, 30000);
    assert.strictEqual(DEFAULT_GENERATION_CONFIG.temperature, 0.1);
    assert.strictEqual(DEFAULT_GENERATION_CONFIG.maxOutputTokens, 2048);
    const aiSrc = fs.readFileSync(path.join(__dirname, '../src/services/ai.service.ts'), 'utf8');
    assert.ok(!aiSrc.includes('thinkingConfig') && !aiSrc.includes('thinkingBudget'));

    let retryAttempts = 0;
    const retried = await retryOnceOnTimeout(async () => {
      retryAttempts++;
      if (retryAttempts === 1) throw new Error('Gemini OCR request timed out (30s)');
      return 'RECOVERED';
    }, 1000);
    assert.strictEqual(retried, 'RECOVERED');
    assert.strictEqual(retryAttempts, 2);

    // Natural Color OCR JPEG (no B&W / contrast burn)
    const samplePhoto = await createSampleReceiptBuffer();
    const ocrBuf = await ImageService.optimizeForFastOCR(samplePhoto);
    const ocrMeta = await sharp(ocrBuf).metadata();
    assert.strictEqual(ocrMeta.format, 'jpeg');
    assert.strictEqual(ocrMeta.channels, 3);
    assert.strictEqual(ocrMeta.space, 'srgb');

    // Background Latin (<5ms) + Bi-Alphabet Product Search
    toLatinUz('Ярко Кетчуп 500гр'); // warm-up
    const tLat0 = performance.now();
    const lat = toLatinUz('Ярко Кетчуп 500гр');
    const latMs = performance.now() - tLat0;
    assert.strictEqual(lat, 'Yarko Ketchup 500gr');
    assert.ok(latMs < 5);

    const cyrNorm = normalizeVerbatimInvoice({
      supplierName: 'Юсуфхон',
      currency: 'UZS',
      rows: ['1|Ярко Кетчуп 500гр|10 шт|45000|450000'],
      subtotalBeforeDiscount: 450000,
      discountPercent: 0,
      discountAmount: 0,
      hasExplicitDiscount: false,
      printedFinalTotal: 450000,
    });
    await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_X,
      supplierName: cyrNorm.supplierName || 'Yusufxon',
      rawTotal: cyrNorm.rawTotal || 450000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      items: cyrNorm.items,
      forceOverrideDuplicate: true,
    });
    const foundByCyrillic = await SearchService.searchProductsWithPriceDiff('кетчуп', TENANT_X);
    const foundByLatin = await SearchService.searchProductsWithPriceDiff('ketchup', TENANT_X);
    assert.ok(foundByCyrillic.length >= 1, 'Must find product by Cyrillic query');
    assert.ok(foundByLatin.length >= 1, 'Must find product by Latin query');
    console.log(
      `  ✅ PASS: 30s timeout, 1x retry, Natural Color OCR ${ocrMeta.width}x${ocrMeta.height} sRGB, toLatinUz ${latMs.toFixed(3)} ms, Cyrillic/Latin search OK!\n`
    );

    // ====================================================================
    // TEST 7: Zero-Hallucination & Strict Discount Guard (No Fake 1.6%, -5%, -21%, 2-Table A4)
    // ====================================================================
    console.log('▶ TEST 7 (Zero-Hallucination & Strict Discount Guard)...');
    assert.ok(COMPACT_SCANNER_PROMPT.includes('ZERO-HALLUCINATION') && COMPACT_SCANNER_PROMPT.includes('[⚠️ xira]'));

    const fakeGuard = reconcileInvoiceTotals({
      itemsSum: 2192300,
      subtotalBeforeDiscount: 2192300,
      discountPercent: 0,
      discountAmount: 0,
      printedFinalTotal: 2157300,
      hasExplicitDiscount: false,
    });
    assert.strictEqual(fakeGuard.discountPercent, 0);
    assert.strictEqual(fakeGuard.discountAmount, 0);
    assert.strictEqual(fakeGuard.finalTotal, 2157300);

    const fivePctGuard = reconcileInvoiceTotals({
      itemsSum: 2000000,
      subtotalBeforeDiscount: 2000000,
      discountPercent: 5,
      printedFinalTotal: 1900000,
      hasExplicitDiscount: true,
    });
    assert.strictEqual(fivePctGuard.rawTotal, 2000000);
    assert.strictEqual(fivePctGuard.discountAmount, 100000);
    assert.strictEqual(fivePctGuard.finalTotal, 1900000, 'Must NOT deduct 5% twice!');

    const nestleGuard = reconcileInvoiceTotals({
      itemsSum: 283822,
      subtotalBeforeDiscount: 283822,
      discountPercent: '-21%',
      discountAmount: '-59 602,62',
      printedFinalTotal: 224219.38,
      hasExplicitDiscount: true,
    });
    assert.strictEqual(nestleGuard.rawTotal, 283822);
    assert.strictEqual(nestleGuard.discountAmount, 59602.62);
    assert.strictEqual(nestleGuard.finalTotal, 224219.38, 'Must NOT deduct 21% twice!');

    const twoTableRoxat = reconcileInvoiceTotals({
      tableTotals: [1371040, 772432],
      discountPercent: 0,
      discountAmount: 0,
      hasExplicitDiscount: false,
    });
    assert.strictEqual(twoTableRoxat.finalTotal, 2143472);
    console.log('  ✅ PASS: Fake 1.6% blocked, -5% & -21% not double-deducted, 2-table A4 = 2,143,472 so\'m!\n');

    // ====================================================================
    // TEST 8: Handwritten Receipt ("GAZVADA - 5.000") & Anti-Duplicate Guard
    // ====================================================================
    console.log('▶ TEST 8 (Handwritten Receipt & Anti-Duplicate Guard)...');
    const hwItems = parseCompactScannerRows(
      [
        'GAZVADA - 5.000',
        'choy chupli kichik - 3.000',
        'Кола 2л - 18.000',
        'Flavis 1.5 - 12.000',
        '+18 - 12.000',
        '~Pepsi 1.5 - 15.000~',
      ],
      'UZS'
    );
    assert.strictEqual(hwItems[0].rawName, 'GAZVADA');
    assert.strictEqual(hwItems[0].lineTotal, 5000);
    assert.strictEqual(hwItems[2].rawName, 'Kola 2l');
    assert.strictEqual(hwItems[2].lineTotal, 18000);
    assert.strictEqual(hwItems[3].rawName, 'Flavis 1.5');
    assert.strictEqual(hwItems[3].lineTotal, 12000);
    assert.strictEqual(hwItems[4].rawName, '+18');
    assert.strictEqual(hwItems[5].lineTotal, 0);
    assert.strictEqual(
      hwItems.reduce((s, it) => s + it.lineTotal, 0),
      50000
    );

    const dupHash = SupplierService.computeImageHash(samplePhoto);
    const firstSave = await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_X,
      supplierName: 'HandwrittenShop',
      rawTotal: 50000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: dupHash,
      items: hwItems,
    });
    assert.strictEqual(firstSave.isDuplicate, false);

    // Stage 1: Exact same imageHash must be blocked
    const dupStage1 = await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_X,
      supplierName: 'HandwrittenShop',
      rawTotal: 50000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: dupHash,
      items: hwItems,
    });
    assert.strictEqual(dupStage1.isDuplicate, true);
    assert.strictEqual(dupStage1.duplicateStage, 'IMAGE_HASH');

    // Stage 2: Different photo angle (new imageHash) but identical contentFingerprint must be blocked
    const dupStage2 = await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_X,
      supplierName: 'HandwrittenShop',
      rawTotal: 50000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: 'different_angle_hash_999',
      items: hwItems,
    });
    assert.strictEqual(dupStage2.isDuplicate, true);
    assert.strictEqual(dupStage2.duplicateStage, 'CONTENT_FINGERPRINT');
    console.log('  ✅ PASS: Handwritten receipt (50,000 so\'m) parsed & both duplicate stages blocked!\n');

    // ====================================================================
    // TEST 9: Z-Report 5 Columns (10,000,000 so'm) & Yesterday Cash Guard
    // ====================================================================
    console.log('▶ TEST 9 (Z-Report 5 Columns & Yesterday Cash Guard)...');
    // Seed supplier with 6,000,000 debt
    await prisma.supplier.create({
      data: { ownerId: TENANT_ZREP, name: 'ZRepSupplier', debtUzs: 6000000, debtUsd: 0, isActive: true },
    });
    // 1. Today's cash purchase: 1,500,000 (TODAY_CASH)
    await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_ZREP,
      supplierName: 'ZRepCashVendor',
      rawTotal: 1500000,
      currency: 'UZS',
      paymentType: 'CASH',
      paymentSource: 'TODAY_CASH',
      paidCashAmount: 1500000,
      creditAmount: 0,
      forceOverrideDuplicate: true,
    });
    // 2. Today's cash payment to supplier: 2,000,000 (TODAY_CASH -> enters Z-Report)
    await SupplierService.recordSupplierPayment({
      ownerId: TENANT_ZREP,
      supplierName: 'ZRepSupplier',
      amount: 2000000,
      currency: 'UZS',
      paymentSource: 'TODAY_CASH',
    });
    // 3. Yesterday safe payment to supplier: 3,000,000 (PREVIOUS_SAFE -> deducts debt, EXCLUDED from today's Z-Report!)
    const prevSafeRes = await SupplierService.recordSupplierPayment({
      ownerId: TENANT_ZREP,
      supplierName: 'ZRepSupplier',
      amount: 3000000,
      currency: 'UZS',
      paymentSource: 'PREVIOUS_SAFE',
    });
    assert.strictEqual(Number(prevSafeRes.supplier.debtUzs), 1000000, 'Both payments (2M+3M) must deduct from debt');

    const zRep = await ReportService.generateAndSaveZReport({
      ownerId: TENANT_ZREP,
      terminalAmount: 2500000,
      clickAmount: 1500000,
      cashRemainingInDrawer: 2500000,
    });
    assert.strictEqual(zRep.dailyCashPurchasesUzs, 1500000);
    assert.strictEqual(zRep.dailySupplierPaymentsUzs, 2000000);
    assert.strictEqual(zRep.previousSafePaymentsUzs, 3000000);
    assert.strictEqual(
      zRep.totalDailySalesUzs,
      10000000,
      'Total Z-Report must be exact 10,000,000 so\'m (PREVIOUS_SAFE excluded!)'
    );
    assert.ok(zRep.formattedText.includes("bugungi savdoga qayta qo'shilmadi"));
    console.log("  ✅ PASS: 5-column Z-Report = 10,000,000 so'm; 3,000,000 PREVIOUS_SAFE deducted debt without inflating sales!\n");

    // ====================================================================
    // TEST 10: Weekly/Monthly 100% Cash vs Credit (40% / 60%) & Excel/PDF Export
    // ====================================================================
    console.log('▶ TEST 10 (Weekly/Monthly 100% Cash vs Credit & Export)...');
    await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_WEEKLY,
      supplierName: 'CashOnlyVendor',
      rawTotal: 4000000,
      currency: 'UZS',
      paymentType: 'CASH',
      paidCashAmount: 4000000,
      creditAmount: 0,
      forceOverrideDuplicate: true,
    });
    await SupplierService.createInvoiceWithItems({
      ownerId: TENANT_WEEKLY,
      supplierName: 'CreditOnlyVendor',
      rawTotal: 6000000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      paidCashAmount: 0,
      creditAmount: 6000000,
      forceOverrideDuplicate: true,
    });

    const weeklyReport = await ReportService.generateReport('current_week', new Date(), TENANT_WEEKLY);
    const monthlyReport = await ReportService.generateReport('current_month', new Date(), TENANT_WEEKLY);
    assert.ok(weeklyReport.includes('40% Naqd / 60% Nasiya'), 'Weekly report must show 40% Naqd / 60% Nasiya');
    assert.ok(monthlyReport.includes('40% Naqd / 60% Nasiya'), 'Monthly report must show 40% Naqd / 60% Nasiya');

    const exported = await ExportService.exportOwnerDatabase(TENANT_WEEKLY);
    assert.ok(exported.excelBuffer.byteLength > 100 && exported.excelText.startsWith('\uFEFF'));
    assert.ok(exported.excelText.includes('CashOnlyVendor') && exported.excelText.includes('CreditOnlyVendor'));
    const pdfStr = exported.pdfBuffer.toString('utf8');
    assert.ok(pdfStr.startsWith('%PDF-1.4') && pdfStr.includes('%%EOF'), 'PDF buffer must be valid PDF-1.4');
    assert.ok(exported.htmlContent.includes('<!DOCTYPE html>'));
    console.log('  ✅ PASS: Weekly & Monthly 40% Naqd / 60% Nasiya (100%) + Excel/PDF/HTML Export verified!\n');

    console.log('====================================================================');
    console.log('✅ BARCHA 10 TA SAAS PRODUCTION AUDIT E2E TESTLAR 100% PASS ✅!');
    console.log('====================================================================');
  } finally {
    await cleanupAllTestOwners();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ SAAS AUDIT E2E SUITE FAILED:', err);
  process.exit(1);
});

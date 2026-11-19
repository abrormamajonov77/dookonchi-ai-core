/**
 * MODUL 6: Automated E2E Verification Suite (`scripts/verify-5-problems-e2e.ts`)
 * Verifies all 5 problem solutions end-to-end against PostgreSQL / Prisma:
 * - TEST 1 (30s Timeout & Background Latin): 30s timeout, retryOnceOnTimeout, 2-table A4 "Roxat" (1,371,040 + 772,432 = 2,143,472) & <5ms background Latin conversion.
 * - TEST 2 (No Hallucination & Strict Discount Guard): No fake 1.6% (-35,076.80) discount when paper has no discount, while preserving real Nestle -21% (-59,602.62 -> 224,219.38) without double deduction.
 * - TEST 3 (Makiz 500.000 Payment Fix): `parseSmartAmount("500.000") === 500000`, `parseSmartAmount("50.17$") === 50.17`, and "Makiz" 500.000 UZS payment recorded & deducted in Postgres.
 * - TEST 4 (Handwritten Receipt "GAZVADA - 5.000"): Handwritten list items ("GAZVADA - 5.000", "choy chupli kichik - 3.000", "Кола 2л - 18.000", "Flavis 1.5 - 12.000", "+18 - 12.000", "~Pepsi 1.5 - 15.000~") parsed accurately.
 * - TEST 5 (Natural Color OCR Image & Code Deduplication): `ImageService.optimizeForFastOCR` outputs natural color sRGB JPEG, highest-res photo index is used, and zero duplicate callback handlers exist.
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
  parseHandwrittenReceiptLine,
  retryOnceOnTimeout,
} from '../src/services/ai.service';
import { ImageService } from '../src/services/image.service';
import { SupplierService } from '../src/services/supplier.service';
import { parseCurrencyAndAmount, parseSmartAmount, reconcileInvoiceTotals } from '../src/utils/formatters';
import { toLatinUz } from '../src/utils/transliterate';

const TEST_OWNER_ID = '9995550011';

async function cleanupTestRecords() {
  await prisma.supplierPayment.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.supplierTransaction.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.invoiceItem.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.invoice.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.supplier.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.product.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
}

async function createSamplePhotoBuffer(): Promise<Buffer> {
  const svg = `
    <svg width="1000" height="1400" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#e9e4d8"/>
      <text x="50" y="100" font-size="36" fill="#1b1b1b" font-family="Arial">НАКЛАДНАЯ №145 - РОХАТ</text>
      <text x="50" y="180" font-size="28" fill="#222222" font-family="Arial">1. GAZVADA - 5.000</text>
      <text x="50" y="240" font-size="28" fill="#222222" font-family="Arial">2. Flavis 1.5 - 12.000</text>
      <text x="50" y="300" font-size="32" fill="#111111" font-family="Arial">ИТОГО: 2 143 472 сум</text>
    </svg>
  `;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  console.log('====================================================================');
  console.log('🚀 SMARTBAQQOL AI — 5 PROBLEMS & CODE DEDUPLICATION E2E SUITE');
  console.log('====================================================================\n');

  await prisma.$connect();
  await cleanupTestRecords();

  try {
    // ====================================================================
    // TEST 1: 30s Timeout, Auto-Retry, 2-Table A4 "Roxat" & Background Latin
    // ====================================================================
    console.log('▶ TEST 1 (30s Timeout & Background Latin)...');
    assert.strictEqual(OCR_TIMEOUT_MS, 30000, 'OCR_TIMEOUT_MS must be 30,000 ms (30s)');
    assert.strictEqual(DEFAULT_GENERATION_CONFIG.temperature, 0.1);
    assert.strictEqual(DEFAULT_GENERATION_CONFIG.maxOutputTokens, 2048);

    // Verify retryOnceOnTimeout automatically retries once on first timeout/transient error
    let attempts = 0;
    const retryResult = await retryOnceOnTimeout(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Gemini OCR request timed out (30s)');
        }
        return 'OK_ON_RETRY';
      },
      1000,
      'TestOCR'
    );
    assert.strictEqual(retryResult, 'OK_ON_RETRY');
    assert.strictEqual(attempts, 2, 'retryOnceOnTimeout must auto-retry once on timeout');

    // Verify 2-table A4 "Roxat" invoice (1,371,040 + 772,432 = 2,143,472) & background Cyrillic->Latin
    const roxatTwoTableRaw = {
      supplierName: 'Рохат',
      paymentMethod: 'CREDIT',
      currency: 'UZS',
      rows: [
        '1|Печенье Рохат Классик|10 кор|137104|1371040',
        '2|Вафли Рохат Шоколад|8 кор|96554|772432',
      ],
      subtotalBeforeDiscount: 2143472,
      discountPercent: 0,
      discountAmount: 0,
      hasExplicitDiscount: false,
      tableTotals: [1371040, 772432],
      printedFinalTotal: 2143472,
    };
    // Warm up V8 JIT once
    normalizeVerbatimInvoice(roxatTwoTableRaw, 'Roxat');
    toLatinUz('1|Печенье Рохат Классик|10 кор|137104|1371040');

    const tLatin0 = performance.now();
    const latinSample = toLatinUz('1|Печенье Рохат Классик|10 кор|137104|1371040');
    const latinMs = performance.now() - tLatin0;
    assert.ok(latinMs < 5, `Background toLatinUz must be <5ms (got ${latinMs.toFixed(3)}ms)`);
    assert.ok(latinSample.includes('Pechenye Roxat Klassik'));

    const t0 = performance.now();
    const normalizedRoxat = normalizeVerbatimInvoice(roxatTwoTableRaw, 'Roxat');
    const elapsedMs = performance.now() - t0;

    assert.ok(elapsedMs < 100, `Background Latin conversion & normalization must be ultra-fast (<100ms, got ${elapsedMs.toFixed(2)}ms)`);
    assert.strictEqual(normalizedRoxat.supplierName, 'Roxat');
    assert.strictEqual(normalizedRoxat.finalTotal, 2143472, '2-table A4 totals (1,371,040 + 772,432) must equal 2,143,472');
    assert.strictEqual(normalizedRoxat.discountAmount, 0);
    assert.strictEqual(normalizedRoxat.items[0].rawName, 'Pechenye Roxat Klassik');
    assert.strictEqual(normalizedRoxat.items[1].rawName, 'Vafli Roxat Shokolad');
    console.log(
      `  ✅ PASS: 30s timeout, auto-retry (${attempts} attempts), 2-table A4 Roxat = 2,143,472 so'm, toLatinUz in ${latinMs.toFixed(3)} ms\n`
    );

    // ====================================================================
    // TEST 2: No Hallucination & Strict Discount Guard (No Fake 1.6% Discount + Nestle -21%)
    // ====================================================================
    console.log('▶ TEST 2 (No Hallucination & Strict Discount Guard)...');
    assert.ok(
      COMPACT_SCANNER_PROMPT.includes('ZERO-HALLUCINATION') && COMPACT_SCANNER_PROMPT.includes('[⚠️ xira]'),
      'Prompt must include strict Zero-Hallucination rule and [⚠️ xira] marker'
    );

    // Case A: Receipt has NO discount on paper, even if row sum (2,192,300) differs from printedFinalTotal (2,157,300)
    const noDiscountCheck = reconcileInvoiceTotals({
      itemsSum: 2192300,
      subtotalBeforeDiscount: 2192300,
      discountPercent: 0,
      discountAmount: 0,
      printedFinalTotal: 2157300,
      hasExplicitDiscount: false,
    });
    assert.strictEqual(noDiscountCheck.discountPercent, 0, 'Must NOT invent a fake 1.6% discount!');
    assert.strictEqual(noDiscountCheck.discountAmount, 0, 'Must NOT invent a fake -35,076.80 discount!');
    assert.strictEqual(noDiscountCheck.finalTotal, 2157300, 'Final total must match printedFinalTotal');

    // Case B: Nestle receipt with explicit -21% discount (-59,602.62) on 283,822.00 = 224,219.38
    const nestleCheck = reconcileInvoiceTotals({
      itemsSum: 283822,
      subtotalBeforeDiscount: 283822,
      discountPercent: '-21%',
      discountAmount: '-59 602,62',
      printedFinalTotal: 224219.38,
      hasExplicitDiscount: true,
    });
    assert.strictEqual(nestleCheck.rawTotal, 283822);
    assert.strictEqual(nestleCheck.discountPercent, 21);
    assert.strictEqual(nestleCheck.discountAmount, 59602.62);
    assert.strictEqual(nestleCheck.finalTotal, 224219.38, 'Must NOT deduct -21% twice!');
    assert.strictEqual(nestleCheck.alreadyDeductedOnPaper, true);
    console.log(
      '  ✅ PASS: Fake 1.6% discount completely blocked (0), Nestle -21% (-59,602.62 -> 224,219.38) preserved without double deduction\n'
    );

    // ====================================================================
    // TEST 3: Makiz 500.000 Payment Fix & parseSmartAmount
    // ====================================================================
    console.log('▶ TEST 3 (Makiz 500.000 Payment Fix)...');
    assert.strictEqual(parseSmartAmount('500.000'), 500000);
    assert.strictEqual(parseSmartAmount('500,000'), 500000);
    assert.strictEqual(parseSmartAmount('500 000'), 500000);
    assert.strictEqual(parseSmartAmount('500000'), 500000);
    assert.strictEqual(parseSmartAmount('1.371.040'), 1371040);
    assert.strictEqual(parseSmartAmount('50.17$'), 50.17);
    assert.strictEqual(parseSmartAmount('102,17'), 102.17);
    assert.strictEqual(parseCurrencyAndAmount('500.000').amount, 500000);

    // Create Makiz supplier with 1,200,000 UZS debt and record a "500.000" UZS payment
    const makiz = await prisma.supplier.create({
      data: {
        ownerId: TEST_OWNER_ID,
        name: 'Makiz',
        debtUzs: 1200000,
        debtUsd: 0,
        isActive: true,
      },
    });
    const parsedPaymentAmount = parseSmartAmount('500.000');
    const payRes = await SupplierService.recordSupplierPayment({
      ownerId: TEST_OWNER_ID,
      supplierId: makiz.id,
      supplierName: makiz.name,
      amount: parsedPaymentAmount,
      currency: 'UZS',
      paymentSource: 'TODAY_CASH',
    });

    assert.strictEqual(Number(payRes.supplier.debtUzs), 700000, 'Makiz debt must decrease from 1,200,000 to 700,000');
    assert.strictEqual(Number(payRes.payment.amount), 500000);
    assert.strictEqual(payRes.transaction.paymentSource, 'TODAY_CASH');
    console.log(
      '  ✅ PASS: parseSmartAmount("500.000") === 500000, Makiz debt updated 1,200,000 -> 700,000 so\'m in Postgres\n'
    );

    // ====================================================================
    // TEST 4: Handwritten Receipt List Mode ("GAZVADA - 5.000", "Flavis 1.5 - 12.000")
    // ====================================================================
    console.log('▶ TEST 4 (Handwritten Receipt "GAZVADA - 5.000")...');
    const handwrittenRows = [
      'GAZVADA - 5.000',
      'choy chupli kichik - 3.000',
      'Кола 2л - 18.000',
      'Flavis 1.5 - 12.000',
      '+18 - 12.000',
      '~Pepsi 1.5 - 15.000~',
    ];
    const parsedHwItems = parseCompactScannerRows(handwrittenRows, 'UZS');
    assert.strictEqual(parsedHwItems.length, 6);

    assert.strictEqual(parsedHwItems[0].rawName, 'GAZVADA');
    assert.strictEqual(parsedHwItems[0].lineTotal, 5000);

    assert.strictEqual(parsedHwItems[1].rawName, 'choy chupli kichik');
    assert.strictEqual(parsedHwItems[1].lineTotal, 3000);

    assert.strictEqual(parsedHwItems[2].rawName, 'Kola 2l', 'Cyrillic "Кола 2л" must become "Kola 2l"');
    assert.strictEqual(parsedHwItems[2].lineTotal, 18000);

    assert.strictEqual(parsedHwItems[3].rawName, 'Flavis 1.5', '"1.5" must stay in product name, NOT price');
    assert.strictEqual(parsedHwItems[3].lineTotal, 12000);

    assert.strictEqual(parsedHwItems[4].rawName, '+18', '"+18" must stay in product name');
    assert.strictEqual(parsedHwItems[4].lineTotal, 12000);

    assert.strictEqual(parsedHwItems[5].lineTotal, 0, 'Crossed-out item "~Pepsi 1.5 - 15.000~" must have 0 sum');

    const hwSum = parsedHwItems.reduce((acc, it) => acc + it.lineTotal, 0);
    assert.strictEqual(hwSum, 50000, 'Sum of active handwritten items must be 50,000 so\'m');
    console.log(
      '  ✅ PASS: Handwritten items ("GAZVADA - 5.000", "Flavis 1.5 - 12.000", "Kola 2l - 18.000", "+18 - 12.000") parsed to 50,000 so\'m\n'
    );

    // ====================================================================
    // TEST 5: Natural Color OCR Image & Code Deduplication Check
    // ====================================================================
    console.log('▶ TEST 5 (Natural Color OCR Image & Code Deduplication)...');
    const sampleBuf = await createSamplePhotoBuffer();
    const ocrBuf = await ImageService.optimizeForFastOCR(sampleBuf);
    assert.ok(ocrBuf && ocrBuf.byteLength > 1000, 'OCR buffer must not be empty');

    const meta = await sharp(ocrBuf).metadata();
    assert.strictEqual(meta.format, 'jpeg');
    assert.strictEqual(meta.channels, 3, 'OCR image must remain 3-channel color sRGB');
    assert.strictEqual(meta.space, 'srgb');

    // Verify invoice.ts uses highest-res photo index `photos[photos.length - 1]` and does NOT re-send B&W xerox
    const invoiceHandlerSrc = fs.readFileSync(
      path.join(__dirname, '../src/bot/handlers/invoice.ts'),
      'utf8'
    );
    assert.ok(
      invoiceHandlerSrc.includes('photos[photos.length - 1]'),
      'invoice.ts must take the highest-resolution photo (photos[photos.length - 1])'
    );
    assert.ok(
      !invoiceHandlerSrc.includes('createUltraBrightXeroxImage') &&
        !invoiceHandlerSrc.includes('kserokopiya.jpg'),
      'invoice.ts must NOT use HD Xerox filter or re-send B&W kserokopiya'
    );

    // Verify no duplicate callbackQuery patterns across handler files
    const handlersDir = path.join(__dirname, '../src/bot/handlers');
    const handlerFiles = fs.readdirSync(handlersDir).filter((f) => f.endsWith('.ts'));
    const seenPatterns = new Map<string, string>();
    for (const file of handlerFiles) {
      const content = fs.readFileSync(path.join(handlersDir, file), 'utf8');
      const regex = /\.callbackQuery\(\s*([^,\n]+)\s*,/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const patternKey = match[1].trim();
        assert.ok(
          !seenPatterns.has(patternKey),
          `Duplicate callbackQuery pattern ${patternKey} found in ${file} and ${seenPatterns.get(patternKey)}`
        );
        seenPatterns.set(patternKey, file);
      }
    }
    console.log(
      `  ✅ PASS: Natural color OCR image (${meta.width}x${meta.height} sRGB JPEG, ${(ocrBuf.byteLength / 1024).toFixed(1)} KB) & 0 duplicate handlers across ${handlerFiles.length} files\n`
    );

    console.log('====================================================================');
    console.log('✅ BARCHA 5 TA MUAMMO YECHIMI VA E2E TESTLAR 100% MUVAFFAQIYATLI (PASS ✅)!');
    console.log('====================================================================');
  } finally {
    await cleanupTestRecords();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ E2E VERIFICATION FAILED:', err);
  process.exit(1);
});

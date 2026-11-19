/**
 * Automated E2E Verification Script (`scripts/verify-original-photo-revert.ts`)
 * Verifies:
 *  1. Complete removal of HD Xerox / B&W contrast filters from `src/` (zero occurrences of
 *     `createUltraBrightXeroxImage`, `.grayscale(`, `.linear(`, `.normalize(`, `.modulate(`, `.sharpen(`).
 *  2. Natural color JPEG OCR preparation (3 channels / sRGB with real color preservation,
 *     no enlargement beyond original width, capped at 1600px) + deterministic SHA-256 `imageHash`.
 *  3. Exact preservation of user's original Telegram `file_id` (`photos[photos.length - 1].file_id`)
 *     in `Invoice.imageFileId` & `SupplierTransaction.photoFileId` in PostgreSQL, plus Stage 1 duplicate guard.
 *  4. Core existing features remain 100% intact (30s OCR timeout + auto-retry, background `toLatinUz` <5ms,
 *     `parseSmartAmount("500.000") === 500000`, Strict Discount Guard + Double-Discount Guard,
 *     Handwritten "GAZVADA - 5.000" mode).
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { prisma } from '../src/database/prisma';
import { ImageService } from '../src/services/image.service';
import { SupplierService } from '../src/services/supplier.service';
import {
  OCR_MAX_OUTPUT_TOKENS,
  OCR_TIMEOUT_MS,
  extractCleanJson,
  parseCompactScannerRows,
  retryOnceOnTimeout,
} from '../src/services/ai.service';
import { parseSmartAmount, reconcileInvoiceTotals } from '../src/utils/formatters';
import { toLatinUz } from '../src/utils/transliterate';

const TEST_OWNER_ID = '9997770088';

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

async function createColorReceiptBuffer(width = 1200, height = 1600): Promise<Buffer> {
  // Real multi-color receipt (warm cream paper, blue pen text, red stamp)
  const svg = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f7efe0"/>
      <rect x="60" y="60" width="380" height="120" rx="12" fill="#d93829"/>
      <text x="90" y="135" font-size="42" fill="#ffffff" font-family="Arial">STAMP RED</text>
      <text x="60" y="260" font-size="38" fill="#1038a8" font-family="Arial">GAZVADA - 5.000</text>
      <text x="60" y="340" font-size="38" fill="#1038a8" font-family="Arial">Flavis 1.5 - 12.000</text>
      <circle cx="950" cy="220" r="95" fill="#1e8449"/>
    </svg>
  `;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function cleanupTestRecords() {
  await prisma.supplierPayment.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.supplierTransaction.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.invoiceItem.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.invoice.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.supplier.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
  await prisma.product.deleteMany({ where: { ownerId: TEST_OWNER_ID } }).catch(() => {});
}

async function main() {
  console.log('====================================================================');
  console.log('🧪 SMARTBAQQOL — ORIGINAL COLOR PHOTO REVERT E2E VERIFICATION');
  console.log('====================================================================\n');

  await prisma.$connect();
  await cleanupTestRecords();

  try {
    // ====================================================================
    // CHECK 1: Static Audit — Zero HD Xerox / B&W Filters in src/
    // ====================================================================
    console.log('▶ CHECK 1: Static Audit of src/ (Zero HD Xerox / B&W Filters)...');
    const srcDir = path.join(__dirname, '../src');
    const tsFiles = walkTsFiles(srcDir);
    const forbiddenPatterns = [
      'createUltraBrightXeroxImage',
      '.grayscale(',
      '.linear(',
      '.normalize(',
      '.modulate(',
      '.sharpen(',
      'kserokopiya.jpg',
    ];

    for (const filePath of tsFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const pattern of forbiddenPatterns) {
        assert.ok(
          !content.includes(pattern),
          `Forbidden B&W/xerox pattern "${pattern}" found in ${path.relative(srcDir, filePath)}`
        );
      }
    }

    const invoiceSrc = fs.readFileSync(path.join(srcDir, 'bot/handlers/invoice.ts'), 'utf8');
    assert.ok(
      invoiceSrc.includes('photos[photos.length - 1]'),
      'invoice.ts must extract highest-resolution photo via photos[photos.length - 1]'
    );
    assert.ok(
      !invoiceSrc.includes('replyWithPhoto('),
      'invoice.ts must NOT send back a processed/xerox photo after reading invoice'
    );

    const suppliersSrc = fs.readFileSync(path.join(srcDir, 'bot/handlers/suppliers.ts'), 'utf8');
    assert.ok(
      suppliersSrc.includes("caption: '🖼 Asl nakladnoy rasmi'") &&
        suppliersSrc.includes('invoice?.imageFileId'),
      'suppliers.ts must show original photo using invoice.imageFileId with caption "🖼 Asl nakladnoy rasmi"'
    );
    console.log(`  ✅ PASS: Audited ${tsFiles.length} files in src/ — 0 B&W/xerox filters found!\n`);

    // ====================================================================
    // CHECK 2: Natural Color JPEG Preparation (3-channel sRGB) + SHA-256 Hash
    // ====================================================================
    console.log('▶ CHECK 2: Natural Color OCR Preparation (3-channel sRGB JPEG)...');
    const rawColorSmall = await createColorReceiptBuffer(1200, 1600);
    const ocrSmall = await ImageService.optimizeForFastOCR(rawColorSmall);
    const metaSmall = await sharp(ocrSmall).metadata();

    assert.strictEqual(metaSmall.format, 'jpeg', 'OCR output must be JPEG');
    assert.strictEqual(metaSmall.channels, 3, 'OCR output must have 3 color channels (RGB)');
    assert.strictEqual(metaSmall.space, 'srgb', 'OCR output color space must be sRGB');
    assert.strictEqual(metaSmall.width, 1200, 'withoutEnlargement: true must NOT upscale 1200px image');

    // Verify genuine color saturation is preserved (not collapsed to R==G==B grayscale)
    const { data: rawRgb } = await sharp(ocrSmall).raw().toBuffer({ resolveWithObject: true });
    let maxChromaDiff = 0;
    for (let i = 0; i < rawRgb.length; i += 3 * 37) {
      const r = rawRgb[i];
      const g = rawRgb[i + 1];
      const b = rawRgb[i + 2];
      const diff = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
      if (diff > maxChromaDiff) maxChromaDiff = diff;
    }
    assert.ok(
      maxChromaDiff > 100,
      `Color channels must preserve true RGB hues (expected chroma diff > 100, got ${maxChromaDiff})`
    );

    // Also verify large 2400px image scales down cleanly to 1600px max width
    const rawColorLarge = await createColorReceiptBuffer(2400, 3200);
    const ocrLarge = await ImageService.optimizeForFastOCR(rawColorLarge);
    const metaLarge = await sharp(ocrLarge).metadata();
    assert.strictEqual(metaLarge.width, 1600, 'Large image must resize cleanly to width=1600');
    assert.strictEqual(metaLarge.channels, 3);
    assert.strictEqual(metaLarge.space, 'srgb');

    // Verify SHA-256 imageHash
    const hash1 = ImageService.getImageHash(rawColorSmall);
    const hash2 = ImageService.getImageHash(rawColorSmall);
    assert.strictEqual(hash1, hash2);
    assert.strictEqual(hash1.length, 64, 'SHA-256 imageHash must be 64 hex chars');
    console.log(
      `  ✅ PASS: Color sRGB JPEG (3 channels, chromaDiff=${maxChromaDiff}, 1200px kept / 2400px->1600px), SHA-256 hash OK!\n`
    );

    // ====================================================================
    // CHECK 3: Original Telegram file_id Preserved Unchanged in PostgreSQL
    // ====================================================================
    console.log('▶ CHECK 3: Original Telegram file_id Persistence in Invoice & SupplierTransaction...');
    const originalFileId = 'AgACAgIAAxkBAAIB_ORIGINAL_COLOR_PHOTO_FILE_ID_TEST_001';
    const created = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_ID,
      supplierName: 'OriginalPhotoTestSupplier',
      invoiceNo: 'ORIG-001',
      rawTotal: 17000,
      discountInput: 0,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: hash1,
      imageFileId: originalFileId,
      photoFileId: originalFileId,
      rawImageUrl: 'photos/file_orig_001.jpg',
      items: [
        { rawName: 'GAZVADA', quantity: 1, unit: 'dona', unitPrice: 5000, lineTotal: 5000, currency: 'UZS' },
        { rawName: 'Flavis 1.5', quantity: 1, unit: 'dona', unitPrice: 12000, lineTotal: 12000, currency: 'UZS' },
      ],
    });

    assert.strictEqual(created.isDuplicate, false);
    const dbInvoice = await prisma.invoice.findUnique({ where: { id: created.invoice.id } });
    const dbTx = await prisma.supplierTransaction.findUnique({ where: { id: created.transaction.id } });

    assert.strictEqual(
      dbInvoice?.imageFileId,
      originalFileId,
      'Invoice.imageFileId must store exact original Telegram file_id unchanged'
    );
    assert.strictEqual(
      dbTx?.photoFileId,
      originalFileId,
      'SupplierTransaction.photoFileId must store exact original Telegram file_id unchanged'
    );
    assert.strictEqual(dbInvoice?.imageHash, hash1, 'Invoice.imageHash must be saved for duplicate guard');

    // Stage 1 duplicate guard still blocks exact same photo hash
    const dupRes = await SupplierService.createInvoiceWithItems({
      ownerId: TEST_OWNER_ID,
      supplierName: 'OriginalPhotoTestSupplier',
      rawTotal: 17000,
      currency: 'UZS',
      paymentType: 'CREDIT',
      imageHash: hash1,
      imageFileId: originalFileId,
      photoFileId: originalFileId,
    });
    assert.strictEqual(dupRes.isDuplicate, true, 'Duplicate imageHash must still be blocked');
    console.log(
      `  ✅ PASS: Invoice.imageFileId & SupplierTransaction.photoFileId === original file_id, duplicate guard intact!\n`
    );

    // ====================================================================
    // CHECK 4: Core Existing Features Intact (30s Timeout, toLatinUz, parseSmartAmount, Strict Discount Guard)
    // ====================================================================
    console.log('▶ CHECK 4: Core Features Regression Check...');
    // 4.1: 30s OCR timeout + auto-retry + 16384 OCR token budget (prevents Gemini 3 thinking token truncation)
    assert.strictEqual(OCR_TIMEOUT_MS, 30000, 'OCR_TIMEOUT_MS must stay 30000 (30s)');
    assert.strictEqual(OCR_MAX_OUTPUT_TOKENS, 16384, 'OCR_MAX_OUTPUT_TOKENS must be 16384 to cover Gemini 3 thinking + JSON');
    const recoveredJson = extractCleanJson(
      '{\n"supplierName": "Roxat",\n"rows": [\n"1|Печенье "Рохат" Классик|10 кор|45000|450000",\n],\n"printedFinalTotal": 450000\n}'
    );
    assert.strictEqual(recoveredJson.supplierName, 'Roxat');
    assert.strictEqual(recoveredJson.rows.length, 1);
    assert.strictEqual(recoveredJson.printedFinalTotal, 450000);

    let attempts = 0;
    const retryOut = await retryOnceOnTimeout(async () => {
      attempts++;
      if (attempts === 1) throw new Error('Gemini OCR request timed out (30s)');
      return 'RETRIED_OK';
    }, 1000);
    assert.strictEqual(retryOut, 'RETRIED_OK');
    assert.strictEqual(attempts, 2);

    // 4.2: Background toLatinUz (<5ms)
    toLatinUz('Печенье Рохат Классик'); // JIT warm-up
    const t0 = performance.now();
    const latin = toLatinUz('Печенье Рохат Классик');
    const latinMs = performance.now() - t0;
    assert.strictEqual(latin, 'Pechenye Roxat Klassik');
    assert.ok(latinMs < 5, `Background toLatinUz must be <5ms (got ${latinMs.toFixed(3)}ms)`);

    // 4.3: Makiz 500.000 & $50.17 parseSmartAmount
    assert.strictEqual(parseSmartAmount('500.000'), 500000);
    assert.strictEqual(parseSmartAmount('50.17$'), 50.17);

    // 4.4: Strict Discount Guard & Double-Discount Guard
    const noFakeDiscount = reconcileInvoiceTotals({
      itemsSum: 2192300,
      subtotalBeforeDiscount: 2192300,
      discountPercent: 0,
      discountAmount: 0,
      printedFinalTotal: 2157300,
      hasExplicitDiscount: false,
    });
    assert.strictEqual(noFakeDiscount.discountAmount, 0, 'Must NOT invent fake 1.6% discount');
    assert.strictEqual(noFakeDiscount.finalTotal, 2157300);

    const nestleRealDiscount = reconcileInvoiceTotals({
      itemsSum: 283822,
      subtotalBeforeDiscount: 283822,
      discountPercent: '-21%',
      discountAmount: '-59 602,62',
      printedFinalTotal: 224219.38,
      hasExplicitDiscount: true,
    });
    assert.strictEqual(nestleRealDiscount.discountAmount, 59602.62);
    assert.strictEqual(nestleRealDiscount.finalTotal, 224219.38, 'Must NOT double-deduct -21%');

    // 4.5: Handwritten GAZVADA - 5.000 mode
    const hwItems = parseCompactScannerRows(['GAZVADA - 5.000', 'Flavis 1.5 - 12.000'], 'UZS');
    assert.strictEqual(hwItems[0].rawName, 'GAZVADA');
    assert.strictEqual(hwItems[0].lineTotal, 5000);
    assert.strictEqual(hwItems[1].rawName, 'Flavis 1.5');
    assert.strictEqual(hwItems[1].lineTotal, 12000);

    console.log(
      `  ✅ PASS: 30s timeout + retry, toLatinUz (${latinMs.toFixed(3)}ms), parseSmartAmount("500.000")===500000, Strict Discount Guard & GAZVADA mode ALL OK!\n`
    );

    console.log('====================================================================');
    console.log('✅ BARCHA E2E TEKSHIRUVLAR 100% MUVAFFAQIYATLI O\'TDI (PASS ✅)!');
    console.log('====================================================================');
  } finally {
    await cleanupTestRecords();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('❌ VERIFICATION FAILED:', err);
  process.exit(1);
});

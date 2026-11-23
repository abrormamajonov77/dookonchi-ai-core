import { describe, it, expect } from 'vitest';
import {
  computeSupplierBalanceFromLedger,
  SupplierFullHistoryResult,
} from '../src/services/supplier.service';
import {
  normalizePdfUzbekText,
  renderSupplierHistoryPdfBuffer,
  sanitizeSupplierFilename,
} from '../src/services/export.service';
import {
  findPriceIncreasesAgainstHistory,
  formatPriceIncreaseAlertsBlock,
} from '../src/services/search.service';
import { parseAmountAndOptionalNote } from '../src/bot/handlers/suppliers';
import { buildPendingPreviewMessage } from '../src/bot/handlers/invoice';
import { ReportService, RawReportInputs } from '../src/services/report.service';

describe('Supplier Balance with INCOMING_GOODS, PAYMENT, and RETURN', () => {
  it('computes net debt separately for UZS and USD: Incoming - Payments - Returns', () => {
    const t1 = new Date('2026-11-01T10:00:00Z');
    const t2 = new Date('2026-11-02T10:00:00Z');
    const t3 = new Date('2026-11-03T10:00:00Z');

    const balance = computeSupplierBalanceFromLedger('owner-1', 'sup-1', {
      transactions: [
        { id: 'tx-1', type: 'INCOMING_GOODS', amount: 1500000, currency: 'UZS', date: t1, invoiceId: 'inv-1' },
        { id: 'tx-2', type: 'PAYMENT', amount: 500000, currency: 'UZS', date: t2 },
        { id: 'tx-3', type: 'RETURN', amount: 250000, currency: 'UZS', date: t3 },
        { id: 'tx-4', type: 'INCOMING_GOODS', amount: 200.5, currency: 'USD', date: t1, invoiceId: 'inv-2' },
        { id: 'tx-5', type: 'PAYMENT', amount: 50.25, currency: 'USD', date: t2 },
        { id: 'tx-6', type: 'RETURN', amount: 30.25, currency: 'USD', date: t3 },
      ],
      invoices: [
        { id: 'inv-1', totalAmount: 1500000, paidCashAmount: 0, creditAmount: 1500000, paymentType: 'CREDIT', currency: 'UZS', createdAt: t1 },
        { id: 'inv-2', totalAmount: 200.5, paidCashAmount: 0, creditAmount: 200.5, paymentType: 'CREDIT', currency: 'USD', createdAt: t1 },
      ],
      // Linked SupplierPayment rows created alongside SupplierTransaction(PAYMENT) must not double-count
      payments: [
        { id: 'pay-1', amount: 500000, currency: 'UZS', createdAt: t2 },
        { id: 'pay-2', amount: 50.25, currency: 'USD', createdAt: t2 },
      ],
    });

    expect(balance.uzs).toEqual({
      totalIncoming: 1500000,
      totalPayments: 500000,
      totalReturns: 250000,
      netDebt: 750000,
    });
    expect(balance.usd).toEqual({
      totalIncoming: 200.5,
      totalPayments: 50.25,
      totalReturns: 30.25,
      netDebt: 120,
    });
    expect(balance.debtUzs).toBe(750000);
    expect(balance.debtUsd).toBe(120);
  });

  it('nets CASH invoices to zero debt and handles PARTIAL invoices cleanly', () => {
    const t1 = new Date('2026-11-05T10:00:00Z');
    const t2 = new Date('2026-11-06T10:00:00Z');

    const balance = computeSupplierBalanceFromLedger('owner-1', 'sup-2', {
      transactions: [
        { id: 'tx-c1', type: 'INCOMING_GOODS', amount: 400000, currency: 'UZS', date: t1, invoiceId: 'inv-cash' },
        { id: 'tx-p1', type: 'INCOMING_GOODS', amount: 1000000, currency: 'UZS', date: t2, invoiceId: 'inv-partial' },
        { id: 'tx-r1', type: 'RETURN', amount: 100000, currency: 'UZS', date: t2 },
      ],
      invoices: [
        { id: 'inv-cash', totalAmount: 400000, paidCashAmount: 400000, creditAmount: 0, paymentType: 'CASH', currency: 'UZS', createdAt: t1 },
        { id: 'inv-partial', totalAmount: 1000000, paidCashAmount: 300000, creditAmount: 700000, paymentType: 'PARTIAL', currency: 'UZS', createdAt: t2 },
      ],
    });

    expect(balance.uzs.totalIncoming).toBe(1400000);
    expect(balance.uzs.totalPayments).toBe(700000);
    expect(balance.uzs.totalReturns).toBe(100000);
    expect(balance.debtUzs).toBe(600000);
  });

  it('excludes RETURN transactions from cash outflow in ReportService while reducing net supplier debt change', () => {
    const inputs: RawReportInputs = {
      registers: [],
      supplierTransactions: [
        { type: 'INCOMING_GOODS', amount: 1000000, currency: 'UZS', supplier: { name: 'Milter' } },
        { type: 'PAYMENT', amount: 300000, currency: 'UZS', supplier: { name: 'Milter' } },
        { type: 'RETURN', amount: 200000, currency: 'UZS', supplier: { name: 'Milter' } },
      ],
      totalSupplierDebtUzs: 500000,
      totalSupplierDebtUsd: 0,
      cashTransactions: [],
      newCustomerDebts: [],
      updatedCustomerDebts: [],
      activeCustomerDebts: [],
      expenses: [],
    };
    const m = ReportService.aggregateReportData(inputs, 7);
    expect(m.supplierPaidUzs).toBe(300000);
    expect(m.outflowUzs).toBe(300000);
    expect(m.supplierReturnsUzs).toBe(200000);
    expect(m.netSupplierDebtChangeUzs).toBe(500000);
  });
});

describe('Supplier History PDF Export (Sverka)', () => {
  it('sanitizes supplier names cleanly for PDF filenames and normalizes Uzbek Latin / Cyrillic', () => {
    expect(sanitizeSupplierFilename("O'rikzor Savdo #1")).toBe('Orikzor_Savdo_1');
    expect(sanitizeSupplierFilename('Ёғ-Мой База')).toBe('Yog_Moy_Baza');
    expect(normalizePdfUzbekText("G‘isht va Oʻrik — 5 ta yog'")).toBe("G'isht va O'rik - 5 ta yog'");
    expect(normalizePdfUzbekText("Qo'qon 🚀")).not.toContain('?');
  });

  it('renders a valid multi-page PDF buffer with Uzbek headers, columns, entries, and UZS/USD summary footer', async () => {
    const entries = Array.from({ length: 45 }, (_, i) => ({
      id: `e-${i}`,
      date: new Date(Date.UTC(2026, 9, 1 + (i % 28), 6, 0, 0)),
      createdAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 6, 0, 0)),
      type: (i % 3 === 0 ? 'INCOMING_GOODS' : i % 3 === 1 ? 'PAYMENT' : 'RETURN') as
        | 'INCOMING_GOODS'
        | 'PAYMENT'
        | 'RETURN',
      actionLabel: (i % 3 === 0
        ? 'Yuk keldi (+)'
        : i % 3 === 1
        ? 'Pul berildi (-)'
        : 'Vozvrat (-)') as 'Yuk keldi (+)' | 'Pul berildi (-)' | 'Vozvrat (-)',
      amount: i % 5 === 0 ? 100 : 250000,
      currency: (i % 5 === 0 ? 'USD' : 'UZS') as 'UZS' | 'USD',
      note: i % 3 === 2 ? "5 ta yog' singan" : `Nakladnoy #${i + 1}`,
    }));

    const mockHistory: SupplierFullHistoryResult = {
      supplier: {
        id: 'sup-pdf-1',
        ownerId: 'owner-1',
        name: "O'rikzor Yog' Baza",
        phone: '+998901234567',
      },
      entries,
      summary: {
        supplierId: 'sup-pdf-1',
        ownerId: 'owner-1',
        uzs: {
          totalIncoming: 3000000,
          totalPayments: 1500000,
          totalReturns: 500000,
          netDebt: 1000000,
        },
        usd: {
          totalIncoming: 300,
          totalPayments: 100,
          totalReturns: 50,
          netDebt: 150,
        },
        debtUzs: 1000000,
        debtUsd: 150,
      },
      firstDate: entries[0].createdAt,
      lastDate: entries[entries.length - 1].createdAt,
    };

    const pdfBuffer = await renderSupplierHistoryPdfBuffer(mockHistory, {
      now: new Date('2026-11-23T09:00:00Z'),
      compress: false,
    });

    expect(Buffer.isBuffer(pdfBuffer)).toBe(true);
    expect(pdfBuffer.byteLength).toBeGreaterThan(2000);
    const pdfStr = pdfBuffer.toString('latin1');
    expect(pdfStr.startsWith('%PDF-')).toBe(true);

    // Ensure footers did not spawn extra blank pages (45 rows fit cleanly on 2 pages)
    const pageCountMatch = pdfStr.match(/\/Count\s+(\d+)/);
    expect(Number(pageCountMatch?.[1])).toBe(2);

    // Decode PDFKit hex-encoded TJ arrays to verify all rendered Uzbek text
    const decodedText = Array.from(pdfStr.matchAll(/\[([^\]]+)\]\s*TJ/g))
      .map((m) =>
        Array.from(m[1].matchAll(/<([0-9a-fA-F]+)>/g))
          .map((h) => Buffer.from(h[1], 'hex').toString('latin1'))
          .join('')
      )
      .join('\n');

    expect(decodedText).toContain('Sana');
    expect(decodedText).toContain('Amal');
    expect(decodedText).toContain('Summa (UZS)');
    expect(decodedText).toContain('Summa (USD)');
    expect(decodedText).toContain('Izoh');
    expect(decodedText).toContain('Yuk keldi (+)');
    expect(decodedText).toContain('Pul berildi (-)');
    expect(decodedText).toContain('Vozvrat (-)');
    expect(decodedText).toContain('Jami kelgan yuk');
    expect(decodedText).toContain('Jami berilgan pul');
    expect(decodedText).toContain('Jami vozvrat');
    expect(decodedText).toContain('Joriy qoldiq qarz');
    expect(decodedText).toContain("3,000,000 so'm");
    expect(decodedText).toContain("1,000,000 so'm");
    expect(decodedText).toContain('$150.00');
    expect(decodedText).toContain('Sahifa 1 / 2');
    expect(decodedText).toContain('Sahifa 2 / 2');
  });
});

describe('Vozvrat Input Parser (parseAmountAndOptionalNote)', () => {
  it('separates amount from trailing reason even when reason starts with a number', () => {
    expect(parseAmountAndOptionalNote("250000 5 ta yog' singan", 'UZS')).toEqual({
      amount: 250000,
      currency: 'UZS',
      note: "5 ta yog' singan",
    });

    expect(parseAmountAndOptionalNote("250.000 5 ta yog' singan", 'UZS')).toEqual({
      amount: 250000,
      currency: 'UZS',
      note: "5 ta yog' singan",
    });

    expect(parseAmountAndOptionalNote("250 000 5 ta yog' singan", 'UZS')).toEqual({
      amount: 250000,
      currency: 'UZS',
      note: "5 ta yog' singan",
    });

    expect(parseAmountAndOptionalNote('$15.50 3 ta quti ezilgan', 'UZS')).toEqual({
      amount: 15.5,
      currency: 'USD',
      note: '3 ta quti ezilgan',
    });

    expect(parseAmountAndOptionalNote('250000', 'UZS')).toEqual({
      amount: 250000,
      currency: 'UZS',
      note: undefined,
    });
  });
});

describe('Automatic Price-Increase Alerts', () => {
  it('detects exact and fuzzy price increases while ignoring unchanged, decreased, or mismatched-size items', () => {
    const history = [
      { rawName: 'Marvari shokolad', normalizedName: 'marvari shokolad', unitPrice: 40000, currency: 'UZS' as const, createdAt: new Date('2026-10-01') },
      { rawName: 'Marvari shokolad', normalizedName: 'marvari shokolad', unitPrice: 44000, currency: 'UZS' as const, createdAt: new Date('2026-11-10') },
      { rawName: 'Kola 1L', normalizedName: 'kola 1l', unitPrice: 10000, currency: 'UZS' as const, createdAt: new Date('2026-11-10') },
      { rawName: 'Alpen Gold 90g', normalizedName: 'alpen gold 90g', unitPrice: 12000, currency: 'UZS' as const, createdAt: new Date('2026-11-10') },
    ];

    const extracted = [
      // Exact match increase vs latest (44000 -> 46200 = +5%)
      { rawName: 'Marvari shokolad', unitPrice: 46200, currency: 'UZS' as const },
      // Different package size (2L vs 1L) must NOT falsely trigger
      { rawName: 'Kola 2L', unitPrice: 18000, currency: 'UZS' as const },
      // Fuzzy typo match increase (Alpen Guld 90g -> Alpen Gold 90g: 12000 -> 13200 = +10%)
      { rawName: 'Alpen Guld 90g', unitPrice: 13200, currency: 'UZS' as const },
    ];

    const alerts = findPriceIncreasesAgainstHistory(extracted, history, 'UZS');
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      productName: 'Marvari shokolad',
      oldPrice: 44000,
      newPrice: 46200,
      percentIncrease: 5,
    });
    expect(alerts[1]).toMatchObject({
      productName: 'Alpen Guld 90g',
      oldPrice: 12000,
      newPrice: 13200,
      percentIncrease: 10,
    });

    const formatted = formatPriceIncreaseAlertsBlock(alerts);
    expect(formatted).toContain('⚠️ Narx oshdi:');
    expect(formatted).toContain("• Marvari shokolad: 44,000 so'm ➡️ 46,200 so'm (+5%)");
    expect(formatted).toContain("• Alpen Guld 90g: 12,000 so'm ➡️ 13,200 so'm (+10%)");

    const preview = buildPendingPreviewMessage(
      {
        supplierName: 'Milter',
        rawTotal: 594000,
        discountAmount: 0,
        finalTotal: 594000,
        currency: 'UZS',
        priceAlerts: alerts,
      },
      'Ta\'minotchi: Milter'
    );
    expect(preview).toContain('⚠️ Narx oshdi:');
    expect(preview).toContain("44,000 so'm ➡️ 46,200 so'm (+5%)");
  });
});

import { afterAll, beforeAll } from 'vitest';
import { prisma } from '../src/database/prisma';
import {
  SupplierService,
  addSupplierReturn,
  deleteSupplierRecord,
  getSupplierBalance,
  getSupplierFullHistory,
  getSupplierRecordsPaginated,
  updateSupplierRecordAmount,
} from '../src/services/supplier.service';
import { generateSupplierHistoryPdf } from '../src/services/export.service';
import { detectPriceIncreases } from '../src/services/search.service';

describe('DB E2E: Returns (Vozvrat), Paginated Views, Edit/Delete + AuditLog, PDF Export, Owner Isolation & Auto Price-Alert', () => {
  const TEST_OWNER_A = '999888777111';
  const TEST_OWNER_B = '999888777222';

  async function cleanup() {
    await prisma.supplier.deleteMany({ where: { ownerId: { in: [TEST_OWNER_A, TEST_OWNER_B] } } });
    await prisma.product.deleteMany({ where: { ownerId: { in: [TEST_OWNER_A, TEST_OWNER_B] } } });
    await prisma.cashTransaction.deleteMany({ where: { ownerId: { in: [TEST_OWNER_A, TEST_OWNER_B] } } });
    await prisma.auditLog.deleteMany({
      where: { telegramId: { in: [BigInt(TEST_OWNER_A), BigInt(TEST_OWNER_B)] } },
    });
  }

  beforeAll(async () => {
    await cleanup();
  }, 60000);

  afterAll(async () => {
    await cleanup();
  }, 60000);

  it(
    'executes full lifecycle: invoice, payment, return (no cash impact), pagination, edit/delete with AuditLog, cross-tenant denial, PDF Sverka, and auto price alert',
    async () => {
      // 1. Create incoming invoice (1,000,000 UZS) with an item (unitPrice 50,000)
      const invRes = await SupplierService.createInvoiceWithItems({
        ownerId: TEST_OWNER_A,
        supplierName: "O'rikzor Test Baza",
        invoiceNo: 'TST-100',
        rawTotal: 1000000,
        discountInput: 0,
        currency: 'UZS',
        paymentType: 'CREDIT',
        items: [
          { rawName: 'Test Kungaboqar Yog 5L', quantity: 20, unit: 'dona', unitPrice: 50000, lineTotal: 1000000, currency: 'UZS' },
        ],
      });
      const supId = invRes.supplier.id;

      // 2. Record payment (300,000 UZS)
      const payRes = await SupplierService.recordSupplierPayment({
        ownerId: TEST_OWNER_A,
        supplierId: supId,
        supplierName: invRes.supplier.name,
        amount: 300000,
        currency: 'UZS',
        paymentSource: 'TODAY_CASH',
      });

      // 3. Record return / Vozvrat (150,000 UZS) -> must NOT touch CashTransaction or DailyRegister
      const cashCountBefore = await prisma.cashTransaction.count({ where: { ownerId: TEST_OWNER_A } });
      const retRes = await addSupplierReturn(TEST_OWNER_A, supId, 150000, 'UZS', "3 ta yog' singan");
      const cashCountAfter = await prisma.cashTransaction.count({ where: { ownerId: TEST_OWNER_A } });
      expect(cashCountAfter).toBe(cashCountBefore);

      // Verify exact net balance: 1,000,000 - 300,000 - 150,000 = 550,000 UZS
      const bal1 = await getSupplierBalance(TEST_OWNER_A, supId);
      expect(bal1.uzs).toEqual({
        totalIncoming: 1000000,
        totalPayments: 300000,
        totalReturns: 150000,
        netDebt: 550000,
      });
      expect(bal1.debtUzs).toBe(550000);
      expect(bal1.debtUsd).toBe(0);

      // 4. Verify strict tenant isolation (Owner B cannot access, edit, or delete Owner A's records)
      await expect(getSupplierBalance(TEST_OWNER_B, supId)).rejects.toThrow();
      await expect(updateSupplierRecordAmount(TEST_OWNER_B, 'VOZVRAT', retRes.transaction.id, 1000)).rejects.toThrow();
      await expect(deleteSupplierRecord(TEST_OWNER_B, 'PULLAR', payRes.transaction.id)).rejects.toThrow();

      // 5. Verify separate paginated views
      const cheklar = await getSupplierRecordsPaginated(TEST_OWNER_A, supId, 'CHEKLAR', 1, 5);
      const pullar = await getSupplierRecordsPaginated(TEST_OWNER_A, supId, 'PULLAR', 1, 5);
      const vozvratlar = await getSupplierRecordsPaginated(TEST_OWNER_A, supId, 'VOZVRAT', 1, 5);
      expect(cheklar.total).toBe(1);
      expect(pullar.total).toBe(1);
      expect(vozvratlar.total).toBe(1);

      // 6. Verify full chronological history + PDF Sverka generation
      const history = await getSupplierFullHistory(TEST_OWNER_A, supId);
      expect(history.entries).toHaveLength(3);
      expect(history.entries.map((e) => e.type)).toEqual(['INCOMING_GOODS', 'PAYMENT', 'RETURN']);

      const pdf = await generateSupplierHistoryPdf(TEST_OWNER_A, supId, {
        now: new Date('2026-11-23T09:00:00Z'),
      });
      expect(pdf.filename).toBe('Orikzor_Test_Baza_Sverka_23_11_2026.pdf');
      expect(pdf.buffer.toString('latin1').startsWith('%PDF-')).toBe(true);

      // 7. Edit return amount 150,000 -> 200,000 => new debt = 1,000,000 - 300,000 - 200,000 = 500,000
      const editRes = await updateSupplierRecordAmount(TEST_OWNER_A, 'VOZVRAT', retRes.transaction.id, 200000);
      expect(editRes.balance.debtUzs).toBe(500000);

      // 8. Delete payment (300,000) => new debt = 1,000,000 - 0 - 200,000 = 800,000
      const delRes = await deleteSupplierRecord(TEST_OWNER_A, 'PULLAR', payRes.transaction.id);
      expect(delRes.balance.debtUzs).toBe(800000);

      // Verify AuditLog captured Return add, Edit, and Delete
      const auditRows = await prisma.auditLog.findMany({
        where: { telegramId: BigInt(TEST_OWNER_A) },
        orderBy: { createdAt: 'asc' },
      });
      const actions = auditRows.map((a) => a.action);
      expect(actions).toContain('SUPPLIER_RETURN_ADD');
      expect(actions).toContain('SUPPLIER_RECORD_UPDATE_VOZVRAT');
      expect(actions).toContain('SUPPLIER_RECORD_DELETE_PULLAR');

      // 9. Verify Auto Price-Increase Alert (Owner A sees +10% alert; Owner B sees 0 alerts!)
      const alertsA = await detectPriceIncreases(
        TEST_OWNER_A,
        [{ rawName: 'Test Kungaboqar Yog 5L', unitPrice: 55000, currency: 'UZS' }],
        'UZS'
      );
      expect(alertsA).toHaveLength(1);
      expect(alertsA[0].oldPrice).toBe(50000);
      expect(alertsA[0].newPrice).toBe(55000);
      expect(alertsA[0].percentIncrease).toBe(10);

      const alertsB = await detectPriceIncreases(
        TEST_OWNER_B,
        [{ rawName: 'Test Kungaboqar Yog 5L', unitPrice: 55000, currency: 'UZS' }],
        'UZS'
      );
      expect(alertsB).toHaveLength(0);
    },
    120000
  );
});


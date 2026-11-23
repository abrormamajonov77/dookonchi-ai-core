import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { prisma } from '../src/database/prisma';
import {
  buildGhostLineSeries,
  calcPercentDelta,
  computePaymentWeekdayCalendar,
  computeRestockCycles,
  detectExpenseAnomalies,
  getDailyTimeMachine,
  getMonthlyComparison,
  normalizeExpenseCategory,
} from '../src/services/dashboard.service';
import {
  handleDashboardHttpRequest,
  verifyTelegramWebAppInitData,
} from '../src/web/dashboard.router';
import {
  buildDailyPaymentReminderMessage,
  buildDailyRestockReminderMessages,
} from '../src/services/cron.service';
import {
  getDashboardWebAppUrl,
  getMainMenu,
  isMenuButton,
} from '../src/bot/keyboards/menu';

function createSignedTelegramInitData(
  botToken: string,
  userObj: Record<string, unknown>,
  authDate: number
): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('query_id', 'AAHdF6IQAAAAAN0XohDhrOrc');
  params.set('user', JSON.stringify(userObj));

  const pairs: string[] = [];
  params.forEach((value, key) => pairs.push(`${key}=${value}`));
  pairs.sort((a, b) => a.localeCompare(b));
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}

function createMockHttpResponse() {
  let statusCode = 200;
  let headers: Record<string, string> = {};
  let body = '';

  const res = {
    writeHead(code: number, hdrs: Record<string, string> = {}) {
      statusCode = code;
      headers = hdrs;
      return res;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      }
      return res;
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    getStatus: () => statusCode,
    getHeaders: () => headers,
    getBody: () => body,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard Service — Month Comparison % & Ghost-Line Series', () => {
  it('computes safe percentage deltas including zero denominators', () => {
    expect(calcPercentDelta(120, 100)).toBe(20);
    expect(calcPercentDelta(75, 100)).toBe(-25);
    expect(calcPercentDelta(500000, 0)).toBe(100);
    expect(calcPercentDelta(0, 0)).toBe(0);
    expect(calcPercentDelta(0, 100000)).toBe(-100);
  });

  it('builds cumulative Ghost-Line series with cutoff nulls for ongoing Month A', () => {
    const series = buildGhostLineSeries({
      daysA: 30,
      daysB: 31,
      dailySalesA: new Map([
        [1, 1_000_000],
        [2, 2_500_000],
      ]),
      dailySalesB: new Map([
        [1, 800_000],
        [2, 1_200_000],
        [5, 3_000_000],
      ]),
      dailyIncomingA: new Map([[1, 500_000]]),
      dailyIncomingB: new Map([[1, 400_000]]),
      cutoffDayA: 2,
    });

    expect(series.labels.length).toBe(31);
    expect(series.salesCumulativeA[0]).toBe(1_000_000);
    expect(series.salesCumulativeA[1]).toBe(3_500_000);
    expect(series.salesCumulativeA[2]).toBeNull();
    expect(series.salesCumulativeB[0]).toBe(800_000);
    expect(series.salesCumulativeB[1]).toBe(2_000_000);
    expect(series.salesCumulativeB[4]).toBe(5_000_000);
  });

  it('aggregates Month A vs Month B strictly scoped by ownerId', async () => {
    const ownerId = '999001';
    const zReportSpy = vi
      .spyOn(prisma.zReport, 'findMany')
      .mockResolvedValueOnce([
        { date: new Date('2026-11-01T00:00:00Z'), totalDailySalesUzs: 2_000_000 } as any,
        { date: new Date('2026-11-02T00:00:00Z'), totalDailySalesUzs: 3_000_000 } as any,
      ])
      .mockResolvedValueOnce([
        { date: new Date('2026-10-01T00:00:00Z'), totalDailySalesUzs: 4_000_000 } as any,
      ]);
    vi.spyOn(prisma.dailyRegister, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.invoice, 'findMany')
      .mockResolvedValueOnce([
        {
          id: 'inv-a1',
          totalAmount: 1_500_000,
          currency: 'UZS',
          createdAt: new Date('2026-11-02T05:00:00Z'),
        } as any,
      ])
      .mockResolvedValueOnce([
        {
          id: 'inv-b1',
          totalAmount: 1_000_000,
          currency: 'UZS',
          createdAt: new Date('2026-10-02T05:00:00Z'),
        } as any,
      ]);
    vi.spyOn(prisma.supplierTransaction, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.supplierPayment, 'findMany').mockResolvedValue([]);
    vi.spyOn(prisma.expense, 'findMany')
      .mockResolvedValueOnce([
        { category: 'XOJALIK', amount: 600_000, currency: 'UZS', createdAt: new Date('2026-11-02T08:00:00Z') } as any,
      ])
      .mockResolvedValueOnce([
        { category: 'XOJALIK', amount: 400_000, currency: 'UZS', createdAt: new Date('2026-10-02T08:00:00Z') } as any,
      ]);
    vi.spyOn(prisma.cashTransaction, 'findMany').mockResolvedValue([]);

    const result = await getMonthlyComparison(
      ownerId,
      '2026-11',
      '2026-10',
      new Date('2026-11-10T10:00:00Z')
    );

    expect(zReportSpy).toHaveBeenCalledTimes(2);
    expect((zReportSpy.mock.calls[0][0] as any).where.ownerId).toBe(ownerId);
    expect(result.monthA.salesUzs).toBe(5_000_000);
    expect(result.monthB.salesUzs).toBe(4_000_000);
    expect(result.deltas.salesPct).toBe(25);
    expect(result.deltas.incomingUzsPct).toBe(50);
    expect(result.deltas.expensesUzsPct).toBe(50);
    expect(result.monthA.incomingToSalesRatioPct).toBe(30);
  });
});

describe('Dashboard Service — Daily Time-Machine', () => {
  it('returns exact single-day snapshot and 2-date side-by-side % comparison', async () => {
    const ownerId = '777123';
    vi.spyOn(prisma.zReport, 'findUnique')
      .mockResolvedValueOnce({
        totalDailySalesUzs: 6_000_000,
        terminalAmount: 2_000_000,
        clickAmount: 1_000_000,
        cashRemainingInDrawer: 3_000_000,
      } as any)
      .mockResolvedValueOnce({
        totalDailySalesUzs: 4_000_000,
        terminalAmount: 1_000_000,
        clickAmount: 500_000,
        cashRemainingInDrawer: 2_500_000,
      } as any);
    vi.spyOn(prisma.dailyRegister, 'findUnique').mockResolvedValue(null);
    vi.spyOn(prisma.invoice, 'findMany')
      .mockResolvedValueOnce([
        {
          id: 'inv-1',
          supplierId: 'sup-1',
          supplier: { name: 'Millora' },
          totalAmount: 2_000_000,
          currency: 'UZS',
          paymentType: 'CREDIT',
          invoiceNo: '101',
          createdAt: new Date('2026-11-20T06:30:00Z'),
        } as any,
      ])
      .mockResolvedValueOnce([
        {
          id: 'inv-2',
          supplierId: 'sup-1',
          supplier: { name: 'Millora' },
          totalAmount: 1_000_000,
          currency: 'UZS',
          paymentType: 'CREDIT',
          invoiceNo: '99',
          createdAt: new Date('2026-11-19T06:30:00Z'),
        } as any,
      ]);
    vi.spyOn(prisma.supplierTransaction, 'findMany')
      .mockResolvedValueOnce([
        {
          id: 'tx-p1',
          supplierId: 'sup-1',
          supplier: { name: 'Millora' },
          type: 'PAYMENT',
          amount: 1_500_000,
          currency: 'UZS',
          paymentSource: 'CASH_REGISTER',
          date: new Date('2026-11-20T09:00:00Z'),
          description: 'Kassadan berildi',
        } as any,
      ])
      .mockResolvedValueOnce([
        {
          id: 'tx-p2',
          supplierId: 'sup-1',
          supplier: { name: 'Millora' },
          type: 'PAYMENT',
          amount: 1_000_000,
          currency: 'UZS',
          paymentSource: 'CASH_REGISTER',
          date: new Date('2026-11-19T09:00:00Z'),
          description: 'Kassadan berildi',
        } as any,
      ]);
    const expenseSpy = vi
      .spyOn(prisma.expense, 'findMany')
      .mockResolvedValueOnce([
        {
          id: 'exp-1',
          category: 'XOJALIK',
          amount: 250_000,
          currency: 'UZS',
          note: 'Paket va qogoz',
          createdAt: new Date('2026-11-20T10:00:00Z'),
        } as any,
      ])
      .mockResolvedValueOnce([
        {
          id: 'exp-2',
          category: 'XOJALIK',
          amount: 500_000,
          currency: 'UZS',
          note: 'Tushlik',
          createdAt: new Date('2026-11-19T10:00:00Z'),
        } as any,
      ]);

    const res = await getDailyTimeMachine(ownerId, '2026-11-20', '2026-11-19');

    expect((expenseSpy.mock.calls[0][0] as any).where.ownerId).toBe(ownerId);
    expect(res.dateA.date).toBe('2026-11-20');
    expect(res.dateA.sales.totalUzs).toBe(6_000_000);
    expect(res.dateA.incoming.count).toBe(1);
    expect(res.dateA.payments.totalUzs).toBe(1_500_000);
    expect(res.dateA.expenses.byCategory[0]).toMatchObject({
      category: 'XOJALIK',
      totalUzs: 250_000,
    });
    expect(res.comparison).toEqual({
      salesDeltaPct: 50,
      incomingUzsDeltaPct: 100,
      paymentsUzsDeltaPct: 50,
      expensesUzsDeltaPct: -50,
    });
  });
});

describe('Dashboard Service — Expense Anomaly Radar', () => {
  it('flags expense category growing >= +15% AND >= +10pp above sales growth with Uzbek explanation', () => {
    const analysis = detectExpenseAnomalies({
      monthA: '2026-11',
      monthB: '2026-10',
      referenceMetricLabel: 'Savdo',
      referenceGrowthPct: 3,
      expensesA: [
        { category: 'XOJALIK', amount: 1_280_000, currency: 'UZS' },
        { category: 'IJARA', amount: 5_000_000, currency: 'UZS' },
        { category: 'ELEKTR', amount: 1_100_000, currency: 'UZS' },
      ],
      expensesB: [
        { category: 'XOJALIK', amount: 1_000_000, currency: 'UZS' },
        { category: 'IJARA', amount: 5_000_000, currency: 'UZS' },
        { category: 'ELEKTR', amount: 1_000_000, currency: 'UZS' },
      ],
    });

    expect(analysis.anomalies.length).toBe(1);
    expect(analysis.anomalies[0].category).toBe('XOJALIK');
    expect(analysis.anomalies[0].growthPct).toBe(28);
    expect(analysis.anomalies[0].gapPercentagePoints).toBe(25);
    expect(analysis.anomalies[0].message).toContain("Savdo +3% o'sdi");
    expect(analysis.anomalies[0].message).toContain("Xo'jalik xarajati +28% oshdi");
    expect(analysis.anomalies[0].message).toContain('ortiqcha chiqimni tekshiring');
  });

  it('does NOT flag category when growth is below 10pp gap above high sales growth', () => {
    const analysis = detectExpenseAnomalies({
      monthA: '2026-11',
      monthB: '2026-10',
      referenceMetricLabel: 'Savdo',
      referenceGrowthPct: 20,
      expensesA: [{ category: 'XOJALIK', amount: 1_250_000, currency: 'UZS' }],
      expensesB: [{ category: 'XOJALIK', amount: 1_000_000, currency: 'UZS' }],
    });

    // +25% expense vs +20% sales => gap is only 5pp (< 10pp)
    expect(analysis.anomalies.length).toBe(0);
    expect(normalizeExpenseCategory('Аренда')).toBe('IJARA');
    expect(normalizeExpenseCategory('Свет')).toBe('ELEKTR');
  });
});

describe('Dashboard Service — Restock Cycle & Payment Weekday Detection', () => {
  it('computes avgCycleDays, deduplicates same-day deliveries, assigns urgency badges & monthly % coefficient', () => {
    // Reference "today" in Asia/Tashkent: 2026-11-23 10:00 (+05:00) = 2026-11-23T05:00:00Z
    const now = new Date('2026-11-23T05:00:00Z');

    const cycles = computeRestockCycles({
      suppliers: [
        { id: 's-tomorrow', name: 'Millora' },
        { id: 's-overdue', name: 'Baraka' },
        { id: 's-single', name: 'Yangi Firma' },
      ],
      incomingRecords: [
        // Millora: every 7 days (Nov 3, Nov 10, Nov 17 + duplicate invoice on Nov 17) => last Nov 17 (6 days ago), next in 1 day ("Ertaga!")
        { supplierId: 's-tomorrow', date: new Date('2026-10-20T06:00:00Z'), amount: 2_000_000, currency: 'UZS' },
        { supplierId: 's-tomorrow', date: new Date('2026-11-03T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        { supplierId: 's-tomorrow', date: new Date('2026-11-10T06:00:00Z'), amount: 1_500_000, currency: 'UZS' },
        { supplierId: 's-tomorrow', date: new Date('2026-11-17T06:00:00Z'), amount: 500_000, currency: 'UZS' },
        { supplierId: 's-tomorrow', date: new Date('2026-11-17T10:00:00Z'), amount: 500_000, currency: 'UZS' },
        // Baraka: every 4 days (Nov 10, Nov 14, Nov 18) => last Nov 18 (5 days ago), daysUntilNext = -1 ("Kechikdi!")
        { supplierId: 's-overdue', date: new Date('2026-11-10T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        { supplierId: 's-overdue', date: new Date('2026-11-14T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        { supplierId: 's-overdue', date: new Date('2026-11-18T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        // Single delivery supplier -> excluded (< 2 unique delivery days)
        { supplierId: 's-single', date: new Date('2026-11-20T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
      ],
      now,
    });

    expect(cycles.length).toBe(2);

    const baraka = cycles.find((c) => c.supplierId === 's-overdue')!;
    expect(baraka.avgCycleDays).toBe(4);
    expect(baraka.daysUntilNext).toBe(-1);
    expect(baraka.status).toBe('OVERDUE');
    expect(baraka.badge).toBe('Kechikdi!');
    expect(baraka.isUrgent).toBe(true);

    const millora = cycles.find((c) => c.supplierId === 's-tomorrow')!;
    expect(millora.deliveryCount).toBe(4); // Oct 20, Nov 3, Nov 10, Nov 17 (2 same-day invoices merged)
    // Gaps: 14, 7, 7 => avg = 28/3 = 9.33 => 9 days; wait let's verify exact math:
    expect(millora.avgCycleDays).toBe(9);
    // Current month incoming: 1M + 1.5M + 0.5M + 0.5M = 3.5M vs prev month 2M => +75%
    expect(millora.monthlyCoefficientPct).toBe(75);
  });

  it('detects exact Ertaga! (1 day) and 2 kun qoldi (2 days) restock statuses', () => {
    const now = new Date('2026-11-23T05:00:00Z');
    const cycles = computeRestockCycles({
      suppliers: [
        { id: 's1', name: 'Coca-Cola' },
        { id: 's2', name: 'Nestle' },
      ],
      incomingRecords: [
        // Coca-Cola: Nov 10, Nov 17 (avg 7d), today Nov 23 (6d since last) => daysUntilNext = 1
        { supplierId: 's1', date: new Date('2026-11-10T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        { supplierId: 's1', date: new Date('2026-11-17T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        // Nestle: Nov 11, Nov 18 (avg 7d), today Nov 23 (5d since last) => daysUntilNext = 2
        { supplierId: 's2', date: new Date('2026-11-11T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
        { supplierId: 's2', date: new Date('2026-11-18T06:00:00Z'), amount: 1_000_000, currency: 'UZS' },
      ],
      now,
    });

    const cola = cycles.find((c) => c.supplierId === 's1')!;
    const nestle = cycles.find((c) => c.supplierId === 's2')!;
    expect(cola.daysUntilNext).toBe(1);
    expect(cola.status).toBe('TOMORROW');
    expect(cola.badge).toBe('Ertaga!');
    expect(nestle.daysUntilNext).toBe(2);
    expect(nestle.status).toBe('SOON');
    expect(nestle.badge).toBe('2 kun qoldi');
  });

  it('maps dominant payment weekday (>= 40%) onto 7-day Du..Ya calendar and ignores scattered/single payments', () => {
    // 2026-11-23 is Monday (weekday = 1) in Asia/Tashkent
    const now = new Date('2026-11-23T05:00:00Z');

    const calendar = computePaymentWeekdayCalendar({
      suppliers: [
        { id: 's-mon', name: 'Millora', debtUzs: 4_500_000, debtUsd: 0 },
        { id: 's-scattered', name: 'Tarqoq', debtUzs: 1_000_000, debtUsd: 0 },
        { id: 's-once', name: 'Bir Martalik', debtUzs: 500_000, debtUsd: 0 },
      ],
      paymentRecords: [
        // Millora: 3 Mondays (Nov 2, Nov 9, Nov 16) + 1 Tuesday (Nov 10) => 75% Monday (>= 40%)
        { supplierId: 's-mon', date: new Date('2026-11-02T07:00:00Z') },
        { supplierId: 's-mon', date: new Date('2026-11-09T07:00:00Z') },
        { supplierId: 's-mon', date: new Date('2026-11-16T07:00:00Z') },
        { supplierId: 's-mon', date: new Date('2026-11-10T07:00:00Z') },
        // Scattered: 5 different days (20% each < 40%) -> ignored
        { supplierId: 's-scattered', date: new Date('2026-11-02T07:00:00Z') },
        { supplierId: 's-scattered', date: new Date('2026-11-03T07:00:00Z') },
        { supplierId: 's-scattered', date: new Date('2026-11-04T07:00:00Z') },
        { supplierId: 's-scattered', date: new Date('2026-11-05T07:00:00Z') },
        { supplierId: 's-scattered', date: new Date('2026-11-06T07:00:00Z') },
        // Single payment -> ignored (< 2)
        { supplierId: 's-once', date: new Date('2026-11-16T07:00:00Z') },
      ],
      now,
    });

    expect(calendar.length).toBe(7);
    expect(calendar[0].shortLabel).toBe('Du');
    expect(calendar[0].isToday).toBe(true);
    expect(calendar[0].suppliers.length).toBe(1);
    expect(calendar[0].suppliers[0]).toMatchObject({
      supplierId: 's-mon',
      supplierName: 'Millora',
      dominantWeekday: 1,
      confidencePercent: 75,
    });

    const totalAssigned = calendar.reduce((acc, d) => acc + d.suppliers.length, 0);
    expect(totalAssigned).toBe(1);
  });
});

describe('Telegram WebApp initData HMAC-SHA256 Verification & Dashboard HTTP Router', () => {
  const TEST_TOKEN = '123456789:TEST_BOT_TOKEN_FOR_HMAC';

  it('accepts a validly signed Telegram WebApp initData payload', () => {
    const nowSec = 1_795_000_000;
    const initData = createSignedTelegramInitData(
      TEST_TOKEN,
      { id: 555000111, first_name: 'Sardor', last_name: 'Karimov', username: 'sardor_ceo' },
      nowSec - 60
    );

    const res = verifyTelegramWebAppInitData(initData, TEST_TOKEN, {
      nowUnixSeconds: nowSec,
      maxAgeSeconds: 3600,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.user.telegramId).toBe('555000111');
      expect(res.user.fullName).toBe('Sardor Karimov');
      expect(res.user.username).toBe('sardor_ceo');
    }
  });

  it('rejects tampered initData, wrong BOT_TOKEN, missing hash, and expired auth_date', () => {
    const nowSec = 1_795_000_000;
    const validInitData = createSignedTelegramInitData(
      TEST_TOKEN,
      { id: 555000111, first_name: 'Sardor' },
      nowSec - 30
    );

    // 1. Tampered payload (spoofed another ownerId)
    const tampered = validInitData.replace('555000111', '999999999');
    expect(verifyTelegramWebAppInitData(tampered, TEST_TOKEN, { nowUnixSeconds: nowSec }).ok).toBe(false);

    // 2. Wrong BOT_TOKEN
    expect(verifyTelegramWebAppInitData(validInitData, '987654:WRONG_TOKEN', { nowUnixSeconds: nowSec }).ok).toBe(false);

    // 3. Missing hash
    expect(verifyTelegramWebAppInitData('auth_date=1795000000&user=%7B%22id%22%3A1%7D', TEST_TOKEN).ok).toBe(false);

    // 4. Expired auth_date
    const expiredInitData = createSignedTelegramInitData(
      TEST_TOKEN,
      { id: 555000111, first_name: 'Sardor' },
      nowSec - 90_000
    );
    expect(
      verifyTelegramWebAppInitData(expiredInitData, TEST_TOKEN, {
        nowUnixSeconds: nowSec,
        maxAgeSeconds: 86400,
      }).ok
    ).toBe(false);
  });

  it('serves GET /dashboard HTML, ignores /health, and rejects unauthenticated API calls with 401', async () => {
    const fakeBot = {} as any;

    // 1. /health must return false so healthServer handles it directly with 200 OK
    const healthRes = createMockHttpResponse();
    const handledHealth = await handleDashboardHttpRequest(
      { url: '/health', method: 'GET', headers: {} } as any,
      healthRes.res,
      fakeBot
    );
    expect(handledHealth).toBe(false);

    // 2. GET /dashboard serves public/dashboard/index.html with 200 text/html
    const dashRes = createMockHttpResponse();
    const handledDash = await handleDashboardHttpRequest(
      { url: '/dashboard', method: 'GET', headers: { host: 'localhost:3000' } } as any,
      dashRes.res,
      fakeBot
    );
    expect(handledDash).toBe(true);
    expect(dashRes.getStatus()).toBe(200);
    expect(dashRes.getHeaders()['Content-Type']).toContain('text/html');
    expect(dashRes.getBody()).toContain('Dookonchi AI');

    // 3. Unauthenticated GET /api/dashboard/overview returns 401
    const apiRes = createMockHttpResponse();
    const handledApi = await handleDashboardHttpRequest(
      { url: '/api/dashboard/overview', method: 'GET', headers: { host: 'localhost:3000' } } as any,
      apiRes.res,
      fakeBot
    );
    expect(handledApi).toBe(true);
    expect(apiRes.getStatus()).toBe(401);
  });
});

describe('09:00 Smart Telegram Reminders & Dashboard Menu Entry Button', () => {
  it('builds 09:00 Payment Day reminder only for today suppliers with non-zero debt and builds Restock reminders for 1–2 days', () => {
    const sampleData = {
      todayWeekday: 1,
      restockRadar: [
        {
          supplierId: 's1',
          supplierName: 'Millora',
          deliveryCount: 4,
          avgCycleDays: 7,
          daysSinceLast: 6,
          daysUntilNext: 1,
          lastDeliveryDate: '2026-11-17',
          status: 'TOMORROW' as const,
          badge: 'Ertaga!',
          isUrgent: true,
          currentMonthIncomingUzs: 3_000_000,
          previousMonthIncomingUzs: 2_500_000,
          monthlyCoefficientPct: 20,
        },
        {
          supplierId: 's2',
          supplierName: 'Coca-Cola',
          deliveryCount: 3,
          avgCycleDays: 5,
          daysSinceLast: 3,
          daysUntilNext: 2,
          lastDeliveryDate: '2026-11-20',
          status: 'SOON' as const,
          badge: '2 kun qoldi',
          isUrgent: true,
          currentMonthIncomingUzs: 2_000_000,
          previousMonthIncomingUzs: 2_000_000,
          monthlyCoefficientPct: 0,
        },
        {
          supplierId: 's3',
          supplierName: 'Baraka',
          deliveryCount: 3,
          avgCycleDays: 10,
          daysSinceLast: 4,
          daysUntilNext: 6,
          lastDeliveryDate: '2026-11-19',
          status: 'NORMAL' as const,
          badge: '6 kun qoldi',
          isUrgent: false,
          currentMonthIncomingUzs: 1_000_000,
          previousMonthIncomingUzs: 1_000_000,
          monthlyCoefficientPct: 0,
        },
      ],
      urgentRestocks: [],
      paymentCalendar: [
        {
          weekday: 1,
          shortLabel: 'Du',
          fullLabel: 'Dushanba',
          isToday: true,
          suppliers: [
            {
              supplierId: 's1',
              supplierName: 'Millora',
              debtUzs: 4_500_000,
              debtUsd: 120,
              dominantWeekday: 1,
              confidencePercent: 75,
              paymentCount: 4,
            },
            {
              supplierId: 's-zero',
              supplierName: 'Qarzsiz Firma',
              debtUzs: 0,
              debtUsd: 0,
              dominantWeekday: 1,
              confidencePercent: 100,
              paymentCount: 3,
            },
          ],
        },
      ],
    };

    const paymentMsg = buildDailyPaymentReminderMessage(sampleData);
    expect(paymentMsg).not.toBeNull();
    expect(paymentMsg!).toContain('Dushanba');
    expect(paymentMsg!).toContain('Millora');
    expect(paymentMsg!).toContain("4,500,000 so'm");
    expect(paymentMsg!).toContain('$120.00');
    expect(paymentMsg!).not.toContain('Qarzsiz Firma');

    const restockMsgs = buildDailyRestockReminderMessages(sampleData);
    expect(restockMsgs.length).toBe(2);
    expect(restockMsgs[0]).toBe(
      '📦 Yuk eslatmasi: Ertaga «Millora»dan yuk olish vaqtingiz (o‘rtacha har 7 kunda). Omborga razm soling, qaysi tovarlar kamayib qoldi?'
    );
    expect(restockMsgs[1]).toContain("2 kundan so'ng «Coca-Cola»dan yuk olish vaqtingiz (o‘rtacha har 5 kunda)");
  });

  it('adds 📊 Dashboard WebApp button when APP_URL/RENDER_EXTERNAL_URL is HTTPS and falls back gracefully when unset', () => {
    expect(isMenuButton('📊 Dashboard')).toBe(true);

    expect(getDashboardWebAppUrl({ APP_URL: 'https://dookonchi.onrender.com/' })).toBe(
      'https://dookonchi.onrender.com/dashboard'
    );
    expect(getDashboardWebAppUrl({ RENDER_EXTERNAL_URL: 'https://my-app.onrender.com' })).toBe(
      'https://my-app.onrender.com/dashboard'
    );
    expect(getDashboardWebAppUrl({ APP_URL: 'http://localhost:3000' })).toBeNull();
    expect(getDashboardWebAppUrl({})).toBeNull();

    const withWebApp = JSON.stringify(
      getMainMenu('STORE_OWNER', { APP_URL: 'https://dookonchi.onrender.com' }).build()
    );
    expect(withWebApp).toContain('📊 Dashboard');
    expect(withWebApp).toContain('https://dookonchi.onrender.com/dashboard');

    const withoutWebApp = JSON.stringify(getMainMenu('STORE_OWNER', {}).build());
    expect(withoutWebApp).not.toContain('📊 Dashboard');
    expect(withoutWebApp).toContain('📈 Davriy Hisobot');
  });
});

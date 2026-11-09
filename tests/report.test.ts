import { describe, it, expect } from 'vitest';
import { ReportService, RawReportInputs } from '../src/services/report.service';
import { getMainMenu, isMenuButton } from '../src/bot/keyboards/menu';
import { getReportKeyboard } from '../src/bot/handlers/report';

describe('ReportService - Period Date Ranges', () => {
  it('calculates last_week range accurately when triggered on Monday 08:00', () => {
    // Monday, Nov 9, 2026 08:00
    const mondayMorning = new Date(2026, 10, 9, 8, 0, 0);
    const range = ReportService.getPeriodRange('last_week', mondayMorning);

    expect(range.totalDays).toBe(7);
    expect(range.startDate.getFullYear()).toBe(2026);
    expect(range.startDate.getMonth()).toBe(10); // November
    expect(range.startDate.getDate()).toBe(2); // Previous Monday Nov 2
    expect(range.startDate.getHours()).toBe(0);
    expect(range.startDate.getMinutes()).toBe(0);

    expect(range.endDate.getFullYear()).toBe(2026);
    expect(range.endDate.getMonth()).toBe(10);
    expect(range.endDate.getDate()).toBe(8); // Previous Sunday Nov 8
    expect(range.endDate.getHours()).toBe(23);
    expect(range.endDate.getMinutes()).toBe(59);
    expect(range.endDate.getSeconds()).toBe(59);
  });

  it('calculates last_week range accurately when triggered on Sunday evening', () => {
    // Sunday, Nov 8, 2026 21:00 -> current week started Nov 2, so last_week is Oct 26 - Nov 1
    const sundayEvening = new Date(2026, 10, 8, 21, 0, 0);
    const range = ReportService.getPeriodRange('last_week', sundayEvening);

    expect(range.totalDays).toBe(7);
    expect(range.startDate.getMonth()).toBe(9); // October
    expect(range.startDate.getDate()).toBe(26);
    expect(range.endDate.getMonth()).toBe(10); // November
    expect(range.endDate.getDate()).toBe(1);
  });

  it('calculates current_week range accurately on Wednesday', () => {
    // Wednesday, Nov 11, 2026 14:30 -> Monday Nov 9 to Wednesday Nov 11 (3 days)
    const wednesday = new Date(2026, 10, 11, 14, 30, 0);
    const range = ReportService.getPeriodRange('current_week', wednesday);

    expect(range.totalDays).toBe(3);
    expect(range.startDate.getDate()).toBe(9);
    expect(range.endDate.getDate()).toBe(11);
  });

  it('calculates last_month range accurately on the 1st of the month', () => {
    // Nov 1, 2026 08:00 -> October 1 to October 31 (31 days)
    const firstOfNov = new Date(2026, 10, 1, 8, 0, 0);
    const range = ReportService.getPeriodRange('last_month', firstOfNov);

    expect(range.totalDays).toBe(31);
    expect(range.startDate.getFullYear()).toBe(2026);
    expect(range.startDate.getMonth()).toBe(9); // October
    expect(range.startDate.getDate()).toBe(1);
    expect(range.endDate.getMonth()).toBe(9);
    expect(range.endDate.getDate()).toBe(31);
  });

  it('calculates last_month range across year boundary (Jan 1 -> December of previous year)', () => {
    // Jan 1, 2026 08:00 -> Dec 1, 2025 to Dec 31, 2025
    const janFirst = new Date(2026, 0, 1, 8, 0, 0);
    const range = ReportService.getPeriodRange('last_month', janFirst);

    expect(range.totalDays).toBe(31);
    expect(range.startDate.getFullYear()).toBe(2025);
    expect(range.startDate.getMonth()).toBe(11); // December
    expect(range.startDate.getDate()).toBe(1);
    expect(range.endDate.getFullYear()).toBe(2025);
    expect(range.endDate.getMonth()).toBe(11);
    expect(range.endDate.getDate()).toBe(31);
  });

  it('calculates current_month range accurately', () => {
    const nov9 = new Date(2026, 10, 9, 12, 0, 0);
    const range = ReportService.getPeriodRange('current_month', nov9);

    expect(range.totalDays).toBe(9);
    expect(range.startDate.getDate()).toBe(1);
    expect(range.endDate.getDate()).toBe(9);
  });
});

describe('ReportService - Financial Aggregation & Cashflow Logic', () => {
  const sampleInputs: RawReportInputs = {
    registers: [
      { date: new Date(2026, 10, 2), cashUzs: 4000000, cashUsd: 0, clickAmount: 2500000, terminalAmount: 3500000, isClosed: true },
      { date: new Date(2026, 10, 3), cashUzs: 5000000, cashUsd: 100, clickAmount: 3000000, terminalAmount: 4000000, isClosed: true },
      // Unclosed register with negative temporary cash deduction from cash invoice
      { date: new Date(2026, 10, 4), cashUzs: -500000, cashUsd: 0, clickAmount: 0, terminalAmount: 0, isClosed: false }
    ],
    supplierTransactions: [
      { type: 'PAYMENT', amount: 5000000, currency: 'UZS', supplier: { name: 'Azamat Shakar' } },
      { type: 'PAYMENT', amount: 2000000, currency: 'UZS', supplier: { name: 'Azamat Shakar' } },
      { type: 'PAYMENT', amount: 4500000, currency: 'UZS', supplier: { name: "Akrom Yog'" } },
      { type: 'PAYMENT', amount: 3000000, currency: 'UZS', supplier: { name: 'Shaxboz Un' } },
      { type: 'PAYMENT', amount: 2500000, currency: 'UZS', supplier: { name: 'Dilshod Ichimlik' } },
      { type: 'PAYMENT', amount: 1500000, currency: 'UZS', supplier: { name: 'Bobur Kofe' } },
      { type: 'PAYMENT', amount: 800000, currency: 'UZS', supplier: { name: 'Oltinchi Hamkor' } },
      { type: 'PAYMENT', amount: 300, currency: 'USD', supplier: { name: 'Azamat Shakar' } },
      { type: 'INCOMING_GOODS', amount: 20000000, currency: 'UZS', supplier: { name: 'Azamat Shakar' } },
      { type: 'INCOMING_GOODS', amount: 500, currency: 'USD', supplier: { name: 'Import Tovar' } }
    ],
    totalSupplierDebtUzs: 45000000,
    totalSupplierDebtUsd: 1200,
    cashTransactions: [
      { amount: 1200000 },
      { amount: 800000 }
    ],
    newCustomerDebts: [
      { amount: 1500000, currency: 'UZS' },
      { amount: 50, currency: 'USD' }
    ],
    updatedCustomerDebts: [
      { paidAmount: 1000000, currency: 'UZS' }
    ],
    activeCustomerDebts: [
      { amount: 1500000, paidAmount: 1000000, currency: 'UZS' },
      { amount: 50, paidAmount: 0, currency: 'USD' }
    ],
    expenses: [
      { category: 'IJARA', amount: 2000000, currency: 'UZS' },
      { category: 'ELEKTR', amount: 500000, currency: 'UZS' },
      { category: 'IJARA', amount: 100, currency: 'USD' }
    ]
  };

  it('aggregates sales, supplier payments, top-5 partners, debts, expenses, and net cashflow accurately', () => {
    const m = ReportService.aggregateReportData(sampleInputs, 7);

    // 1. Sales
    expect(m.clickTotal).toBe(5500000);
    expect(m.terminalTotal).toBe(7500000);
    expect(m.cardSalesUzs).toBe(13000000);
    expect(m.cashSalesUzs).toBe(9000000); // -500000 is ignored as 0
    expect(m.cashSalesUsd).toBe(100);
    expect(m.totalSalesUzs).toBe(22000000);
    expect(m.closedDaysCount).toBe(2);
    expect(m.missingDaysCount).toBe(5);

    // 2. Suppliers
    // 5M + 2M + 4.5M + 3M + 2.5M + 1.5M + 0.8M = 19,300,000 UZS
    expect(m.supplierPaidUzs).toBe(19300000);
    expect(m.supplierPaidUsd).toBe(300);
    expect(m.supplierPaymentCount).toBe(8);
    expect(m.topPaidSuppliers).toHaveLength(5);
    expect(m.topPaidSuppliers[0].name).toBe('Azamat Shakar');
    expect(m.topPaidSuppliers[0].paidUzs).toBe(7000000);
    expect(m.topPaidSuppliers[0].paidUsd).toBe(300);
    expect(m.topPaidSuppliers[1].name).toBe("Akrom Yog'");
    expect(m.topPaidSuppliers[1].paidUzs).toBe(4500000);

    // Incoming goods
    expect(m.incomingGoodsUzs).toBe(20000000);
    expect(m.incomingGoodsUsd).toBe(500);
    expect(m.incomingGoodsCount).toBe(2);
    expect(m.netSupplierDebtChangeUzs).toBe(700000); // 20M - 19.3M
    expect(m.netSupplierDebtChangeUsd).toBe(200); // 500 - 300

    // 3. Cash purchases
    expect(m.cashPurchasesUzs).toBe(2000000);
    expect(m.cashPurchasesCount).toBe(2);

    // 4. Customer debts
    expect(m.newCustomerDebtUzs).toBe(1500000);
    expect(m.newCustomerDebtUsd).toBe(50);
    expect(m.collectedCustomerDebtUzs).toBe(1000000);
    expect(m.activeCustomerDebtUzs).toBe(500000);
    expect(m.activeCustomerDebtUsd).toBe(50);

    // 5. Expenses
    expect(m.expensesUzs).toBe(2500000);
    expect(m.expensesUsd).toBe(100);
    expect(m.expensesByCategory).toHaveLength(2);
    expect(m.expensesByCategory[0].category).toBe('IJARA');
    expect(m.expensesByCategory[0].amountUzs).toBe(2000000);
    expect(m.expensesByCategory[0].amountUsd).toBe(100);

    // 6. Net Cashflow
    // Inflow UZS = 22,000,000 (sales) + 1,000,000 (collected debt) = 23,000,000
    expect(m.inflowUzs).toBe(23000000);
    // Outflow UZS = 19,300,000 (supplier paid) + 2,000,000 (cash buy) + 2,500,000 (expense) = 23,800,000
    expect(m.outflowUzs).toBe(23800000);
    expect(m.netCashFlowUzs).toBe(-800000);

    // Inflow USD = 100, Outflow USD = 300 + 100 = 400 -> Net USD = -300
    expect(m.inflowUsd).toBe(100);
    expect(m.outflowUsd).toBe(400);
    expect(m.netCashFlowUsd).toBe(-300);
  });

  it('formats the report message with all required sections and missing Z-Report warning', () => {
    const range = ReportService.getPeriodRange('last_week', new Date(2026, 10, 9, 8, 0, 0));
    const m = ReportService.aggregateReportData(sampleInputs, range.totalDays);
    const text = ReportService.formatReportMessage(range, m);

    expect(text).toContain('📊 HAFTALIK MOLIYAVIY HISOBOT');
    expect(text).toContain('1. SAVDO VA TUSHUM (KASSA)');
    expect(text).toContain("2. HAMKORLAR (TA'MINOTCHILAR)");
    expect(text).toContain("Top-5 to'lov qilingan hamkorlar:");
    expect(text).toContain('Azamat Shakar');
    expect(text).toContain('3. NAQD TOVAR XARIDLARI');
    expect(text).toContain('4. MIJOZLAR NASIYASI');
    expect(text).toContain("5. DO'KON XARAJATLARI");
    expect(text).toContain('SOF PUL OQIMI (KASSA BALANSI)');
    expect(text).toContain('7 kundan 5 kun kassa (Z-Hisobot) yopilmagan');
  });

  it('displays green confirmation when all days have closed Z-Reports', () => {
    const range = ReportService.getPeriodRange('current_week', new Date(2026, 10, 9, 18, 0, 0)); // Monday (1 day)
    const inputs: RawReportInputs = {
      ...sampleInputs,
      registers: [{ date: new Date(2026, 10, 9), cashUzs: 1000000, cashUsd: 0, clickAmount: 500000, terminalAmount: 500000, isClosed: true }]
    };
    const m = ReportService.aggregateReportData(inputs, range.totalDays);
    const text = ReportService.formatReportMessage(range, m);

    expect(m.missingDaysCount).toBe(0);
    expect(text).toContain('barcha 1 kun Z-Hisobot to\'liq yopilgan');
  });
});

describe('Menu & Report Keyboard Permissions', () => {
  it('recognizes 📈 Davriy Hisobot as a system menu button', () => {
    expect(isMenuButton('📈 Davriy Hisobot')).toBe(true);
    expect(isMenuButton('/report')).toBe(true);
    expect(isMenuButton('/hisobot')).toBe(true);
  });

  it('includes 📈 Davriy Hisobot in OWNER menu but hides it from SELLER menu', () => {
    const ownerMenu = JSON.stringify(getMainMenu('OWNER').build());
    const sellerMenu = JSON.stringify(getMainMenu('SELLER').build());

    expect(ownerMenu).toContain('📈 Davriy Hisobot');
    expect(sellerMenu).not.toContain('📈 Davriy Hisobot');
  });

  it('marks active period with checkmark in getReportKeyboard', () => {
    const kbJson = JSON.stringify(getReportKeyboard('last_week').inline_keyboard);
    expect(kbJson).toContain("✅ O'tgan hafta");
    expect(kbJson).toContain('📅 Shu hafta');
  });
});


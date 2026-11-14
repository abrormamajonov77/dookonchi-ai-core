import { prisma } from '../database/prisma';
import { formatMoney, formatDateShort, formatSom, getTashkentDayRange } from '../utils/formatters';

export type ReportPeriod = 'current_week' | 'last_week' | 'current_month' | 'last_month';

export interface CashVsCreditAnalytics {
  cashTotal: number;
  creditTotal: number;
  grandTotal: number;
  cashPercent: number;
  creditPercent: number;
  progressBar: string;
  diffAmount: number;
  diffPercent: number;
  formattedBlock: string;
}

export interface ZReportInput {
  terminalAmount: number;
  clickAmount: number;
  cashRemainingInDrawer: number;
  now?: Date;
}

export interface ZReportResult {
  date: Date;
  terminalAmount: number;
  clickAmount: number;
  cashRemainingInDrawer: number;
  dailyCashPurchasesUzs: number;
  dailyCashPurchasesCount: number;
  dailySupplierPaymentsUzs: number;
  dailySupplierPaymentsCount: number;
  totalDailySalesUzs: number;
  formattedText: string;
}

export interface PeriodRange {
  period: ReportPeriod;
  title: string;
  subtitle: string;
  startDate: Date;
  endDate: Date;
  totalDays: number;
}

export interface SupplierPaymentSummary {
  name: string;
  paidUzs: number;
  paidUsd: number;
  txCount: number;
}

export interface ExpenseCategorySummary {
  category: string;
  amountUzs: number;
  amountUsd: number;
}

export interface RawReportInputs {
  registers: Array<{
    date: Date;
    cashUzs: any;
    cashUsd: any;
    clickAmount: any;
    terminalAmount: any;
    isClosed: boolean;
  }>;
  supplierTransactions: Array<{
    type: 'INCOMING_GOODS' | 'PAYMENT';
    amount: any;
    currency: 'UZS' | 'USD';
    supplier: { name: string };
  }>;
  totalSupplierDebtUzs: number;
  totalSupplierDebtUsd: number;
  cashTransactions: Array<{
    amount: any;
  }>;
  newCustomerDebts: Array<{
    amount: any;
    currency: 'UZS' | 'USD';
  }>;
  updatedCustomerDebts: Array<{
    paidAmount: any;
    currency: 'UZS' | 'USD';
  }>;
  activeCustomerDebts: Array<{
    amount: any;
    paidAmount: any;
    currency: 'UZS' | 'USD';
  }>;
  expenses: Array<{
    category: string;
    amount: any;
    currency: 'UZS' | 'USD';
  }>;
}

export interface AggregatedReportMetrics {
  // 1. Sales (DailyRegister)
  clickTotal: number;
  terminalTotal: number;
  cardSalesUzs: number;
  cashSalesUzs: number;
  cashSalesUsd: number;
  totalSalesUzs: number;
  closedDaysCount: number;
  missingDaysCount: number;
  totalDays: number;

  // 2. Suppliers (Partners)
  supplierPaidUzs: number;
  supplierPaidUsd: number;
  supplierPaymentCount: number;
  topPaidSuppliers: SupplierPaymentSummary[];
  incomingGoodsUzs: number;
  incomingGoodsUsd: number;
  incomingGoodsCount: number;
  netSupplierDebtChangeUzs: number;
  netSupplierDebtChangeUsd: number;
  totalSupplierDebtUzs: number;
  totalSupplierDebtUsd: number;

  // 3. Cash Purchases
  cashPurchasesUzs: number;
  cashPurchasesCount: number;

  // 4. Customer Debts
  newCustomerDebtUzs: number;
  newCustomerDebtUsd: number;
  collectedCustomerDebtUzs: number;
  collectedCustomerDebtUsd: number;
  activeCustomerDebtUzs: number;
  activeCustomerDebtUsd: number;

  // 5. Expenses
  expensesUzs: number;
  expensesUsd: number;
  expensesByCategory: ExpenseCategorySummary[];

  // 6. Net Cash Flow
  inflowUzs: number;
  inflowUsd: number;
  outflowUzs: number;
  outflowUsd: number;
  netCashFlowUzs: number;
  netCashFlowUsd: number;
}

const sanitizeMd = (str: string): string =>
  (str || '').replace(/[*_`\[\]]/g, '');

const formatDualCurrency = (uzs: number, usd: number): string => {
  const uzsPart = formatMoney(uzs, 'UZS');
  return usd !== 0 ? `${uzsPart} (+ ${formatMoney(usd, 'USD')})` : uzsPart;
};

const formatSignedMoney = (amount: number, currency: 'UZS' | 'USD' = 'UZS'): string => {
  if (amount > 0) return `+${formatMoney(amount, currency)}`;
  if (amount < 0) return `-${formatMoney(Math.abs(amount), currency)}`;
  return formatMoney(0, currency);
};

export class ReportService {
  /**
   * MODUL 4: Calculate 100% Cash vs. Credit Purchase Analytics, 10-block visual progress bar,
   * and directional difference analysis.
   */
  static calculateCashVsCreditAnalytics(params: {
    cashTotal: number;
    creditTotal: number;
  }): CashVsCreditAnalytics {
    const cashTotal = Math.max(0, Number(Number(params.cashTotal || 0).toFixed(2)));
    const creditTotal = Math.max(0, Number(Number(params.creditTotal || 0).toFixed(2)));
    const grandTotal = Number((cashTotal + creditTotal).toFixed(2));

    const cashPercent = grandTotal > 0 ? Math.round((cashTotal / grandTotal) * 100) : 0;
    const creditPercent = grandTotal > 0 ? 100 - cashPercent : 0;

    const greenBlocks = grandTotal > 0 ? Math.max(0, Math.min(10, Math.round(cashPercent / 10))) : 0;
    const orangeBlocks = 10 - greenBlocks;
    const progressBar = `[${'🟩'.repeat(greenBlocks)}${'🟧'.repeat(orangeBlocks)}]`;

    const diffAmount = Number(Math.abs(creditTotal - cashTotal).toFixed(2));
    const diffPercent = Math.abs(creditPercent - cashPercent);

    let directionSentence = '';
    if (grandTotal === 0) {
      directionSentence = `Ushbu davrda xaridlar qayd etilmagan.`;
    } else if (creditTotal > cashTotal) {
      directionSentence = `Nasiya xaridlar naqd xaridlardan ${formatSom(diffAmount)}ga (${diffPercent}% ga) ko'p. Do'kon aylanmasida nasiya ulushi ustunlik qilmoqda.`;
    } else if (cashTotal > creditTotal) {
      directionSentence = `Naqd xaridlar nasiya xaridlardan ${formatSom(diffAmount)}ga (${diffPercent}% ga) ko'p. Do'kon aylanmasida naqd xarid ulushi ustunlik qilmoqda.`;
    } else {
      directionSentence = `Naqd va nasiya xaridlar teng muvozanatda (50% / 50%).`;
    }

    const formattedBlock = [
      `📊 XARIDLAR TAHLILI (NAQD VS. NASIYA — 100%):`,
      `📦 Jami olingan yuklar (100%): ${formatSom(grandTotal)}`,
      `├── 💵 Naqdga olingan: ${formatSom(cashTotal)} (${cashPercent}%)`,
      `└── 📝 Nasiyaga (qarzga) olingan: ${formatSom(creditTotal)} (${creditPercent}%)`,
      `${progressBar} (${cashPercent}% Naqd / ${creditPercent}% Nasiya)`,
      `🧭 YO'NALISH VA TAFOVUT: ${directionSentence}`,
    ].join('\n');

    return {
      cashTotal,
      creditTotal,
      grandTotal,
      cashPercent,
      creditPercent,
      progressBar,
      diffAmount,
      diffPercent,
      formattedBlock,
    };
  }

  /**
   * MODUL 5: Calculate and persist the 5-column Daily Z-Report (`ZReport` + `DailyRegister`)
   * for the current Tashkent day (`UTC+5`).
   */
  static async generateAndSaveZReport(input: ZReportInput): Promise<ZReportResult> {
    const now = input.now || new Date();
    const { startOfDay, endOfDay, dateKey } = getTashkentDayRange(now);

    const terminalAmount = Math.max(0, Number(Number(input.terminalAmount || 0).toFixed(2)));
    const clickAmount = Math.max(0, Number(Number(input.clickAmount || 0).toFixed(2)));
    const cashRemainingInDrawer = Math.max(0, Number(Number(input.cashRemainingInDrawer || 0).toFixed(2)));

    const [cashInvoices, supplierPayments] = await Promise.all([
      prisma.invoice.findMany({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          currency: 'UZS',
          paidCashAmount: { gt: 0 },
        },
        select: { paidCashAmount: true },
      }),
      prisma.supplierPayment.findMany({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay },
          currency: 'UZS',
        },
        select: { amount: true },
      }),
    ]);

    const dailyCashPurchasesUzs = Number(
      cashInvoices.reduce((acc, inv) => acc + Number(inv.paidCashAmount || 0), 0).toFixed(2)
    );
    const dailyCashPurchasesCount = cashInvoices.length;

    const dailySupplierPaymentsUzs = Number(
      supplierPayments.reduce((acc, p) => acc + Number(p.amount || 0), 0).toFixed(2)
    );
    const dailySupplierPaymentsCount = supplierPayments.length;

    const totalDailySalesUzs = Number(
      (
        terminalAmount +
        clickAmount +
        cashRemainingInDrawer +
        dailyCashPurchasesUzs +
        dailySupplierPaymentsUzs
      ).toFixed(2)
    );

    const dateFormatted = new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'Asia/Tashkent',
    }).format(now);

    const formattedText = [
      `🧾 KUNLIK Z-OTCHYOT (KASSA YOPILISHI)`,
      `📅 Sana: ${dateFormatted}`,
      ``,
      `1️⃣ 💳 Terminal: ${formatSom(terminalAmount)}`,
      `2️⃣ 📱 Click / O'tkazma: ${formatSom(clickAmount)}`,
      `3️⃣ 💵 Kassadagi qoldiq naqd pul: ${formatSom(cashRemainingInDrawer)}`,
      `4️⃣ 📦 Bugun naqdga olingan yuklar (avtomat): +${formatSom(dailyCashPurchasesUzs)} (${dailyCashPurchasesCount} ta nakladnoy)`,
      `5️⃣ 🤝 Bugun ta'minotchilarga berilgan pul (avtomat): +${formatSom(dailySupplierPaymentsUzs)} (${dailySupplierPaymentsCount} ta to'lov)`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💰 BUGUNGI JAMI SAVDO (1+2+3+4+5): ${formatSom(totalDailySalesUzs)}`,
    ].join('\n');

    await prisma.$transaction(
      async (tx) => {
        await Promise.all([
          tx.zReport.upsert({
            where: { date: dateKey },
            create: {
              date: dateKey,
              terminalAmount,
              clickAmount,
              cashRemainingInDrawer,
              dailyCashPurchasesUzs,
              dailySupplierPaymentsUzs,
              totalDailySalesUzs,
            },
            update: {
              terminalAmount,
              clickAmount,
              cashRemainingInDrawer,
              dailyCashPurchasesUzs,
              dailySupplierPaymentsUzs,
              totalDailySalesUzs,
            },
          }),
          tx.dailyRegister.upsert({
            where: { date: dateKey },
            create: {
              date: dateKey,
              cashUzs: cashRemainingInDrawer,
              cashRemainingInDrawer,
              clickAmount,
              terminalAmount,
              dailyCashPurchasesUzs,
              dailySupplierPaymentsUzs,
              totalDailySalesUzs,
              isClosed: true,
            },
            update: {
              cashUzs: cashRemainingInDrawer,
              cashRemainingInDrawer,
              clickAmount,
              terminalAmount,
              dailyCashPurchasesUzs,
              dailySupplierPaymentsUzs,
              totalDailySalesUzs,
              isClosed: true,
            },
          }),
        ]);
      },
      { maxWait: 15000, timeout: 30000 }
    );

    return {
      date: dateKey,
      terminalAmount,
      clickAmount,
      cashRemainingInDrawer,
      dailyCashPurchasesUzs,
      dailyCashPurchasesCount,
      dailySupplierPaymentsUzs,
      dailySupplierPaymentsCount,
      totalDailySalesUzs,
      formattedText,
    };
  }

  static getPeriodRange(period: ReportPeriod, now: Date = new Date()): PeriodRange {
    const year = now.getFullYear();
    const month = now.getMonth();
    const date = now.getDate();
    const dayOfWeek = now.getDay();
    const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    if (period === 'last_week') {
      const startDate = new Date(year, month, date - diffToMonday - 7, 0, 0, 0, 0);
      const endDate = new Date(year, month, date - diffToMonday - 1, 23, 59, 59, 999);
      return {
        period,
        title: '📊 HAFTALIK MOLIYAVIY HISOBOT',
        subtitle: "O'tgan hafta (Dushanba — Yakshanba)",
        startDate,
        endDate,
        totalDays: 7
      };
    }

    if (period === 'current_week') {
      const startDate = new Date(year, month, date - diffToMonday, 0, 0, 0, 0);
      const endDate = new Date(year, month, date, 23, 59, 59, 999);
      return {
        period,
        title: '📊 JORIY HAFTA HISOBOTI',
        subtitle: 'Shu hafta (Dushanbadan bugungacha)',
        startDate,
        endDate,
        totalDays: diffToMonday + 1
      };
    }

    if (period === 'last_month') {
      const startDate = new Date(year, month - 1, 1, 0, 0, 0, 0);
      const endDate = new Date(year, month, 0, 23, 59, 59, 999);
      return {
        period,
        title: '📅 OYLIK MOLIYAVIY HISOBOT',
        subtitle: "O'tgan oy yakuniy xulosasi",
        startDate,
        endDate,
        totalDays: endDate.getDate()
      };
    }

    // current_month
    const startDate = new Date(year, month, 1, 0, 0, 0, 0);
    const endDate = new Date(year, month, date, 23, 59, 59, 999);
    return {
      period,
      title: '📅 JORIY OY HISOBOTI',
      subtitle: 'Shu oy (1-sanadan bugungacha)',
      startDate,
      endDate,
      totalDays: date
    };
  }

  static aggregateReportData(inputs: RawReportInputs, totalDays: number): AggregatedReportMetrics {
    let clickTotal = 0;
    let terminalTotal = 0;
    let cashSalesUzs = 0;
    let cashSalesUsd = 0;
    let closedDaysCount = 0;

    for (const r of inputs.registers) {
      clickTotal += Math.max(0, Number(r.clickAmount || 0));
      terminalTotal += Math.max(0, Number(r.terminalAmount || 0));
      cashSalesUzs += Math.max(0, Number(r.cashUzs || 0));
      cashSalesUsd += Math.max(0, Number(r.cashUsd || 0));
      if (r.isClosed) closedDaysCount++;
    }

    const cardSalesUzs = clickTotal + terminalTotal;
    const totalSalesUzs = cardSalesUzs + cashSalesUzs;
    const missingDaysCount = Math.max(0, totalDays - closedDaysCount);

    let supplierPaidUzs = 0;
    let supplierPaidUsd = 0;
    let supplierPaymentCount = 0;
    let incomingGoodsUzs = 0;
    let incomingGoodsUsd = 0;
    let incomingGoodsCount = 0;

    const supplierMap = new Map<string, SupplierPaymentSummary>();

    for (const tx of inputs.supplierTransactions) {
      const amt = Math.abs(Number(tx.amount || 0));
      const isUsd = tx.currency === 'USD';
      const supName = tx.supplier?.name || "Noma'lum";

      if (tx.type === 'PAYMENT') {
        supplierPaymentCount++;
        if (isUsd) supplierPaidUsd += amt;
        else supplierPaidUzs += amt;

        const existing = supplierMap.get(supName) || { name: supName, paidUzs: 0, paidUsd: 0, txCount: 0 };
        if (isUsd) existing.paidUsd += amt;
        else existing.paidUzs += amt;
        existing.txCount += 1;
        supplierMap.set(supName, existing);
      } else if (tx.type === 'INCOMING_GOODS') {
        incomingGoodsCount++;
        if (isUsd) incomingGoodsUsd += amt;
        else incomingGoodsUzs += amt;
      }
    }

    const topPaidSuppliers = Array.from(supplierMap.values())
      .sort((a, b) => (b.paidUzs - a.paidUzs) || (b.paidUsd - a.paidUsd))
      .slice(0, 5);

    const netSupplierDebtChangeUzs = incomingGoodsUzs - supplierPaidUzs;
    const netSupplierDebtChangeUsd = incomingGoodsUsd - supplierPaidUsd;

    let cashPurchasesUzs = 0;
    for (const c of inputs.cashTransactions) {
      cashPurchasesUzs += Math.abs(Number(c.amount || 0));
    }
    const cashPurchasesCount = inputs.cashTransactions.length;

    let newCustomerDebtUzs = 0;
    let newCustomerDebtUsd = 0;
    for (const d of inputs.newCustomerDebts) {
      const amt = Math.abs(Number(d.amount || 0));
      if (d.currency === 'USD') newCustomerDebtUsd += amt;
      else newCustomerDebtUzs += amt;
    }

    let collectedCustomerDebtUzs = 0;
    let collectedCustomerDebtUsd = 0;
    for (const d of inputs.updatedCustomerDebts) {
      const paid = Math.abs(Number(d.paidAmount || 0));
      if (d.currency === 'USD') collectedCustomerDebtUsd += paid;
      else collectedCustomerDebtUzs += paid;
    }

    let activeCustomerDebtUzs = 0;
    let activeCustomerDebtUsd = 0;
    for (const d of inputs.activeCustomerDebts) {
      const rem = Math.max(0, Number(d.amount || 0) - Number(d.paidAmount || 0));
      if (d.currency === 'USD') activeCustomerDebtUsd += rem;
      else activeCustomerDebtUzs += rem;
    }

    let expensesUzs = 0;
    let expensesUsd = 0;
    const catMap = new Map<string, ExpenseCategorySummary>();
    for (const exp of inputs.expenses) {
      const amt = Math.abs(Number(exp.amount || 0));
      const cat = exp.category || 'Boshqa';
      const isUsd = exp.currency === 'USD';
      if (isUsd) expensesUsd += amt;
      else expensesUzs += amt;

      const existing = catMap.get(cat) || { category: cat, amountUzs: 0, amountUsd: 0 };
      if (isUsd) existing.amountUsd += amt;
      else existing.amountUzs += amt;
      catMap.set(cat, existing);
    }

    const expensesByCategory = Array.from(catMap.values())
      .sort((a, b) => (b.amountUzs - a.amountUzs) || (b.amountUsd - a.amountUsd));

    const inflowUzs = totalSalesUzs + collectedCustomerDebtUzs;
    const inflowUsd = cashSalesUsd + collectedCustomerDebtUsd;
    const outflowUzs = supplierPaidUzs + cashPurchasesUzs + expensesUzs;
    const outflowUsd = supplierPaidUsd + expensesUsd;
    const netCashFlowUzs = inflowUzs - outflowUzs;
    const netCashFlowUsd = inflowUsd - outflowUsd;

    return {
      clickTotal,
      terminalTotal,
      cardSalesUzs,
      cashSalesUzs,
      cashSalesUsd,
      totalSalesUzs,
      closedDaysCount,
      missingDaysCount,
      totalDays,
      supplierPaidUzs,
      supplierPaidUsd,
      supplierPaymentCount,
      topPaidSuppliers,
      incomingGoodsUzs,
      incomingGoodsUsd,
      incomingGoodsCount,
      netSupplierDebtChangeUzs,
      netSupplierDebtChangeUsd,
      totalSupplierDebtUzs: inputs.totalSupplierDebtUzs,
      totalSupplierDebtUsd: inputs.totalSupplierDebtUsd,
      cashPurchasesUzs,
      cashPurchasesCount,
      newCustomerDebtUzs,
      newCustomerDebtUsd,
      collectedCustomerDebtUzs,
      collectedCustomerDebtUsd,
      activeCustomerDebtUzs,
      activeCustomerDebtUsd,
      expensesUzs,
      expensesUsd,
      expensesByCategory,
      inflowUzs,
      inflowUsd,
      outflowUzs,
      outflowUsd,
      netCashFlowUzs,
      netCashFlowUsd
    };
  }

  static formatReportMessage(range: PeriodRange, m: AggregatedReportMetrics): string {
    const periodStr = `${formatDateShort(range.startDate)} — ${formatDateShort(range.endDate)}`;
    const lines: string[] = [
      `**${range.title}**`,
      `📅 **Davr:** ${periodStr} _(${range.subtitle})_`,
      '',
      `🏪 **1. SAVDO VA TUSHUM (KASSA)**`,
      `├ 💳 Plastik (Terminal + Click): **${formatMoney(m.cardSalesUzs, 'UZS')}**`,
      `│   ▫️ Terminal: ${formatMoney(m.terminalTotal, 'UZS')} | Click: ${formatMoney(m.clickTotal, 'UZS')}`,
      `├ 💵 Naqd savdo: **${formatDualCurrency(m.cashSalesUzs, m.cashSalesUsd)}**`,
      `└ 📈 **Jami savdo:** **${formatDualCurrency(m.totalSalesUzs, m.cashSalesUsd)}**`,
      '',
      `🤝 **2. HAMKORLAR (TA'MINOTCHILAR)**`,
      `├ 💸 Berilgan to'lovlar (${m.supplierPaymentCount} ta): **${formatDualCurrency(m.supplierPaidUzs, m.supplierPaidUsd)}**`
    ];

    if (m.topPaidSuppliers.length > 0) {
      lines.push(`│   🏆 **Top-${m.topPaidSuppliers.length} to'lov qilingan hamkorlar:**`);
      for (const sup of m.topPaidSuppliers) {
        lines.push(`│   ▫️ ${sanitizeMd(sup.name)}: ${formatDualCurrency(sup.paidUzs, sup.paidUsd)}`);
      }
    }

    const debtDeltaText = m.netSupplierDebtChangeUzs !== 0 || m.netSupplierDebtChangeUsd !== 0
      ? ` (${formatSignedMoney(m.netSupplierDebtChangeUzs, 'UZS')}${m.netSupplierDebtChangeUsd !== 0 ? `, ${formatSignedMoney(m.netSupplierDebtChangeUsd, 'USD')}` : ''})`
      : ' (O\'zgarishsiz)';

    const cashVsCredit = this.calculateCashVsCreditAnalytics({
      cashTotal: m.cashPurchasesUzs,
      creditTotal: m.incomingGoodsUzs,
    });

    lines.push(
      `├ 📦 Nasiyaga kelgan tovar (${m.incomingGoodsCount} ta): **${formatDualCurrency(m.incomingGoodsUzs, m.incomingGoodsUsd)}**`,
      `├ 📊 JAMI QARZ (UZS): **${formatMoney(m.totalSupplierDebtUzs, 'UZS')}**`,
      `├ 💵 JAMI QARZ (USD/USDT): **${formatMoney(m.totalSupplierDebtUsd, 'USD')}**`,
      `└ ⚖️ Jami qarzimiz qoldig'i: **${formatDualCurrency(m.totalSupplierDebtUzs, m.totalSupplierDebtUsd)}**${debtDeltaText}`,
      '',
      `🛒 **3. NAQD TOVAR XARIDLARI**`,
      `└ 💵 Naqdga olingan tovar (${m.cashPurchasesCount} ta): **${formatMoney(m.cashPurchasesUzs, 'UZS')}**`,
      '',
      cashVsCredit.formattedBlock,
      '',
      `👥 **4. MIJOZLAR NASIYASI**`,
      `├ 📤 Yangi berilgan nasiya: **${formatDualCurrency(m.newCustomerDebtUzs, m.newCustomerDebtUsd)}**`,
      `├ 📥 Mijozlardan qaytgan qarz: **${formatDualCurrency(m.collectedCustomerDebtUzs, m.collectedCustomerDebtUsd)}**`,
      `└ 📊 Aktiv nasiyalar qoldig'i: **${formatDualCurrency(m.activeCustomerDebtUzs, m.activeCustomerDebtUsd)}**`,
      '',
      `📉 **5. DO'KON XARAJATLARI**`,
      `└ 🏢 Jami xarajatlar: **${formatDualCurrency(m.expensesUzs, m.expensesUsd)}**`
    );

    if (m.expensesByCategory.length > 0) {
      for (const cat of m.expensesByCategory) {
        lines.push(`    ▫️ ${sanitizeMd(cat.category)}: ${formatDualCurrency(cat.amountUzs, cat.amountUsd)}`);
      }
    }

    lines.push(
      '',
      `━━━━━━━━━━━━━━━━━━━━`,
      `💰 **SOF PUL OQIMI (KASSA BALANSI)**`,
      `├ 🟢 Jami kirim: **${formatDualCurrency(m.inflowUzs, m.inflowUsd)}** _(Savdo + Mijozdan qarz)_`,
      `├ 🔴 Jami chiqim: **${formatDualCurrency(m.outflowUzs, m.outflowUsd)}** _(Hamkor + Naqd xarid + Xarajat)_`,
      `└ 💎 **Sof kassa qoldig'i:** **${formatSignedMoney(m.netCashFlowUzs, 'UZS')}**${m.netCashFlowUsd !== 0 ? ` (**${formatSignedMoney(m.netCashFlowUsd, 'USD')}**)` : ''}`,
      ''
    );

    if (m.missingDaysCount === 0) {
      lines.push(`✅ _Davr mobaynida barcha ${m.totalDays} kun Z-Hisobot to'liq yopilgan._`);
    } else {
      lines.push(`⚠️ _Diqqat: Ushbu davrda ${m.totalDays} kundan ${m.missingDaysCount} kun kassa (Z-Hisobot) yopilmagan!_`);
    }

    return lines.join('\n');
  }

  static async generateReport(period: ReportPeriod, now: Date = new Date()): Promise<string> {
    const range = this.getPeriodRange(period, now);
    const { startDate, endDate, totalDays } = range;

    const [
      registers,
      supplierTransactions,
      invoicesInPeriod,
      supplierAggregate,
      cashTransactions,
      newCustomerDebts,
      updatedCustomerDebts,
      activeCustomerDebts,
      expenses
    ] = await Promise.all([
      prisma.dailyRegister.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: { date: true, cashUzs: true, cashUsd: true, clickAmount: true, terminalAmount: true, isClosed: true }
      }),
      prisma.supplierTransaction.findMany({
        where: { date: { gte: startDate, lte: endDate } },
        select: {
          type: true,
          amount: true,
          currency: true,
          invoiceId: true,
          supplier: { select: { name: true } }
        }
      }),
      prisma.invoice.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { id: true, paymentType: true, paidCashAmount: true, creditAmount: true, totalAmount: true, currency: true }
      }),
      prisma.supplier.aggregate({
        where: { isActive: true },
        _sum: { debtUzs: true, debtUsd: true }
      }),
      prisma.cashTransaction.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { amount: true }
      }),
      prisma.customerDebt.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { amount: true, currency: true }
      }),
      prisma.customerDebt.findMany({
        where: { updatedAt: { gte: startDate, lte: endDate }, paidAmount: { gt: 0 } },
        select: { paidAmount: true, currency: true }
      }),
      prisma.customerDebt.findMany({
        where: { status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        select: { amount: true, paidAmount: true, currency: true }
      }),
      prisma.expense.findMany({
        where: { createdAt: { gte: startDate, lte: endDate } },
        select: { category: true, amount: true, currency: true }
      })
    ]);

    const cashInvoiceIds = new Set(
      invoicesInPeriod.filter((inv) => inv.paymentType === 'CASH').map((inv) => inv.id)
    );
    const filteredSupplierTransactions = supplierTransactions.filter(
      (tx) => !(tx.type === 'INCOMING_GOODS' && tx.invoiceId && cashInvoiceIds.has(tx.invoiceId))
    );

    const metrics = this.aggregateReportData(
      {
        registers,
        supplierTransactions: filteredSupplierTransactions,
        totalSupplierDebtUzs: Number(supplierAggregate._sum.debtUzs || 0),
        totalSupplierDebtUsd: Number(supplierAggregate._sum.debtUsd || 0),
        cashTransactions,
        newCustomerDebts,
        updatedCustomerDebts,
        activeCustomerDebts,
        expenses
      },
      totalDays
    );

    // Ensure invoices created directly via Invoice table (paidCashAmount / creditAmount) are also reflected
    const invoiceCashSumUzs = invoicesInPeriod
      .filter((i) => i.currency === 'UZS')
      .reduce((s, i) => s + Number(i.paidCashAmount || 0), 0);
    const invoiceCreditSumUzs = invoicesInPeriod
      .filter((i) => i.currency === 'UZS')
      .reduce((s, i) => s + Number(i.creditAmount || 0), 0);

    if (invoiceCashSumUzs > metrics.cashPurchasesUzs) {
      metrics.cashPurchasesUzs = invoiceCashSumUzs;
      metrics.cashPurchasesCount = Math.max(
        metrics.cashPurchasesCount,
        invoicesInPeriod.filter((i) => Number(i.paidCashAmount || 0) > 0).length
      );
    }
    if (invoiceCreditSumUzs > metrics.incomingGoodsUzs) {
      metrics.incomingGoodsUzs = invoiceCreditSumUzs;
      metrics.incomingGoodsCount = Math.max(
        metrics.incomingGoodsCount,
        invoicesInPeriod.filter((i) => Number(i.creditAmount || 0) > 0).length
      );
    }

    return this.formatReportMessage(range, metrics);
  }
}


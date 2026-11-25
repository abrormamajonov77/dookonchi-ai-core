"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DashboardService = exports.WEEKDAY_META = exports.EXPENSE_CATEGORY_LABELS = exports.EXPENSE_CATEGORIES = void 0;
exports.calcPercentDelta = calcPercentDelta;
exports.formatTashkentYearMonth = formatTashkentYearMonth;
exports.formatTashkentDateIso = formatTashkentDateIso;
exports.getPreviousYearMonth = getPreviousYearMonth;
exports.getTashkentMonthRange = getTashkentMonthRange;
exports.getTashkentSpecificDayRange = getTashkentSpecificDayRange;
exports.getTashkentDayOfMonth = getTashkentDayOfMonth;
exports.getTashkentWeekday = getTashkentWeekday;
exports.getTashkentTimeHHMM = getTashkentTimeHHMM;
exports.normalizeExpenseCategory = normalizeExpenseCategory;
exports.buildGhostLineSeries = buildGhostLineSeries;
exports.getMonthlyComparison = getMonthlyComparison;
exports.getSupplierDebtMap = getSupplierDebtMap;
exports.getDailyTimeMachine = getDailyTimeMachine;
exports.detectExpenseAnomalies = detectExpenseAnomalies;
exports.getExpenseAnalysisAndAnomalies = getExpenseAnalysisAndAnomalies;
exports.computeRestockCycles = computeRestockCycles;
exports.computePaymentWeekdayCalendar = computePaymentWeekdayCalendar;
exports.getRestockCyclesAndPaymentCalendar = getRestockCyclesAndPaymentCalendar;
const prisma_1 = require("../database/prisma");
const transliterate_1 = require("../utils/transliterate");
const supplier_service_1 = require("./supplier.service");
const cash_source_1 = require("../utils/cash-source");
const report_service_1 = require("./report.service");
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
exports.EXPENSE_CATEGORIES = [
    'IJARA',
    'ELEKTR',
    'OYLIK',
    'XOJALIK',
    'SOLIQ',
    'BOSHQA',
];
exports.EXPENSE_CATEGORY_LABELS = {
    IJARA: 'Ijara',
    ELEKTR: 'Elektr',
    OYLIK: 'Oylik',
    XOJALIK: "Xo'jalik",
    SOLIQ: 'Soliq',
    BOSHQA: 'Boshqa',
};
exports.WEEKDAY_META = [
    { weekday: 1, shortLabel: 'Du', fullLabel: 'Dushanba' },
    { weekday: 2, shortLabel: 'Se', fullLabel: 'Seshanba' },
    { weekday: 3, shortLabel: 'Ch', fullLabel: 'Chorshanba' },
    { weekday: 4, shortLabel: 'Pa', fullLabel: 'Payshanba' },
    { weekday: 5, shortLabel: 'Ju', fullLabel: 'Juma' },
    { weekday: 6, shortLabel: 'Sh', fullLabel: 'Shanba' },
    { weekday: 7, shortLabel: 'Ya', fullLabel: 'Yakshanba' },
];
function roundMoney(v) {
    const n = Number(v || 0);
    if (!Number.isFinite(n))
        return 0;
    const r = Number(n.toFixed(2));
    return Object.is(r, -0) ? 0 : r;
}
/**
 * Safely computes percentage delta (A - B) / |B| * 100.
 * Handles B === 0 cleanly without NaN or Infinity.
 */
function calcPercentDelta(a, b) {
    const numA = Number(a || 0);
    const numB = Number(b || 0);
    if (Math.abs(numB) < 0.001) {
        if (Math.abs(numA) < 0.001)
            return 0;
        return numA > 0 ? 100 : -100;
    }
    return Number((((numA - numB) / Math.abs(numB)) * 100).toFixed(1));
}
function formatTashkentYearMonth(date = new Date()) {
    const t = new Date(date.getTime() + TASHKENT_OFFSET_MS);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
}
function formatTashkentDateIso(date = new Date()) {
    const t = new Date(date.getTime() + TASHKENT_OFFSET_MS);
    const y = t.getUTCFullYear();
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
function getPreviousYearMonth(ym) {
    const match = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!match)
        return formatTashkentYearMonth(new Date());
    let y = parseInt(match[1], 10);
    let m = parseInt(match[2], 10) - 1;
    if (m < 1) {
        m = 12;
        y -= 1;
    }
    return `${y}-${String(m).padStart(2, '0')}`;
}
function getTashkentMonthRange(ym, fallbackNow = new Date()) {
    const match = /^(\d{4})-(\d{2})$/.exec((ym || '').trim());
    const tNow = new Date(fallbackNow.getTime() + TASHKENT_OFFSET_MS);
    const year = match ? parseInt(match[1], 10) : tNow.getUTCFullYear();
    const monthIndex = match ? Math.max(0, Math.min(11, parseInt(match[2], 10) - 1)) : tNow.getUTCMonth();
    const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0) - TASHKENT_OFFSET_MS);
    const end = new Date(Date.UTC(year, monthIndex, daysInMonth, 23, 59, 59, 999) - TASHKENT_OFFSET_MS);
    const dateKeyStart = new Date(Date.UTC(year, monthIndex, 1));
    const dateKeyEnd = new Date(Date.UTC(year, monthIndex, daysInMonth));
    const normalizedYm = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    return { year, monthIndex, daysInMonth, start, end, dateKeyStart, dateKeyEnd, ym: normalizedYm };
}
function getTashkentSpecificDayRange(ymd, fallbackNow = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((ymd || '').trim());
    const tNow = new Date(fallbackNow.getTime() + TASHKENT_OFFSET_MS);
    const year = match ? parseInt(match[1], 10) : tNow.getUTCFullYear();
    const monthIndex = match ? Math.max(0, Math.min(11, parseInt(match[2], 10) - 1)) : tNow.getUTCMonth();
    const maxDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const day = match ? Math.max(1, Math.min(maxDay, parseInt(match[3], 10))) : tNow.getUTCDate();
    const startOfDay = new Date(Date.UTC(year, monthIndex, day, 0, 0, 0, 0) - TASHKENT_OFFSET_MS);
    const endOfDay = new Date(Date.UTC(year, monthIndex, day, 23, 59, 59, 999) - TASHKENT_OFFSET_MS);
    const dateKey = new Date(Date.UTC(year, monthIndex, day));
    const dateStr = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return { year, monthIndex, day, startOfDay, endOfDay, dateKey, dateStr };
}
function getTashkentDayOfMonth(date) {
    return new Date(date.getTime() + TASHKENT_OFFSET_MS).getUTCDate();
}
/**
 * Returns ISO weekday in Asia/Tashkent: Mon = 1 ... Sun = 7.
 */
function getTashkentWeekday(date) {
    const jsDay = new Date(date.getTime() + TASHKENT_OFFSET_MS).getUTCDay();
    return jsDay === 0 ? 7 : jsDay;
}
function getTashkentTimeHHMM(date) {
    const t = new Date(date.getTime() + TASHKENT_OFFSET_MS);
    return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}
function normalizeExpenseCategory(raw) {
    const s = (0, transliterate_1.toLatinUz)(String(raw || '')).toUpperCase().trim();
    if (!s)
        return 'BOSHQA';
    if (s === 'IJARA' || s.includes('IJARA') || s.includes('ARENDA'))
        return 'IJARA';
    if (s === 'ELEKTR' || s.includes('ELEKTR') || s.includes('SVET') || s.includes('GAZ') || s.includes('SUV') || s.includes('KOMMUNAL')) {
        return 'ELEKTR';
    }
    if (s === 'OYLIK' || s.includes('OYLIK') || s.includes('MAOSH') || s.includes('ISH HAQI') || s.includes('AVANS')) {
        return 'OYLIK';
    }
    if (s === 'XOJALIK' || s.includes('XOJALIK') || s.includes("XO'JALIK") || s.includes('TUSHLIK') || s.includes('OBED') || s.includes('PAKET')) {
        return 'XOJALIK';
    }
    if (s === 'SOLIQ' || s.includes('SOLIQ') || s.includes('NALOG') || s.includes('PATENT'))
        return 'SOLIQ';
    return 'BOSHQA';
}
function buildGhostLineSeries(params) {
    const maxDays = Math.max(params.daysA, params.daysB, 28);
    const labels = [];
    const salesCumulativeA = [];
    const salesCumulativeB = [];
    const incomingCumulativeA = [];
    const incomingCumulativeB = [];
    let runSalesA = 0;
    let runSalesB = 0;
    let runIncA = 0;
    let runIncB = 0;
    for (let day = 1; day <= maxDays; day++) {
        labels.push(String(day));
        if (day <= params.daysB) {
            runSalesB = roundMoney(runSalesB + (params.dailySalesB.get(day) || 0));
            runIncB = roundMoney(runIncB + (params.dailyIncomingB.get(day) || 0));
        }
        salesCumulativeB.push(runSalesB);
        incomingCumulativeB.push(runIncB);
        const beyondCutoff = params.cutoffDayA != null && day > params.cutoffDayA;
        if (day <= params.daysA && !beyondCutoff) {
            runSalesA = roundMoney(runSalesA + (params.dailySalesA.get(day) || 0));
            runIncA = roundMoney(runIncA + (params.dailyIncomingA.get(day) || 0));
            salesCumulativeA.push(runSalesA);
            incomingCumulativeA.push(runIncA);
        }
        else {
            salesCumulativeA.push(null);
            incomingCumulativeA.push(null);
        }
    }
    return {
        labels,
        salesCumulativeA,
        salesCumulativeB,
        incomingCumulativeA,
        incomingCumulativeB,
    };
}
async function fetchMonthRawData(ownerId, ym, now) {
    const range = getTashkentMonthRange(ym, now);
    const [zReports, dailyRegisters, invoices, supplierTxs, supplierPayments, expenses, cashTxs] = await Promise.all([
        prisma_1.prisma.zReport.findMany({
            where: { ownerId, date: { gte: range.dateKeyStart, lte: range.dateKeyEnd } },
            select: { date: true, totalDailySalesUzs: true },
        }),
        prisma_1.prisma.dailyRegister.findMany({
            where: { ownerId, date: { gte: range.dateKeyStart, lte: range.dateKeyEnd } },
            select: {
                date: true,
                totalDailySalesUzs: true,
                cashUzs: true,
                clickAmount: true,
                terminalAmount: true,
                isClosed: true,
            },
        }),
        prisma_1.prisma.invoice.findMany({
            where: { ownerId, createdAt: { gte: range.start, lte: range.end } },
            select: {
                id: true,
                totalAmount: true,
                paidCashAmount: true,
                paymentType: true,
                paymentSource: true,
                cashSource: true,
                currency: true,
                createdAt: true,
            },
        }),
        prisma_1.prisma.supplierTransaction.findMany({
            where: { ownerId, date: { gte: range.start, lte: range.end } },
            select: { id: true, type: true, amount: true, currency: true, date: true, invoiceId: true },
        }),
        prisma_1.prisma.supplierPayment.findMany({
            where: { ownerId, createdAt: { gte: range.start, lte: range.end } },
            select: { id: true, amount: true, currency: true, createdAt: true },
        }),
        prisma_1.prisma.expense.findMany({
            where: { ownerId, createdAt: { gte: range.start, lte: range.end } },
            select: { category: true, amount: true, currency: true, createdAt: true },
        }),
        prisma_1.prisma.cashTransaction.findMany({
            where: { ownerId, createdAt: { gte: range.start, lte: range.end } },
            select: {
                id: true,
                invoiceId: true,
                amount: true,
                currency: true,
                cashSource: true,
                paymentSource: true,
                createdAt: true,
            },
        }),
    ]);
    const dailySalesMap = new Map();
    const zDaySet = new Set();
    for (const zr of zReports) {
        const day = zr.date.getUTCDate();
        const val = Math.max(0, Number(zr.totalDailySalesUzs || 0));
        dailySalesMap.set(day, roundMoney((dailySalesMap.get(day) || 0) + val));
        zDaySet.add(day);
    }
    for (const dr of dailyRegisters) {
        const day = dr.date.getUTCDate();
        if (zDaySet.has(day))
            continue;
        const total = Number(dr.totalDailySalesUzs || 0);
        const fallback = Math.max(0, Number(dr.cashUzs || 0)) +
            Math.max(0, Number(dr.clickAmount || 0)) +
            Math.max(0, Number(dr.terminalAmount || 0));
        const val = total > 0 ? total : fallback;
        if (val > 0) {
            dailySalesMap.set(day, roundMoney((dailySalesMap.get(day) || 0) + val));
        }
    }
    let salesUzs = 0;
    for (const v of dailySalesMap.values())
        salesUzs += v;
    salesUzs = roundMoney(salesUzs);
    const dailyIncomingMap = new Map();
    const invoiceIds = new Set();
    const cashInvoiceMarkers = [];
    let incomingUzs = 0;
    let incomingUsd = 0;
    for (const inv of invoices) {
        invoiceIds.add(inv.id);
        const amt = Math.abs(Number(inv.totalAmount || 0));
        if (inv.currency === 'USD') {
            incomingUsd += amt;
        }
        else {
            incomingUzs += amt;
            const day = getTashkentDayOfMonth(inv.createdAt);
            dailyIncomingMap.set(day, roundMoney((dailyIncomingMap.get(day) || 0) + amt));
        }
        const paidCash = Math.abs(Number(inv.paidCashAmount ?? (inv.paymentType === 'CASH' ? inv.totalAmount : 0)));
        if (paidCash > 0) {
            cashInvoiceMarkers.push({
                currency: inv.currency,
                amount: roundMoney(paidCash),
                time: new Date(inv.createdAt).getTime(),
                matched: false,
            });
        }
    }
    // Include standalone CashTransaction rows (not linked to an Invoice) in total incoming goods history
    for (const c of cashTxs) {
        const amt = roundMoney(Math.abs(Number(c.amount || 0)));
        if (amt <= 0)
            continue;
        if (c.invoiceId && invoiceIds.has(c.invoiceId))
            continue;
        if (!c.invoiceId && c.createdAt) {
            const cTime = new Date(c.createdAt).getTime();
            const match = cashInvoiceMarkers.find((m) => !m.matched &&
                m.currency === c.currency &&
                Math.abs(m.amount - amt) < 0.01 &&
                Math.abs(m.time - cTime) <= 10_000);
            if (match) {
                match.matched = true;
                continue;
            }
        }
        if (c.currency === 'USD') {
            incomingUsd += amt;
        }
        else {
            incomingUzs += amt;
            const day = getTashkentDayOfMonth(c.createdAt);
            dailyIncomingMap.set(day, roundMoney((dailyIncomingMap.get(day) || 0) + amt));
        }
    }
    let paymentsUzs = 0;
    let paymentsUsd = 0;
    let returnsUzs = 0;
    let returnsUsd = 0;
    const paymentMarkers = [];
    for (const tx of supplierTxs) {
        const amt = Math.abs(Number(tx.amount || 0));
        if (tx.type === 'INCOMING_GOODS') {
            if (tx.invoiceId && invoiceIds.has(tx.invoiceId))
                continue;
            if (tx.currency === 'USD') {
                incomingUsd += amt;
            }
            else {
                incomingUzs += amt;
                const day = getTashkentDayOfMonth(tx.date);
                dailyIncomingMap.set(day, roundMoney((dailyIncomingMap.get(day) || 0) + amt));
            }
        }
        else if (tx.type === 'PAYMENT') {
            if (tx.currency === 'USD')
                paymentsUsd += amt;
            else
                paymentsUzs += amt;
            paymentMarkers.push({
                currency: tx.currency,
                amount: roundMoney(amt),
                time: tx.date.getTime(),
                matched: false,
            });
        }
        else if (tx.type === 'RETURN') {
            if (tx.currency === 'USD')
                returnsUsd += amt;
            else
                returnsUzs += amt;
        }
    }
    for (const p of supplierPayments) {
        const amt = roundMoney(Math.abs(Number(p.amount || 0)));
        const pTime = p.createdAt.getTime();
        const match = paymentMarkers.find((m) => !m.matched &&
            m.currency === p.currency &&
            Math.abs(m.amount - amt) < 0.01 &&
            Math.abs(m.time - pTime) <= 10_000);
        if (match) {
            match.matched = true;
        }
        else if (p.currency === 'USD') {
            paymentsUsd += amt;
        }
        else {
            paymentsUzs += amt;
        }
    }
    let expensesUzs = 0;
    let expensesUsd = 0;
    for (const e of expenses) {
        const amt = Math.abs(Number(e.amount || 0));
        if (e.currency === 'USD')
            expensesUsd += amt;
        else
            expensesUzs += amt;
    }
    const cashSummary = (0, report_service_1.summarizeCashGoodsPurchases)({
        invoices: invoices.map((inv) => ({
            id: inv.id,
            paidCashAmount: inv.paidCashAmount ?? (inv.paymentType === 'CASH' ? inv.totalAmount : 0),
            currency: inv.currency,
            cashSource: inv.cashSource,
            paymentSource: inv.paymentSource,
            createdAt: inv.createdAt,
        })),
        cashTransactions: cashTxs,
    });
    const totals = {
        month: range.ym,
        salesUzs,
        incomingUzs: roundMoney(incomingUzs),
        incomingUsd: roundMoney(incomingUsd),
        paymentsUzs: roundMoney(paymentsUzs),
        paymentsUsd: roundMoney(paymentsUsd),
        returnsUzs: roundMoney(returnsUzs),
        returnsUsd: roundMoney(returnsUsd),
        expensesUzs: roundMoney(expensesUzs),
        expensesUsd: roundMoney(expensesUsd),
        cashTransactionsUzs: cashSummary.totalUzs,
        cashPurchasesUzs: cashSummary.totalUzs,
        cashPurchasesTodayRegisterUzs: cashSummary.todayRegisterUzs,
        cashPurchasesTodayRegisterCount: cashSummary.todayRegisterCount,
        cashPurchasesSafeUzs: cashSummary.safeUzs,
        cashPurchasesSafeCount: cashSummary.safeCount,
        incomingToSalesRatioPct: salesUzs > 0 ? Number(((incomingUzs / salesUzs) * 100).toFixed(1)) : 0,
        closedDaysCount: dailySalesMap.size,
    };
    return { range, totals, dailySalesMap, dailyIncomingMap, expenses };
}
/**
 * 1. Monthly comparison (Month A vs Month B) + daily cumulative Ghost-Line chart data.
 */
async function getMonthlyComparison(ownerId, monthA, monthB, now = new Date()) {
    const cleanOwnerId = String(ownerId).trim();
    const [dataA, dataB] = await Promise.all([
        fetchMonthRawData(cleanOwnerId, monthA, now),
        fetchMonthRawData(cleanOwnerId, monthB, now),
    ]);
    const currentYm = formatTashkentYearMonth(now);
    const cutoffDayA = dataA.range.ym === currentYm ? getTashkentDayOfMonth(now) : null;
    const ghostLineChart = buildGhostLineSeries({
        daysA: dataA.range.daysInMonth,
        daysB: dataB.range.daysInMonth,
        dailySalesA: dataA.dailySalesMap,
        dailySalesB: dataB.dailySalesMap,
        dailyIncomingA: dataA.dailyIncomingMap,
        dailyIncomingB: dataB.dailyIncomingMap,
        cutoffDayA,
    });
    return {
        monthA: dataA.totals,
        monthB: dataB.totals,
        deltas: {
            salesPct: calcPercentDelta(dataA.totals.salesUzs, dataB.totals.salesUzs),
            incomingUzsPct: calcPercentDelta(dataA.totals.incomingUzs, dataB.totals.incomingUzs),
            incomingUsdPct: calcPercentDelta(dataA.totals.incomingUsd, dataB.totals.incomingUsd),
            paymentsUzsPct: calcPercentDelta(dataA.totals.paymentsUzs, dataB.totals.paymentsUzs),
            paymentsUsdPct: calcPercentDelta(dataA.totals.paymentsUsd, dataB.totals.paymentsUsd),
            expensesUzsPct: calcPercentDelta(dataA.totals.expensesUzs, dataB.totals.expensesUzs),
            expensesUsdPct: calcPercentDelta(dataA.totals.expensesUsd, dataB.totals.expensesUsd),
        },
        ghostLineChart,
    };
}
/**
 * 2. Supplier Debt Map using getSupplierBalance for all active suppliers of ownerId.
 */
async function getSupplierDebtMap(ownerId) {
    const cleanOwnerId = String(ownerId).trim();
    const [suppliers, lastActivityRows] = await Promise.all([
        prisma_1.prisma.supplier.findMany({
            where: { ownerId: cleanOwnerId, isActive: true },
            select: { id: true, name: true, phone: true },
        }),
        prisma_1.prisma.supplierTransaction.groupBy({
            by: ['supplierId'],
            where: { ownerId: cleanOwnerId },
            _max: { date: true },
        }),
    ]);
    const lastDateMap = new Map();
    for (const r of lastActivityRows) {
        if (r._max.date)
            lastDateMap.set(r.supplierId, r._max.date);
    }
    // Compute exact balances via getSupplierBalance in small batches to stay gentle on connection pool
    const balances = [];
    const BATCH_SIZE = 4;
    for (let i = 0; i < suppliers.length; i += BATCH_SIZE) {
        const chunk = suppliers.slice(i, i + BATCH_SIZE);
        const chunkRes = await Promise.all(chunk.map(async (s) => {
            const bal = await (0, supplier_service_1.getSupplierBalance)(cleanOwnerId, s.id);
            const lastDt = lastDateMap.get(s.id);
            return {
                id: s.id,
                name: (0, transliterate_1.toLatinUz)(s.name),
                phone: s.phone,
                debtUzs: bal.debtUzs,
                debtUsd: bal.debtUsd,
                lastActivityDate: lastDt ? formatTashkentDateIso(lastDt) : null,
            };
        }));
        balances.push(...chunkRes);
    }
    const totalDebtUzs = roundMoney(balances.reduce((acc, b) => acc + (b.debtUzs > 0 ? b.debtUzs : 0), 0));
    const totalDebtUsd = roundMoney(balances.reduce((acc, b) => acc + (b.debtUsd > 0 ? b.debtUsd : 0), 0));
    const enriched = balances
        .map((b) => ({
        ...b,
        sharePercentUzs: totalDebtUzs > 0 && b.debtUzs > 0 ? Number(((b.debtUzs / totalDebtUzs) * 100).toFixed(1)) : 0,
    }))
        .sort((a, b) => b.debtUzs - a.debtUzs || b.debtUsd - a.debtUsd || a.name.localeCompare(b.name));
    return {
        totalDebtUzs,
        totalDebtUsd,
        suppliersCount: enriched.length,
        suppliers: enriched,
    };
}
async function fetchSingleDaySnapshot(ownerId, dateStr) {
    const { startOfDay, endOfDay, dateKey, dateStr: normalizedDate } = getTashkentSpecificDayRange(dateStr);
    const [zReport, dailyRegister, invoices, supplierTxs, expenses, cashTxs] = await Promise.all([
        prisma_1.prisma.zReport.findUnique({ where: { ownerId_date: { ownerId, date: dateKey } } }),
        prisma_1.prisma.dailyRegister.findUnique({ where: { ownerId_date: { ownerId, date: dateKey } } }),
        prisma_1.prisma.invoice.findMany({
            where: { ownerId, createdAt: { gte: startOfDay, lte: endOfDay } },
            include: { supplier: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
        }),
        prisma_1.prisma.supplierTransaction.findMany({
            where: { ownerId, date: { gte: startOfDay, lte: endOfDay } },
            include: { supplier: { select: { name: true } } },
            orderBy: { date: 'desc' },
        }),
        prisma_1.prisma.expense.findMany({
            where: { ownerId, createdAt: { gte: startOfDay, lte: endOfDay } },
            orderBy: { createdAt: 'desc' },
        }),
        prisma_1.prisma.cashTransaction.findMany({
            where: { ownerId, createdAt: { gte: startOfDay, lte: endOfDay } },
            orderBy: { createdAt: 'desc' },
        }),
    ]);
    const salesTotal = zReport
        ? Number(zReport.totalDailySalesUzs || 0)
        : dailyRegister
            ? Number(dailyRegister.totalDailySalesUzs || 0) ||
                Math.max(0, Number(dailyRegister.cashUzs || 0)) +
                    Math.max(0, Number(dailyRegister.clickAmount || 0)) +
                    Math.max(0, Number(dailyRegister.terminalAmount || 0))
            : 0;
    const invoiceIds = new Set();
    const cashInvoiceMarkers = [];
    const incomingItems = [];
    const cashPurchaseItems = [];
    let incomingUzs = 0;
    let incomingUsd = 0;
    let cashPurchasesTotalUzs = 0;
    let cashPurchasesTotalUsd = 0;
    let todayRegisterCashUzs = 0;
    let todayRegisterCashCount = 0;
    let safeCashUzs = 0;
    let safeCashCount = 0;
    for (const inv of invoices) {
        invoiceIds.add(inv.id);
        const amt = roundMoney(Math.abs(Number(inv.totalAmount || 0)));
        if (inv.currency === 'USD')
            incomingUsd += amt;
        else
            incomingUzs += amt;
        const isCashInv = inv.paymentType === 'CASH' || Number(inv.paidCashAmount || 0) > 0;
        const cashSrc = isCashInv
            ? (0, cash_source_1.resolveEffectiveCashSource)({ cashSource: inv.cashSource, paymentSource: inv.paymentSource })
            : null;
        const badge = cashSrc ? (0, cash_source_1.formatCashSourceBadge)(cashSrc) : null;
        const supName = (0, transliterate_1.toLatinUz)(inv.supplier?.name || "Noma'lum");
        const noteText = (0, transliterate_1.toLatinUz)(inv.invoiceNo ? `Nakladnoy #${inv.invoiceNo}` : 'Nakladnoy');
        const timeStr = getTashkentTimeHHMM(inv.createdAt);
        incomingItems.push({
            id: inv.id,
            supplierId: inv.supplierId,
            supplierName: supName,
            amount: amt,
            currency: inv.currency,
            paymentType: inv.paymentType,
            cashSource: cashSrc,
            cashSourceBadge: badge,
            time: timeStr,
            note: noteText,
        });
        if (isCashInv && cashSrc && badge) {
            const paidAmt = roundMoney(Math.abs(Number(inv.paidCashAmount ?? (inv.paymentType === 'CASH' ? inv.totalAmount : 0))));
            if (paidAmt > 0) {
                cashInvoiceMarkers.push({
                    currency: inv.currency,
                    amount: paidAmt,
                    time: new Date(inv.createdAt).getTime(),
                    matched: false,
                });
                if (inv.currency === 'USD') {
                    cashPurchasesTotalUsd = roundMoney(cashPurchasesTotalUsd + paidAmt);
                }
                else {
                    cashPurchasesTotalUzs = roundMoney(cashPurchasesTotalUzs + paidAmt);
                    if (cashSrc === 'SAFE') {
                        safeCashUzs = roundMoney(safeCashUzs + paidAmt);
                        safeCashCount += 1;
                    }
                    else {
                        todayRegisterCashUzs = roundMoney(todayRegisterCashUzs + paidAmt);
                        todayRegisterCashCount += 1;
                    }
                }
                cashPurchaseItems.push({
                    id: inv.id,
                    partyName: supName,
                    amount: paidAmt,
                    currency: inv.currency,
                    cashSource: cashSrc,
                    cashSourceBadge: badge,
                    time: timeStr,
                    note: noteText,
                });
            }
        }
    }
    for (const ct of cashTxs || []) {
        const amt = roundMoney(Math.abs(Number(ct.amount || 0)));
        if (amt <= 0)
            continue;
        if (ct.invoiceId && invoiceIds.has(ct.invoiceId))
            continue;
        if (!ct.invoiceId && ct.createdAt) {
            const ctTime = new Date(ct.createdAt).getTime();
            const match = cashInvoiceMarkers.find((m) => !m.matched &&
                m.currency === ct.currency &&
                Math.abs(m.amount - amt) < 0.01 &&
                Math.abs(m.time - ctTime) <= 10_000);
            if (match) {
                match.matched = true;
                continue;
            }
        }
        const cashSrc = (0, cash_source_1.resolveEffectiveCashSource)({ cashSource: ct.cashSource, paymentSource: ct.paymentSource });
        const badge = (0, cash_source_1.formatCashSourceBadge)(cashSrc);
        const partyName = (0, transliterate_1.toLatinUz)(ct.partyName || 'Naqd xarid');
        const noteText = (0, transliterate_1.toLatinUz)(ct.items && !ct.items.startsWith('[') ? ct.items : 'Naqd xarid');
        const timeStr = getTashkentTimeHHMM(ct.createdAt);
        if (ct.currency === 'USD') {
            incomingUsd += amt;
            cashPurchasesTotalUsd = roundMoney(cashPurchasesTotalUsd + amt);
        }
        else {
            incomingUzs += amt;
            cashPurchasesTotalUzs = roundMoney(cashPurchasesTotalUzs + amt);
            if (cashSrc === 'SAFE') {
                safeCashUzs = roundMoney(safeCashUzs + amt);
                safeCashCount += 1;
            }
            else {
                todayRegisterCashUzs = roundMoney(todayRegisterCashUzs + amt);
                todayRegisterCashCount += 1;
            }
        }
        incomingItems.push({
            id: ct.id,
            supplierId: '',
            supplierName: partyName,
            amount: amt,
            currency: ct.currency,
            paymentType: 'CASH',
            cashSource: cashSrc,
            cashSourceBadge: badge,
            time: timeStr,
            note: noteText,
        });
        cashPurchaseItems.push({
            id: ct.id,
            partyName,
            amount: amt,
            currency: ct.currency,
            cashSource: cashSrc,
            cashSourceBadge: badge,
            time: timeStr,
            note: noteText,
        });
    }
    const sales = {
        totalUzs: roundMoney(salesTotal),
        terminalAmount: roundMoney(Number(zReport?.terminalAmount ?? dailyRegister?.terminalAmount ?? 0)),
        clickAmount: roundMoney(Number(zReport?.clickAmount ?? dailyRegister?.clickAmount ?? 0)),
        cashRemainingInDrawer: roundMoney(Number(zReport?.cashRemainingInDrawer ?? dailyRegister?.cashRemainingInDrawer ?? dailyRegister?.cashUzs ?? 0)),
        dailyCashPurchasesUzs: roundMoney(Number(zReport?.dailyCashPurchasesUzs ?? dailyRegister?.dailyCashPurchasesUzs ?? todayRegisterCashUzs)),
        safeCashPurchasesUzs: roundMoney(safeCashUzs),
        isClosed: Boolean(zReport || dailyRegister?.isClosed),
    };
    const paymentItems = [];
    let paymentsUzs = 0;
    let paymentsUsd = 0;
    const returnItems = [];
    let returnsUzs = 0;
    let returnsUsd = 0;
    for (const tx of supplierTxs) {
        const amt = roundMoney(Math.abs(Number(tx.amount || 0)));
        const supName = (0, transliterate_1.toLatinUz)(tx.supplier?.name || "Noma'lum");
        if (tx.type === 'INCOMING_GOODS') {
            if (tx.invoiceId && invoiceIds.has(tx.invoiceId))
                continue;
            if (tx.currency === 'USD')
                incomingUsd += amt;
            else
                incomingUzs += amt;
            incomingItems.push({
                id: tx.id,
                supplierId: tx.supplierId,
                supplierName: supName,
                amount: amt,
                currency: tx.currency,
                paymentType: 'CREDIT',
                cashSource: null,
                cashSourceBadge: null,
                time: getTashkentTimeHHMM(tx.date),
                note: (0, transliterate_1.toLatinUz)(tx.description || 'Yuk keldi'),
            });
        }
        else if (tx.type === 'PAYMENT') {
            if (tx.currency === 'USD')
                paymentsUsd += amt;
            else
                paymentsUzs += amt;
            paymentItems.push({
                id: tx.id,
                supplierId: tx.supplierId,
                supplierName: supName,
                amount: amt,
                currency: tx.currency,
                paymentSource: tx.paymentSource,
                cashSourceBadge: (0, cash_source_1.formatCashSourceBadge)(tx.cashSource, tx.paymentSource),
                time: getTashkentTimeHHMM(tx.date),
                note: (0, transliterate_1.toLatinUz)(tx.description || "To'lov"),
            });
        }
        else if (tx.type === 'RETURN') {
            if (tx.currency === 'USD')
                returnsUsd += amt;
            else
                returnsUzs += amt;
            returnItems.push({
                id: tx.id,
                supplierId: tx.supplierId,
                supplierName: supName,
                amount: amt,
                currency: tx.currency,
                time: getTashkentTimeHHMM(tx.date),
                note: (0, transliterate_1.toLatinUz)(tx.description || 'Vozvrat'),
            });
        }
    }
    const catAcc = new Map();
    const expenseItems = [];
    let expensesUzs = 0;
    let expensesUsd = 0;
    for (const e of expenses) {
        const cat = normalizeExpenseCategory(e.category);
        const amt = roundMoney(Math.abs(Number(e.amount || 0)));
        if (e.currency === 'USD')
            expensesUsd += amt;
        else
            expensesUzs += amt;
        const bucket = catAcc.get(cat) || { totalUzs: 0, totalUsd: 0 };
        if (e.currency === 'USD')
            bucket.totalUsd = roundMoney(bucket.totalUsd + amt);
        else
            bucket.totalUzs = roundMoney(bucket.totalUzs + amt);
        catAcc.set(cat, bucket);
        expenseItems.push({
            id: e.id,
            category: cat,
            label: exports.EXPENSE_CATEGORY_LABELS[cat],
            amount: amt,
            currency: e.currency,
            time: getTashkentTimeHHMM(e.createdAt),
            note: (0, transliterate_1.toLatinUz)(e.note || e.category || ''),
        });
    }
    const byCategory = exports.EXPENSE_CATEGORIES.filter((c) => catAcc.has(c)).map((c) => ({
        category: c,
        label: exports.EXPENSE_CATEGORY_LABELS[c],
        totalUzs: catAcc.get(c).totalUzs,
        totalUsd: catAcc.get(c).totalUsd,
    }));
    return {
        date: normalizedDate,
        sales,
        incoming: {
            count: incomingItems.length,
            totalUzs: roundMoney(incomingUzs),
            totalUsd: roundMoney(incomingUsd),
            items: incomingItems,
        },
        cashPurchases: {
            count: cashPurchaseItems.length,
            totalUzs: roundMoney(cashPurchasesTotalUzs),
            totalUsd: roundMoney(cashPurchasesTotalUsd),
            todayRegisterUzs: roundMoney(todayRegisterCashUzs),
            todayRegisterCount: todayRegisterCashCount,
            safeUzs: roundMoney(safeCashUzs),
            safeCount: safeCashCount,
            items: cashPurchaseItems,
        },
        payments: {
            count: paymentItems.length,
            totalUzs: roundMoney(paymentsUzs),
            totalUsd: roundMoney(paymentsUsd),
            items: paymentItems,
        },
        returns: {
            count: returnItems.length,
            totalUzs: roundMoney(returnsUzs),
            totalUsd: roundMoney(returnsUsd),
            items: returnItems,
        },
        expenses: {
            count: expenseItems.length,
            totalUzs: roundMoney(expensesUzs),
            totalUsd: roundMoney(expensesUsd),
            byCategory,
            items: expenseItems,
        },
    };
}
/**
 * 3. Daily Time-Machine single-day snapshot or 2-date side-by-side comparison.
 */
async function getDailyTimeMachine(ownerId, dateA, dateB) {
    const cleanOwnerId = String(ownerId).trim();
    const [snapA, snapB] = await Promise.all([
        fetchSingleDaySnapshot(cleanOwnerId, dateA),
        dateB && dateB.trim() ? fetchSingleDaySnapshot(cleanOwnerId, dateB) : Promise.resolve(null),
    ]);
    const comparison = snapB
        ? {
            salesDeltaPct: calcPercentDelta(snapA.sales.totalUzs, snapB.sales.totalUzs),
            incomingUzsDeltaPct: calcPercentDelta(snapA.incoming.totalUzs, snapB.incoming.totalUzs),
            paymentsUzsDeltaPct: calcPercentDelta(snapA.payments.totalUzs, snapB.payments.totalUzs),
            expensesUzsDeltaPct: calcPercentDelta(snapA.expenses.totalUzs, snapB.expenses.totalUzs),
        }
        : null;
    return {
        dateA: snapA,
        dateB: snapB,
        comparison,
    };
}
/**
 * Pure deterministic Expense Anomaly Radar engine:
 * Flags any category that grew >= +15% AND exceeded sales/goods growth by >= 10 percentage points.
 */
function detectExpenseAnomalies(params) {
    const refLabel = params.referenceMetricLabel || 'Savdo';
    const refGrowth = Number(Number(params.referenceGrowthPct || 0).toFixed(1));
    const mapA = new Map();
    const mapB = new Map();
    for (const cat of exports.EXPENSE_CATEGORIES) {
        mapA.set(cat, { uzs: 0, usd: 0 });
        mapB.set(cat, { uzs: 0, usd: 0 });
    }
    let totalUzsA = 0;
    let totalUsdA = 0;
    for (const e of params.expensesA) {
        const cat = normalizeExpenseCategory(e.category);
        const amt = Math.abs(Number(e.amount || 0));
        const bucket = mapA.get(cat);
        if (e.currency === 'USD') {
            bucket.usd = roundMoney(bucket.usd + amt);
            totalUsdA += amt;
        }
        else {
            bucket.uzs = roundMoney(bucket.uzs + amt);
            totalUzsA += amt;
        }
    }
    let totalUzsB = 0;
    let totalUsdB = 0;
    for (const e of params.expensesB) {
        const cat = normalizeExpenseCategory(e.category);
        const amt = Math.abs(Number(e.amount || 0));
        const bucket = mapB.get(cat);
        if (e.currency === 'USD') {
            bucket.usd = roundMoney(bucket.usd + amt);
            totalUsdB += amt;
        }
        else {
            bucket.uzs = roundMoney(bucket.uzs + amt);
            totalUzsB += amt;
        }
    }
    totalUzsA = roundMoney(totalUzsA);
    totalUsdA = roundMoney(totalUsdA);
    totalUzsB = roundMoney(totalUzsB);
    totalUsdB = roundMoney(totalUsdB);
    const categories = [];
    const anomalies = [];
    for (const cat of exports.EXPENSE_CATEGORIES) {
        const a = mapA.get(cat);
        const b = mapB.get(cat);
        const label = exports.EXPENSE_CATEGORY_LABELS[cat];
        const growthPct = calcPercentDelta(a.uzs, b.uzs);
        const gapPts = Number((growthPct - refGrowth).toFixed(1));
        const isAnomaly = a.uzs > 0 && growthPct >= 15 && gapPts >= 10;
        let anomalyMessage = null;
        if (isAnomaly) {
            const refPhrase = refGrowth > 0
                ? `${refLabel} +${refGrowth}% o'sdi`
                : refGrowth < 0
                    ? `${refLabel} ${refGrowth}% pasaydi`
                    : `${refLabel} 0% o'zgarmadi`;
            anomalyMessage = `${refPhrase}, lekin ${label} xarajati +${growthPct}% oshdi — ortiqcha chiqimni tekshiring`;
            anomalies.push({
                category: cat,
                label,
                amountUzsA: a.uzs,
                amountUzsB: b.uzs,
                growthPct,
                referenceGrowthPct: refGrowth,
                gapPercentagePoints: gapPts,
                message: anomalyMessage,
            });
        }
        categories.push({
            category: cat,
            label,
            amountUzsA: a.uzs,
            amountUzsB: b.uzs,
            amountUsdA: a.usd,
            amountUsdB: b.usd,
            sharePercentA: totalUzsA > 0 ? Number(((a.uzs / totalUzsA) * 100).toFixed(1)) : 0,
            growthPct,
            isAnomaly,
            anomalyMessage,
        });
    }
    categories.sort((x, y) => y.amountUzsA - x.amountUzsA || y.amountUsdA - x.amountUsdA);
    anomalies.sort((x, y) => y.gapPercentagePoints - x.gapPercentagePoints);
    return {
        monthA: params.monthA,
        monthB: params.monthB,
        totalUzsA,
        totalUzsB,
        totalUsdA,
        totalUsdB,
        totalDeltaPct: calcPercentDelta(totalUzsA, totalUzsB),
        referenceMetricLabel: refLabel,
        referenceGrowthPct: refGrowth,
        categories,
        anomalies,
    };
}
/**
 * 4. Expense Category Analysis & AI Anomaly Radar (strictly ownerId scoped).
 */
async function getExpenseAnalysisAndAnomalies(ownerId, monthA, monthB, now = new Date()) {
    const cleanOwnerId = String(ownerId).trim();
    const [dataA, dataB] = await Promise.all([
        fetchMonthRawData(cleanOwnerId, monthA, now),
        fetchMonthRawData(cleanOwnerId, monthB, now),
    ]);
    const useSalesRef = dataA.totals.salesUzs > 0 || dataB.totals.salesUzs > 0;
    const referenceMetricLabel = useSalesRef ? 'Savdo' : 'Yuk olish';
    const referenceGrowthPct = useSalesRef
        ? calcPercentDelta(dataA.totals.salesUzs, dataB.totals.salesUzs)
        : calcPercentDelta(dataA.totals.incomingUzs, dataB.totals.incomingUzs);
    return detectExpenseAnomalies({
        monthA: dataA.range.ym,
        monthB: dataB.range.ym,
        expensesA: dataA.expenses,
        expensesB: dataB.expenses,
        referenceGrowthPct,
        referenceMetricLabel,
    });
}
function toTashkentDayEpoch(date) {
    const t = new Date(date.getTime() + TASHKENT_OFFSET_MS);
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
/**
 * Pure deterministic Restock Cycle Learning engine.
 */
function computeRestockCycles(params) {
    const now = params.now || new Date();
    const todayEpoch = toTashkentDayEpoch(now);
    const currentYm = formatTashkentYearMonth(now);
    const prevYm = getPreviousYearMonth(currentYm);
    const bySupplier = new Map();
    for (const r of params.incomingRecords) {
        const list = bySupplier.get(r.supplierId) || [];
        list.push({ date: new Date(r.date), amount: Math.abs(Number(r.amount || 0)), currency: r.currency });
        bySupplier.set(r.supplierId, list);
    }
    const results = [];
    for (const sup of params.suppliers) {
        const records = bySupplier.get(sup.id) || [];
        if (records.length < 2)
            continue;
        // Deduplicate same-day deliveries so multiple invoices on one truck don't skew cycle to 0
        const uniqueDayEpochs = Array.from(new Set(records.map((r) => toTashkentDayEpoch(r.date)))).sort((a, b) => a - b);
        if (uniqueDayEpochs.length < 2)
            continue;
        let totalGapDays = 0;
        for (let i = 1; i < uniqueDayEpochs.length; i++) {
            totalGapDays += (uniqueDayEpochs[i] - uniqueDayEpochs[i - 1]) / DAY_MS;
        }
        const avgCycleDays = Math.max(1, Math.round(totalGapDays / (uniqueDayEpochs.length - 1)));
        const lastEpoch = uniqueDayEpochs[uniqueDayEpochs.length - 1];
        const daysSinceLast = Math.max(0, Math.round((todayEpoch - lastEpoch) / DAY_MS));
        const daysUntilNext = avgCycleDays - daysSinceLast;
        let status = 'NORMAL';
        let badge = `${daysUntilNext} kun qoldi`;
        if (daysUntilNext < 0) {
            status = 'OVERDUE';
            badge = 'Kechikdi!';
        }
        else if (daysUntilNext === 0) {
            status = 'TODAY';
            badge = 'Bugun!';
        }
        else if (daysUntilNext === 1) {
            status = 'TOMORROW';
            badge = 'Ertaga!';
        }
        else if (daysUntilNext === 2) {
            status = 'SOON';
            badge = '2 kun qoldi';
        }
        let currentMonthIncomingUzs = 0;
        let previousMonthIncomingUzs = 0;
        for (const r of records) {
            if (r.currency !== 'UZS')
                continue;
            const rYm = formatTashkentYearMonth(r.date);
            if (rYm === currentYm)
                currentMonthIncomingUzs += r.amount;
            else if (rYm === prevYm)
                previousMonthIncomingUzs += r.amount;
        }
        const lastDateObj = new Date(lastEpoch - TASHKENT_OFFSET_MS);
        results.push({
            supplierId: sup.id,
            supplierName: (0, transliterate_1.toLatinUz)(sup.name),
            deliveryCount: uniqueDayEpochs.length,
            avgCycleDays,
            daysSinceLast,
            daysUntilNext,
            lastDeliveryDate: formatTashkentDateIso(lastDateObj),
            status,
            badge,
            isUrgent: daysUntilNext <= 2,
            currentMonthIncomingUzs: roundMoney(currentMonthIncomingUzs),
            previousMonthIncomingUzs: roundMoney(previousMonthIncomingUzs),
            monthlyCoefficientPct: calcPercentDelta(currentMonthIncomingUzs, previousMonthIncomingUzs),
        });
    }
    results.sort((a, b) => a.daysUntilNext - b.daysUntilNext || b.deliveryCount - a.deliveryCount);
    return results;
}
/**
 * Pure deterministic Payment Weekday Learning engine (Mon=1 .. Sun=7, >= 40% dominance).
 */
function computePaymentWeekdayCalendar(params) {
    const now = params.now || new Date();
    const todayWeekday = getTashkentWeekday(now);
    const bySupplier = new Map();
    for (const p of params.paymentRecords) {
        const list = bySupplier.get(p.supplierId) || [];
        list.push(new Date(p.date));
        bySupplier.set(p.supplierId, list);
    }
    const calendar = exports.WEEKDAY_META.map((meta) => ({
        ...meta,
        isToday: meta.weekday === todayWeekday,
        suppliers: [],
    }));
    for (const sup of params.suppliers) {
        const dates = bySupplier.get(sup.id) || [];
        if (dates.length < 2)
            continue;
        const counts = new Map();
        for (const d of dates) {
            const wd = getTashkentWeekday(d);
            counts.set(wd, (counts.get(wd) || 0) + 1);
        }
        let bestWeekday = 1;
        let bestCount = 0;
        for (const [wd, count] of counts.entries()) {
            if (count > bestCount) {
                bestCount = count;
                bestWeekday = wd;
            }
        }
        const ratio = bestCount / dates.length;
        if (ratio >= 0.4) {
            const targetDay = calendar.find((c) => c.weekday === bestWeekday);
            if (targetDay) {
                targetDay.suppliers.push({
                    supplierId: sup.id,
                    supplierName: (0, transliterate_1.toLatinUz)(sup.name),
                    debtUzs: roundMoney(sup.debtUzs),
                    debtUsd: roundMoney(sup.debtUsd),
                    dominantWeekday: bestWeekday,
                    confidencePercent: Math.round(ratio * 100),
                    paymentCount: dates.length,
                });
            }
        }
    }
    for (const day of calendar) {
        day.suppliers.sort((a, b) => b.debtUzs - a.debtUzs || b.debtUsd - a.debtUsd);
    }
    return calendar;
}
/**
 * 5. AI Restock Cycle Learning & 7-Day Payment Weekday Calendar (strictly ownerId scoped).
 */
async function getRestockCyclesAndPaymentCalendar(ownerId, now = new Date()) {
    const cleanOwnerId = String(ownerId).trim();
    const [suppliers, supplierTxs, invoices, payments] = await Promise.all([
        prisma_1.prisma.supplier.findMany({
            where: { ownerId: cleanOwnerId, isActive: true },
            select: { id: true, name: true, debtUzs: true, debtUsd: true },
        }),
        prisma_1.prisma.supplierTransaction.findMany({
            where: { ownerId: cleanOwnerId, type: { in: ['INCOMING_GOODS', 'PAYMENT'] } },
            select: { supplierId: true, type: true, amount: true, currency: true, date: true, invoiceId: true },
            orderBy: { date: 'asc' },
        }),
        prisma_1.prisma.invoice.findMany({
            where: { ownerId: cleanOwnerId },
            select: { id: true, supplierId: true, totalAmount: true, currency: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
        }),
        prisma_1.prisma.supplierPayment.findMany({
            where: { ownerId: cleanOwnerId },
            select: { supplierId: true, amount: true, currency: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
        }),
    ]);
    const invoiceIds = new Set();
    const incomingRecords = [];
    for (const inv of invoices) {
        invoiceIds.add(inv.id);
        incomingRecords.push({
            supplierId: inv.supplierId,
            date: inv.createdAt,
            amount: Number(inv.totalAmount || 0),
            currency: inv.currency,
        });
    }
    const paymentRecords = [];
    const paymentTxMarkers = [];
    for (const tx of supplierTxs) {
        if (tx.type === 'INCOMING_GOODS') {
            if (tx.invoiceId && invoiceIds.has(tx.invoiceId))
                continue;
            incomingRecords.push({
                supplierId: tx.supplierId,
                date: tx.date,
                amount: Number(tx.amount || 0),
                currency: tx.currency,
            });
        }
        else if (tx.type === 'PAYMENT') {
            paymentRecords.push({ supplierId: tx.supplierId, date: tx.date });
            paymentTxMarkers.push({ supplierId: tx.supplierId, time: tx.date.getTime(), matched: false });
        }
    }
    for (const p of payments) {
        const t = p.createdAt.getTime();
        const match = paymentTxMarkers.find((m) => !m.matched && m.supplierId === p.supplierId && Math.abs(m.time - t) <= 10_000);
        if (match) {
            match.matched = true;
        }
        else {
            paymentRecords.push({ supplierId: p.supplierId, date: p.createdAt });
        }
    }
    const restockRadar = computeRestockCycles({
        suppliers,
        incomingRecords,
        now,
    });
    const paymentCalendar = computePaymentWeekdayCalendar({
        suppliers: suppliers.map((s) => ({
            id: s.id,
            name: s.name,
            debtUzs: Number(s.debtUzs || 0),
            debtUsd: Number(s.debtUsd || 0),
        })),
        paymentRecords,
        now,
    });
    // Refresh matched payment-calendar suppliers with exact net balances (Incoming - Payments - Returns)
    const matchedSupplierIds = Array.from(new Set(paymentCalendar.flatMap((day) => day.suppliers.map((s) => s.supplierId))));
    if (matchedSupplierIds.length > 0) {
        const exactBalances = new Map();
        const BATCH_SIZE = 4;
        for (let i = 0; i < matchedSupplierIds.length; i += BATCH_SIZE) {
            const chunk = matchedSupplierIds.slice(i, i + BATCH_SIZE);
            const res = await Promise.all(chunk.map(async (supplierId) => {
                const bal = await (0, supplier_service_1.getSupplierBalance)(cleanOwnerId, supplierId);
                return { supplierId, debtUzs: bal.debtUzs, debtUsd: bal.debtUsd };
            }));
            for (const item of res) {
                exactBalances.set(item.supplierId, { debtUzs: item.debtUzs, debtUsd: item.debtUsd });
            }
        }
        for (const day of paymentCalendar) {
            for (const sup of day.suppliers) {
                const exact = exactBalances.get(sup.supplierId);
                if (exact) {
                    sup.debtUzs = roundMoney(exact.debtUzs);
                    sup.debtUsd = roundMoney(exact.debtUsd);
                }
            }
            day.suppliers.sort((a, b) => b.debtUzs - a.debtUzs || b.debtUsd - a.debtUsd);
        }
    }
    return {
        todayWeekday: getTashkentWeekday(now),
        restockRadar,
        urgentRestocks: restockRadar.filter((r) => r.isUrgent),
        paymentCalendar,
    };
}
exports.DashboardService = {
    getMonthlyComparison,
    getSupplierDebtMap,
    getDailyTimeMachine,
    getExpenseAnalysisAndAnomalies,
    getRestockCyclesAndPaymentCalendar,
};

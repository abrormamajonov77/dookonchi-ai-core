import { describe, it, expect } from 'vitest';

describe('Customer Debt FIFO Repayment Logic', () => {
  interface MockDebt {
    id: string;
    customerName: string;
    amount: number;
    paidAmount: number;
    status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID';
    createdAt: Date;
  }

  function applyRepayment(activeDebts: MockDebt[], paymentAmount: number) {
    let unapplied = paymentAmount;
    const updated = activeDebts.map(d => ({ ...d }));

    for (const debt of updated) {
      if (unapplied <= 0) break;
      const remaining = debt.amount - debt.paidAmount;
      if (remaining <= 0) continue;

      if (unapplied >= remaining) {
        debt.paidAmount = debt.amount;
        debt.status = 'PAID';
        unapplied -= remaining;
      } else {
        debt.paidAmount += unapplied;
        debt.status = 'PARTIALLY_PAID';
        unapplied = 0;
      }
    }

    const remainingTotal = updated.reduce((acc, d) => acc + (d.amount - d.paidAmount), 0);
    return { updated, remainingTotal, unappliedRemaining: unapplied };
  }

  it('correctly applies partial payment to the oldest debt first', () => {
    const debts: MockDebt[] = [
      { id: '1', customerName: 'Rustam', amount: 100000, paidAmount: 0, status: 'PENDING', createdAt: new Date('2026-01-01') },
      { id: '2', customerName: 'Rustam', amount: 150000, paidAmount: 0, status: 'PENDING', createdAt: new Date('2026-01-02') }
    ];

    const result = applyRepayment(debts, 50000);
    expect(result.updated[0].paidAmount).toBe(50000);
    expect(result.updated[0].status).toBe('PARTIALLY_PAID');
    expect(result.updated[1].paidAmount).toBe(0);
    expect(result.remainingTotal).toBe(200000);
  });

  it('cascades payment across multiple debts and marks fully paid debts', () => {
    const debts: MockDebt[] = [
      { id: '1', customerName: 'Rustam', amount: 100000, paidAmount: 0, status: 'PENDING', createdAt: new Date('2026-01-01') },
      { id: '2', customerName: 'Rustam', amount: 150000, paidAmount: 0, status: 'PENDING', createdAt: new Date('2026-01-02') }
    ];

    const result = applyRepayment(debts, 180000);
    expect(result.updated[0].paidAmount).toBe(100000);
    expect(result.updated[0].status).toBe('PAID');
    expect(result.updated[1].paidAmount).toBe(80000);
    expect(result.updated[1].status).toBe('PARTIALLY_PAID');
    expect(result.remainingTotal).toBe(70000);
  });

  it('handles overpayment when payment exceeds all debts', () => {
    const debts: MockDebt[] = [
      { id: '1', customerName: 'Rustam', amount: 100000, paidAmount: 0, status: 'PENDING', createdAt: new Date('2026-01-01') }
    ];

    const result = applyRepayment(debts, 150000);
    expect(result.updated[0].paidAmount).toBe(100000);
    expect(result.updated[0].status).toBe('PAID');
    expect(result.remainingTotal).toBe(0);
    expect(result.unappliedRemaining).toBe(50000);
  });
});

describe('Supplier Ledger & Balance Calculations', () => {
  interface SupplierBalance {
    debtUzs: number;
    debtUsd: number;
  }

  function applySupplierTransaction(
    current: SupplierBalance,
    txType: 'INCOMING_GOODS' | 'PAYMENT',
    amount: number,
    currency: 'UZS' | 'USD'
  ): SupplierBalance {
    const next = { ...current };
    const isIncoming = txType === 'INCOMING_GOODS';

    if (currency === 'USD') {
      next.debtUsd = isIncoming ? next.debtUsd + amount : next.debtUsd - amount;
    } else {
      next.debtUzs = isIncoming ? next.debtUzs + amount : next.debtUzs - amount;
    }
    return next;
  }

  it('increases debt on INCOMING_GOODS for UZS', () => {
    const initial = { debtUzs: 500000, debtUsd: 0 };
    const updated = applySupplierTransaction(initial, 'INCOMING_GOODS', 300000, 'UZS');
    expect(updated.debtUzs).toBe(800000);
    expect(updated.debtUsd).toBe(0);
  });

  it('decreases debt on PAYMENT for UZS', () => {
    const initial = { debtUzs: 500000, debtUsd: 0 };
    const updated = applySupplierTransaction(initial, 'PAYMENT', 200000, 'UZS');
    expect(updated.debtUzs).toBe(300000);
  });

  it('properly tracks USD transactions independently of UZS debt', () => {
    const initial = { debtUzs: 500000, debtUsd: 100 };
    const goodsUsd = applySupplierTransaction(initial, 'INCOMING_GOODS', 400, 'USD');
    expect(goodsUsd.debtUzs).toBe(500000);
    expect(goodsUsd.debtUsd).toBe(500);

    const payUsd = applySupplierTransaction(goodsUsd, 'PAYMENT', 250, 'USD');
    expect(payUsd.debtUzs).toBe(500000);
    expect(payUsd.debtUsd).toBe(250);
  });
});

describe('Invoice Discount Calculation Logic', () => {
  function computeDiscount(grossTotal: number, text: string) {
    let discountAmount = 0;
    const percentMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const fixedDiscountMatch = text.match(/^(\d[\d\s]*)(?:\s*(?:ming|k|sum|so'm|skidka))?$/i);

    if (percentMatch) {
      const percent = parseFloat(percentMatch[1].replace(',', '.'));
      discountAmount = grossTotal * (percent / 100);
    } else if (fixedDiscountMatch) {
      let numericOnly = text.replace(/[^\d.,]/g, '').replace(',', '.');
      let parsedVal = parseFloat(numericOnly);
      if (text.toLowerCase().includes('ming') || text.toLowerCase().includes('k')) {
        parsedVal *= 1000;
      }
      if (!isNaN(parsedVal) && parsedVal > 0 && parsedVal < grossTotal) {
        discountAmount = parsedVal;
      }
    }

    if (discountAmount > grossTotal) discountAmount = grossTotal;
    return {
      discountAmount,
      netTotal: grossTotal - discountAmount
    };
  }

  it('calculates percentage discounts correctly', () => {
    const res = computeDiscount(1000000, '5%');
    expect(res.discountAmount).toBe(50000);
    expect(res.netTotal).toBe(950000);
  });

  it('calculates fixed sum discounts correctly', () => {
    const res = computeDiscount(1000000, '50000');
    expect(res.discountAmount).toBe(50000);
    expect(res.netTotal).toBe(950000);
  });

  it('calculates colloquial "ming" discounts correctly', () => {
    const res = computeDiscount(1000000, '25 ming');
    expect(res.discountAmount).toBe(25000);
    expect(res.netTotal).toBe(975000);
  });

  it('caps discount amount to gross total if exceeded', () => {
    const res = computeDiscount(500000, '120%');
    expect(res.discountAmount).toBe(500000);
    expect(res.netTotal).toBe(0);
  });
});

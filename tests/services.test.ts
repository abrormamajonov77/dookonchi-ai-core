import { describe, it, expect } from 'vitest';
import { TranslitService } from '../src/services/translit.service';
import { SupplierService } from '../src/services/supplier.service';
import { InvoiceItemSchema, InvoiceSchema, VoiceIntentSchema } from '../src/services/ai.service';
import { QueueService } from '../src/services/queue.service';

describe('TranslitService', () => {
  it('transliterates Cyrillic Uzbek text to Latin', () => {
    expect(TranslitService.toLatin('Шакар')).toBe('Shakar');
    expect(TranslitService.toLatin('Ўрик')).toBe("O'rik");
    expect(TranslitService.toLatin('Ғишт')).toBe("G'isht");
    expect(TranslitService.toLatin('Қозон')).toBe('Qozon');
    expect(TranslitService.toLatin('Ёғ')).toBe("Yog'");
  });

  it('handles empty input gracefully', () => {
    expect(TranslitService.toLatin('')).toBe('');
  });

  it('generates combined search tokens for cyrillic and latin search', () => {
    const tokens = TranslitService.generateSearchTokens('Шакар 50кг');
    expect(tokens).toContain('шакар');
    expect(tokens).toContain('shakar');
    expect(tokens).toContain('50кг');
  });
});

describe('SupplierService', () => {
  it('cleans Uzbek honorific suffixes from supplier names', () => {
    expect(SupplierService.cleanSupplierName('Azamat aka')).toBe('Azamat');
    expect(SupplierService.cleanSupplierName('Rustam oka')).toBe('Rustam');
    expect(SupplierService.cleanSupplierName('Dilnoza opa')).toBe('Dilnoza');
    expect(SupplierService.cleanSupplierName('Botir boy')).toBe('Botir');
    expect(SupplierService.cleanSupplierName('Salim xon')).toBe('Salim');
  });

  it('normalizes supplier names for search comparison', () => {
    const normalized = SupplierService.normalizeName('Азамат акадан');
    expect(normalized).toBe('azamat');
  });
});

describe('AiService Schemas', () => {
  it('validates a valid invoice item', () => {
    const validItem = {
      productName: 'Shakar 50kg',
      quantity: 10,
      unitPrice: 450000,
      totalPrice: 4500000
    };
    const parsed = InvoiceItemSchema.parse(validItem);
    expect(parsed.productName).toBe('Shakar 50kg');
    expect(parsed.totalPrice).toBe(4500000);
  });

  it('validates and applies defaults to InvoiceSchema', () => {
    const rawInvoice = {
      total_amount: 1500000,
      table_text: '| 1 | Shakar | 2 | 750000 | 1500000 |',
      supplier: 'Akmal Savdo'
    };
    const parsed = InvoiceSchema.parse(rawInvoice);
    expect(parsed.total_amount).toBe(1500000);
    expect(parsed.discount).toBe(0);
    expect(parsed.supplier).toBe('Akmal Savdo');
  });

  it('validates VoiceIntentSchema for EXPENSE intent', () => {
    const expenseIntent = {
      intent: 'ADD_EXPENSE',
      amount: 250000,
      currency: 'UZS',
      category: 'ELEKTR',
      comment: 'Elektr energiyasi uchun to\'lov'
    };
    const parsed = VoiceIntentSchema.parse(expenseIntent);
    expect(parsed.intent).toBe('ADD_EXPENSE');
    expect(parsed.amount).toBe(250000);
    expect(parsed.currency).toBe('UZS');
  });

  it('validates VoiceIntentSchema for SUPPLIER_TX intent', () => {
    const supplierIntent = {
      intent: 'ADD_SUPPLIER_TX',
      txType: 'PAYMENT',
      amount: 1000,
      currency: 'USD',
      name: 'Azamat'
    };
    const parsed = VoiceIntentSchema.parse(supplierIntent);
    expect(parsed.intent).toBe('ADD_SUPPLIER_TX');
    expect(parsed.txType).toBe('PAYMENT');
    expect(parsed.currency).toBe('USD');
  });
});

describe('QueueService', () => {
  it('executes tasks in FIFO order for a specific user', async () => {
    const queue = new QueueService();
    const order: number[] = [];

    const task1 = () => new Promise<void>((resolve) => {
      setTimeout(() => { order.push(1); resolve(); }, 30);
    });
    const task2 = () => new Promise<void>((resolve) => {
      setTimeout(() => { order.push(2); resolve(); }, 10);
    });

    await Promise.all([
      queue.enqueue(12345, task1),
      queue.enqueue(12345, task2)
    ]);

    expect(order).toEqual([1, 2]);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { prisma } from '../src/database/prisma';
import {
  CASH_SOURCE_BTN_CANCEL,
  CASH_SOURCE_BTN_SAFE,
  CASH_SOURCE_BTN_TODAY,
  CASH_SOURCE_PROMPT_TEXT,
  cashSourceToPaymentSource,
  detectCashSourceFromText,
  formatCashSourceBadge,
  formatCashSourceDisplay,
  paymentSourceToCashSource,
  resolveEffectiveCashSource,
} from '../src/utils/cash-source';
import { parseTextCommandLocally } from '../src/utils/local-parser';
import { AiService } from '../src/services/ai.service';
import { processIntent, voiceHandler } from '../src/bot/handlers/voice';
import { invoiceHandler } from '../src/bot/handlers/invoice';
import { cashHandler } from '../src/bot/handlers/cash';
import { SupplierService } from '../src/services/supplier.service';
import {
  ReportService,
  computeDailyRegisterBalance,
  summarizeCashGoodsPurchases,
} from '../src/services/report.service';

afterEach(() => {
  vi.restoreAllMocks();
});

function createMockCtx(overrides: Record<string, any> = {}) {
  const replies: Array<{ text: string; extra?: any }> = [];
  const edits: Array<{ chatId: number; messageId: number; text: string; extra?: any }> = [];
  const callbackAnswers: Array<any> = [];

  const ctx: any = {
    from: { id: 901001, first_name: 'Sardor' },
    chat: { id: 901001, type: 'private' },
    session: { step: undefined, tempData: undefined },
    reply: vi.fn(async (text: string, extra?: any) => {
      replies.push({ text, extra });
      return { message_id: 500 + replies.length };
    }),
    editMessageText: vi.fn(async (text: string, extra?: any) => {
      edits.push({ chatId: 901001, messageId: 100, text, extra });
      return true;
    }),
    answerCallbackQuery: vi.fn(async (arg?: any) => {
      callbackAnswers.push(arg);
      return true;
    }),
    deleteMessage: vi.fn(async () => true),
    api: {
      editMessageText: vi.fn(async (chatId: number, messageId: number, text: string, extra?: any) => {
        edits.push({ chatId, messageId, text, extra });
        return true;
      }),
      deleteMessage: vi.fn(async () => true),
    },
    ...overrides,
  };

  return { ctx, replies, edits, callbackAnswers };
}

function getInlineButtonTexts(replyMarkup: any): string[] {
  const rows = replyMarkup?.inline_keyboard || [];
  return rows.flat().map((b: any) => b.text);
}

function getInlineCallbackData(replyMarkup: any): string[] {
  const rows = replyMarkup?.inline_keyboard || [];
  return rows.flat().map((b: any) => b.callback_data);
}

describe('Cash Source Utility — Explicit Keyword Detection & Compatibility', () => {
  it('maps explicit Uzbek (Latin & Cyrillic) register and safe keywords accurately', () => {
    // TODAY_REGISTER
    expect(detectCashSourceFromText('naqdga 500 ming yuk oldim kassadan')).toEqual({
      cashSource: 'TODAY_REGISTER',
      hasExplicitSource: true,
      paymentSource: 'TODAY_CASH',
    });
    expect(detectCashSourceFromText('naqdga 500 ming yuk oldim bugungi kassadan')).toEqual({
      cashSource: 'TODAY_REGISTER',
      hasExplicitSource: true,
      paymentSource: 'TODAY_CASH',
    });
    expect(detectCashSourceFromText('Нақдга 500 минг юк олдим бугунги кассадан')).toEqual({
      cashSource: 'TODAY_REGISTER',
      hasExplicitSource: true,
      paymentSource: 'TODAY_CASH',
    });

    // SAFE
    expect(detectCashSourceFromText('naqdga 500 ming yuk oldim seyfdan')).toEqual({
      cashSource: 'SAFE',
      hasExplicitSource: true,
      paymentSource: 'PREVIOUS_SAFE',
    });
    expect(detectCashSourceFromText('naqdga 500 ming yuk oldim kechagi puldan')).toEqual({
      cashSource: 'SAFE',
      hasExplicitSource: true,
      paymentSource: 'PREVIOUS_SAFE',
    });
    expect(detectCashSourceFromText('eski kassadan 300 ming naqd yuk oldim')).toEqual({
      cashSource: 'SAFE',
      hasExplicitSource: true,
      paymentSource: 'PREVIOUS_SAFE',
    });
    expect(detectCashSourceFromText('Нақдга 500 минг юк олдим сейфдан')).toEqual({
      cashSource: 'SAFE',
      hasExplicitSource: true,
      paymentSource: 'PREVIOUS_SAFE',
    });

    // Omitted / ambiguous ("bugun" alone is NOT an explicit register source)
    expect(detectCashSourceFromText('naqdga 500 ming yuk oldim')).toEqual({
      cashSource: null,
      hasExplicitSource: false,
      paymentSource: 'TODAY_CASH',
    });
    expect(detectCashSourceFromText('bugun naqdga 500 ming yuk oldim')).toEqual({
      cashSource: null,
      hasExplicitSource: false,
      paymentSource: 'TODAY_CASH',
    });
  });

  it('keeps legacy paymentSource and new cashSource 100% compatible', () => {
    expect(cashSourceToPaymentSource('TODAY_REGISTER')).toBe('TODAY_CASH');
    expect(cashSourceToPaymentSource('SAFE')).toBe('PREVIOUS_SAFE');
    expect(paymentSourceToCashSource('TODAY_CASH')).toBe('TODAY_REGISTER');
    expect(paymentSourceToCashSource('PREVIOUS_SAFE')).toBe('SAFE');
    expect(resolveEffectiveCashSource({ cashSource: null, paymentSource: 'PREVIOUS_SAFE' })).toBe('SAFE');
    expect(resolveEffectiveCashSource({ cashSource: null, paymentSource: 'TODAY_CASH' })).toBe('TODAY_REGISTER');
    expect(resolveEffectiveCashSource({ cashSource: 'SAFE', paymentSource: 'TODAY_CASH' })).toBe('SAFE');
    expect(formatCashSourceBadge('TODAY_REGISTER')).toBe('Kassadan');
    expect(formatCashSourceBadge('SAFE')).toBe('Seyfdan');
    expect(formatCashSourceDisplay('TODAY_REGISTER')).toBe('💵 Bugungi kassadan');
    expect(formatCashSourceDisplay('SAFE')).toBe('🔐 Seyfdan (kechagi pul)');
  });
});

describe('Local Parser & AI Intent Normalization — Cash Goods Purchases', () => {
  it('parses generic cash purchase with omitted source and marks hasExplicitSource = false', () => {
    const parsed = parseTextCommandLocally('naqdga 500 ming yuk oldim');
    expect(parsed).not.toBeNull();
    expect(parsed?.intent).toBe('ADD_CASH_TX');
    expect(parsed?.amount).toBe(500_000);
    expect(parsed?.currency).toBe('UZS');
    expect(parsed?.paymentType).toBe('CASH');
    expect(parsed?.cashSource).toBeNull();
    expect(parsed?.hasExplicitSource).toBe(false);
  });

  it('maps explicit voice/text keywords ("kassadan" vs "seyfdan") to TODAY_REGISTER and SAFE', () => {
    const regGeneric = parseTextCommandLocally('naqdga 500 ming yuk oldim bugungi kassadan');
    expect(regGeneric?.intent).toBe('ADD_CASH_TX');
    expect(regGeneric?.amount).toBe(500_000);
    expect(regGeneric?.cashSource).toBe('TODAY_REGISTER');
    expect(regGeneric?.paymentSource).toBe('TODAY_CASH');
    expect(regGeneric?.hasExplicitSource).toBe(true);

    const safeGeneric = parseTextCommandLocally('naqdga 500 ming yuk oldim seyfdan');
    expect(safeGeneric?.intent).toBe('ADD_CASH_TX');
    expect(safeGeneric?.amount).toBe(500_000);
    expect(safeGeneric?.cashSource).toBe('SAFE');
    expect(safeGeneric?.paymentSource).toBe('PREVIOUS_SAFE');
    expect(safeGeneric?.hasExplicitSource).toBe(true);

    const safeYesterday = parseTextCommandLocally('kechagi puldan 750 ming yuk oldim');
    expect(safeYesterday?.intent).toBe('ADD_CASH_TX');
    expect(safeYesterday?.amount).toBe(750_000);
    expect(safeYesterday?.cashSource).toBe('SAFE');
    expect(safeYesterday?.hasExplicitSource).toBe(true);

    const namedReg = parseTextCommandLocally('Sirok 500.000 naqd kassadan');
    expect(namedReg?.intent).toBe('INVOICE_CASH');
    expect(namedReg?.supplierName).toBe('Sirok');
    expect(namedReg?.cashSource).toBe('TODAY_REGISTER');
    expect(namedReg?.hasExplicitSource).toBe(true);

    const namedSafe = parseTextCommandLocally('Sirok 500.000 naqd seyfdan');
    expect(namedSafe?.intent).toBe('INVOICE_CASH');
    expect(namedSafe?.supplierName).toBe('Sirok');
    expect(namedSafe?.cashSource).toBe('SAFE');
    expect(namedSafe?.hasExplicitSource).toBe(true);

    const namedOmitted = parseTextCommandLocally('Sirok 500.000 naqd');
    expect(namedOmitted?.intent).toBe('INVOICE_CASH');
    expect(namedOmitted?.supplierName).toBe('Sirok');
    expect(namedOmitted?.cashSource).toBeNull();
    expect(namedOmitted?.hasExplicitSource).toBe(false);
  });

  it('normalizes AI voice/text intent cashSource strictly against raw transcript', () => {
    const omitted = AiService.normalizeIntentCashSource(
      {
        intent: 'ADD_CASH_TX',
        amount: 500_000,
        currency: 'UZS',
        cashSource: 'TODAY_REGISTER', // even if LLM hallucinates default
        hasExplicitSource: false,
      },
      'naqdga 500 ming yuk oldim'
    );
    expect(omitted.cashSource).toBeNull();
    expect(omitted.hasExplicitSource).toBe(false);

    const safeFromVoice = AiService.normalizeIntentCashSource(
      {
        intent: 'ADD_CASH_TX',
        amount: 500_000,
        currency: 'UZS',
        transcript: 'seyfdan 500 minglik yuk oldim naqdga',
      },
      ''
    );
    expect(safeFromVoice.cashSource).toBe('SAFE');
    expect(safeFromVoice.paymentSource).toBe('PREVIOUS_SAFE');
    expect(safeFromVoice.hasExplicitSource).toBe(true);

    const regFromVoice = AiService.normalizeIntentCashSource(
      {
        intent: 'ADD_CASH_TX',
        amount: 500_000,
        currency: 'UZS',
        transcript: 'bugungi kassadan 500 ming yuk oldim',
      },
      ''
    );
    expect(regFromVoice.cashSource).toBe('TODAY_REGISTER');
    expect(regFromVoice.paymentSource).toBe('TODAY_CASH');
    expect(regFromVoice.hasExplicitSource).toBe(true);
  });
});

describe('Mandatory Cash Source Prompt — All 3 Purchase Flows', () => {
  it('1. Zero-menu voice/text: prompts for cash source when omitted and does NOT write to DB', async () => {
    const createCashSpy = vi.spyOn(prisma.cashTransaction, 'create').mockResolvedValue({} as any);
    const createInvSpy = vi.spyOn(SupplierService, 'createInvoiceWithItems').mockResolvedValue({} as any);
    const pendingCreateSpy = vi
      .spyOn(prisma.pendingAction, 'create')
      .mockResolvedValue({ id: 'pa-voice-1' } as any);

    const { ctx, replies } = createMockCtx();
    const parsed = parseTextCommandLocally('naqdga 500 ming yuk oldim')!;

    await processIntent(ctx, {
      intent: parsed.intent,
      amount: parsed.amount,
      currency: parsed.currency,
      paymentType: parsed.paymentType,
      cashSource: parsed.cashSource,
      hasExplicitSource: parsed.hasExplicitSource,
      comment: parsed.comment,
    });

    expect(createCashSpy).not.toHaveBeenCalled();
    expect(createInvSpy).not.toHaveBeenCalled();
    expect(pendingCreateSpy).toHaveBeenCalledTimes(1);
    expect(ctx.session.tempData).toMatchObject({
      type: 'CASH_PURCHASE_DRAFT',
      actionId: 'v_pa-voice-1',
    });
    expect(replies.length).toBe(1);
    expect(replies[0].text).toContain(CASH_SOURCE_PROMPT_TEXT);
    expect(getInlineButtonTexts(replies[0].extra?.reply_markup)).toEqual([
      CASH_SOURCE_BTN_TODAY,
      CASH_SOURCE_BTN_SAFE,
      CASH_SOURCE_BTN_CANCEL,
    ]);
    expect(getInlineCallbackData(replies[0].extra?.reply_markup)).toEqual([
      'cs:T:v_pa-voice-1',
      'cs:S:v_pa-voice-1',
      'cancel_v_pa-voice-1',
    ]);
  });

  it('2. Zero-menu voice/text: saves directly with TODAY_REGISTER or SAFE when explicitly stated', async () => {
    const createCashSpy = vi.spyOn(prisma.cashTransaction, 'create').mockResolvedValue({ id: 'ct-1' } as any);
    const pendingCreateSpy = vi.spyOn(prisma.pendingAction, 'create').mockResolvedValue({} as any);

    // Explicit TODAY_REGISTER
    const regMock = createMockCtx();
    const parsedReg = parseTextCommandLocally('naqdga 500 ming yuk oldim kassadan')!;
    await processIntent(regMock.ctx, {
      intent: parsedReg.intent,
      amount: parsedReg.amount,
      currency: parsedReg.currency,
      paymentType: parsedReg.paymentType,
      cashSource: parsedReg.cashSource,
      paymentSource: parsedReg.paymentSource,
      hasExplicitSource: parsedReg.hasExplicitSource,
      comment: parsedReg.comment,
    });

    expect(pendingCreateSpy).not.toHaveBeenCalled();
    expect(createCashSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: '901001',
          amount: 500_000,
          cashSource: 'TODAY_REGISTER',
          paymentSource: 'TODAY_CASH',
        }),
      })
    );
    expect(regMock.replies[0].text).toContain('Kassadan');
    expect(regMock.replies[0].text).toContain('Bugungi kassadan');

    // Explicit SAFE
    const safeMock = createMockCtx();
    const parsedSafe = parseTextCommandLocally('naqdga 650 ming yuk oldim seyfdan')!;
    await processIntent(safeMock.ctx, {
      intent: parsedSafe.intent,
      amount: parsedSafe.amount,
      currency: parsedSafe.currency,
      paymentType: parsedSafe.paymentType,
      cashSource: parsedSafe.cashSource,
      paymentSource: parsedSafe.paymentSource,
      hasExplicitSource: parsedSafe.hasExplicitSource,
      comment: parsedSafe.comment,
    });

    expect(createCashSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: '901001',
          amount: 650_000,
          cashSource: 'SAFE',
          paymentSource: 'PREVIOUS_SAFE',
        }),
      })
    );
    expect(safeMock.replies[0].text).toContain('Seyfdan');
  });

  it('3. Zero-menu callback cs:S:v_<id> finalizes stored draft with SAFE and cleans up session', async () => {
    const createCashSpy = vi.spyOn(prisma.cashTransaction, 'create').mockResolvedValue({ id: 'ct-safe' } as any);
    vi.spyOn(prisma.pendingAction, 'findFirst').mockResolvedValue({
      id: 'pa-voice-2',
      userId: BigInt(901001),
      type: 'VOICE_INTENT',
      data: {
        ownerId: '901001',
        intent: 'ADD_CASH_TX',
        amount: 450_000,
        currency: 'UZS',
        paymentType: 'CASH',
        comment: 'naqdga 450 ming yuk oldim',
      },
    } as any);
    const deletePendingSpy = vi
      .spyOn(prisma.pendingAction, 'deleteMany')
      .mockResolvedValue({ count: 1 } as any);

    const { ctx, edits } = createMockCtx({
      update: { callback_query: { id: 'cb1', data: 'cs:S:v_pa-voice-2', from: { id: 901001 } } },
      callbackQuery: {
        id: 'cb1',
        data: 'cs:S:v_pa-voice-2',
        from: { id: 901001 },
        message: { message_id: 222, chat: { id: 901001 } },
      },
      session: {
        step: 'v_pa-voice-2',
        tempData: { type: 'CASH_PURCHASE_DRAFT', actionId: 'v_pa-voice-2' },
      },
    });

    await voiceHandler.middleware()(ctx, async () => {});

    expect(createCashSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: '901001',
          amount: 450_000,
          cashSource: 'SAFE',
          paymentSource: 'PREVIOUS_SAFE',
        }),
      })
    );
    expect(deletePendingSpy).toHaveBeenCalled();
    expect(ctx.session.step).toBeUndefined();
    expect(ctx.session.tempData).toBeNull();
    expect(edits[0].text).toContain('Seyfdan');
  });

  it('4. Invoice OCR flow: confirm_invcash prompts for source without saving, then cs:T / cs:S saves with cashSource', async () => {
    const createInvSpy = vi.spyOn(SupplierService, 'createInvoiceWithItems').mockResolvedValue({
      supplier: { id: 'sup-1', name: 'Millora', debtUzs: 0, debtUsd: 0 },
      invoice: { id: 'inv-cash-1' },
      transaction: { id: 'tx-1' },
    } as any);
    vi.spyOn(prisma.pendingAction, 'findFirst').mockResolvedValue({
      id: 'inv-pend-1',
      userId: BigInt(901001),
      type: 'INVOICE',
      data: {
        ownerId: '901001',
        data: {
          supplierName: 'Millora',
          rawTotal: 1_200_000,
          discountAmount: 0,
          finalTotal: 1_200_000,
          currency: 'UZS',
          items: [],
        },
        photoFileId: null,
        imageUrl: null,
        userPhotoMsgId: null,
      },
    } as any);
    vi.spyOn(prisma.pendingAction, 'deleteMany').mockResolvedValue({ count: 1 } as any);

    // Step A: User taps "💵 Naqdga" on OCR preview -> MUST prompt, MUST NOT save yet
    const stepA = createMockCtx({
      update: { callback_query: { id: 'cb-inv-1', data: 'confirm_invcash_i_inv-pend-1', from: { id: 901001 } } },
      callbackQuery: {
        id: 'cb-inv-1',
        data: 'confirm_invcash_i_inv-pend-1',
        from: { id: 901001 },
        message: { message_id: 301, chat: { id: 901001 } },
      },
    });
    await invoiceHandler.middleware()(stepA.ctx, async () => {});

    expect(createInvSpy).not.toHaveBeenCalled();
    expect(stepA.edits.length).toBe(1);
    expect(stepA.edits[0].text).toContain(CASH_SOURCE_PROMPT_TEXT);
    expect(getInlineButtonTexts(stepA.edits[0].extra?.reply_markup)).toEqual([
      CASH_SOURCE_BTN_TODAY,
      CASH_SOURCE_BTN_SAFE,
      CASH_SOURCE_BTN_CANCEL,
    ]);

    // Step B: User taps "🔐 Seyfdan (kechagi pul)" -> saves invoice with cashSource: 'SAFE'
    const stepB = createMockCtx({
      update: { callback_query: { id: 'cb-inv-2', data: 'cs:S:i_inv-pend-1', from: { id: 901001 } } },
      callbackQuery: {
        id: 'cb-inv-2',
        data: 'cs:S:i_inv-pend-1',
        from: { id: 901001 },
        message: { message_id: 301, chat: { id: 901001 } },
      },
    });
    await invoiceHandler.middleware()(stepB.ctx, async () => {});

    expect(createInvSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: '901001',
        supplierName: 'Millora',
        paymentType: 'CASH',
        cashSource: 'SAFE',
        paymentSource: 'PREVIOUS_SAFE',
        paidCashAmount: 1_200_000,
      })
    );
    expect(stepB.edits[0].text).toContain('Seyfdan');
    expect(stepB.edits[0].text).toContain('Z-otchyot) dan ayirilmadi');
  });

  it('5. Manual "💵 Naqd" flow: template prompts for source before saving, then cs:T saves with TODAY_REGISTER', async () => {
    const createCashSpy = vi.spyOn(prisma.cashTransaction, 'create').mockResolvedValue({ id: 'ct-manual' } as any);

    // Step A: Submit filled template
    const templateMsg = {
      message_id: 401,
      chat: { id: 901001, type: 'private' },
      from: { id: 901001, first_name: 'Sardor' },
      text: 'Operatsiya: Naqd xarid\nKimdan/Brend: Bozor\nSumma: 350000\nTovar/Izoh: Olma va banan',
    };
    const stepA = createMockCtx({
      update: { update_id: 1, message: templateMsg },
      message: templateMsg,
      session: { step: 'ADD_CASH_TEMPLATE', tempData: undefined },
    });
    await cashHandler.middleware()(stepA.ctx, async () => {});

    expect(createCashSpy).not.toHaveBeenCalled();
    expect(stepA.replies.length).toBe(1);
    expect(stepA.replies[0].text).toContain(CASH_SOURCE_PROMPT_TEXT);
    const cbData = getInlineCallbackData(stepA.replies[0].extra?.reply_markup);
    const todayCb = cbData.find((c) => c.startsWith('cs:T:cash_'))!;
    expect(todayCb).toBeTruthy();
    expect(cbData.some((c) => c.startsWith('cs:S:cash_'))).toBe(true);

    // Step B: Tap "💵 Bugungi kassadan"
    const stepB = createMockCtx({
      update: { callback_query: { id: 'cb-cash-1', data: todayCb, from: { id: 901001 } } },
      callbackQuery: {
        id: 'cb-cash-1',
        data: todayCb,
        from: { id: 901001 },
        message: { message_id: 402, chat: { id: 901001 } },
      },
      session: stepA.ctx.session,
    });
    await cashHandler.middleware()(stepB.ctx, async () => {});

    expect(createCashSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerId: '901001',
          partyName: 'Bozor',
          amount: 350_000,
          cashSource: 'TODAY_REGISTER',
          paymentSource: 'TODAY_CASH',
        }),
      })
    );
    expect(stepB.edits[0].text).toContain('Kassadan');
    expect(stepB.ctx.session.step).toBeUndefined();
  });
});

describe('Z-Report & Daily Cash Register Balance — TODAY_REGISTER vs SAFE Accounting', () => {
  it('deducts TODAY_REGISTER cash purchases from daily register balance and excludes SAFE cash purchases', () => {
    const summary = summarizeCashGoodsPurchases({
      invoices: [
        {
          id: 'inv-1',
          paidCashAmount: 500_000,
          currency: 'UZS',
          cashSource: 'TODAY_REGISTER',
          createdAt: new Date('2026-11-25T06:00:00Z'),
        },
        {
          id: 'inv-2',
          paidCashAmount: 1_200_000,
          currency: 'UZS',
          cashSource: 'SAFE',
          createdAt: new Date('2026-11-25T07:00:00Z'),
        },
      ],
      cashTransactions: [
        // Linked to inv-1 -> must NOT be double counted
        {
          id: 'ct-1',
          invoiceId: 'inv-1',
          amount: 500_000,
          currency: 'UZS',
          cashSource: 'TODAY_REGISTER',
          createdAt: new Date('2026-11-25T06:00:01Z'),
        },
        // Standalone manual purchase from today's register
        {
          id: 'ct-2',
          invoiceId: null,
          amount: 300_000,
          currency: 'UZS',
          cashSource: 'TODAY_REGISTER',
          createdAt: new Date('2026-11-25T08:00:00Z'),
        },
        // Standalone manual purchase from safe
        {
          id: 'ct-3',
          invoiceId: null,
          amount: 400_000,
          currency: 'UZS',
          cashSource: 'SAFE',
          createdAt: new Date('2026-11-25T09:00:00Z'),
        },
      ],
    });

    expect(summary).toEqual({
      todayRegisterUzs: 800_000,
      todayRegisterCount: 2,
      safeUzs: 1_600_000,
      safeCount: 2,
      totalUzs: 2_400_000,
      totalCount: 4,
    });

    const balance = computeDailyRegisterBalance({
      grossCashSalesUzs: 5_000_000,
      cashPurchasesTodayRegisterUzs: summary.todayRegisterUzs,
      cashPurchasesSafeUzs: summary.safeUzs,
      supplierPaymentsTodayRegisterUzs: 700_000,
      expensesTodayRegisterUzs: 200_000,
    });

    // Expected drawer cash = 5,000,000 - 800,000 (TODAY_REGISTER) - 700,000 - 200,000 = 3,300,000
    // SAFE 1,600,000 is excluded from register balance, yet preserved in total history (2,400,000)
    expect(balance.expectedCashInDrawerUzs).toBe(3_300_000);
    expect(balance.deductedCashPurchasesUzs).toBe(800_000);
    expect(balance.excludedSafeCashPurchasesUzs).toBe(1_600_000);
    expect(balance.totalCashPurchasesHistoryUzs).toBe(2_400_000);
  });

  it('ReportService.generateAndSaveZReport includes TODAY_REGISTER and excludes SAFE cash purchases with ownerId isolation', async () => {
    const ownerId = '888555';
    const invSpy = vi.spyOn(prisma.invoice, 'findMany').mockResolvedValue([
      {
        id: 'inv-reg-z',
        paidCashAmount: 600_000,
        currency: 'UZS',
        cashSource: 'TODAY_REGISTER',
        createdAt: new Date('2026-11-25T06:00:00Z'),
      } as any,
      {
        id: 'inv-safe-z',
        paidCashAmount: 2_000_000,
        currency: 'UZS',
        cashSource: 'SAFE',
        createdAt: new Date('2026-11-25T06:30:00Z'),
      } as any,
    ]);
    vi.spyOn(prisma.cashTransaction, 'findMany').mockResolvedValue([
      {
        id: 'ct-manual-reg-z',
        invoiceId: null,
        amount: 200_000,
        currency: 'UZS',
        cashSource: 'TODAY_REGISTER',
        paymentSource: 'TODAY_CASH',
        createdAt: new Date('2026-11-25T08:00:00Z'),
      } as any,
      {
        id: 'ct-manual-safe-z',
        invoiceId: null,
        amount: 500_000,
        currency: 'UZS',
        cashSource: 'SAFE',
        paymentSource: 'PREVIOUS_SAFE',
        createdAt: new Date('2026-11-25T08:30:00Z'),
      } as any,
    ]);
    vi.spyOn(prisma.supplierPayment, 'findMany').mockResolvedValue([
      { amount: 400_000, paymentSource: 'TODAY_CASH' } as any,
    ]);
    const zUpsert = vi.fn().mockResolvedValue({});
    const regUpsert = vi.fn().mockResolvedValue({});
    vi.spyOn(prisma, '$transaction').mockImplementation(async (fn: any) =>
      fn({
        zReport: { upsert: zUpsert },
        dailyRegister: { upsert: regUpsert },
      })
    );

    const zRes = await ReportService.generateAndSaveZReport({
      ownerId,
      terminalAmount: 1_000_000,
      clickAmount: 500_000,
      cashRemainingInDrawer: 2_500_000,
      now: new Date('2026-11-25T15:00:00Z'),
    });

    expect((invSpy.mock.calls[0][0] as any).where.ownerId).toBe(ownerId);
    expect(zUpsert).toHaveBeenCalledTimes(1);
    expect(regUpsert).toHaveBeenCalledTimes(1);
    // TODAY_REGISTER cash purchases = 600k + 200k = 800k
    expect(zRes.dailyCashPurchasesUzs).toBe(800_000);
    expect(zRes.dailyCashPurchasesCount).toBe(2);
    // SAFE cash purchases = 2,000k + 500k = 2,500k (excluded from totalDailySalesUzs!)
    expect(zRes.safeCashPurchasesUzs).toBe(2_500_000);
    expect(zRes.safeCashPurchasesCount).toBe(2);
    // Total daily sales = 1,000k (term) + 500k (click) + 2,500k (drawer) + 800k (TODAY_REGISTER) + 400k (sup pay) = 5,200,000
    expect(zRes.totalDailySalesUzs).toBe(5_200_000);
    expect(zRes.formattedText).toContain('Bugungi kassadan');
    expect(zRes.formattedText).toContain('Seyfdan');
    expect(zRes.formattedText).toContain('bugungi kassadan ayirilmadi');
  });

  it('ReportService.aggregateReportData & formatReportMessage exclude SAFE from register outflow while keeping it in cash purchase history', () => {
    const period = ReportService.getPeriodRange('current_week', new Date('2026-11-25T10:00:00Z'));
    const data = ReportService.aggregateReportData(
      {
        registers: [
          {
            date: new Date('2026-11-25T00:00:00Z'),
            cashUzs: 4_000_000,
            cashUsd: 0,
            clickAmount: 500_000,
            terminalAmount: 1_000_000,
            isClosed: true,
          },
        ],
        supplierTransactions: [],
        totalSupplierDebtUzs: 0,
        totalSupplierDebtUsd: 0,
        expenses: [],
        cashTransactions: [
          {
            amount: 500_000,
            cashSource: 'TODAY_REGISTER',
            paymentSource: 'TODAY_CASH',
          },
          {
            amount: 1_500_000,
            cashSource: 'SAFE',
            paymentSource: 'PREVIOUS_SAFE',
          },
        ],
        newCustomerDebts: [],
        updatedCustomerDebts: [],
        activeCustomerDebts: [],
      },
      period.totalDays
    );

    // Total cash purchases history includes BOTH (500k + 1.5M = 2M)
    expect(data.cashPurchasesUzs).toBe(2_000_000);
    expect(data.cashPurchasesTodayRegisterUzs).toBe(500_000);
    expect(data.cashPurchasesSafeUzs).toBe(1_500_000);
    // Register outflow deducts ONLY TODAY_REGISTER (500k), NOT SAFE (1.5M)
    expect(data.outflowUzs).toBe(500_000);

    const formatted = ReportService.formatReportMessage(period, data);
    expect(formatted).toContain('Kassadan');
    expect(formatted).toContain('Seyfdan');
  });
});

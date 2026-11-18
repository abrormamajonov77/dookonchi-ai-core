import { Composer } from 'grammy';
import { Prisma } from '@prisma/client';
import { MyContext } from '../context';
import { AiService } from '../../services/ai.service';
import {
  getConfirmationKeyboard,
  getDisambiguationKeyboard,
  getFuzzySupplierSuggestionKeyboard,
  getPaymentSourceConfirmationKeyboard,
} from '../keyboards/inline';
import { isMenuButton } from '../keyboards/menu';
import { logger } from '../../config/logger';
import { formatCurrency, formatDate } from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import { withChatAction, downloadTelegramFile, clearSession, formatFriendlyError, safeEditMessageText, safeReply, sanitizeMdV1 } from '../../utils/telegram';
import { SupplierService } from '../../services/supplier.service';
import { cacheService } from '../../services/cache.service';
import { SearchService } from '../../services/search.service';
import { parseTextCommandLocally } from '../../utils/local-parser';
import { toLatinUz } from '../../utils/transliterate';

export const voiceHandler = new Composer<MyContext>();

const EXPIRED_MSG =
  "⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.";
const NEW_SUPP_PROMPT =
  "Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):";

export function parseShorthandTx(text: string) {
  const local = parseTextCommandLocally(text);
  if (!local) return null;
  if (
    local.intent !== 'INVOICE_CASH' &&
    local.intent !== 'INVOICE_CREDIT' &&
    local.intent !== 'SUPPLIER_PAYMENT'
  ) {
    return null;
  }
  return {
    txType: (local.intent === 'SUPPLIER_PAYMENT' ? 'PAYMENT' : 'INCOMING_GOODS') as
      | 'PAYMENT'
      | 'INCOMING_GOODS',
    amount: local.amount,
    currency: local.currency,
    name: local.supplierName,
    paymentType: local.paymentType,
    paymentSource: local.paymentSource,
    hasExplicitSource: local.hasExplicitSource,
  };
}

async function saveSupplierTxData(
  data: any,
  ownerId: string,
  overrideSource?: 'TODAY_CASH' | 'PREVIOUS_SAFE'
): Promise<number> {
  const currency: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const amount = Number(Math.abs(Number(data.amount || 0)).toFixed(2));
  const paymentSource: 'TODAY_CASH' | 'PREVIOUS_SAFE' =
    overrideSource || data.paymentSource || 'TODAY_CASH';
  const cleanName = toLatinUz(data.name || data.supplierName || "Noma'lum").trim();

  // If it's a CASH purchase ("Sirok 500.000 naqd"), record via createInvoiceWithItems (paymentType: 'CASH')
  if (data.paymentType === 'CASH' || data.intent === 'INVOICE_CASH' || data.intent === 'ADD_CASH_TX') {
    const res = await SupplierService.createInvoiceWithItems({
      ownerId,
      supplierId:
        data.exactSupplierId && data.exactSupplierId !== 'CREATE_NEW'
          ? data.exactSupplierId
          : undefined,
      supplierName: cleanName,
      rawTotal: amount,
      discountInput: 0,
      currency,
      paymentType: 'CASH',
      paymentSource,
      paidCashAmount: amount,
      creditAmount: 0,
      forceOverrideDuplicate: true,
    });
    return currency === 'USD' ? Number(res.supplier.debtUsd) : Number(res.supplier.debtUzs);
  }

  // If it's a PAYMENT to supplier
  if (data.txType === 'PAYMENT' || data.intent === 'SUPPLIER_PAYMENT') {
    const res = await SupplierService.recordSupplierPayment({
      ownerId,
      supplierId:
        data.exactSupplierId && data.exactSupplierId !== 'CREATE_NEW'
          ? data.exactSupplierId
          : undefined,
      supplierName: cleanName,
      amount,
      currency,
      paymentSource,
      comment: data.comment || (paymentSource === 'PREVIOUS_SAFE' ? "Kechagi puldan / Seyfdan to'lov" : "Bugungi kassadan to'lov"),
    });
    return currency === 'USD' ? Number(res.supplier.debtUsd) : Number(res.supplier.debtUzs);
  }

  // Otherwise CREDIT incoming goods
  let finalDebt = 0;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const supplier = await SupplierService.getOrMergeSupplier(
      tx,
      cleanName,
      data.exactSupplierId,
      ownerId
    );
    const isUsd = currency === 'USD';
    const currentDebtUzs = Number((Number(supplier.debtUzs) + (isUsd ? 0 : amount)).toFixed(2));
    const currentDebtUsd = Number((Number(supplier.debtUsd) + (isUsd ? amount : 0)).toFixed(2));
    const postDebtText = isUsd ? formatCurrency(currentDebtUsd, 'USD') : formatCurrency(currentDebtUzs, 'UZS');
    const formattedReceipt =
      `🧾 ELEKTRON NAKLADNOY\n` +
      `🏢 Ta'minotchi: ${supplier.name}\n` +
      `📅 Sana: ${formatDate(new Date())}\n` +
      `📥 Kiritish usuli: 🎙 Matn / Ovozli xabar\n` +
      `-----------------------------\n` +
      `Yuk olish - ${formatCurrency(amount, currency)}\n` +
      `${data.comment ? `Izoh: ${toLatinUz(data.comment)}\n` : ''}` +
      `-----------------------------\n` +
      `💰 Amaliyot summasi: ${formatCurrency(amount, currency)}\n` +
      `📦 Ushbu amaliyotdan keyingi qarz: ${postDebtText}\n`;

    const inv = await tx.invoice.create({
      data: {
        ownerId,
        supplierId: supplier.id,
        totalAmount: amount,
        originalAmount: amount,
        discountAmount: 0,
        currency,
        paymentType: 'CREDIT',
        paymentSource: 'TODAY_CASH',
        paidCashAmount: 0,
        creditAmount: amount,
        verbatimText: formattedReceipt,
      },
    });

    await tx.supplierTransaction.create({
      data: {
        ownerId,
        supplierId: supplier.id,
        invoiceId: inv.id,
        type: 'INCOMING_GOODS',
        paymentSource: 'TODAY_CASH',
        amount,
        currency,
        description: toLatinUz(data.comment || 'Matn/ovozli xabar orqali kiritildi'),
        sourceType: 'VOICE',
        formattedReceipt,
        receiptData: { comment: data.comment, amount, currency, txType: 'INCOMING_GOODS', invoiceId: inv.id },
      },
    });

    const updated = await tx.supplier.update({
      where: { id: supplier.id },
      data: { debtUzs: currentDebtUzs, debtUsd: currentDebtUsd },
    });
    finalDebt = isUsd ? Number(updated.debtUsd) : Number(updated.debtUzs);
  });
  cacheService.invalidateSupplierNames(ownerId);
  return finalDebt;
}

async function processIntent(ctx: MyContext, intentData: any) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);

  if (intentData.name) intentData.name = toLatinUz(intentData.name).trim();
  if (intentData.supplierName) intentData.supplierName = toLatinUz(intentData.supplierName).trim();

  if (intentData.intent === 'UNKNOWN')
    return ctx.reply("🤔 Kechirasiz, xabaringizni tushunmadim. Iltimos, aniqroq yozing yoki menyudan tanlang.");
  if (intentData.intent === 'GENERAL_CHAT')
    return ctx.reply(intentData.replyText || 'Savolingizga javob topa olmadim.');
  if (intentData.intent === 'SEARCH_PRODUCT') {
    const query = intentData.name || '';
    const items = await SearchService.searchProductsWithPriceDiff(query, ownerId);
    if (!items.length) return ctx.reply(`🤷‍♂️ "${query}" nomli mahsulot topilmadi.`);
    return safeReply(ctx, items.slice(0, 8).map((i) => i.formattedCard).join('\n\n────────────────────\n\n'));
  }

  if (intentData.intent === 'GET_DEBT_INFO') {
    const name = toLatinUz(intentData.name || '');
    const matchRes = await SupplierService.findOrSuggestSupplier(name, ownerId);
    const supplier = matchRes.supplier || matchRes.suggestedSupplier;
    if (!supplier) return ctx.reply(`🤷‍♂️ "${name}" ismli ta'minotchi topilmadi.`);
    return safeReply(
      ctx,
      `📊 **Qarz ma'lumoti:**\n\n🏢 Ta'minotchi: **${sanitizeMdV1(toLatinUz(supplier.name))}**\n💰 Qarz (UZS): **${formatCurrency(supplier.debtUzs, 'UZS')}**\n💵 Qarz (USD/USDT): **${formatCurrency(supplier.debtUsd, 'USD', true)}**`,
      { parse_mode: 'Markdown' }
    );
  }

  // Normalize local parser intents into unified voice confirmation intents
  if (intentData.intent === 'INVOICE_CASH') {
    intentData.intent = 'ADD_SUPPLIER_TX';
    intentData.txType = 'INCOMING_GOODS';
    intentData.paymentType = 'CASH';
  } else if (intentData.intent === 'INVOICE_CREDIT') {
    intentData.intent = 'ADD_SUPPLIER_TX';
    intentData.txType = 'INCOMING_GOODS';
    intentData.paymentType = 'CREDIT';
  } else if (intentData.intent === 'SUPPLIER_PAYMENT') {
    intentData.intent = 'ADD_SUPPLIER_TX';
    intentData.txType = 'PAYMENT';
  }

  // MODUL 4: Fuzzy Supplier Typo Guard ("Dinar" vs "Diner" / "Dinar kalbasa")
  if (intentData.intent === 'ADD_SUPPLIER_TX' && !intentData.exactSupplierId) {
    const targetName = intentData.name || intentData.supplierName || '';
    const fuzzyCheck = await SupplierService.findOrSuggestSupplier(targetName, ownerId);

    if (fuzzyCheck.isExactMatch && fuzzyCheck.supplier) {
      intentData.exactSupplierId = fuzzyCheck.supplier.id;
      intentData.name = fuzzyCheck.supplier.name;
    } else if (fuzzyCheck.isFuzzyMatch && fuzzyCheck.suggestedSupplier && fuzzyCheck.promptText) {
      const pendingAction = await prisma.pendingAction.create({
        data: {
          userId: BigInt(ctx.from.id),
          type: 'SUPPLIER_FUZZY_GUARD',
          data: {
            ...intentData,
            ownerId,
            suggestedSupplierId: fuzzyCheck.suggestedSupplier.id,
            suggestedSupplierName: fuzzyCheck.suggestedSupplier.name,
            inputName: fuzzyCheck.inputName,
          } as Prisma.InputJsonValue,
        },
      });
      const kb = getFuzzySupplierSuggestionKeyboard(
        fuzzyCheck.suggestedSupplier.id,
        fuzzyCheck.suggestedSupplier.name,
        fuzzyCheck.inputName,
        pendingAction.id
      );
      return ctx.reply(fuzzyCheck.promptText, { reply_markup: kb });
    } else {
      const candidates = await SupplierService.findMatchingSuppliers(
        targetName,
        intentData.comment,
        ownerId
      );
      if (candidates.length === 1) {
        intentData.exactSupplierId = candidates[0].id;
        intentData.name = candidates[0].name;
      } else if (candidates.length > 1) {
        const candidateIds = candidates.map((c) => c.id);
        const pendingAction = await prisma.pendingAction.create({
          data: {
            userId: BigInt(ctx.from.id),
            type: 'VOICE_INTENT_DISAMBIGUATION',
            data: { ...intentData, ownerId, candidateIds } as Prisma.InputJsonValue,
          },
        });
        return safeReply(
          ctx,
          `⚠️ *Bir nechta ta'minotchi topildi:*\nQaysi "${sanitizeMdV1(intentData.name)}" hisobiga yozilsin?`,
          {
            parse_mode: 'Markdown',
            reply_markup: getDisambiguationKeyboard(candidates, pendingAction.id, 'vsel', 'vnew', 'cancel_vdis'),
          }
        );
      }
    }
  }

  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId: BigInt(ctx.from.id),
      type: 'VOICE_INTENT',
      data: { ...intentData, ownerId } as Prisma.InputJsonValue,
    },
  });
  const actionId = `v_${pendingAction.id}`;
  ctx.session.step = actionId;

  const cur: 'UZS' | 'USD' = (intentData.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  let balancePreview = '';
  if (intentData.intent === 'ADD_SUPPLIER_TX') {
    const isCashPurchase = intentData.paymentType === 'CASH';
    const isIncoming = intentData.txType === 'INCOMING_GOODS';
    const isUsd = cur === 'USD';
    const amt = Number(Math.abs(Number(intentData.amount || 0)).toFixed(2));
    const supp = intentData.exactSupplierId && intentData.exactSupplierId !== 'CREATE_NEW'
      ? await prisma.supplier.findFirst({ where: { id: intentData.exactSupplierId, ownerId }, select: { debtUzs: true, debtUsd: true } })
      : await prisma.supplier.findFirst({
          where: { ownerId, name: { equals: intentData.name, mode: 'insensitive' }, isActive: true },
          select: { debtUzs: true, debtUsd: true },
        });
    if (supp && !isCashPurchase) {
      const curDebt = Number(isUsd ? supp.debtUsd : supp.debtUzs);
      const nextDebt = Number((isIncoming ? curDebt + amt : curDebt - amt).toFixed(2));
      balancePreview = `\n📊 Joriy qarz (${cur}): ${formatCurrency(curDebt, cur)}\n📦 Kutilayotgan yakuniy qoldiq: ${formatCurrency(nextDebt, cur)}`;
    }
  } else if (intentData.intent === 'ADD_CUSTOMER_DEBT') {
    const amt = Number(Math.abs(Number(intentData.amount || 0)).toFixed(2));
    const agg = await prisma.customerDebt.aggregate({
      where: {
        ownerId,
        customerName: { equals: intentData.name, mode: 'insensitive' },
        currency: cur,
        status: { in: ['PENDING', 'PARTIALLY_PAID'] },
      },
      _sum: { amount: true, paidAmount: true },
    });
    const curRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
    const nextRem = Number((curRem + amt).toFixed(2));
    balancePreview = `\n📊 Joriy nasiya (${cur}): ${formatCurrency(curRem, cur)}\n📦 Kutilayotgan yakuniy qoldiq: ${formatCurrency(nextRem, cur)}`;
  }

  const isPaymentTx =
    intentData.intent === 'ADD_SUPPLIER_TX' && intentData.txType === 'PAYMENT';

  const safeParty = sanitizeMdV1(intentData.name || intentData.supplierName || "Noma'lum");
  const safeCategory = sanitizeMdV1(intentData.category || 'Boshqa');
  const safeComment = sanitizeMdV1(intentData.comment || "Yo'q");

  const details =
    intentData.intent === 'ADD_EXPENSE'
      ? `Operatsiya: Xarajat\nSumma: ${formatCurrency(intentData.amount, cur)}\nKategoriya: ${safeCategory}\nIzoh: ${safeComment}`
      : intentData.intent === 'ADD_SUPPLIER_TX' && intentData.paymentType === 'CASH'
      ? `Operatsiya: 💵 Naqd yuk olish (Qarzga qo'shilmaydi)\nTa'minotchi: ${safeParty}\nSumma: ${formatCurrency(Math.abs(Number(intentData.amount)), cur)}`
      : intentData.intent === 'ADD_SUPPLIER_TX'
      ? `Operatsiya: Ta'minotchi bilan oldi-berdi\nTa'minotchi: ${safeParty}\nAmal turi: ${intentData.txType === 'INCOMING_GOODS' ? "Yuk olish (Kirim - Qarzga qo'shish)" : "To'lov (Chiqim - Qarzdan ayirish)"}\nSumma: ${intentData.txType === 'INCOMING_GOODS' ? '+' : '-'}${formatCurrency(Math.abs(Number(intentData.amount)), cur)}${balancePreview}`
      : intentData.intent === 'ADD_CASH_TX'
      ? `Operatsiya: Naqd xarid\nKimdan: ${safeParty}\nSumma: ${formatCurrency(intentData.amount, cur)}`
      : intentData.intent === 'ADD_CUSTOMER_DEBT'
      ? `Operatsiya: Nasiya savdo\nMijoz: ${safeParty}\nSumma: +${formatCurrency(Math.abs(Number(intentData.amount)), cur)}${balancePreview}`
      : '';

  // MODUL 5.2: For supplier payments without an explicit source, ask 1-click payment source
  if (isPaymentTx && !intentData.hasExplicitSource) {
    await safeReply(
      ctx,
      `💸 **Ta'minotchiga to'lov tasdiqlash**\n\n${details}\n\n👇 **Pul qaysi manbadan berildi?**`,
      {
        parse_mode: 'Markdown',
        reply_markup: getPaymentSourceConfirmationKeyboard(actionId),
      }
    );
    return;
  }

  await safeReply(ctx, `⚡️ **Tahlil Natijasi**\n\n${details}\n\nMa'lumotlar to'g'rimi?`, {
    parse_mode: 'Markdown',
    reply_markup: getConfirmationKeyboard(actionId),
  });
}

// MODUL 4: Fuzzy Supplier Typo Guard Callbacks (compact `sf_*` + legacy `sup_fuzzy_*`)
voiceHandler.callbackQuery(/^(?:sf_use:(.+)|sup_fuzzy_use:([^:]+):(.+))$/, async (ctx, next) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const rawPendingId = ctx.match[1] || ctx.match[3];
  if (rawPendingId.startsWith('inv_')) return next();

  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: rawPendingId } }).catch(() => null);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  const supplierId = ctx.match[2] || pData.suggestedSupplierId;
  const supplier = supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
    : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  await prisma.pendingAction.delete({ where: { id: rawPendingId } }).catch(() => {});
  await ctx.deleteMessage().catch(() => {});

  const intentData = {
    ...pData,
    exactSupplierId: supplier.id,
    name: supplier.name,
    supplierName: supplier.name,
  };
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^(?:sf_new|sup_fuzzy_new):(.+)$/, async (ctx, next) => {
  const pendingId = ctx.match[1];
  if (pendingId.startsWith('inv_')) return next();

  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
  await ctx.deleteMessage().catch(() => {});

  const intentData = {
    ...pData,
    exactSupplierId: 'CREATE_NEW',
    name: toLatinUz(pData.inputName || pData.name),
    supplierName: toLatinUz(pData.inputName || pData.name),
  };
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^(?:sf_no|sup_fuzzy_cancel):(.+)$/, async (ctx, next) => {
  const pendingId = ctx.match[1];
  if (pendingId.startsWith('inv_')) return next();

  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
  clearSession(ctx);
  await ctx.editMessageText('❌ Amal bekor qilindi.', { reply_markup: undefined });
});

// MODUL 5.2: 1-Click Payment Source Callbacks (`ps:T:v_<id>` / `ps:S:v_<id>` + legacy)
voiceHandler.callbackQuery(/^(?:pay_source:(TODAY_CASH|PREVIOUS_SAFE)|ps:(T|S)):v_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const paymentSource: 'TODAY_CASH' | 'PREVIOUS_SAFE' =
    ctx.match[1] === 'PREVIOUS_SAFE' || ctx.match[2] === 'S' ? 'PREVIOUS_SAFE' : 'TODAY_CASH';
  const pendingId = ctx.match[3];

  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  const cur: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const amt = Number(Math.abs(Number(data.amount)).toFixed(2));

  try {
    const finalDebt = await saveSupplierTxData(data, ownerId, paymentSource);
    const sourceBadge =
      paymentSource === 'PREVIOUS_SAFE'
        ? "🏦 Kechagi puldan / Seyfdan (Z-otchyot savdosiga qo'shilmadi)"
        : "💵 Bugungi kassadan (Bugungi Z-otchyotga qo'shildi)";

    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `✅ **To'lov muvaffaqiyatli saqlandi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(toLatinUz(data.name))}**\n` +
          `💸 To'lov: **-${formatCurrency(amt, cur)}**\n` +
          `🗂 Manba: ${sourceBadge}\n` +
          `📊 **Yakuniy qarz qoldig'i (${cur}):** **${formatCurrency(finalDebt, cur)}**`,
        { parse_mode: 'Markdown' }
      );
    }
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Error saving supplier payment with source');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi.", show_alert: true });
  }
});

voiceHandler.on('message:voice', async (ctx, next) => {
  if (!ctx.user) return next();
  await withChatAction(ctx, 'record_voice', async () => {
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('Ovozli fayl topilmadi');
      await processIntent(ctx, await AiService.parseVoiceNote(await downloadTelegramFile(file.file_path)));
    } catch (error) {
      logger.error({ error }, 'Error parsing voice');
      await ctx.reply(`❌ Ovozli xabarni tushunib bo'lmadi.\n\nSabab: ${formatFriendlyError(error)}`);
    }
  });
});

voiceHandler.on('message:text', async (ctx, next) => {
  if (!ctx.user || !ctx.from || ctx.message.text.startsWith('/')) return next();
  const ownerId = String(ctx.from.id);
  const text = ctx.message.text.trim();
  if (isMenuButton(text)) {
    clearSession(ctx);
    return next();
  }

  if (ctx.session.step === 'await_new_supplier_name') {
    const pendingId = ctx.session.tempData?.pendingId;
    const activePending = pendingId
      ? await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null)
      : await prisma.pendingAction.findFirst({
          where: {
            userId: BigInt(ctx.from.id),
            status: 'AWAIT_NEW_SUPPLIER_NAME',
            createdAt: { gte: new Date(Date.now() - 3600000) },
          },
          orderBy: { createdAt: 'desc' },
        });

    if (activePending) {
      const intentData = { ...(activePending.data as any), exactSupplierId: 'CREATE_NEW', name: toLatinUz(text) };
      await prisma.pendingAction.delete({ where: { id: activePending.id } });
      clearSession(ctx);
      return processIntent(ctx, intentData);
    }
    clearSession(ctx);
  } else if (ctx.session.step) {
    // Earlier handlers already processed text-input steps; leftover confirmation button steps (v_*, i_*, zrep_*) shouldn't block new commands.
    clearSession(ctx);
  }

  // MODUL 2: Instant Local Text Parser (<0.001s, 100% AI-free — never hits AI rate limits!)
  const localParsed = parseTextCommandLocally(text);
  if (localParsed) {
    if (localParsed.intent === 'SEARCH_PRODUCT') {
      const items = await SearchService.searchProductsWithPriceDiff(localParsed.name, ownerId);
      if (!items.length) return ctx.reply(`🤷‍♂️ "${localParsed.name}" nomli tovar bazadan topilmadi.`);
      return safeReply(ctx, items.slice(0, 8).map((i) => i.formattedCard).join('\n\n────────────────────\n\n'));
    }
    return processIntent(ctx, localParsed);
  }

  await withChatAction(ctx, 'typing', async () => {
    try {
      await processIntent(ctx, await AiService.parseTextIntent(ctx.message.text));
    } catch (error) {
      logger.error({ error }, 'Error parsing text intent');
      await ctx.reply(
        `🤔 Ushbu matnni tushunib bo'lmadi. Iltimos, quyidagi ko'rinishda yozing:\n` +
          `• Naqd xarid: \`Sirok 500.000 naqd\`\n` +
          `• Nasiya yuk: \`Dinar +811.432\`\n` +
          `• Qarzdan to'lov: \`Milter -500.000\``,
        { parse_mode: 'Markdown' }
      );
    }
  });
});

voiceHandler.callbackQuery(/^confirm_v_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  const cur: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  const safeName = sanitizeMdV1(toLatinUz(data.name || "Noma'lum"));
  try {
    let replyMsg = '';
    let useMarkdown = true;

    if (data.intent === 'ADD_EXPENSE') {
      await prisma.expense.create({
        data: {
          ownerId,
          amount: data.amount,
          currency: cur,
          category: toLatinUz(data.category || 'Boshqa'),
          note: toLatinUz(data.comment || ''),
        },
      });
      replyMsg = `✅ Xarajat saqlandi: ${formatCurrency(data.amount, cur)}`;
      useMarkdown = false;
    } else if (data.intent === 'ADD_SUPPLIER_TX') {
      const isCashPurchase = data.paymentType === 'CASH';
      const isIncoming = data.txType === 'INCOMING_GOODS';
      const amt = Number(Math.abs(Number(data.amount)).toFixed(2));
      const finalDebt = await saveSupplierTxData(data, ownerId);

      replyMsg = isCashPurchase
        ? `✅ **Naqd xarid muvaffaqiyatli saqlandi!**\n\n` +
          `🏢 Ta'minotchi: **${safeName}**\n` +
          `💵 Naqd summa: **${formatCurrency(amt, cur)}**\n` +
          `📊 Qarzga qo'shilmadi (0). Bugungi Z-otchyot naqd xaridlariga kiritildi.`
        : `✅ ${isIncoming ? 'Yuk olish (Kirim)' : "To'lov"} muvaffaqiyatli saqlandi!\n\n` +
          `🏢 Ta'minotchi: **${safeName}**\n` +
          `${isIncoming ? '📥 Yangi kirim' : "💸 To'lov"}: **${isIncoming ? '+' : '-'}${formatCurrency(amt, cur)}**\n` +
          `📊 **Yakuniy qarz qoldig'i (${cur}):** **${formatCurrency(finalDebt, cur)}**`;
    } else if (data.intent === 'ADD_CASH_TX') {
      await saveSupplierTxData({ ...data, paymentType: 'CASH' }, ownerId);
      replyMsg = `✅ Naqd xarid saqlandi:\nKimdan: ${safeName}\nSumma: ${formatCurrency(data.amount, cur)}${data.comment ? `\nIzoh: ${sanitizeMdV1(toLatinUz(data.comment))}` : ''}\n_(Ushbu summa qarzga ta'sir qilmadi)_`;
    } else if (data.intent === 'ADD_CUSTOMER_DEBT') {
      const amt = Number(Math.abs(Number(data.amount)).toFixed(2));
      const cleanCust = toLatinUz(data.name);
      await prisma.customerDebt.create({
        data: { ownerId, customerName: cleanCust, amount: amt, currency: cur },
      });
      const agg = await prisma.customerDebt.aggregate({
        where: {
          ownerId,
          customerName: { equals: cleanCust, mode: 'insensitive' },
          currency: cur,
          status: { in: ['PENDING', 'PARTIALLY_PAID'] },
        },
        _sum: { amount: true, paidAmount: true },
      });
      const totalCustRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
      replyMsg =
        `✅ Nasiya muvaffaqiyatli saqlandi!\n\n` +
        `👤 Mijoz: **${sanitizeMdV1(cleanCust)}**\n` +
        `💰 Nasiya summasi: **+${formatCurrency(amt, cur)}**\n` +
        `📊 **Mijozning umumiy nasiya qoldig'i (${cur}):** **${formatCurrency(totalCustRem, cur)}**`;
    }

    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
    ctx.session.step = undefined;
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        replyMsg,
        useMarkdown ? { parse_mode: 'Markdown' } : {}
      );
    }
  } catch (error) {
    logger.error(error, 'Transaction error saving voice intent');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
  }
});

voiceHandler.callbackQuery(/^confirm_suptx_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'SUPPLIER_TX')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  const cur: 'UZS' | 'USD' = (data.currency || 'UZS') === 'USD' ? 'USD' : 'UZS';
  try {
    const isIncoming = data.txType === 'INCOMING_GOODS';
    const amt = Number(Math.abs(Number(data.amount)).toFixed(2));
    const finalDebt = await saveSupplierTxData(data, ownerId);
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
    ctx.session.step = undefined;
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `✅ ${isIncoming ? 'Yuk olish (Kirim)' : "To'lov"} muvaffaqiyatli saqlandi!\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(toLatinUz(data.name))}**\n` +
          `${isIncoming ? '📥 Yangi kirim' : "💸 To'lov"}: **${isIncoming ? '+' : '-'}${formatCurrency(amt, cur)}**\n` +
          `📊 **Yakuniy qarz qoldig'i (${cur}):** **${formatCurrency(finalDebt, cur)}**`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (error) {
    logger.error(error, 'Error saving supplier tx confirmation');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi.", show_alert: true });
  }
});

voiceHandler.callbackQuery(/^cancel_(?:v|suptx|vdis)_(.+)$/, async (ctx) => {
  await prisma.pendingAction.delete({ where: { id: ctx.match[1] } }).catch(() => {});
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Bekor qilindi.', { reply_markup: undefined });
});

voiceHandler.callbackQuery(/^vsel_(.+)_(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const [, pendingId, rawIdx] = ctx.match;
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION')
    return ctx.editMessageText(
      '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.',
      { reply_markup: undefined }
    );
  const pData = pendingAction.data as any;
  const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
  const supplier = supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
    : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
  const intentData = { ...pData, exactSupplierId: supplier.id, name: supplier.name };
  await Promise.all([
    prisma.pendingAction.delete({ where: { id: pendingId } }),
    ctx.deleteMessage().catch(() => {}),
  ]);
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^vnew_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION')
    return ctx.editMessageText(
      '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.',
      { reply_markup: undefined }
    );
  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: { type: 'VOICE_INTENT_NEW_SUPP', status: 'AWAIT_NEW_SUPPLIER_NAME' },
  });
  ctx.session.step = 'await_new_supplier_name';
  ctx.session.tempData = { pendingId };
  await ctx.editMessageText(NEW_SUPP_PROMPT, { reply_markup: undefined });
});

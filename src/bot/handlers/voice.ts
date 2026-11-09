import { Composer } from 'grammy';
import { Prisma } from '@prisma/client';
import { MyContext } from '../context';
import { AiService } from '../../services/ai.service';
import { getConfirmationKeyboard, getDisambiguationKeyboard } from '../keyboards/inline';
import { isMenuButton } from '../keyboards/menu';
import { logger } from '../../config/logger';
import { formatMoney, formatDate, parseAmount } from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import { withChatAction, downloadTelegramFile, clearSession, formatFriendlyError } from '../../utils/telegram';
import { TranslitService } from '../../services/translit.service';
import { SupplierService } from '../../services/supplier.service';

export const voiceHandler = new Composer<MyContext>();

const EXPIRED_MSG = "⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.";
const NEW_SUPP_PROMPT = "Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):";

export function parseShorthandTx(text: string): { txType: 'PAYMENT' | 'INCOMING_GOODS'; amount: number; currency: 'UZS' | 'USD'; name: string } | null {
  const t = text.trim();
  if (!t || t.startsWith('/') || /qarzim|qancha|nechpul/i.test(t)) return null;

  let sign: string | null = null;
  let rawAmt: string | null = null;
  let rawName: string | null = null;

  const m1 = t.match(/^([+-])\s*([\d\s.,]+(?:\s*(?:mln|million|ming|k|\$|dollar|so'?m))?)\s+([a-zA-Zа-яА-Яo'g'shchO'G'SHCH0-9\s._-]+)$/i);
  if (m1) {
    sign = m1[1];
    rawAmt = m1[2];
    rawName = m1[3];
  } else {
    const m2 = t.match(/^([a-zA-Zа-яА-Яo'g'shchO'G'SHCH0-9\s._-]+?)\s+([+-])\s*([\d\s.,]+(?:\s*(?:mln|million|ming|k|\$|dollar|so'?m))?)$/i);
    if (m2) {
      rawName = m2[1];
      sign = m2[2];
      rawAmt = m2[3];
    } else {
      const m3 = t.match(/^([a-zA-Zа-яА-Яo'g'shchO'G'SHCH0-9\s._-]+?)\s+([\d\s.,]+(?:\s*(?:mln|million|ming|k|\$|dollar|so'?m))?)\s+ayir(?:dim|ing|ib\s*qo'?y|ish)?$/i);
      if (m3) {
        rawName = m3[1];
        sign = '-';
        rawAmt = m3[2];
      }
    }
  }

  if (!sign || !rawAmt || !rawName) return null;

  const cleanName = rawName.replace(/(?:dan\s*qarz|dan|ga|ni|ning)$/gi, '').trim();
  if (cleanName.length < 2) return null;

  const isUsd = /\$|dollar/i.test(rawAmt);
  const cleanAmtStr = rawAmt.replace(/\$|dollar|so'?m/gi, '').trim();
  const amount = parseAmount(cleanAmtStr);
  if (!amount || amount <= 0 || isNaN(amount)) return null;

  return {
    txType: sign === '-' ? 'PAYMENT' : 'INCOMING_GOODS',
    amount,
    currency: isUsd ? 'USD' : 'UZS',
    name: cleanName
  };
}

async function saveSupplierTxData(data: any): Promise<number> {
  let finalDebt = 0;
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const supplier = await SupplierService.getOrMergeSupplier(tx, data.name, data.exactSupplierId);
    const isIncoming = data.txType === 'INCOMING_GOODS';
    const isUsd = (data.currency || 'UZS') === 'USD';
    const amount = Math.abs(Number(data.amount || 0));
    data.amount = amount;
    const delta = isIncoming ? amount : -amount;
    const currentDebtUzs = Number(supplier.debtUzs) + (isUsd ? 0 : delta);
    const currentDebtUsd = Number(supplier.debtUsd) + (isUsd ? delta : 0);
    const postDebtText = isUsd ? formatMoney(currentDebtUsd, 'USD') : formatMoney(currentDebtUzs, 'UZS');
    const formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n🏢 Ta'minotchi: ${data.name}\n📅 Sana: ${formatDate(new Date())}\n📥 Kiritish usuli: 🎙 Matn / Ovozli xabar\n-----------------------------\n${isIncoming ? 'Yuk olish' : "To'lov"} - ${formatMoney(amount, data.currency)}\n${data.comment ? `Izoh: ${data.comment}\n` : ''}-----------------------------\n💰 Amaliyot summasi: ${formatMoney(amount, data.currency)}\n📦 Ushbu amaliyotdan keyingi qarz: ${postDebtText}\n`;

    await tx.supplierTransaction.create({
      data: { supplierId: supplier.id, type: data.txType, amount, currency: data.currency || 'UZS', description: data.comment || 'Ovozli/matnli xabar orqali kiritildi', sourceType: 'VOICE', formattedReceipt, receiptData: { comment: data.comment, amount, txType: data.txType } }
    });
    if (!isIncoming) await tx.supplierPayment.create({ data: { supplierId: supplier.id, amount, currency: data.currency || 'UZS', comment: data.comment } });
    const updated = await tx.supplier.update({ where: { id: supplier.id }, data: { debtUzs: currentDebtUzs, debtUsd: currentDebtUsd } });
    finalDebt = isUsd ? Number(updated.debtUsd) : Number(updated.debtUzs);
  });
  return finalDebt;
}

async function processIntent(ctx: MyContext, intentData: any) {
  if (intentData.intent === 'UNKNOWN') return ctx.reply("🤔 Kechirasiz, xabaringizni tushunmadim. Iltimos, aniqroq yozing yoki menyudan tanlang.");
  if (intentData.intent === 'GENERAL_CHAT') return ctx.reply(intentData.replyText || 'Savolingizga javob topa olmadim.');
  if (intentData.intent === 'SEARCH_PRODUCT') return ctx.reply(`🔍 Qidiruv: ${intentData.name}\nTez orada topib beraman...`);

  if (intentData.intent === 'GET_DEBT_INFO') {
    const name = intentData.name || '';
    const supplier = await prisma.supplier.findFirst({ where: { name: { contains: name, mode: 'insensitive' } }, select: { name: true, debtUzs: true, debtUsd: true } });
    if (!supplier) return ctx.reply(`🤷‍♂️ "${name}" ismli ta'minotchi topilmadi.`);
    const usdInfo = Number(supplier.debtUsd) !== 0 ? `\nQarz (USD): ${formatMoney(supplier.debtUsd, 'USD')}` : '';
    return ctx.reply(`📊 **Qarz ma'lumoti:**\n\nTa'minotchi: ${supplier.name}\nQarz: ${formatMoney(supplier.debtUzs, 'UZS')}${usdInfo}`);
  }

  if (intentData.intent === 'ADD_SUPPLIER_TX' && !intentData.exactSupplierId) {
    const candidates = await SupplierService.findMatchingSuppliers(intentData.name, intentData.comment);
    if (candidates.length === 1) {
      intentData.exactSupplierId = candidates[0].id;
      intentData.name = candidates[0].name;
    } else if (candidates.length > 1) {
      const candidateIds = candidates.map(c => c.id);
      const pendingAction = await prisma.pendingAction.create({
        data: { userId: ctx.from?.id ? BigInt(ctx.from.id) : null, type: 'VOICE_INTENT_DISAMBIGUATION', data: { ...intentData, candidateIds } as Prisma.InputJsonValue }
      });
      return ctx.reply(`⚠️ *Bir nechta ta'minotchi topildi:*\nQaysi "${intentData.name}" hisobiga yozilsin?`, {
        parse_mode: 'Markdown',
        reply_markup: getDisambiguationKeyboard(candidates, pendingAction.id, 'vsel', 'vnew', 'cancel_vdis')
      });
    }
  }

  const pendingAction = await prisma.pendingAction.create({
    data: { userId: ctx.from?.id ? BigInt(ctx.from.id) : null, type: 'VOICE_INTENT', data: intentData as Prisma.InputJsonValue }
  });
  const actionId = `v_${pendingAction.id}`;
  ctx.session.step = actionId;

  let balancePreview = '';
  if (intentData.intent === 'ADD_SUPPLIER_TX') {
    const isIncoming = intentData.txType === 'INCOMING_GOODS';
    const isUsd = (intentData.currency || 'UZS') === 'USD';
    const amt = Math.abs(Number(intentData.amount || 0));
    const supp = await prisma.supplier.findFirst({
      where: { name: { contains: intentData.name, mode: 'insensitive' }, isActive: true },
      select: { debtUzs: true, debtUsd: true }
    });
    if (supp) {
      const curDebt = Number(isUsd ? supp.debtUsd : supp.debtUzs);
      const nextDebt = isIncoming ? curDebt + amt : curDebt - amt;
      balancePreview = `\n📊 Joriy qarz: ${formatMoney(curDebt, intentData.currency)}\n📦 Kutilayotgan yakuniy qoldiq: ${formatMoney(nextDebt, intentData.currency)}`;
    }
  } else if (intentData.intent === 'ADD_CUSTOMER_DEBT') {
    const amt = Math.abs(Number(intentData.amount || 0));
    const agg = await prisma.customerDebt.aggregate({
      where: { customerName: { equals: intentData.name, mode: 'insensitive' }, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
      _sum: { amount: true, paidAmount: true }
    });
    const curRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
    const nextRem = curRem + amt;
    balancePreview = `\n📊 Joriy nasiya: ${formatMoney(curRem, intentData.currency)}\n📦 Kutilayotgan yakuniy qoldiq: ${formatMoney(nextRem, intentData.currency)}`;
  }

  const details = intentData.intent === 'ADD_EXPENSE'
    ? `Operatsiya: Xarajat\nSumma: ${formatMoney(intentData.amount, intentData.currency)}\nKategoriya: ${intentData.category || 'Boshqa'}\nIzoh: ${intentData.comment || "Yo'q"}`
    : intentData.intent === 'ADD_SUPPLIER_TX'
    ? `Operatsiya: Ta'minotchi bilan oldi-berdi\nTa'minotchi: ${intentData.name}\nAmal turi: ${intentData.txType === 'INCOMING_GOODS' ? 'Yuk olish (Kirim - Qarzga qo\'shish)' : "To'lov (Chiqim - Qarzdan ayirish)"}\nSumma: ${intentData.txType === 'INCOMING_GOODS' ? '+' : '-'}${formatMoney(Math.abs(Number(intentData.amount)), intentData.currency)}${balancePreview}\nIzoh: ${intentData.comment || 'Matn / ovozli xabar orqali'}`
    : intentData.intent === 'ADD_CASH_TX'
    ? `Operatsiya: Naqd xarid\nKimdan: ${intentData.name || "Noma'lum"}\nSumma: ${formatMoney(intentData.amount, intentData.currency)}\nIzoh: ${intentData.comment || "Yo'q"}`
    : intentData.intent === 'ADD_CUSTOMER_DEBT'
    ? `Operatsiya: Nasiya savdo\nMijoz: ${intentData.name}\nSumma: +${formatMoney(Math.abs(Number(intentData.amount)), intentData.currency)}${balancePreview}`
    : '';

  await ctx.reply(`🎙 **Tahlil Natijasi**\n\n${details}\n\nMa'lumotlar to'g'rimi?`, { parse_mode: 'Markdown', reply_markup: getConfirmationKeyboard(actionId) });
}

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
  if (!ctx.user || ctx.message.text.startsWith('/')) return next();
  const text = ctx.message.text.trim();
  if (isMenuButton(text) || (ctx.session.step && ctx.session.step !== 'await_new_supplier_name')) return next();

  const activePending = await prisma.pendingAction.findFirst({
    where: { userId: ctx.from?.id ? BigInt(ctx.from.id) : undefined, status: 'AWAIT_NEW_SUPPLIER_NAME' },
    orderBy: { createdAt: 'desc' }
  });

  if (activePending) {
    const intentData = { ...(activePending.data as any), exactSupplierId: 'CREATE_NEW', name: text };
    await prisma.pendingAction.delete({ where: { id: activePending.id } });
    clearSession(ctx);
    return processIntent(ctx, intentData);
  }

  const shorthand = parseShorthandTx(text);
  if (shorthand) {
    return processIntent(ctx, {
      intent: 'ADD_SUPPLIER_TX',
      txType: shorthand.txType,
      amount: shorthand.amount,
      currency: shorthand.currency,
      name: shorthand.name,
      comment: 'Tezkor matnli amaliyot'
    });
  }

  const priceMatch = text.match(/(.+?)\s+(narxi\s*nechpul|narxi\s*qancha|qancha\s*turadi|nechpul|nechi\s*pul|narxi|narx)/i);
  if (priceMatch && priceMatch[1].trim().length >= 2) {
    const query = priceMatch[1].trim();
    return withChatAction(ctx, 'typing', async () => {
      const products = await prisma.product.findMany({
        where: { searchTokens: { contains: TranslitService.toLatin(query).toLowerCase() } },
        select: { name: true, lastPrice: true, currency: true },
        take: 3
      });
      if (!products.length) return ctx.reply(`🤷‍♂️ "${query}" nomli tovar bazadan topilmadi.`);
      const lines = products.map(p => `📦 ${p.name}\n💵 Oxirgi narx: ${formatMoney(p.lastPrice, p.currency)}`).join('\n\n');
      await ctx.reply(`🔍 **"${query}" narxlari:**\n\n${lines}`, { parse_mode: 'Markdown' });
    });
  }

  await withChatAction(ctx, 'typing', async () => {
    try {
      await processIntent(ctx, await AiService.parseTextIntent(ctx.message.text));
    } catch (error) {
      logger.error({ error }, 'Error parsing text intent');
      await ctx.reply(`❌ Xabarni tahlil qilib bo'lmadi.\n\nSabab: ${formatFriendlyError(error)}`);
    }
  });
});

voiceHandler.callbackQuery(/^confirm_v_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT') return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  try {
    if (data.intent === 'ADD_EXPENSE') {
      await prisma.expense.create({ data: { amount: data.amount, currency: data.currency || 'UZS', category: data.category || 'Boshqa', note: data.comment } });
      await ctx.editMessageText(`✅ Xarajat saqlandi: ${formatMoney(data.amount, data.currency)}`);
    } else if (data.intent === 'ADD_SUPPLIER_TX') {
      const isIncoming = data.txType === 'INCOMING_GOODS';
      const amt = Math.abs(Number(data.amount));
      const finalDebt = await saveSupplierTxData(data);
      await ctx.editMessageText(
        `✅ ${isIncoming ? 'Yuk olish (Kirim)' : "To'lov"} muvaffaqiyatli saqlandi!\n\n` +
        `🏢 Ta'minotchi: **${data.name}**\n` +
        `${isIncoming ? '📥 Yangi kirim' : "💸 To'lov"}: **${isIncoming ? '+' : '-'}${formatMoney(amt, data.currency)}**\n` +
        `📊 **Yakuniy qarz qoldig'i:** **${formatMoney(finalDebt, data.currency || 'UZS')}**`,
        { parse_mode: 'Markdown' }
      );
    } else if (data.intent === 'ADD_CASH_TX') {
      await prisma.cashTransaction.create({ data: { partyName: data.name || "Noma'lum", amount: data.amount, items: data.comment || null } });
      await ctx.editMessageText(`✅ Naqd xarid saqlandi:\nKimdan: ${data.name}\nSumma: ${formatMoney(data.amount)}${data.comment ? `\nIzoh: ${data.comment}` : ''}\n*(Ushbu summa qarzga ta'sir qilmadi)*`);
    } else if (data.intent === 'ADD_CUSTOMER_DEBT') {
      const amt = Math.abs(Number(data.amount));
      await prisma.customerDebt.create({ data: { customerName: data.name, amount: amt, currency: data.currency || 'UZS' } });
      const agg = await prisma.customerDebt.aggregate({
        where: { customerName: { equals: data.name, mode: 'insensitive' }, status: { in: ['PENDING', 'PARTIALLY_PAID'] } },
        _sum: { amount: true, paidAmount: true }
      });
      const totalCustRem = Number(agg._sum.amount || 0) - Number(agg._sum.paidAmount || 0);
      await ctx.editMessageText(
        `✅ Nasiya muvaffaqiyatli saqlandi!\n\n` +
        `👤 Mijoz: **${data.name}**\n` +
        `💰 Nasiya summasi: **+${formatMoney(amt, data.currency)}**\n` +
        `📊 **Mijozning umumiy nasiya qoldig'i:** **${formatMoney(totalCustRem, data.currency || 'UZS')}**`,
        { parse_mode: 'Markdown' }
      );
    }
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Transaction error saving voice intent');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi, qayta urinib ko'ring.", show_alert: true });
  }
});

voiceHandler.callbackQuery(/^confirm_suptx_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'SUPPLIER_TX') return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const data = pendingAction.data as any;
  try {
    const isIncoming = data.txType === 'INCOMING_GOODS';
    const amt = Math.abs(Number(data.amount));
    const finalDebt = await saveSupplierTxData(data);
    await ctx.editMessageText(
      `✅ ${isIncoming ? 'Yuk olish (Kirim)' : "To'lov"} muvaffaqiyatli saqlandi!\n\n` +
      `🏢 Ta'minotchi: **${data.name}**\n` +
      `${isIncoming ? '📥 Yangi kirim' : "💸 To'lov"}: **${isIncoming ? '+' : '-'}${formatMoney(amt, data.currency)}**\n` +
      `📊 **Yakuniy qarz qoldig'i:** **${formatMoney(finalDebt, data.currency || 'UZS')}**`,
      { parse_mode: 'Markdown' }
    );
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Error saving supplier tx confirmation');
    await ctx.answerCallbackQuery({ text: "Saqlashda xatolik bo'ldi.", show_alert: true });
  }
});

voiceHandler.callbackQuery(/^cancel_(?:v|suptx|vdis)_(.+)$/, async (ctx) => {
  await prisma.pendingAction.delete({ where: { id: ctx.match[1] } }).catch(() => { });
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Bekor qilindi.', { reply_markup: undefined });
});

voiceHandler.callbackQuery(/^vsel_(.+)_(\d+)$/, async (ctx) => {
  const [, pendingId, rawIdx] = ctx.match;
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION') return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  const pData = pendingAction.data as any;
  const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
  const supplier = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId } }) : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
  const intentData = { ...pData, exactSupplierId: supplier.id, name: supplier.name };
  await Promise.all([prisma.pendingAction.delete({ where: { id: pendingId } }), ctx.deleteMessage().catch(() => {})]);
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^vnew_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION') return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  await prisma.pendingAction.update({ where: { id: pendingId }, data: { type: 'VOICE_INTENT_NEW_SUPP', status: 'AWAIT_NEW_SUPPLIER_NAME' } });
  ctx.session.step = 'await_new_supplier_name';
  ctx.session.tempData = { pendingId };
  await ctx.editMessageText(NEW_SUPP_PROMPT, { reply_markup: undefined });
});

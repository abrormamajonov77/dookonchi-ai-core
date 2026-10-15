import { Composer, InlineKeyboard } from 'grammy';
import { Prisma } from '@prisma/client';
import { MyContext } from '../context';
import { AiService, VoiceIntentSchema } from '../../services/ai.service';
import { getConfirmationKeyboard } from '../keyboards/inline';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { formatMoney, formatDate } from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import { withChatAction } from '../../utils/telegram';
import { TranslitService } from '../../services/translit.service';
import { SupplierService } from '../../services/supplier.service';

export const voiceHandler = new Composer<MyContext>();

async function downloadFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function processIntent(ctx: MyContext, intentData: any) {
    if (intentData.intent === 'UNKNOWN') {
      return ctx.reply("Kechirasiz, xabaringizni to'liq tushunmadim.");
    }

    if (intentData.intent === 'GET_DEBT_INFO') {
      const name = intentData.name || '';
      const supplier = await prisma.supplier.findFirst({
        where: { name: { contains: name, mode: 'insensitive' } }
      });
      if (supplier) {
         let info = `📊 **Qarz ma'lumoti:**\n\nTa'minotchi: ${supplier.name}\nQarz: ${formatMoney(supplier.debtUzs, 'UZS')}`;
         if (Number(supplier.debtUsd) !== 0) {
           info += `\nQarz (USD): ${formatMoney(supplier.debtUsd, 'USD')}`;
         }
         return ctx.reply(info);
      } else {
         return ctx.reply(`🤷‍♂️ "${name}" ismli ta'minotchi (qarz) topilmadi.`);
      }
    }

    if (intentData.intent === 'GENERAL_CHAT') {
      return ctx.reply(intentData.replyText || "Kechirasiz, savolingizga javob topa olmadim.");
    }

    // Disambiguation Flow for Suppliers
    if (intentData.intent === 'ADD_SUPPLIER_TX' && !intentData.exactSupplierId) {
      const candidates = await SupplierService.findMatchingSuppliers(intentData.name, intentData.comment);
      
      if (candidates.length === 1) {
        intentData.exactSupplierId = candidates[0].id;
        intentData.name = candidates[0].name;
      } else if (candidates.length > 1) {
        const pendingAction = await prisma.pendingAction.create({
          data: {
            userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
            type: 'VOICE_INTENT_DISAMBIGUATION',
            data: intentData as Prisma.InputJsonValue
          }
        });
        const actionId = `vdis_${pendingAction.id}`;
        
        let disambigText = `⚠️ *Bir nechta ta'minotchi topildi:*\nQaysi "${intentData.name}" hisobiga yozilsin?`;
        const keyboard = new InlineKeyboard();
        
        candidates.forEach(c => {
          keyboard.text(`🏢 ${c.name} - ${formatMoney(Number(c.debtUzs), 'UZS')}`, `vsel_${actionId}_${c.id}`).row();
        });
        keyboard.text(`➕ Bu yangi ta'minotchi (Alohida ochish)`, `vnew_${actionId}`).row();
        keyboard.text(`❌ Bekor qilish`, `cancel_vdis_${actionId}`).row();

        return ctx.reply(disambigText, { parse_mode: 'Markdown', reply_markup: keyboard });
      }
    }

    const pendingAction = await prisma.pendingAction.create({
      data: {
        userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
        type: 'VOICE_INTENT',
        data: intentData as Prisma.InputJsonValue
      }
    });
    const actionId = `v_${pendingAction.id}`;
    ctx.session.step = actionId;

    let text = `🎙 **Tahlil Natijasi**\n\n`;
    
    if (intentData.intent === 'ADD_EXPENSE') {
      text += `Operatsiya: Xarajat\nSumma: ${formatMoney(intentData.amount, intentData.currency)}\nKategoriya: ${intentData.category || 'Boshqa'}\nIzoh: ${intentData.comment || "Yo'q"}`;
    } else if (intentData.intent === 'ADD_SUPPLIER_TX') {
      const typeLabel = intentData.txType === 'INCOMING_GOODS' ? 'Yuk olish (Kirim)' : 'To\'lov (Chiqim)';
      text += `Operatsiya: Ta'minotchi bilan oldi-berdi\nTa'minotchi: ${intentData.name}\nAmal turi: ${typeLabel}\nSumma: ${formatMoney(intentData.amount, intentData.currency)}\nIzoh: ${intentData.comment || "Ovozli xabar orqali"}`;
    } else if (intentData.intent === 'ADD_CUSTOMER_DEBT') {
      text += `Operatsiya: Nasiya savdo\nMijoz: ${intentData.name}\nSumma: ${formatMoney(intentData.amount, intentData.currency)}`;
    } else if (intentData.intent === 'SEARCH_PRODUCT') {
      return ctx.reply(`🔍 Qidiruv: ${intentData.name}\nTez orada topib beraman...`);
    }

    text += `\n\nMa'lumotlar to'g'rimi?`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: getConfirmationKeyboard(actionId)
    });
}

voiceHandler.on('message:voice', async (ctx, next) => {
  if (!ctx.user) return next();

  await withChatAction(ctx, 'record_voice', async () => {
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('File path not found');

      const buffer = await downloadFile(file.file_path);
      const intentData = await AiService.parseVoiceNote(buffer);
      
      await processIntent(ctx, intentData);

    } catch (error) {
      logger.error({ error: error, stack: error instanceof Error ? error.stack : undefined }, 'Error parsing voice');
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Xatolik yuz berdi. Ovozni tahlil qila olmadim.\n\nSabab: ${errorMessage}`);
    }
  });
});

voiceHandler.on('message:text', async (ctx, next) => {
  if (!ctx.user) return next();
  
  // Ignore commands
  if (ctx.message.text.startsWith('/')) return next();

  const rawText = ctx.message.text.trim();
  const SYSTEM_MENU_BUTTONS = [
    "📦 Ta'minotchilar",
    "👥 Nasiyadorlar",
    "💵 Naqd",
    "📉 Xarajatlar",
    "📊 Z-Hisobot (Kunlik)",
    "📝 Qidiruv",
    "/start"
  ];
  
  if (SYSTEM_MENU_BUTTONS.some(btn => rawText.includes(btn))) {
    return next(); 
  }

  // Explicit session steps take precedence over implicit drafts (except voice-specific steps)
  if (ctx.session.step && ctx.session.step !== 'await_new_supplier_name') return next();

  const activePending = await prisma.pendingAction.findFirst({
    where: {
      userId: ctx.from?.id ? BigInt(ctx.from.id) : undefined,
      status: 'AWAIT_NEW_SUPPLIER_NAME'
    },
    orderBy: { createdAt: 'desc' }
  });

  if (activePending) {
    const intentData = activePending.data as any;
    intentData.exactSupplierId = 'CREATE_NEW';
    intentData.name = ctx.message.text.trim();
    
    await prisma.pendingAction.delete({ where: { id: activePending.id } });
    ctx.session.step = undefined;
    ctx.session.tempData = null;
    
    await processIntent(ctx, intentData);
    return;
  }

  const text = ctx.message.text.trim();

  // Instant Price Lookup Intercept
  const priceRegex = /(.+?)\s+(narxi\s*nechpul|narxi\s*qancha|qancha\s*turadi|nechpul|nechi\s*pul|narxi|narx)/i;
  const match = text.match(priceRegex);
  
  if (match) {
    const query = match[1].trim();
    if (query.length >= 2) {
      await withChatAction(ctx, 'typing', async () => {
        const searchKey = TranslitService.toLatin(query).toLowerCase();
        const products = await prisma.product.findMany({
          where: { searchTokens: { contains: searchKey } },
          take: 3
        });

        if (products.length > 0) {
          let reply = `🔍 **"${query}" narxlari:**\n\n`;
          for (const p of products) {
            reply += `📦 ${p.name}\n`;
            reply += `💵 Oxirgi narx: ${formatMoney(p.lastPrice, p.currency)}\n\n`;
          }
          await ctx.reply(reply, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`🤷‍♂️ "${query}" nomli tovar bazadan topilmadi.`);
        }
      });
      return;
    }
  }

  await withChatAction(ctx, 'typing', async () => {
    try {
      const intentData = await AiService.parseTextIntent(ctx.message.text);
      await processIntent(ctx, intentData);
    } catch (error) {
      logger.error({ error: error, stack: error instanceof Error ? error.stack : undefined }, 'Error parsing text intent');
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (errorMessage.includes('OPERATION_TIMEOUT') || errorMessage.includes('SEARCH_TIMEOUT')) {
        await ctx.reply(`⏳ Kechirasiz, AI uzoq vaqt o'ylab qoldi (5 soniya). Iltimos, qaytadan urinib ko'ring yoki aniqroq yozing.`);
      } else {
        await ctx.reply(`❌ Xatolik yuz berdi. Xabarni tahlil qila olmadim.\n\nSabab: ${errorMessage}`);
      }
    }
  });
});

voiceHandler.callbackQuery(/^confirm_v_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });

  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.", { reply_markup: undefined });
  }

  const data = pendingAction.data as any;

  try {
    if (data.intent === 'ADD_EXPENSE') {
      await prisma.expense.create({
        data: {
          amount: data.amount,
          currency: data.currency || 'UZS',
          category: 'Boshqa',
          note: data.comment
        }
      });
      await ctx.editMessageText(`✅ Xarajat saqlandi: ${formatMoney(data.amount, data.currency)}`);
    } else if (data.intent === 'ADD_SUPPLIER_TX') {
      const suptxAction = await prisma.pendingAction.create({
        data: {
          userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
          type: 'SUPPLIER_TX',
          data: data
        }
      });
      const actionId = `suptx_${suptxAction.id}`;
      ctx.session.step = actionId;

      const typeLabel = data.txType === 'INCOMING_GOODS' ? 'Yuk olish (Kirim)' : "To'lov (Chiqim)";
      let confirmText = `🧾 *Ta'minotchi Amaliyoti Tahlili:*\n`;
      confirmText += `▫️ *Operatsiya:* ${typeLabel}\n`;
      confirmText += `▫️ *Ta'minotchi:* ${data.name || "Noma'lum"}\n`;
      confirmText += `▫️ *Summa:* ${formatMoney(data.amount, data.currency)}\n`;
      if (data.comment) confirmText += `▫️ *Izoh:* ${data.comment}\n`;
      confirmText += `\nMa'lumotlar to'g'rimi?`;

      const customKeyboard = new InlineKeyboard()
        .text("✅ Tasdiqlash", `confirm_${actionId}`)
        .text("❌ Bekor qilish", `cancel_${actionId}`);

      await ctx.editMessageText(confirmText, { parse_mode: 'Markdown', reply_markup: customKeyboard });
    } else if (data.intent === 'ADD_CASH_TX') {
      await prisma.cashTransaction.create({
        data: {
          partyName: data.name || 'Noma\'lum',
          amount: data.amount,
          items: data.comment || null
        }
      });
      let resText = `✅ Naqd xarid saqlandi:\nKimdan: ${data.name}\nSumma: ${formatMoney(data.amount)}`;
      if (data.comment) resText += `\nIzoh: ${data.comment}`;
      resText += `\n*(Ushbu summa qarzga ta'sir qilmadi)*`;
      await ctx.editMessageText(resText);
    } else if (data.intent === 'ADD_CUSTOMER_DEBT') {
      await prisma.customerDebt.create({
        data: {
          customerName: data.name,
          amount: data.amount,
          currency: data.currency || 'UZS',
        }
      });
      await ctx.editMessageText(`✅ Nasiya saqlandi: ${data.name} - ${formatMoney(data.amount, data.currency)}`);
    }

    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
    ctx.session.step = undefined;

  } catch (error) {
    logger.error(error, 'Transaction error saving voice intent');
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.', show_alert: true });
  }
});

voiceHandler.callbackQuery(/^cancel_v_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Bekor qilindi.');
});

voiceHandler.callbackQuery(/^confirm_suptx_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });

  if (!pendingAction || pendingAction.type !== 'SUPPLIER_TX') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.", { reply_markup: undefined });
  }

  const data = pendingAction.data as any;
  let finalDebt = 0;
  let txId = '';
  let formattedReceipt = '';

  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const supplier = await SupplierService.getOrMergeSupplier(tx, data.name, data.exactSupplierId);
      
      const isIncoming = data.txType === 'INCOMING_GOODS';
      const isUsd = (data.currency || 'UZS') === 'USD';
      const amountNum = Number(data.amount);

      let currentDebtUzs = Number(supplier.debtUzs);
      let currentDebtUsd = Number(supplier.debtUsd);

      if (isUsd) {
        if (isIncoming) currentDebtUsd += amountNum;
        else currentDebtUsd -= amountNum;
      } else {
        if (isIncoming) currentDebtUzs += amountNum;
        else currentDebtUzs -= amountNum;
      }

      const postDebtText = isUsd
        ? formatMoney(currentDebtUsd, 'USD')
        : formatMoney(currentDebtUzs, 'UZS');

      formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n`;
      formattedReceipt += `🏢 Ta'minotchi: ${data.name}\n`;
      formattedReceipt += `📅 Sana: ${formatDate(new Date())}\n`;
      formattedReceipt += `📥 Kiritish usuli: 🎙 Matn / Ovozli xabar\n`;
      formattedReceipt += `-----------------------------\n`;
      formattedReceipt += `${isIncoming ? 'Yuk olish' : "To'lov"} - ${formatMoney(data.amount, data.currency)}\n`;
      if (data.comment) formattedReceipt += `Izoh: ${data.comment}\n`;
      formattedReceipt += `-----------------------------\n`;
      formattedReceipt += `💰 Amaliyot summasi: ${formatMoney(data.amount, data.currency)}\n`;
      formattedReceipt += `📦 Ushbu amaliyotdan keyingi qarz: ${postDebtText}\n`;

      const newTx = await tx.supplierTransaction.create({
        data: {
          supplierId: supplier.id,
          type: data.txType,
          amount: data.amount,
          currency: data.currency || 'UZS',
          description: data.comment || 'Ovozli/matnli xabar orqali kiritildi',
          sourceType: 'VOICE',
          formattedReceipt: formattedReceipt,
          receiptData: { comment: data.comment, amount: data.amount, txType: data.txType }
        }
      });
      txId = newTx.id;

      if (!isIncoming) {
        await tx.supplierPayment.create({
          data: {
            supplierId: supplier.id,
            amount: data.amount,
            currency: data.currency || 'UZS',
            comment: data.comment
          }
        });
      }

      const updated = await tx.supplier.update({
        where: { id: supplier.id },
        data: { 
          debtUzs: currentDebtUzs,
          debtUsd: currentDebtUsd
        } 
      });
      finalDebt = isUsd ? Number(updated.debtUsd) : Number(updated.debtUzs);
    });

    const typeLabel = data.txType === 'INCOMING_GOODS' ? 'Yuk olish' : "To'lov";
    const finalDebtStr = formatMoney(finalDebt, data.currency || 'UZS');
    await ctx.editMessageText(`✅ ${typeLabel} saqlandi: ${data.name} (+${formatMoney(data.amount, data.currency)})\n🏢 ${data.name} oldidagi jami qarzimiz: ${finalDebtStr}`);
    
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Error saving supplier tx confirmation');
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.', show_alert: true });
  }
});

voiceHandler.callbackQuery(/^cancel_suptx_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Bekor qilindi.');
});

// --- DISAMBIGUATION HANDLERS ---
voiceHandler.callbackQuery(/^vsel_vdis_(.+)_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const supplierId = ctx.match[2];
  
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  const intentData = pendingAction.data as any;
  intentData.exactSupplierId = supplier.id;
  intentData.name = supplier.name;

  await prisma.pendingAction.delete({ where: { id: pendingId } });
  
  await ctx.deleteMessage().catch(() => {});
  await processIntent(ctx, intentData);
});

voiceHandler.callbackQuery(/^vnew_vdis_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'VOICE_INTENT_DISAMBIGUATION') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  }

  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: { 
      type: 'VOICE_INTENT_NEW_SUPP',
      status: 'AWAIT_NEW_SUPPLIER_NAME' 
    }
  });

  ctx.session.step = 'await_new_supplier_name';
  ctx.session.tempData = { pendingId: pendingId };

  await ctx.editMessageText("Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):", { reply_markup: undefined });
});

voiceHandler.callbackQuery(/^cancel_vdis_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
  await ctx.editMessageText('❌ Amaliyot bekor qilindi.', { reply_markup: undefined });
});

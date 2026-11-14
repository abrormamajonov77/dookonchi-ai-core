import { Composer } from 'grammy';
import { MyContext } from '../context';
import { AiService, buildVerbatimTableText } from '../../services/ai.service';
import { ImageService } from '../../services/image.service';
import {
  getInvoiceConfirmationKeyboard,
  getDiscountConfirmationKeyboard,
  getDisambiguationKeyboard,
  getSavedInvoiceCardKeyboard,
  getDuplicateInvoiceWarningKeyboard,
} from '../keyboards/inline';
import { isMenuButton } from '../keyboards/menu';
import { logger } from '../../config/logger';
import {
  calculateDiscountedTotal,
  formatCurrency,
  getToday,
  parseCurrencyAndAmount,
} from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import { cacheService } from '../../services/cache.service';
import {
  withChatAction,
  downloadTelegramFile,
  safeDelete,
  clearSession,
  formatFriendlyError,
} from '../../utils/telegram';
import { SupplierService } from '../../services/supplier.service';

export const invoiceHandler = new Composer<MyContext>();

const CASH_REGEX = /naqd\s*pulga|naqdga|naqd|cash/i;
const EXPIRED_MSG = '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.';

export function buildEditableInvoiceText(
  invoiceData: any,
  _includeMoreHint = false,
  modifiedLabel = false
): { editableText: string; totalSum: number } {
  const name = invoiceData.supplierName || invoiceData.supplier || "Noma'lum";
  const currency: 'UZS' | 'USD' = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
  const header = modifiedLabel
    ? `🏢 Ta'minotchi: ${name} (O'zgartirildi)\n`
    : invoiceData.isCashOverride
    ? `🏢 Kimdan (Naqd): ${name}\n`
    : invoiceData.isCaptionOverride
    ? `Ta'minotchi: ${name} (Izohingiz orqali belgilandi)\n`
    : `Ta'minotchi: ${name}\n`;

  let editableText = `${header}Raqam: ${invoiceData.invoiceNo || "Yo'q"} | Valyuta: ${currency}\n\n`;
  let totalSum = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);

  if (invoiceData.verbatimText && String(invoiceData.verbatimText).trim()) {
    editableText += `${invoiceData.verbatimText}\n`;
  } else if (Array.isArray(invoiceData.items) && invoiceData.items.length > 0) {
    editableText += `${buildVerbatimTableText(invoiceData.items, currency)}\n`;
    if (!totalSum) {
      totalSum = invoiceData.items.reduce(
        (acc: number, it: any) => acc + Number(it.lineTotal ?? it.totalPrice ?? 0),
        0
      );
    }
  } else if (invoiceData.table_text && String(invoiceData.table_text).trim()) {
    editableText += `${invoiceData.table_text}\n`;
  }

  return { editableText, totalSum: Number(totalSum.toFixed(2)) };
}

export function buildPendingPreviewMessage(invoiceData: any, editableText: string): string {
  const currency: 'UZS' | 'USD' = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
  const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
  const discount = Number(invoiceData.discountAmount ?? invoiceData.discount ?? 0);
  const math = calculateDiscountedTotal(rawTotal, discount);
  const percentText =
    invoiceData.discountLabel ||
    (invoiceData.discountPercent && Number(invoiceData.discountPercent) > 0 ? `${invoiceData.discountPercent}%` : '');

  const title = invoiceData.isCashOverride ? '🧾 **Naqd Xarid Tahlili (100% Kserokopiya)**' : '📄 **Nakladnoy Tahlili (100% Kserokopiya)**';
  let text = `${title}\n\n\`\`\`\n${editableText}\`\`\`\n`;
  text += `💱 Valyuta: **${currency === 'USD' ? 'USD ($)' : "UZS (so'm)"}**\n`;
  text += `📦 Tovarlarning asl summasi: **${formatCurrency(math.rawTotal, currency)}**\n`;
  if (math.discountAmount > 0) {
    const label = percentText ? ` (${percentText})` : '';
    text += `🏷 Skidka${label}: **-${formatCurrency(math.discountAmount, currency)}**\n`;
  } else {
    text += `🏷 Skidka: **0**\n`;
  }
  text += `💰 Skidkadan keyingi yakuniy summa (Itogo): **${formatCurrency(math.finalTotal, currency)}**\n`;
  if (invoiceData.isCashOverride) {
    text += `📦 Amal turi: 💵 Naqd xarid (Qarzga ta'sir qilmaydi)\n`;
  }
  text += `\n_💡 Skidka yoki ta'minotchi nomini to'g'rilash uchun pastdagi tugmalardan foydalaning yoki chatga yozing_\n\nMa'lumotlar to'g'rimi?`;
  return text;
}

async function processParsedInvoice(
  ctx: MyContext,
  invoiceData: any,
  imageUrl: string,
  photoFileId: string | null,
  userPhotoMsgId: number | null,
  rawCaption: string,
  statusMsgId?: number | null
) {
  if (!invoiceData.exactSupplierId && invoiceData.supplierName && invoiceData.supplierName !== "Noma'lum") {
    const candidates = await SupplierService.findMatchingSuppliers(invoiceData.supplierName, rawCaption);
    if (candidates.length === 1) {
      invoiceData.exactSupplierId = candidates[0].id;
      invoiceData.supplierName = candidates[0].name;
    } else if (candidates.length > 1) {
      const candidateIds = candidates.map((c) => c.id);
      const pendingAction = await prisma.pendingAction.create({
        data: {
          type: 'INVOICE_DISAMBIGUATION',
          data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId, rawCaption, candidateIds },
        },
      });
      const disText = `⚠️ *Bir nechta ta'minotchi topildi:*\nNakladnoy qaysi "${invoiceData.supplierName}" hisobiga yozilsin?`;
      const disKb = getDisambiguationKeyboard(candidates, pendingAction.id, 'isel', 'inew', 'cancel_idis');
      if (statusMsgId && ctx.chat?.id) {
        return ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, disText, { parse_mode: 'Markdown', reply_markup: disKb })
          .catch(() => ctx.reply(disText, { parse_mode: 'Markdown', reply_markup: disKb }));
      }
      return ctx.reply(disText, { parse_mode: 'Markdown', reply_markup: disKb });
    }
  }

  const { editableText, totalSum } = buildEditableInvoiceText(invoiceData, false);
  const math = calculateDiscountedTotal(
    totalSum,
    invoiceData.discountAmount ?? invoiceData.discount ?? 0
  );
  invoiceData.rawTotal = invoiceData.grossTotal = invoiceData.total_amount = math.rawTotal;
  invoiceData.discountAmount = invoiceData.discount = math.discountAmount;
  invoiceData.finalTotal = invoiceData.netTotal = math.finalTotal;
  invoiceData.currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';

  const contentFingerprint = SupplierService.computeContentFingerprint({
    supplierName: invoiceData.supplierName || "Noma'lum",
    currency: invoiceData.currency,
    finalTotal: math.finalTotal,
    items: Array.isArray(invoiceData.items) ? invoiceData.items : [],
  });
  invoiceData.contentFingerprint = contentFingerprint;

  // MODUL 3: Stage 2 Anti-Duplicate Content Fingerprint check
  if (!invoiceData.forceOverrideDuplicate) {
    const dupCheck = await SupplierService.checkDuplicateInvoice({
      imageHash: invoiceData.imageHash || null,
      contentFingerprint,
    });
    if (dupCheck.isDuplicate && dupCheck.warningText) {
      const pendingAction = await prisma.pendingAction.create({
        data: {
          userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
          type: 'INVOICE',
          data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId },
        },
      });
      const dupKb = getDuplicateInvoiceWarningKeyboard(pendingAction.id);
      if (statusMsgId && ctx.chat?.id) {
        return ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, dupCheck.warningText, { reply_markup: dupKb })
          .catch(() => ctx.reply(dupCheck.warningText!, { reply_markup: dupKb }));
      }
      return ctx.reply(dupCheck.warningText, { reply_markup: dupKb });
    }
  }

  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
      type: 'INVOICE',
      data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId },
    },
  });
  const actionId = `i_${pendingAction.id}`;
  ctx.session.step = actionId;

  const text = buildPendingPreviewMessage(invoiceData, editableText);
  const kb = getInvoiceConfirmationKeyboard(actionId, editableText, invoiceData.currency);

  let botMessageId = statusMsgId;
  if (statusMsgId && ctx.chat?.id) {
    await ctx.api
      .editMessageText(ctx.chat.id, statusMsgId, text, { parse_mode: 'Markdown', reply_markup: kb })
      .catch(async () => {
        const sent = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
        botMessageId = sent.message_id;
      });
  } else {
    const sentMessage = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: kb });
    botMessageId = sentMessage.message_id;
  }

  await prisma.pendingAction.update({
    where: { id: pendingAction.id },
    data: { data: { ...(pendingAction.data as any), botMessageId } },
  });
}

async function handleInvoiceImageUpload(ctx: MyContext, fileId: string, _mimeType: string, errLabel: string) {
  await withChatAction(ctx, 'upload_photo', async () => {
    const statusMsg = await ctx.reply('⚡️ Nakladnoy kserokopiya qilinmoqda...').catch(() => null);
    try {
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error('Rasm fayli topilmadi');

      // Parallel pre-fetching of Telegram file in RAM and supplier names cache
      const [buffer] = await Promise.all([
        downloadTelegramFile(file.file_path),
        cacheService.getSupplierNames(),
      ]);

      // MODUL 1: High-contrast B&W scanner buffer (<60 KB in <150 ms)
      const processedBuffer = await ImageService.optimizeForFastOCR(buffer);
      const imageHash = ImageService.getImageHash(processedBuffer);

      // MODUL 3: Stage 1 ImageHash check before calling AI
      const stage1Dup = await SupplierService.checkDuplicateInvoice({ imageHash });
      if (stage1Dup.isDuplicate && stage1Dup.warningText && stage1Dup.existingInvoice) {
        const dupInvoiceData = {
          supplierName: stage1Dup.existingInvoice.supplier?.name || "Noma'lum",
          exactSupplierId: stage1Dup.existingInvoice.supplierId,
          invoiceNo: stage1Dup.existingInvoice.invoiceNo,
          rawTotal: Number(stage1Dup.existingInvoice.originalAmount ?? stage1Dup.existingInvoice.totalAmount),
          discountAmount: Number(stage1Dup.existingInvoice.discountAmount ?? 0),
          finalTotal: Number(stage1Dup.existingInvoice.totalAmount),
          currency: stage1Dup.existingInvoice.currency as 'UZS' | 'USD',
          verbatimText: stage1Dup.existingInvoice.verbatimText || '',
          imageHash,
          forceOverrideDuplicate: true,
        };
        const pendingAction = await prisma.pendingAction.create({
          data: {
            userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
            type: 'INVOICE',
            data: {
              data: dupInvoiceData,
              imageUrl: file.file_path,
              photoFileId: fileId,
              userPhotoMsgId: ctx.message?.message_id || null,
            },
          },
        });
        const dupKb = getDuplicateInvoiceWarningKeyboard(pendingAction.id);
        if (statusMsg && ctx.chat?.id) {
          await ctx.api
            .editMessageText(ctx.chat.id, statusMsg.message_id, stage1Dup.warningText, { reply_markup: dupKb })
            .catch(() => ctx.reply(stage1Dup.warningText!, { reply_markup: dupKb }));
        } else {
          await ctx.reply(stage1Dup.warningText, { reply_markup: dupKb });
        }
        return;
      }

      const caption = ctx.message?.caption?.trim() || '';
      const invoiceData = await AiService.parseInvoiceImage(processedBuffer, 'image/jpeg', caption);
      (invoiceData as any).imageHash = imageHash;

      if (caption) {
        invoiceData.isCaptionOverride = true;
        invoiceData.isCashOverride = CASH_REGEX.test(caption);
        const parsedCap = parseCurrencyAndAmount(caption);
        if (parsedCap.currency === 'USD') {
          invoiceData.currency = 'USD';
        }
        const cleanedCaptionName = caption
          .replace(CASH_REGEX, '')
          .replace(/\$|usd|usdt|dollar/gi, '')
          .trim();
        if (cleanedCaptionName.length >= 2) {
          invoiceData.supplierName = cleanedCaptionName;
        }
      }

      await processParsedInvoice(
        ctx,
        invoiceData,
        file.file_path,
        fileId,
        ctx.message!.message_id,
        caption,
        statusMsg?.message_id
      );
    } catch (error) {
      logger.error({ error }, 'Error parsing invoice');
      const errText = `❌ Xatolik yuz berdi. ${errLabel} o'qish imkoni bo'lmadi.\n\nSabab: ${formatFriendlyError(error)}`;
      if (statusMsg && ctx.chat?.id) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errText).catch(() => ctx.reply(errText));
      } else {
        await ctx.reply(errText);
      }
      clearSession(ctx);
    }
  });
}

invoiceHandler.on('message:photo', async (ctx) => {
  if (!ctx.user) return;
  const photos = ctx.message.photo;
  const photo = photos[Math.min(photos.length - 1, 2)];
  if (photo) await handleInvoiceImageUpload(ctx, photo.file_id, 'image/jpeg', 'Nakladnoyni');
});

invoiceHandler.on('message:document', async (ctx, next) => {
  if (!ctx.user || !ctx.message.document.mime_type?.startsWith('image/')) return next();
  await handleInvoiceImageUpload(
    ctx,
    ctx.message.document.file_id,
    ctx.message.document.mime_type,
    'Nakladnoy hujjatini'
  );
});

invoiceHandler.hears('➕ Nakladnoy', (ctx) =>
  ctx.reply('📷 Iltimos, nakladnoy chekining rasmini (yoki hujjat shaklida) yuboring. AI uni 100% kserokopiya shaklida tahlil qiladi.')
);

// MODUL 2: Inline callbacks for both Pending (`p_<pendingId>`) and Saved (`<invoiceId>`) invoices
invoiceHandler.callbackQuery(/^(?:edit_invoice_discount:|add_discount_(?:i_)?)(.+)$/, async (ctx) => {
  const rawId = ctx.match[1];
  const isPending = rawId.startsWith('p_') || !(await prisma.invoice.findUnique({ where: { id: rawId } }).catch(() => null));
  const cleanId = rawId.replace(/^p_/, '');

  if (isPending) {
    const pendingAction = await prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null);
    if (pendingAction && pendingAction.type === 'INVOICE') {
      const botMessageId = ctx.callbackQuery.message?.message_id;
      await prisma.pendingAction.update({
        where: { id: cleanId },
        data: { status: 'AWAIT_DISCOUNT', data: { ...(pendingAction.data as any), botMessageId } },
      });
      ctx.session.step = 'await_invoice_discount';
      ctx.session.tempData = { pendingId: cleanId, botMessageId };
      return ctx.reply(
        '🏷 **Chegirma (Skidka) miqdorini kiriting:**\n• Foizda: masalan, `5%` yoki `10%`\n• Summada: masalan, `15000`, `50 ming` yoki `$12.50`',
        { parse_mode: 'Markdown' }
      );
    }
  }

  // Saved Invoice discount edit
  ctx.session.step = 'AWAIT_SAVED_INVOICE_DISCOUNT';
  ctx.session.tempData = { invoiceId: cleanId, botMessageId: ctx.callbackQuery.message?.message_id };
  await ctx.reply(
    '🏷 **Saqlangan nakladnoy uchun chegirma (skidka) miqdorini kiriting:**\n• Foizda: masalan, `5%` yoki `10%`\n• Summada: masalan, `15000` yoki `$12.50`',
    { parse_mode: 'Markdown' }
  );
});

invoiceHandler.callbackQuery(/^edit_invoice_total:(.+)$/, async (ctx) => {
  const rawId = ctx.match[1];
  const cleanId = rawId.replace(/^p_/, '');
  const pendingAction = rawId.startsWith('p_')
    ? await prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null)
    : null;

  if (pendingAction && pendingAction.type === 'INVOICE') {
    const botMessageId = ctx.callbackQuery.message?.message_id;
    await prisma.pendingAction.update({
      where: { id: cleanId },
      data: { status: 'AWAIT_MANUAL_TOTAL', data: { ...(pendingAction.data as any), botMessageId } },
    });
    ctx.session.step = 'await_invoice_manual_total';
    ctx.session.tempData = { pendingId: cleanId, botMessageId };
    return ctx.reply(
      "✏️ **Umumiy summani qo'lda kiriting:**\n" +
        "• Faqat yakuniy summa: masalan `880000` yoki `$102.17`\n" +
        "• Yoki Asl summa va Skidkadan keyingi yakuniy summa (bo'sh joy bilan): masalan `1000000 880000`",
      { parse_mode: 'Markdown' }
    );
  }

  ctx.session.step = 'AWAIT_SAVED_INVOICE_TOTAL';
  ctx.session.tempData = { invoiceId: cleanId, botMessageId: ctx.callbackQuery.message?.message_id };
  await ctx.reply(
    "✏️ **Saqlangan nakladnoy uchun umumiy summani qo'lda kiriting:**\n" +
      "• Faqat yakuniy summa: masalan `880000` yoki `$102.17`\n" +
      "• Yoki Asl summa va Yakuniy summa: masalan `1000000 880000`",
    { parse_mode: 'Markdown' }
  );
});

invoiceHandler.callbackQuery(/^clear_invoice_discount:(.+)$/, async (ctx) => {
  const rawId = ctx.match[1];
  const cleanId = rawId.replace(/^p_/, '');
  const pendingAction = rawId.startsWith('p_')
    ? await prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null)
    : null;

  if (pendingAction && pendingAction.type === 'INVOICE') {
    const pData = pendingAction.data as any;
    const invoiceData = pData.data;
    const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
    invoiceData.discountAmount = invoiceData.discount = 0;
    invoiceData.finalTotal = invoiceData.netTotal = rawTotal;
    invoiceData.discountLabel = null;

    await prisma.pendingAction.update({
      where: { id: cleanId },
      data: { data: pData, status: 'PENDING' },
    });

    const { editableText } = buildEditableInvoiceText(invoiceData);
    const txt = buildPendingPreviewMessage(invoiceData, editableText);
    const kb = getInvoiceConfirmationKeyboard(`i_${cleanId}`, editableText, invoiceData.currency || 'UZS');
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
    return ctx.answerCallbackQuery({ text: '❌ Skidka olib tashlandi!' });
  }

  try {
    const updated = await SupplierService.clearInvoiceDiscount(cleanId);
    const cur = updated.currency;
    const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
    await ctx.answerCallbackQuery({ text: '❌ Skidka 0 ga tushirildi va balans yangilandi!' });
    await ctx
      .editMessageText(
        `✅ **Nakladnoy skidkasi olib tashlandi!**\n\n` +
          `🏢 Ta'minotchi: **${updated.supplier.name}**\n` +
          `💰 Asl summa: **${formatCurrency(updated.rawTotal, cur)}**\n` +
          `🏷 Skidka: **0**\n` +
          `💵 Yakuniy summa: **${formatCurrency(updated.finalTotal, cur)}**\n` +
          `📊 Ta'minotchi joriy qarzi (${cur}): **${formatCurrency(newDebt, cur)}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(updated.invoice.id, updated.supplier.id),
        }
      )
      .catch(() => {});
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^toggle_invoice_currency:(.+)$/, async (ctx) => {
  const rawId = ctx.match[1];
  const cleanId = rawId.replace(/^p_/, '');
  const pendingAction = rawId.startsWith('p_')
    ? await prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null)
    : null;

  if (pendingAction && pendingAction.type === 'INVOICE') {
    const pData = pendingAction.data as any;
    const invoiceData = pData.data;
    invoiceData.currency = invoiceData.currency === 'USD' ? 'UZS' : 'USD';
    if (Array.isArray(invoiceData.items)) {
      invoiceData.items.forEach((it: any) => (it.currency = invoiceData.currency));
      invoiceData.verbatimText = buildVerbatimTableText(invoiceData.items, invoiceData.currency);
    }

    await prisma.pendingAction.update({
      where: { id: cleanId },
      data: { data: pData, status: 'PENDING' },
    });

    const { editableText } = buildEditableInvoiceText(invoiceData);
    const txt = buildPendingPreviewMessage(invoiceData, editableText);
    const kb = getInvoiceConfirmationKeyboard(`i_${cleanId}`, editableText, invoiceData.currency);
    await ctx.editMessageText(txt, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
    return ctx.answerCallbackQuery({ text: `💱 Valyuta ${invoiceData.currency} ga o'zgartirildi!` });
  }

  try {
    const updated = await SupplierService.toggleInvoiceCurrency(cleanId);
    const cur = updated.currency;
    await ctx.answerCallbackQuery({ text: `💱 Valyuta ${cur} ga o'zgartirildi va balans yangilandi!` });
    await ctx
      .editMessageText(
        `✅ **Nakladnoy valyutasi ${cur} ga o'zgartirildi!**\n\n` +
          `🏢 Ta'minotchi: **${updated.supplier.name}**\n` +
          `💵 Yakuniy summa: **${formatCurrency(updated.finalTotal, cur)}**\n` +
          `📊 Qarz balansi (UZS): **${formatCurrency(updated.supplier.debtUzs, 'UZS')}**\n` +
          `💵 Qarz balansi (USD): **${formatCurrency(updated.supplier.debtUsd, 'USD')}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(updated.invoice.id, updated.supplier.id),
        }
      )
      .catch(() => {});
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
  }
});

function parseTwoOrOneAmounts(rawText: string): { first: number; second?: number } {
  const parts = rawText
    .trim()
    .split(/[\s/;|-]+/)
    .map((p) => p.trim())
    .filter((p) => /\d/.test(p));
  if (parts.length >= 2) {
    const first = parseCurrencyAndAmount(parts[0]).amount;
    const second = parseCurrencyAndAmount(parts[1]).amount;
    if (first > 0 && second >= 0) {
      return { first, second };
    }
  }
  const single = parseCurrencyAndAmount(rawText).amount;
  return { first: single };
}

invoiceHandler.on('message:text', async (ctx, next) => {
  if (!ctx.user || ctx.message.text.startsWith('/')) return next();
  const rawText = ctx.message.text.trim();
  if (isMenuButton(rawText)) return next();

  // 1. Handle saved invoice discount edit
  if (ctx.session.step === 'AWAIT_SAVED_INVOICE_DISCOUNT') {
    const { invoiceId } = ctx.session.tempData || {};
    clearSession(ctx);
    if (!invoiceId) return next();
    try {
      const updated = await SupplierService.updateInvoiceDiscount(invoiceId, rawText);
      const cur = updated.currency;
      const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
      return ctx.reply(
        `✅ **Nakladnoy skidkasi yangilandi!**\n\n` +
          `🏢 Ta'minotchi: **${updated.supplier.name}**\n` +
          `💰 Asl summa: **${formatCurrency(updated.rawTotal, cur)}**\n` +
          `🏷 Skidka (${rawText}): **-${formatCurrency(updated.discountAmount, cur)}**\n` +
          `💵 Yakuniy summa: **${formatCurrency(updated.finalTotal, cur)}**\n` +
          `📊 Ta'minotchi yangilangan qarzi (${cur}): **${formatCurrency(newDebt, cur)}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(updated.invoice.id, updated.supplier.id),
        }
      );
    } catch (err: any) {
      return ctx.reply(`❌ Xatolik: ${err?.message || "Skidkani yangilab bo'lmadi."}`);
    }
  }

  // 2. Handle saved invoice manual total override
  if (ctx.session.step === 'AWAIT_SAVED_INVOICE_TOTAL') {
    const { invoiceId } = ctx.session.tempData || {};
    clearSession(ctx);
    if (!invoiceId) return next();
    const { first, second } = parseTwoOrOneAmounts(rawText);
    if (!first || first <= 0) {
      return ctx.reply("❌ Iltimos, to'g'ri summa kiriting (masalan: 880000 yoki 1000000 880000).");
    }
    try {
      const updated = await SupplierService.overrideInvoiceTotal(invoiceId, first, second);
      const cur = updated.currency;
      const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
      return ctx.reply(
        `✅ **Nakladnoy summasi qo'lda yangilandi!**\n\n` +
          `🏢 Ta'minotchi: **${updated.supplier.name}**\n` +
          `💰 Asl summa: **${formatCurrency(updated.rawTotal, cur)}**\n` +
          `🏷 Skidka: **-${formatCurrency(updated.discountAmount, cur)}**\n` +
          `💵 Yakuniy summa: **${formatCurrency(updated.finalTotal, cur)}**\n` +
          `📊 Ta'minotchi yangilangan qarzi (${cur}): **${formatCurrency(newDebt, cur)}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(updated.invoice.id, updated.supplier.id),
        }
      );
    } catch (err: any) {
      return ctx.reply(`❌ Xatolik: ${err?.message || "Summani yangilab bo'lmadi."}`);
    }
  }

  if (
    ctx.session.step &&
    ctx.session.step !== 'await_invoice_discount' &&
    ctx.session.step !== 'await_invoice_manual_total' &&
    ctx.session.step !== 'await_new_supplier_name_inv' &&
    !ctx.session.step.startsWith('i_')
  ) {
    return next();
  }

  const activePending = await prisma.pendingAction.findFirst({
    where: {
      userId: ctx.from?.id ? BigInt(ctx.from.id) : undefined,
      type: { in: ['INVOICE', 'INVOICE_NEW_SUPP'] },
      status: { in: ['PENDING', 'AWAIT_DISCOUNT', 'AWAIT_MANUAL_TOTAL', 'AWAIT_NEW_SUPPLIER_NAME_INV'] },
      createdAt: { gte: new Date(Date.now() - 3600000) },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (activePending) {
    const pData = activePending.data as any;
    const pendingId = activePending.id;
    const invoiceData = pData.data;

    if (activePending.status === 'AWAIT_NEW_SUPPLIER_NAME_INV') {
      pData.data.exactSupplierId = 'CREATE_NEW';
      pData.data.supplierName = rawText;
      await prisma.pendingAction.delete({ where: { id: activePending.id } });
      clearSession(ctx);
      return processParsedInvoice(
        ctx,
        pData.data,
        pData.imageUrl,
        pData.photoFileId,
        pData.userPhotoMsgId,
        pData.rawCaption
      );
    }

    const updatePreviewMessage = async (txt: string, finalAmt: number) => {
      const currency: 'UZS' | 'USD' = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
      const kb = getDiscountConfirmationKeyboard(
        `i_${pendingId}`,
        finalAmt,
        !!invoiceData.isCashOverride,
        currency
      );
      if (pData.botMessageId) {
        await ctx.api
          .editMessageText(ctx.chat?.id || 0, pData.botMessageId, txt, {
            parse_mode: 'Markdown',
            reply_markup: kb,
          })
          .catch(() => {});
      } else {
        pData.botMessageId = (await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb })).message_id;
        await prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } });
      }
    };

    if (activePending.status === 'AWAIT_MANUAL_TOTAL') {
      const { first, second } = parseTwoOrOneAmounts(rawText);
      if (first > 0) {
        const oldRaw = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? first);
        const rawTotal = second !== undefined ? first : Math.max(oldRaw, first);
        const finalTotal = second !== undefined ? second : first;
        const discountAmount = Math.max(0, Number((rawTotal - finalTotal).toFixed(2)));

        invoiceData.rawTotal = invoiceData.grossTotal = invoiceData.total_amount = rawTotal;
        invoiceData.discountAmount = invoiceData.discount = discountAmount;
        invoiceData.finalTotal = invoiceData.netTotal = finalTotal;

        await Promise.all([
          prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
          safeDelete(ctx, ctx.chat?.id, ctx.message.message_id),
        ]);

        const { editableText } = buildEditableInvoiceText(invoiceData);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        await updatePreviewMessage(txt, finalTotal);
        clearSession(ctx);
        return;
      }
    }

    if (
      activePending.status === 'AWAIT_DISCOUNT' ||
      (activePending.type === 'INVOICE' && activePending.status === 'PENDING')
    ) {
      const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
      const isPercent = /(\d+(?:[.,]\d+)?)\s*%/.test(rawText);
      const isNumericDiscount = /^[\d\s.,$]+(?:\s*(?:ming|k|sum|so'm|skidka|usd|usdt|dollar))?$/i.test(rawText);

      if (isPercent || isNumericDiscount || activePending.status === 'AWAIT_DISCOUNT') {
        const math = calculateDiscountedTotal(rawTotal, rawText);
        invoiceData.rawTotal = invoiceData.grossTotal = invoiceData.total_amount = math.rawTotal;
        invoiceData.discountAmount = invoiceData.discount = math.discountAmount;
        invoiceData.finalTotal = invoiceData.netTotal = math.finalTotal;
        invoiceData.discountLabel = rawText;

        await Promise.all([
          prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
          safeDelete(ctx, ctx.chat?.id, ctx.message.message_id),
        ]);

        const { editableText } = buildEditableInvoiceText(invoiceData);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        await updatePreviewMessage(txt, math.finalTotal);
        clearSession(ctx);
        return;
      }

      if (activePending.status === 'PENDING' && rawText.length >= 2) {
        invoiceData.supplierName = rawText;
        invoiceData.isCaptionOverride = true;
        await Promise.all([
          prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } }),
          safeDelete(ctx, ctx.chat?.id, ctx.message.message_id),
        ]);

        const { editableText } = buildEditableInvoiceText(invoiceData, false, true);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        await updatePreviewMessage(txt, Number(invoiceData.finalTotal ?? rawTotal));
        return;
      }
    }
  }

  const cleanText = ctx.message.text.replace(/^@\w+\s+/, '').trim();
  if (/^ta'?minotchi:/i.test(cleanText) || cleanText.includes('Raqam:')) {
    return withChatAction(ctx, 'typing', async () => {
      try {
        const invoiceData = await AiService.parseInvoiceText(cleanText);
        if (CASH_REGEX.test(cleanText)) {
          invoiceData.isCashOverride = true;
          invoiceData.supplierName = invoiceData.supplierName?.replace(CASH_REGEX, '').trim() || "Noma'lum";
        }
        await processParsedInvoice(ctx, invoiceData, '', null, null, cleanText);
      } catch (error) {
        logger.error({ error }, 'Error parsing edited invoice');
        await ctx.reply(
          `❌ Xatolik yuz berdi. Tahrirlangan matnni o'qish imkoni bo'lmadi.\n\nSabab: ${formatFriendlyError(error)}`
        );
      }
    });
  }
  return next();
});

const extractPendingInvoice = async (ctx: MyContext, pendingId: string) => {
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'INVOICE') {
    await ctx
      .editMessageText(
        "⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.",
        { reply_markup: undefined }
      )
      .catch(() => {});
    return null;
  }
  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {});
  const pData = pendingAction.data as any;
  const invoiceData = pData.data;
  const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
  const math = calculateDiscountedTotal(rawTotal, invoiceData.discountAmount ?? invoiceData.discount ?? 0);
  const currency: 'UZS' | 'USD' = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
  return {
    pData,
    invoiceData,
    totalSum: math.rawTotal,
    discountAmount: math.discountAmount,
    finalPayable: math.finalTotal,
    currency,
    supplierName: invoiceData.supplierName || "Umumiy Ta'minotchi",
  };
};

invoiceHandler.callbackQuery(/^force_dup_inv:(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  const invoiceData = pData.data || {};
  invoiceData.forceOverrideDuplicate = true;
  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: { data: { ...pData, data: invoiceData } },
  });

  const actionId = `i_${pendingId}`;
  ctx.session.step = actionId;
  const { editableText } = buildEditableInvoiceText(invoiceData);
  const text = buildPendingPreviewMessage(invoiceData, editableText);
  const kb = getInvoiceConfirmationKeyboard(actionId, editableText, invoiceData.currency || 'UZS');
  await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "✅ Qayta kiritishga ruxsat berildi. To'lov turini tanlang." });
});

invoiceHandler.callbackQuery(/^confirm_invdebt_i_(.+)$/, async (ctx) => {
  const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
  if (!extracted) return;
  const { pData, invoiceData, totalSum, discountAmount, finalPayable, currency, supplierName } = extracted;

  try {
    const result = await SupplierService.createInvoiceWithItems({
      supplierId:
        invoiceData.exactSupplierId && invoiceData.exactSupplierId !== 'CREATE_NEW'
          ? invoiceData.exactSupplierId
          : undefined,
      supplierName,
      invoiceNo: invoiceData.invoiceNo,
      rawTotal: totalSum,
      discountInput: discountAmount,
      currency,
      paymentType: 'CREDIT',
      paidCashAmount: 0,
      creditAmount: finalPayable,
      imageHash: invoiceData.imageHash || null,
      contentFingerprint: invoiceData.contentFingerprint || null,
      forceOverrideDuplicate: !!invoiceData.forceOverrideDuplicate,
      items: Array.isArray(invoiceData.items) ? invoiceData.items : [],
      verbatimText: invoiceData.verbatimText || invoiceData.table_text || '',
      photoFileId: pData.photoFileId || null,
      rawImageUrl: pData.imageUrl || null,
    });

    if (result.isDuplicate && result.warningText) {
      await ctx.editMessageText(result.warningText, { reply_markup: undefined });
      return;
    }

    const finalDebt =
      currency === 'USD' ? Number(result.supplier.debtUsd) : Number(result.supplier.debtUzs);

    await Promise.all([
      ctx.editMessageText(
        `✅ **Nakladnoy (📝 Nasiyaga) muvaffaqiyatli saqlandi!**\n\n` +
          `🏢 Ta'minotchi: **${result.supplier.name}**\n` +
          `📦 Tovarlarning asl summasi: **${formatCurrency(totalSum, currency)}**\n` +
          (discountAmount > 0 ? `🏷 Skidka: **-${formatCurrency(discountAmount, currency)}**\n` : '') +
          `💰 Skidkadan keyingi yakuniy summa (Itogo): **+${formatCurrency(finalPayable, currency)}**\n` +
          `📊 **Yakuniy qarz qoldig'i (${currency}):** **${formatCurrency(finalDebt, currency)}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(
            result.invoice.id,
            result.supplier.id,
            pData.photoFileId,
            result.transaction?.id
          ),
        }
      ),
      safeDelete(ctx, ctx.chat?.id, pData.userPhotoMsgId),
    ]);
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Transaction error saving invoice');
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi. Qayta urinib ko'ring.", show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^confirm_invcash_i_(.+)$/, async (ctx) => {
  const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
  if (!extracted) return;
  const { pData, invoiceData, totalSum, discountAmount, finalPayable, currency, supplierName } = extracted;

  try {
    const result = await SupplierService.createInvoiceWithItems({
      supplierId:
        invoiceData.exactSupplierId && invoiceData.exactSupplierId !== 'CREATE_NEW'
          ? invoiceData.exactSupplierId
          : undefined,
      supplierName,
      invoiceNo: invoiceData.invoiceNo,
      rawTotal: totalSum,
      discountInput: discountAmount,
      currency,
      paymentType: 'CASH',
      paidCashAmount: finalPayable,
      creditAmount: 0,
      imageHash: invoiceData.imageHash || null,
      contentFingerprint: invoiceData.contentFingerprint || null,
      forceOverrideDuplicate: !!invoiceData.forceOverrideDuplicate,
      items: Array.isArray(invoiceData.items) ? invoiceData.items : [],
      verbatimText: invoiceData.verbatimText || invoiceData.table_text || '',
      photoFileId: pData.photoFileId || null,
      rawImageUrl: pData.imageUrl || null,
    });

    if (result.isDuplicate && result.warningText) {
      await ctx.editMessageText(result.warningText, { reply_markup: undefined });
      return;
    }

    await Promise.all([
      ctx.editMessageText(
        `✅ **Nakladnoy (💵 Naqdga) muvaffaqiyatli saqlandi!**\n\n` +
          `🏢 Ta'minotchi: **${result.supplier.name}**\n` +
          `📦 Tovarlarning asl summasi: **${formatCurrency(totalSum, currency)}**\n` +
          (discountAmount > 0 ? `🏷 Skidka: **-${formatCurrency(discountAmount, currency)}**\n` : '') +
          `💵 Naqd to'langan summa (Itogo): **${formatCurrency(finalPayable, currency)}**\n` +
          `📊 Qarzga yozilmadi (0). Bugungi Z-Otchyot naqd xaridlariga qo'shildi.`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(
            result.invoice.id,
            result.supplier.id,
            pData.photoFileId,
            result.transaction?.id
          ),
        }
      ),
      safeDelete(ctx, ctx.chat?.id, pData.userPhotoMsgId),
    ]);
    ctx.session.step = undefined;
  } catch (error) {
    logger.error(error, 'Transaction error saving cash invoice');
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi. Qayta urinib ko'ring.", show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^cancel_(?:i|idis)_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
  if (pendingAction) {
    await Promise.all([
      safeDelete(ctx, ctx.chat?.id, (pendingAction.data as any)?.userPhotoMsgId),
      prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => {}),
    ]);
  }
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Nakladnoy bekor qilindi.', { reply_markup: undefined });
});

invoiceHandler.callbackQuery(/^isel_(.+)_(\d+)$/, async (ctx) => {
  const [, pendingId, rawIdx] = ctx.match;
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
  const pData = pendingAction.data as any;
  const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
  const supplier = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId } }) : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  pData.data.exactSupplierId = supplier.id;
  pData.data.supplierName = supplier.name;

  await Promise.all([
    prisma.pendingAction.delete({ where: { id: pendingId } }),
    ctx.deleteMessage().catch(() => {}),
  ]);
  await processParsedInvoice(
    ctx,
    pData.data,
    pData.imageUrl,
    pData.photoFileId,
    pData.userPhotoMsgId,
    pData.rawCaption
  );
});

invoiceHandler.callbackQuery(/^inew_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: { type: 'INVOICE_NEW_SUPP', status: 'AWAIT_NEW_SUPPLIER_NAME_INV' },
  });
  ctx.session.step = 'await_new_supplier_name_inv';
  ctx.session.tempData = { pendingId };
  await ctx.editMessageText(
    "Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):",
    { reply_markup: undefined }
  );
});

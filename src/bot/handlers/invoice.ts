import { Composer, InputFile } from 'grammy';
import { MyContext } from '../context';
import { AiService, buildVerbatimTableText } from '../../services/ai.service';
import { ImageService, createUltraBrightXeroxImage } from '../../services/image.service';
import {
  getInvoiceConfirmationKeyboard,
  getDiscountConfirmationKeyboard,
  getDisambiguationKeyboard,
  getSavedInvoiceCardKeyboard,
  getDuplicateInvoiceWarningKeyboard,
  getFuzzySupplierSuggestionKeyboard,
} from '../keyboards/inline';
import { isMenuButton } from '../keyboards/menu';
import { logger } from '../../config/logger';
import {
  calculateDiscountedTotal,
  formatCurrency,
  parseCurrencyAndAmount,
  parseSmartAmount,
  reconcileInvoiceTotals,
} from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import { cacheService } from '../../services/cache.service';
import {
  withChatAction,
  downloadTelegramFile,
  safeDelete,
  clearSession,
  formatFriendlyError,
  safeReply,
  safeEditMessageText,
  sanitizeMdV1,
  findOwnedPendingAction,
  deleteOwnedPendingAction,
} from '../../utils/telegram';
import { SupplierService } from '../../services/supplier.service';
import { toLatinUz } from '../../utils/transliterate';
import { parseTextCommandLocally } from '../../utils/local-parser';

export const invoiceHandler = new Composer<MyContext>();

const CASH_REGEX = /naqd\s*pulga|naqdga|naqd|naqt|cash/i;
const EXPIRED_MSG = '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.';

export function buildEditableInvoiceText(
  invoiceData: any,
  _includeMoreHint = false,
  modifiedLabel = false
): { editableText: string; totalSum: number } {
  const name = toLatinUz(invoiceData.supplierName || invoiceData.supplier || "Noma'lum");
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
  const math = reconcileInvoiceTotals({
    rows: invoiceData.items || invoiceData.rows,
    subtotalBeforeDiscount: rawTotal,
    discountPercent: invoiceData.discountPercent,
    discountAmount: discount,
    printedFinalTotal: invoiceData.finalTotal ?? invoiceData.printedFinalTotal,
    tableTotals: invoiceData.tableTotals,
    hasExplicitDiscount: invoiceData.hasExplicitDiscount,
  });
  const percentText =
    invoiceData.discountLabel ||
    (math.discountPercent && Number(math.discountPercent) > 0 ? `${math.discountPercent}%` : '');

  const title = invoiceData.isCashOverride
    ? '🧾 **Naqd Xarid Tahlili (100% HD Kserokopiya)**'
    : '📄 **Nakladnoy Tahlili (100% HD Kserokopiya)**';
  const safeCodeBlock = String(editableText || '')
    .replace(/```/g, "'''")
    .slice(0, 3200);
  let text = `${title}\n\n\`\`\`\n${safeCodeBlock}\`\`\`\n`;
  text += `💱 Valyuta: **${currency === 'USD' ? 'USD ($)' : "UZS (so'm)"}**\n`;
  text += `📦 Tovarlarning asl summasi: **${formatCurrency(math.rawTotal, currency)}**\n`;
  if (math.discountAmount > 0) {
    const label = percentText ? ` (${sanitizeMdV1(percentText)})` : '';
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
  statusMsgId?: number | null,
  xeroxBuffer?: Buffer | null
) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);

  if (invoiceData.supplierName) {
    invoiceData.supplierName = toLatinUz(invoiceData.supplierName).trim();
  }

  // 5-MUAMMO: Send 1:1 Ultra-Bright HD Xerox image to user first if xeroxBuffer is provided,
  // and capture its Telegram file_id as the authoritative photoFileId for "🖼 Asl rasmni ko'rish"
  let effectivePhotoFileId = photoFileId;
  if (xeroxBuffer && xeroxBuffer.byteLength > 0) {
    try {
      const xeroxSupplier = sanitizeMdV1(toLatinUz(invoiceData.supplierName || "Noma'lum"));
      const cur: 'UZS' | 'USD' = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
      const itogoText = formatCurrency(invoiceData.finalTotal ?? invoiceData.printedFinalTotal ?? 0, cur);
      const sentPhoto = await ctx.replyWithPhoto(new InputFile(xeroxBuffer, 'kserokopiya.jpg'), {
        caption: `🖨 *1:1 HD Kserokopiya Skaner*\n🏢 Ta'minotchi: *${xeroxSupplier}*\n💰 Itogo: *${itogoText}*`,
        parse_mode: 'Markdown',
      });
      const sentPhotos = sentPhoto?.photo;
      if (Array.isArray(sentPhotos) && sentPhotos.length > 0) {
        effectivePhotoFileId = sentPhotos[sentPhotos.length - 1].file_id;
      }
    } catch (photoErr) {
      logger.warn({ photoErr }, 'Could not send HD Xerox photo preview');
    }
  }

  if (!invoiceData.exactSupplierId && invoiceData.supplierName && invoiceData.supplierName !== "Noma'lum") {
    const fuzzyCheck = await SupplierService.findOrSuggestSupplier(invoiceData.supplierName, ownerId);
    if (fuzzyCheck.isExactMatch && fuzzyCheck.supplier) {
      invoiceData.exactSupplierId = fuzzyCheck.supplier.id;
      invoiceData.supplierName = fuzzyCheck.supplier.name;
    } else if (fuzzyCheck.isFuzzyMatch && fuzzyCheck.suggestedSupplier && fuzzyCheck.promptText) {
      const pendingAction = await prisma.pendingAction.create({
        data: {
          userId: BigInt(ctx.from.id),
          type: 'INVOICE_DISAMBIGUATION',
          data: {
            ownerId,
            data: invoiceData,
            imageUrl,
            photoFileId: effectivePhotoFileId,
            userPhotoMsgId,
            rawCaption,
            suggestedSupplierId: fuzzyCheck.suggestedSupplier.id,
            candidateIds: [fuzzyCheck.suggestedSupplier.id],
          },
        },
      });
      const fuzzyKb = getFuzzySupplierSuggestionKeyboard(
        fuzzyCheck.suggestedSupplier.id,
        fuzzyCheck.suggestedSupplier.name,
        fuzzyCheck.inputName,
        `inv_${pendingAction.id}`
      );
      if (statusMsgId && ctx.chat?.id) {
        return ctx.api
          .editMessageText(ctx.chat.id, statusMsgId, fuzzyCheck.promptText, { reply_markup: fuzzyKb })
          .catch(() => ctx.reply(fuzzyCheck.promptText!, { reply_markup: fuzzyKb }));
      }
      return ctx.reply(fuzzyCheck.promptText, { reply_markup: fuzzyKb });
    } else {
      const candidates = await SupplierService.findMatchingSuppliers(
        invoiceData.supplierName,
        rawCaption,
        ownerId
      );
      if (candidates.length === 1) {
        invoiceData.exactSupplierId = candidates[0].id;
        invoiceData.supplierName = candidates[0].name;
      } else if (candidates.length > 1) {
        const candidateIds = candidates.map((c) => c.id);
        const pendingAction = await prisma.pendingAction.create({
          data: {
            userId: BigInt(ctx.from.id),
            type: 'INVOICE_DISAMBIGUATION',
            data: {
              ownerId,
              data: invoiceData,
              imageUrl,
              photoFileId: effectivePhotoFileId,
              userPhotoMsgId,
              rawCaption,
              candidateIds,
            },
          },
        });
        const disText = `⚠️ *Bir nechta ta'minotchi topildi:*\nNakladnoy qaysi "${sanitizeMdV1(invoiceData.supplierName)}" hisobiga yozilsin?`;
        const disKb = getDisambiguationKeyboard(candidates, pendingAction.id, 'isel', 'inew', 'cancel_idis');
        if (statusMsgId && ctx.chat?.id) {
          return safeEditMessageText(ctx, ctx.chat.id, statusMsgId, disText, {
            parse_mode: 'Markdown',
            reply_markup: disKb,
          }).catch(() => safeReply(ctx, disText, { parse_mode: 'Markdown', reply_markup: disKb }));
        }
        return safeReply(ctx, disText, { parse_mode: 'Markdown', reply_markup: disKb });
      }
    }
  }

  const { editableText, totalSum } = buildEditableInvoiceText(invoiceData, false);
  const math = reconcileInvoiceTotals({
    rows: invoiceData.items || invoiceData.rows,
    subtotalBeforeDiscount: totalSum,
    discountPercent: invoiceData.discountPercent,
    discountAmount: invoiceData.discountAmount ?? invoiceData.discount ?? 0,
    printedFinalTotal: invoiceData.finalTotal ?? invoiceData.printedFinalTotal,
    tableTotals: invoiceData.tableTotals,
    hasExplicitDiscount: invoiceData.hasExplicitDiscount,
  });
  invoiceData.rawTotal = invoiceData.grossTotal = invoiceData.total_amount = math.rawTotal;
  invoiceData.discountAmount = invoiceData.discount = math.discountAmount;
  invoiceData.finalTotal = invoiceData.netTotal = math.finalTotal;
  invoiceData.currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';

  const contentFingerprint = SupplierService.computeContentFingerprint({
    ownerId,
    supplierName: invoiceData.supplierName || "Noma'lum",
    currency: invoiceData.currency,
    finalTotal: math.finalTotal,
    items: Array.isArray(invoiceData.items) ? invoiceData.items : [],
  });
  invoiceData.contentFingerprint = contentFingerprint;

  // MODUL 6: Stage 2 Anti-Duplicate Content Fingerprint check isolated by ownerId
  if (!invoiceData.forceOverrideDuplicate) {
    const dupCheck = await SupplierService.checkDuplicateInvoice({
      ownerId,
      imageHash: invoiceData.imageHash || null,
      contentFingerprint,
    });
    if (dupCheck.isDuplicate && dupCheck.warningText) {
      const pendingAction = await prisma.pendingAction.create({
        data: {
          userId: BigInt(ctx.from.id),
          type: 'INVOICE',
          data: { ownerId, data: invoiceData, imageUrl, photoFileId: effectivePhotoFileId, userPhotoMsgId },
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
      userId: BigInt(ctx.from.id),
      type: 'INVOICE',
      data: { ownerId, data: invoiceData, imageUrl, photoFileId: effectivePhotoFileId, userPhotoMsgId },
    },
  });
  const actionId = `i_${pendingAction.id}`;
  ctx.session.step = actionId;

  const text = buildPendingPreviewMessage(invoiceData, editableText);
  const kb = getInvoiceConfirmationKeyboard(actionId, editableText, invoiceData.currency);

  let botMessageId = statusMsgId;
  if (statusMsgId && ctx.chat?.id) {
    await safeEditMessageText(ctx, ctx.chat.id, statusMsgId, text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(async () => {
      const sent = await safeReply(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
      botMessageId = sent.message_id;
    });
  } else {
    const sentMessage = await safeReply(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
    botMessageId = sentMessage.message_id;
  }

  await prisma.pendingAction.update({
    where: { id: pendingAction.id },
    data: { data: { ...(pendingAction.data as any), botMessageId } },
  });
}

async function handleInvoiceImageUpload(ctx: MyContext, fileId: string, _mimeType: string, errLabel: string) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);

  await withChatAction(ctx, 'upload_photo', async () => {
    const statusMsg = await ctx.reply('🖨 Nakladnoy 1:1 HD kserokopiya qilinmoqda...').catch(() => null);
    try {
      const file = await ctx.api.getFile(fileId);
      if (!file.file_path) throw new Error('Rasm fayli topilmadi');

      const [buffer] = await Promise.all([
        downloadTelegramFile(file.file_path),
        cacheService.getSupplierNames(ownerId),
      ]);

      // 5-MUAMMO: Ultra-Bright HD Xerox Scanner (1800px lanczos3, high-contrast B&W, quality 92)
      const xeroxBuffer = await createUltraBrightXeroxImage(buffer);
      const imageHash = ImageService.getImageHash(xeroxBuffer);

      // MODUL 6: Stage 1 ImageHash check before calling AI (isolated by ownerId)
      const stage1Dup = await SupplierService.checkDuplicateInvoice({ ownerId, imageHash });
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
            userId: BigInt(ctx.from!.id),
            type: 'INVOICE',
            data: {
              ownerId,
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
      const invoiceData = await AiService.parseInvoiceImage(xeroxBuffer, 'image/jpeg', caption);
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
        statusMsg?.message_id,
        xeroxBuffer
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
  clearSession(ctx);
  // 2-MUAMMO: Har doim eng yuqori sifatli (oxirgi indeksdagi) rasmni ol!
  const photos = ctx.message.photo;
  const highestResPhoto = photos[photos.length - 1];
  if (highestResPhoto) {
    await handleInvoiceImageUpload(ctx, highestResPhoto.file_id, 'image/jpeg', 'Nakladnoyni');
  }
});

invoiceHandler.on('message:document', async (ctx, next) => {
  if (!ctx.user || !ctx.message.document.mime_type?.startsWith('image/')) return next();
  clearSession(ctx);
  await handleInvoiceImageUpload(
    ctx,
    ctx.message.document.file_id,
    ctx.message.document.mime_type,
    'Nakladnoy hujjatini'
  );
});

invoiceHandler.hears('➕ Nakladnoy', (ctx) => {
  clearSession(ctx);
  return ctx.reply('📷 Iltimos, nakladnoy chekining rasmini (yoki hujjat shaklida) yuboring. AI uni 100% kserokopiya shaklida tahlil qiladi.');
});

invoiceHandler.callbackQuery(/^(?:edit_invoice_discount:|add_discount_(?:i_)?)(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const rawId = ctx.match[1];
  const isPending =
    rawId.startsWith('p_') ||
    !(await prisma.invoice.findFirst({ where: { id: rawId, ownerId }, select: { id: true } }).catch(() => null));
  const cleanId = rawId.replace(/^p_/, '');

  if (isPending) {
    const pendingAction = await findOwnedPendingAction(cleanId, ctx.from.id);
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

  ctx.session.step = 'AWAIT_SAVED_INVOICE_DISCOUNT';
  ctx.session.tempData = { invoiceId: cleanId, botMessageId: ctx.callbackQuery.message?.message_id };
  await ctx.reply(
    '🏷 **Saqlangan nakladnoy uchun chegirma (skidka) miqdorini kiriting:**\n• Foizda: masalan, `5%` yoki `10%`\n• Summada: masalan, `15000` yoki `$12.50`',
    { parse_mode: 'Markdown' }
  );
});

invoiceHandler.callbackQuery(/^edit_invoice_total:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const rawId = ctx.match[1];
  const cleanId = rawId.replace(/^p_/, '');
  const pendingAction = rawId.startsWith('p_') ? await findOwnedPendingAction(cleanId, ctx.from.id) : null;

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
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const rawId = ctx.match[1];
  const cleanId = rawId.replace(/^p_/, '');
  const pendingAction = rawId.startsWith('p_') ? await findOwnedPendingAction(cleanId, ctx.from.id) : null;

  if (pendingAction && pendingAction.type === 'INVOICE') {
    const pData = pendingAction.data as any;
    const invoiceData = pData.data;
    const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
    invoiceData.discountAmount = invoiceData.discount = 0;
    invoiceData.discountPercent = 0;
    invoiceData.finalTotal = invoiceData.netTotal = invoiceData.printedFinalTotal = rawTotal;
    invoiceData.discountLabel = null;

    await prisma.pendingAction.update({
      where: { id: cleanId },
      data: { data: pData, status: 'PENDING' },
    });

    const { editableText } = buildEditableInvoiceText(invoiceData);
    const txt = buildPendingPreviewMessage(invoiceData, editableText);
    const kb = getInvoiceConfirmationKeyboard(`i_${cleanId}`, editableText, invoiceData.currency || 'UZS');
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, txt, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      }).catch(() => {});
    }
    return ctx.answerCallbackQuery({ text: '❌ Skidka olib tashlandi!' });
  }

  try {
    const updated = await SupplierService.clearInvoiceDiscount(cleanId, ownerId);
    const cur = updated.currency;
    const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
    await ctx.answerCallbackQuery({ text: '❌ Skidka 0 ga tushirildi va balans yangilandi!' });
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `✅ **Nakladnoy skidkasi olib tashlandi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(updated.supplier.name)}**\n` +
          `💰 Asl summa: **${formatCurrency(updated.rawTotal, cur)}**\n` +
          `🏷 Skidka: **0**\n` +
          `💵 Yakuniy summa: **${formatCurrency(updated.finalTotal, cur)}**\n` +
          `📊 Ta'minotchi joriy qarzi (${cur}): **${formatCurrency(newDebt, cur)}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(updated.invoice.id, updated.supplier.id),
        }
      ).catch(() => {});
    }
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^toggle_invoice_currency:(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const rawId = ctx.match[1];
  const cleanId = rawId.replace(/^p_/, '');
  const pendingAction = rawId.startsWith('p_') ? await findOwnedPendingAction(cleanId, ctx.from.id) : null;

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
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, txt, {
        parse_mode: 'Markdown',
        reply_markup: kb,
      }).catch(() => {});
    }
    return ctx.answerCallbackQuery({ text: `💱 Valyuta ${invoiceData.currency} ga o'zgartirildi!` });
  }

  try {
    const updated = await SupplierService.toggleInvoiceCurrency(cleanId, ownerId);
    const cur = updated.currency;
    await ctx.answerCallbackQuery({ text: `💱 Valyuta ${cur} ga o'zgartirildi va balans yangilandi!` });
    if (ctx.callbackQuery.message && ctx.chat?.id) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        ctx.callbackQuery.message.message_id,
        `✅ **Nakladnoy valyutasi ${cur} ga o'zgartirildi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(updated.supplier.name)}**\n` +
          `💵 Yakuniy summa: **${formatCurrency(updated.finalTotal, cur)}**\n` +
          `📊 Qarz balansi (UZS): **${formatCurrency(updated.supplier.debtUzs, 'UZS')}**\n` +
          `💵 Qarz balansi (USD): **${formatCurrency(updated.supplier.debtUsd, 'USD')}**`,
        {
          parse_mode: 'Markdown',
          reply_markup: getSavedInvoiceCardKeyboard(updated.invoice.id, updated.supplier.id),
        }
      ).catch(() => {});
    }
  } catch (err: any) {
    await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
  }
});

function parseTwoOrOneAmounts(rawText: string): { first: number; second?: number } {
  const trimmed = rawText.trim();
  // Single space-separated thousands number like "500 000" or "1 250 000"
  if (/^\$?\d{1,3}(?:\s+\d{3})+(?:\s*(?:so['`’]?m|uzs|usd|usdt|\$))?$/i.test(trimmed)) {
    return { first: parseSmartAmount(trimmed) };
  }
  const parts = trimmed
    .split(/[\s/;|-]+/)
    .map((p) => p.trim())
    .filter((p) => /\d/.test(p));
  if (parts.length >= 2) {
    const first = parseSmartAmount(parts[0]);
    const second = parseSmartAmount(parts[1]);
    if (first > 0 && second >= 0) {
      return { first, second };
    }
  }
  return { first: parseSmartAmount(trimmed) };
}

invoiceHandler.on('message:text', async (ctx, next) => {
  if (!ctx.user || !ctx.from || ctx.message.text.startsWith('/')) return next();
  const ownerId = String(ctx.from.id);
  const rawText = ctx.message.text.trim();
  if (isMenuButton(rawText)) {
    clearSession(ctx);
    return next();
  }

  // 1. Handle saved invoice discount edit
  if (ctx.session.step === 'AWAIT_SAVED_INVOICE_DISCOUNT') {
    const { invoiceId } = ctx.session.tempData || {};
    clearSession(ctx);
    if (!invoiceId) return next();
    try {
      const updated = await SupplierService.updateInvoiceDiscount(invoiceId, rawText, ownerId);
      const cur = updated.currency;
      const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
      return safeReply(
        ctx,
        `✅ **Nakladnoy skidkasi yangilandi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(updated.supplier.name)}**\n` +
          `💰 Asl summa: **${formatCurrency(updated.rawTotal, cur)}**\n` +
          `🏷 Skidka (${sanitizeMdV1(rawText)}): **-${formatCurrency(updated.discountAmount, cur)}**\n` +
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
      const updated = await SupplierService.overrideInvoiceTotal(invoiceId, first, second, ownerId);
      const cur = updated.currency;
      const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
      return safeReply(
        ctx,
        `✅ **Nakladnoy summasi qo'lda yangilandi!**\n\n` +
          `🏢 Ta'minotchi: **${sanitizeMdV1(updated.supplier.name)}**\n` +
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

  const isInvoiceStep =
    ctx.session.step === 'await_invoice_discount' ||
    ctx.session.step === 'await_invoice_manual_total' ||
    ctx.session.step === 'await_new_supplier_name_inv' ||
    Boolean(ctx.session.step?.startsWith('i_'));

  const activePending = isInvoiceStep
    ? await prisma.pendingAction.findFirst({
        where: {
          userId: BigInt(ctx.from.id),
          type: { in: ['INVOICE', 'INVOICE_NEW_SUPP'] },
          status: { in: ['PENDING', 'AWAIT_DISCOUNT', 'AWAIT_MANUAL_TOTAL', 'AWAIT_NEW_SUPPLIER_NAME_INV'] },
          createdAt: { gte: new Date(Date.now() - 3600000) },
          ...(ctx.session.step?.startsWith('i_')
            ? { id: ctx.session.step.slice(2) }
            : ctx.session.tempData?.pendingId
            ? { id: String(ctx.session.tempData.pendingId) }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
      })
    : null;

  // If user is on an unconfirmed `i_<id>` preview (did NOT click edit discount/total/new supplier)
  // and types a standalone business command (e.g. "Sirok 500.000 naqd", "Kola narxi"), let voiceHandler run it!
  if (
    activePending &&
    activePending.status === 'PENDING' &&
    parseTextCommandLocally(rawText) !== null
  ) {
    clearSession(ctx);
    return next();
  }

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
        invoiceData.discountPercent =
          rawTotal > 0 ? Number(((discountAmount / rawTotal) * 100).toFixed(2)) : 0;
        invoiceData.discountLabel = null;
        invoiceData.finalTotal = invoiceData.netTotal = invoiceData.printedFinalTotal = finalTotal;

        await Promise.all([
          prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
          safeDelete(ctx, ctx.chat?.id, ctx.message.message_id),
        ]);

        const { editableText } = buildEditableInvoiceText(invoiceData);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        await updatePreviewMessage(txt, finalTotal);
        ctx.session.step = `i_${pendingId}`;
        ctx.session.tempData = null;
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
        invoiceData.discountPercent = math.isPercent
          ? Number(math.percent || 0)
          : math.rawTotal > 0
          ? Number(((math.discountAmount / math.rawTotal) * 100).toFixed(2))
          : 0;
        invoiceData.finalTotal = invoiceData.netTotal = invoiceData.printedFinalTotal = math.finalTotal;
        invoiceData.discountLabel = rawText;

        await Promise.all([
          prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
          safeDelete(ctx, ctx.chat?.id, ctx.message.message_id),
        ]);

        const { editableText } = buildEditableInvoiceText(invoiceData);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        await updatePreviewMessage(txt, math.finalTotal);
        ctx.session.step = `i_${pendingId}`;
        ctx.session.tempData = null;
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
  if (!ctx.from) return null;
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction || pendingAction.type !== 'INVOICE') {
    await ctx
      .editMessageText(
        "⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.",
        { reply_markup: undefined }
      )
      .catch(() => {});
    return null;
  }
  const pData = pendingAction.data as any;
  const invoiceData = pData.data;
  const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
  const math = reconcileInvoiceTotals({
    rows: invoiceData.items || invoiceData.rows,
    subtotalBeforeDiscount: rawTotal,
    discountPercent: invoiceData.discountPercent,
    discountAmount: invoiceData.discountAmount ?? invoiceData.discount ?? 0,
    printedFinalTotal: invoiceData.finalTotal ?? invoiceData.printedFinalTotal,
    tableTotals: invoiceData.tableTotals,
    hasExplicitDiscount: invoiceData.hasExplicitDiscount,
  });
  const currency: 'UZS' | 'USD' = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
  return {
    pendingId,
    ownerId: String(pData.ownerId || ctx.from?.id || ''),
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
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
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
  if (ctx.callbackQuery.message && ctx.chat?.id) {
    await safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, text, {
      parse_mode: 'Markdown',
      reply_markup: kb,
    }).catch(() => {});
  }
  await ctx.answerCallbackQuery({ text: "✅ Qayta kiritishga ruxsat berildi. To'lov turini tanlang." });
});

invoiceHandler.callbackQuery(/^confirm_invdebt_i_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
  if (!extracted) return;
  const { pendingId, ownerId, pData, invoiceData, totalSum, discountAmount, finalPayable, currency, supplierName } = extracted;

  try {
    const result = await SupplierService.createInvoiceWithItems({
      ownerId,
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

    await deleteOwnedPendingAction(pendingId, ctx.from.id);
    clearSession(ctx);

    if (result.isDuplicate && result.warningText) {
      await ctx.editMessageText(result.warningText, { reply_markup: undefined });
      return;
    }

    const finalDebt =
      currency === 'USD' ? Number(result.supplier.debtUsd) : Number(result.supplier.debtUzs);

    const savedMsg =
      `✅ **Nakladnoy (📝 Nasiyaga) muvaffaqiyatli saqlandi!**\n\n` +
      `🏢 Ta'minotchi: **${sanitizeMdV1(result.supplier.name)}**\n` +
      `📦 Tovarlarning asl summasi: **${formatCurrency(totalSum, currency)}**\n` +
      (discountAmount > 0 ? `🏷 Skidka: **-${formatCurrency(discountAmount, currency)}**\n` : '') +
      `💰 Skidkadan keyingi yakuniy summa (Itogo): **+${formatCurrency(finalPayable, currency)}**\n` +
      `📊 **Yakuniy qarz qoldig'i (${currency}):** **${formatCurrency(finalDebt, currency)}**`;

    const savedKb = getSavedInvoiceCardKeyboard(
      result.invoice.id,
      result.supplier.id,
      pData.photoFileId,
      result.transaction?.id
    );

    await Promise.all([
      ctx.callbackQuery.message && ctx.chat?.id
        ? safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, savedMsg, {
            parse_mode: 'Markdown',
            reply_markup: savedKb,
          })
        : safeReply(ctx, savedMsg, { parse_mode: 'Markdown', reply_markup: savedKb }),
      safeDelete(ctx, ctx.chat?.id, pData.userPhotoMsgId),
    ]);
  } catch (error) {
    logger.error(error, 'Transaction error saving invoice');
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi. Qayta urinib ko'ring.", show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^confirm_invcash_i_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
  if (!extracted) return;
  const { pendingId, ownerId, pData, invoiceData, totalSum, discountAmount, finalPayable, currency, supplierName } = extracted;

  try {
    const result = await SupplierService.createInvoiceWithItems({
      ownerId,
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

    await deleteOwnedPendingAction(pendingId, ctx.from.id);
    clearSession(ctx);

    if (result.isDuplicate && result.warningText) {
      await ctx.editMessageText(result.warningText, { reply_markup: undefined });
      return;
    }

    const savedMsg =
      `✅ **Nakladnoy (💵 Naqdga) muvaffaqiyatli saqlandi!**\n\n` +
      `🏢 Ta'minotchi: **${sanitizeMdV1(result.supplier.name)}**\n` +
      `📦 Tovarlarning asl summasi: **${formatCurrency(totalSum, currency)}**\n` +
      (discountAmount > 0 ? `🏷 Skidka: **-${formatCurrency(discountAmount, currency)}**\n` : '') +
      `💵 Naqd to'langan summa (Itogo): **${formatCurrency(finalPayable, currency)}**\n` +
      `📊 Qarzga yozilmadi (0). Bugungi Z-Otchyot naqd xaridlariga qo'shildi.`;

    const savedKb = getSavedInvoiceCardKeyboard(
      result.invoice.id,
      result.supplier.id,
      pData.photoFileId,
      result.transaction?.id
    );

    await Promise.all([
      ctx.callbackQuery.message && ctx.chat?.id
        ? safeEditMessageText(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, savedMsg, {
            parse_mode: 'Markdown',
            reply_markup: savedKb,
          })
        : safeReply(ctx, savedMsg, { parse_mode: 'Markdown', reply_markup: savedKb }),
      safeDelete(ctx, ctx.chat?.id, pData.userPhotoMsgId),
    ]);
  } catch (error) {
    logger.error(error, 'Transaction error saving cash invoice');
    await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi. Qayta urinib ko'ring.", show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^cancel_(?:i|idis)_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (pendingAction) {
    await Promise.all([
      safeDelete(ctx, ctx.chat?.id, (pendingAction.data as any)?.userPhotoMsgId),
      deleteOwnedPendingAction(pendingId, ctx.from.id),
    ]);
  }
  clearSession(ctx);
  await ctx.editMessageText('❌ Nakladnoy bekor qilindi.', { reply_markup: undefined });
});

invoiceHandler.callbackQuery(/^isel_(.+)_(\d+)$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const [, pendingId, rawIdx] = ctx.match;
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
    return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
  const pData = pendingAction.data as any;
  const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
  const supplier = supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
    : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  pData.data.exactSupplierId = supplier.id;
  pData.data.supplierName = supplier.name;

  await Promise.all([
    deleteOwnedPendingAction(pendingId, ctx.from.id),
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
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
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

invoiceHandler.callbackQuery(/^(?:sf_use:inv_(.+)|sup_fuzzy_use:([^:]+):inv_(.+))$/, async (ctx) => {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);
  const pendingId = ctx.match[1] || ctx.match[3];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  const supplierId = ctx.match[2] || pData.suggestedSupplierId || pData.candidateIds?.[0];
  const supplier = supplierId
    ? await prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
    : null;
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  pData.data.exactSupplierId = supplier.id;
  pData.data.supplierName = supplier.name;

  await Promise.all([
    deleteOwnedPendingAction(pendingId, ctx.from.id),
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

invoiceHandler.callbackQuery(/^(?:sf_new|sup_fuzzy_new):inv_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (!pendingAction) return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });

  const pData = pendingAction.data as any;
  pData.data.exactSupplierId = 'CREATE_NEW';
  pData.data.supplierName = toLatinUz(pData.data.supplierName || "Noma'lum");

  await Promise.all([
    deleteOwnedPendingAction(pendingId, ctx.from.id),
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

invoiceHandler.callbackQuery(/^(?:sf_no|sup_fuzzy_cancel):inv_(.+)$/, async (ctx) => {
  if (!ctx.from) return;
  const pendingId = ctx.match[1];
  const pendingAction = await findOwnedPendingAction(pendingId, ctx.from.id);
  if (pendingAction) {
    await Promise.all([
      safeDelete(ctx, ctx.chat?.id, (pendingAction.data as any)?.userPhotoMsgId),
      deleteOwnedPendingAction(pendingId, ctx.from.id),
    ]);
  }
  clearSession(ctx);
  await ctx.editMessageText('❌ Nakladnoy bekor qilindi.', { reply_markup: undefined });
});


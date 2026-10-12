import { Composer } from 'grammy';
import { Prisma } from '@prisma/client';
import { MyContext } from '../context';
import { AiService } from '../../services/ai.service';
import { ImageService } from '../../services/image.service';
import { getConfirmationKeyboard, getInvoiceConfirmationKeyboard, getDiscountConfirmationKeyboard } from '../keyboards/inline';
import { logger } from '../../config/logger';
import { env } from '../../config/env';
import { formatMoney, formatDate } from '../../utils/formatters';
import { prisma } from '../../database/prisma';
import { TranslitService } from '../../services/translit.service';
import { fuzzyMatch } from '../../utils/fuzzy';
import { cacheService } from '../../services/cache.service';
import { withChatAction } from '../../utils/telegram';
import { SupplierService } from '../../services/supplier.service';
import { InlineKeyboard } from 'grammy';

export const invoiceHandler = new Composer<MyContext>();

const safeDelete = async (ctx: MyContext, chatId: number | string, msgId?: number) => {
  if (!msgId) return;
  try {
    await ctx.api.deleteMessage(chatId, msgId);
  } catch (_) { }
};

async function downloadFile(filePath: string): Promise<Buffer> {
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function processParsedInvoice(ctx: MyContext, invoiceData: any, imageUrl: string, photoFileId: string | null, userPhotoMsgId: number | null, rawCaption: string) {
  // Disambiguation
  if (!invoiceData.exactSupplierId && invoiceData.supplierName && invoiceData.supplierName !== "Noma'lum") {
    const candidates = await SupplierService.findMatchingSuppliers(invoiceData.supplierName, rawCaption);

    if (candidates.length === 1) {
      invoiceData.exactSupplierId = candidates[0].id;
      invoiceData.supplierName = candidates[0].name;
    } else if (candidates.length > 1) {
      const pendingAction = await prisma.pendingAction.create({
        data: {
          type: 'INVOICE_DISAMBIGUATION',
          data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId, rawCaption }
        }
      });
      const actionId = `idis_${pendingAction.id}`;

      let disambigText = `⚠️ *Bir nechta ta'minotchi topildi:*\nNakladnoy qaysi "${invoiceData.supplierName}" hisobiga yozilsin?`;
      const keyboard = new InlineKeyboard();

      candidates.forEach(c => {
        keyboard.text(`🏢 ${c.name} - ${formatMoney(Number(c.debtUzs), 'UZS')}`, `isel_${actionId}_${c.id}`).row();
      });
      keyboard.text(`➕ Bu yangi ta'minotchi (Alohida ochish)`, `inew_${actionId}`).row();
      keyboard.text(`❌ Bekor qilish`, `cancel_idis_${actionId}`).row();

      return ctx.reply(disambigText, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  }

  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId: ctx.from?.id ? BigInt(ctx.from.id) : null,
      type: 'INVOICE',
      data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId }
    }
  });
  const actionId = `i_${pendingAction.id}`;
  ctx.session.step = actionId;

  let editableText = ``;
  if (invoiceData.isCashOverride) {
    editableText += `🏢 Kimdan (Naqd): ${invoiceData.supplierName || "Noma'lum"}\n`;
  } else if (invoiceData.isCaptionOverride) {
    editableText += `Ta'minotchi: ${invoiceData.supplierName || "Noma'lum"} (Izohingiz orqali belgilandi)\n`;
  } else {
    editableText += `Ta'minotchi: ${invoiceData.supplierName || "Noma'lum"}\n`;
  }
  editableText += `Raqam: ${invoiceData.invoiceNo || "Yo'q"}\n\n`;

  let totalSum = invoiceData.total_amount ?? invoiceData.grossTotal ?? 0;

  if (invoiceData.sampleItems && invoiceData.sampleItems.length > 0) {
    editableText += `📦 Tovarlar (jami ${invoiceData.itemsCount || invoiceData.sampleItems.length} ta):\n`;
    invoiceData.sampleItems.forEach((name: string, idx: number) => {
      editableText += `  ${idx + 1}. ${name}\n`;
    });
    if (invoiceData.itemsCount && invoiceData.itemsCount > invoiceData.sampleItems.length) {
      editableText += `  ... va yana ${invoiceData.itemsCount - invoiceData.sampleItems.length} xil tovar\n`;
    }
  } else if (invoiceData.items && invoiceData.items.length > 0) {
    invoiceData.items.forEach((item: any, idx: number) => {
      editableText += `${idx + 1}. ${item.productName} - ${item.quantity} x ${item.unitPrice}\n`;
      if (!invoiceData.grossTotal) totalSum += item.totalPrice;
    });
  }

  // Sync back calculated total sum if it was empty
  invoiceData.grossTotal = totalSum;
  invoiceData.total_amount = totalSum;
  const discount = invoiceData.discount ?? invoiceData.discountAmount ?? 0;
  invoiceData.discountAmount = discount;
  invoiceData.discount = discount;

  let text = invoiceData.isCashOverride ? `🧾 **Naqd Xarid Tahlili**\n\n` : `📄 **Nakladnoy Tahlili**\n\n`;
  text += `\`\`\`\n${editableText}\`\`\`\n`;
  text += `\n💰 Jami summa: ${formatMoney(totalSum)}\n`;
  if (discount > 0) {
    text += `🎁 Skidka: -${formatMoney(discount)}\n`;
    text += `💳 K оплате: ${formatMoney(invoiceData.netTotal || (totalSum - discount))}\n`;
  }

  if (invoiceData.isCashOverride) {
    text += `📦 Amal turi: 💵 Naqd xarid (Qarzga ta'sir qilmaydi)\n\n`;
  }
  text += `_💡 Skidka yoki ta'minotchi nomini to'g'irlash uchun chatga yozib yuboring (masalan: "5%" yoki "Azamataka")_\n\nMa'lumotlar to'g'rimi?`;

  const sentMessage = await ctx.reply(text, {
    parse_mode: 'Markdown',
    reply_markup: getInvoiceConfirmationKeyboard(actionId, editableText)
  });

  await prisma.pendingAction.update({
    where: { id: pendingAction.id },
    data: { data: { ...pendingAction.data as any, botMessageId: sentMessage.message_id } }
  });
}

invoiceHandler.on('message:photo', async (ctx) => {
  if (!ctx.user) return;

  await withChatAction(ctx, 'upload_photo', async () => {
    try {
      const photo = ctx.message.photo.pop();
      if (!photo) throw new Error('Photo not found');

      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('File path not found');

      // Run download and cache fetching in parallel to save time
      const [buffer, supplierNames] = await Promise.all([
        downloadFile(file.file_path),
        cacheService.getSupplierNames()
      ]);

      // Hash validation (Deduplication)
      const imageHash = ImageService.getImageHash(buffer);
      const existing = await prisma.processedImage.findUnique({ where: { hash: imageHash } }).catch(() => null);
      if (existing) {
        const d = existing.data as any;
        const dateStr = new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(existing.createdAt);
        await ctx.reply(`⚠️ Ushbu nakladnoy allaqachon ro'yxatga olingan! (Sana: ${dateStr}, Ta'minotchi: ${d.supplierName || "Noma'lum"}, Summa: ${formatMoney(d.grossTotal || 0)})`);
        return;
      }

      // Process image with fast OCR optimization
      const processedBuffer = await ImageService.optimizeForFastOCR(buffer);

      // Send to Gemini
      const caption = ctx.message.caption?.trim() || "";
      const invoiceData = await AiService.parseInvoiceImage(processedBuffer, 'image/jpeg', caption);

      // Save hash to prevent future duplicates
      await prisma.processedImage.create({
        data: {
          hash: imageHash,
          data: invoiceData as any
        }
      }).catch(console.error);

      if (caption) {
        const cashRegex = /naqd\s*pulga|naqdga|naqd|cash/i;
        if (cashRegex.test(caption)) {
          invoiceData.isCashOverride = true;
          invoiceData.isCaptionOverride = true;
          invoiceData.supplierName = caption.replace(cashRegex, '').trim() || "Noma'lum";
        } else {
          invoiceData.isCaptionOverride = true;
          invoiceData.supplierName = caption;
        }
      }

      await processParsedInvoice(ctx, invoiceData, file.file_path, photo.file_id, ctx.message.message_id, caption || '');

    } catch (error) {
      logger.error({ error: error, stack: error instanceof Error ? error.stack : undefined }, 'Error parsing invoice');
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Xatolik yuz berdi. Nakladnoyni o'qish imkoni bo'lmadi.\n\nSabab: ${errorMessage}`);
      // Cleanup temporary session data on error
      ctx.session.tempData = null;
      ctx.session.step = undefined;
    }
  });
});

invoiceHandler.on('message:document', async (ctx, next) => {
  if (!ctx.user) return next();
  const doc = ctx.message.document;
  if (!doc.mime_type?.startsWith('image/')) {
    return next();
  }

  await withChatAction(ctx, 'upload_photo', async () => {
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error('File path not found');

      const [buffer, supplierNames] = await Promise.all([
        downloadFile(file.file_path),
        cacheService.getSupplierNames()
      ]);

      const imageHash = ImageService.getImageHash(buffer);
      const existing = await prisma.processedImage.findUnique({ where: { hash: imageHash } }).catch(() => null);
      if (existing) {
        const d = existing.data as any;
        const dateStr = new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short', timeStyle: 'short' }).format(existing.createdAt);
        await ctx.reply(`⚠️ Ushbu nakladnoy allaqachon ro'yxatga olingan! (Sana: ${dateStr}, Ta'minotchi: ${d.supplierName || "Noma'lum"}, Summa: ${formatMoney(d.grossTotal || 0)})`);
        return;
      }

      const processedBuffer = await ImageService.optimizeForFastOCR(buffer);

      const caption = ctx.message.caption?.trim() || "";
      const invoiceData = await AiService.parseInvoiceImage(processedBuffer, doc.mime_type || 'image/jpeg', caption);

      await prisma.processedImage.create({
        data: {
          hash: imageHash,
          data: invoiceData as any
        }
      }).catch(console.error);

      if (caption) {
        const cashRegex = /naqd\s*pulga|naqdga|naqd|cash/i;
        if (cashRegex.test(caption)) {
          invoiceData.isCashOverride = true;
          invoiceData.isCaptionOverride = true;
          invoiceData.supplierName = caption.replace(cashRegex, '').trim() || "Noma'lum";
        } else {
          invoiceData.isCaptionOverride = true;
          invoiceData.supplierName = caption;
        }
      }

      await processParsedInvoice(ctx, invoiceData, file.file_path, doc.file_id, ctx.message.message_id, caption || '');

    } catch (error) {
      logger.error({ error: error, stack: error instanceof Error ? error.stack : undefined }, 'Error parsing invoice document');
      const errorMessage = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ Xatolik yuz berdi. Nakladnoy hujjatini o'qish imkoni bo'lmadi.\n\nSabab: ${errorMessage}`);
      ctx.session.tempData = null;
      ctx.session.step = undefined;
    }
  });
});

invoiceHandler.hears('➕ Nakladnoy', async (ctx) => {
  await ctx.reply("📷 Iltimos, nakladnoy chekining rasmini (yoki hujjat shaklida) yuboring. AI uni avtomatik tahlil qiladi.");
});

invoiceHandler.on('message:text', async (ctx, next) => {
  if (!ctx.user || ctx.message.text.startsWith('/')) return next();

  const rawText = ctx.message.text.trim();
  const SYSTEM_MENU_BUTTONS = [
    "📦 Ta'minotchilar",
    "👥 Nasiyadorlar",
    "💵 Naqd",
    "📉 Xarajatlar",
    "📊 Z-Hisobot (Kunlik)",
    "📝 Qidiruv",
    "➕ Nakladnoy",
    "/start"
  ];

  if (SYSTEM_MENU_BUTTONS.some(btn => rawText.includes(btn))) {
    return next();
  }

  // Explicit session steps take precedence over implicit drafts
  if (ctx.session.step) return next();

  const activePending = await prisma.pendingAction.findFirst({
    where: {
      userId: ctx.from?.id ? BigInt(ctx.from.id) : undefined,
      type: { in: ['INVOICE', 'INVOICE_NEW_SUPP'] },
      status: { in: ['PENDING', 'AWAIT_DISCOUNT', 'AWAIT_NEW_SUPPLIER_NAME_INV'] },
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
    },
    orderBy: { createdAt: 'desc' }
  });

  if (activePending) {
    if (activePending.status === 'AWAIT_NEW_SUPPLIER_NAME_INV') {
      const pData = activePending.data as any;
      pData.data.exactSupplierId = 'CREATE_NEW';
      pData.data.supplierName = ctx.message.text.trim();

      await prisma.pendingAction.delete({ where: { id: activePending.id } });
      ctx.session.step = undefined;
      ctx.session.tempData = null;

      await processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
      return;
    }

    if (activePending.status === 'AWAIT_DISCOUNT' || (activePending.type === 'INVOICE' && activePending.status === 'PENDING')) {
      const pendingId = activePending.id;
      const pData = activePending.data as any;
      const botMessageId = pData.botMessageId || pData.userPhotoMsgId + 1; // best effort fallback
      const invoiceData = pData.data;
      const text = ctx.message.text.trim();
      let discountAmount = 0;
      let totalSum = invoiceData.grossTotal || 0;
      if (!invoiceData.grossTotal && invoiceData.items) invoiceData.items.forEach((i: any) => totalSum += i.totalPrice);
      const percentMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
      const fixedDiscountMatch = text.match(/^(\d[\d\s]*)(?:\s*(?:ming|k|sum|so'm|skidka))?$/i);

      let discountLabel = text;
      let matchedDiscount = false;

      if (percentMatch) {
        const percent = parseFloat(percentMatch[1].replace(',', '.'));
        discountAmount = totalSum * (percent / 100);
        matchedDiscount = true;
      } else if (fixedDiscountMatch) {
        let numericOnly = text.replace(/[^\d.,]/g, '').replace(',', '.');
        if (numericOnly.length >= 3 && Number(numericOnly) < totalSum) {
          discountAmount = parseFloat(numericOnly);
          if (text.toLowerCase().includes('ming')) discountAmount *= 1000;
          matchedDiscount = true;
        }
      }

      // If it matches a discount OR we explicitly requested AWAIT_DISCOUNT
      if (matchedDiscount || activePending.status === 'AWAIT_DISCOUNT') {
        if (!matchedDiscount && text.length > 0) { // Fallback for explicit discount request
          let numStr = text.replace(/[^\d.,]/g, '').replace(',', '.');
          if (numStr) {
            discountAmount = parseFloat(numStr);
            if (text.toLowerCase().includes('ming')) discountAmount *= 1000;
          }
        }

        if (isNaN(discountAmount) || discountAmount < 0) discountAmount = 0;
        if (discountAmount > totalSum) discountAmount = totalSum;

        invoiceData.discountAmount = discountAmount;
        invoiceData.discountLabel = discountLabel;

        await prisma.pendingAction.update({
          where: { id: pendingId },
          data: { data: pData, status: 'PENDING' }
        });

        await safeDelete(ctx, ctx.chat?.id || 0, ctx.message.message_id);

        const finalPayable = totalSum - discountAmount;
        let editableText = ``;
        if (invoiceData.isCashOverride) {
          editableText += `🏢 Kimdan (Naqd): ${invoiceData.supplierName || "Noma'lum"}\n`;
        } else if (invoiceData.isCaptionOverride) {
          editableText += `Ta'minotchi: ${invoiceData.supplierName || "Noma'lum"} (Izohingiz orqali belgilandi)\n`;
        } else {
          editableText += `Ta'minotchi: ${invoiceData.supplierName || "Noma'lum"}\n`;
        }
        editableText += `Raqam: ${invoiceData.invoiceNo || "Yo'q"}\n\n`;

        if (invoiceData.sampleItems && invoiceData.sampleItems.length > 0) {
          editableText += `📦 Tovarlar:\n`;
          invoiceData.sampleItems.forEach((name: string, idx: number) => {
            editableText += `  ${idx + 1}. ${name}\n`;
          });
        } else if (invoiceData.items) {
          invoiceData.items.forEach((item: any, idx: number) => {
            editableText += `${idx + 1}. ${item.productName} - ${item.quantity} x ${item.unitPrice}\n`;
          });
        }

        let txt = invoiceData.isCashOverride ? `🧾 **Naqd Xarid Tahlili (Yangilandi)**\n\n` : `📄 **Nakladnoy Tahlili (Yangilandi)**\n\n`;
        txt += `\`\`\`\n${editableText}\`\`\`\n`;
        txt += `📊 Tovarlar jami: ${formatMoney(totalSum)}\n`;
        txt += `🎁 Skidka (${discountLabel}): -${formatMoney(discountAmount)}\n`;
        txt += `--------------------------------\n`;
        txt += `💰 Yakuniy ${invoiceData.isCashOverride ? 'summa' : 'qarzga yoziladi'}: ${formatMoney(finalPayable)}\n`;

        const keyboard = getDiscountConfirmationKeyboard(`i_${pendingId}`, finalPayable, !!invoiceData.isCashOverride);

        if (pData.botMessageId) {
          await ctx.api.editMessageText(ctx.chat?.id || 0, pData.botMessageId, txt, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => { });
        } else {
          const sent = await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: keyboard });
          pData.botMessageId = sent.message_id;
          await prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } });
        }
        return;
      }
      // Else if no discount matches and it's PENDING, treat it as supplier name!
      else if (activePending.status === 'PENDING' && text.length > 2 && !text.startsWith('/')) {
        invoiceData.supplierName = text;
        invoiceData.isCaptionOverride = true;

        await prisma.pendingAction.update({
          where: { id: pendingId },
          data: { data: pData }
        });

        await safeDelete(ctx, ctx.chat?.id || 0, ctx.message.message_id);

        let editableText = `🏢 Ta'minotchi: ${invoiceData.supplierName} (O'zgartirildi)\n`;
        editableText += `Raqam: ${invoiceData.invoiceNo || "Yo'q"}\n\n`;

        if (invoiceData.sampleItems && invoiceData.sampleItems.length > 0) {
          editableText += `📦 Tovarlar:\n`;
          invoiceData.sampleItems.forEach((name: string, idx: number) => {
            editableText += `  ${idx + 1}. ${name}\n`;
          });
        } else if (invoiceData.items) {
          invoiceData.items.forEach((item: any, idx: number) => {
            editableText += `${idx + 1}. ${item.productName} - ${item.quantity} x ${item.unitPrice}\n`;
          });
        }

        let txt = invoiceData.isCashOverride ? `🧾 **Naqd Xarid Tahlili**\n\n` : `📄 **Nakladnoy Tahlili**\n\n`;
        txt += `\`\`\`\n${editableText}\`\`\`\n`;
        txt += `💰 Umumiy summa: ${formatMoney(totalSum)}\n`;
        if (invoiceData.discountAmount) {
          txt += `🎁 Skidka: -${formatMoney(invoiceData.discountAmount)}\n`;
          txt += `💳 Yakuniy: ${formatMoney(totalSum - invoiceData.discountAmount)}\n`;
        }
        txt += `\nMa'lumotlar to'g'rimi?`;

        const finalAmount = totalSum - (invoiceData.discountAmount || 0);
        const keyboard = getDiscountConfirmationKeyboard(`i_${pendingId}`, finalAmount, !!invoiceData.isCashOverride);

        if (pData.botMessageId) {
          await ctx.api.editMessageText(ctx.chat?.id || 0, pData.botMessageId, txt, { parse_mode: 'Markdown', reply_markup: keyboard }).catch(() => { });
        } else {
          const sent = await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: keyboard });
          pData.botMessageId = sent.message_id;
          await prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } });
        }
        return;
      }
    }
  }

  // Matn ichida @botname bo'lishi mumkin (switch_inline_query_current_chat orqali kelganda)
  const cleanText = ctx.message.text.replace(/^@\w+\s+/, '').trim();

  if (cleanText.toLowerCase().startsWith("ta'minotchi:") || cleanText.toLowerCase().startsWith("taminotchi:") || cleanText.includes("Raqam:")) {
    await withChatAction(ctx, 'typing', async () => {
      try {
        const invoiceData = await AiService.parseInvoiceText(cleanText);

        const cashRegex = /naqd\s*pulga|naqdga|naqd|cash/i;
        if (cashRegex.test(cleanText)) {
          invoiceData.isCashOverride = true;
          const cleanedName = invoiceData.supplierName?.replace(cashRegex, '').trim();
          invoiceData.supplierName = cleanedName || "Noma'lum";
        }

        await processParsedInvoice(ctx, invoiceData, '', null, null, cleanText);
      } catch (error) {
        logger.error({ error: error, stack: error instanceof Error ? error.stack : undefined }, 'Error parsing edited invoice');
        const errorMessage = error instanceof Error ? error.message : String(error);
        await ctx.reply(`❌ Xatolik yuz berdi. Tahrirlangan matnni o'qish imkoni bo'lmadi.\n\nSabab: ${errorMessage}`);
      }
    });
  } else {
    return next();
  }
});



invoiceHandler.callbackQuery(/^confirm_invdebt_i_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });

  if (!pendingAction || pendingAction.type !== 'INVOICE') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.", { reply_markup: undefined }).catch(() => { });
  }

  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });

  const pData = pendingAction.data as any;
  const userPhotoMsgId = pData.userPhotoMsgId;
  const invoiceData = pData.data;
  let totalSum = invoiceData.grossTotal || 0;
  if (!invoiceData.grossTotal && Array.isArray(invoiceData.items)) {
    invoiceData.items.forEach((i: any) => totalSum += (i.totalPrice || 0));
  }
  const supplierName = invoiceData.supplierName || 'Umumiy Ta\'minotchi';
  const discountAmount = invoiceData.discountAmount || 0;
  const finalPayable = totalSum - discountAmount;

  try {
    // ACID Transaction
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      let supplier;
      if (invoiceData.exactSupplierId && invoiceData.exactSupplierId !== 'CREATE_NEW') {
        supplier = await tx.supplier.findUnique({ where: { id: invoiceData.exactSupplierId } });
      }

      if (!supplier) {
        supplier = await tx.supplier.findUnique({ where: { name: supplierName } });
        if (!supplier) {
          supplier = await tx.supplier.create({
            data: { name: supplierName, debtUzs: finalPayable }
          });
        } else {
          supplier = await tx.supplier.update({
            where: { id: supplier.id },
            data: { debtUzs: { increment: finalPayable } }
          });
        }
      } else {
        supplier = await tx.supplier.update({
          where: { id: supplier.id },
          data: { debtUzs: { increment: finalPayable } }
        });
      }

      const invoice = await tx.invoice.create({
        data: {
          supplierId: supplier.id,
          invoiceNo: invoiceData.invoiceNo,
          totalAmount: finalPayable,
          originalAmount: totalSum,
          discountAmount: discountAmount,
          currency: 'UZS',
        }
      });

      if (invoiceData.items && invoiceData.items.length > 0) {
        for (const item of invoiceData.items) {
          const searchTokens = TranslitService.generateSearchTokens(item.productName);
          let product = await tx.product.findFirst({
            where: { searchTokens: { contains: TranslitService.toLatin(item.productName).toLowerCase() } }
          });

          if (!product) {
            product = await tx.product.create({
              data: {
                name: item.productName,
                searchTokens,
                lastPrice: item.unitPrice
              }
            });
          } else {
            await tx.product.update({
              where: { id: product.id },
              data: { lastPrice: item.unitPrice }
            });
          }

          await tx.invoiceItem.create({
            data: {
              invoiceId: invoice.id,
              productId: product.id,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice
            }
          });
        }
      }
      let formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n`;
      formattedReceipt += `🏢 Ta'minotchi: ${supplierName}\n`;
      formattedReceipt += `📅 Sana: ${formatDate(new Date())}\n`;
      formattedReceipt += `📥 Kiritish usuli: 📷 Rasm / Matnli Nakladnoy\n`;
      formattedReceipt += `-----------------------------\n`;

      if (invoiceData.table_text) {
        formattedReceipt += `${invoiceData.table_text}\n`;
      } else if (invoiceData.sampleItems && invoiceData.sampleItems.length > 0) {
        for (let idx = 0; idx < invoiceData.sampleItems.length; idx++) {
          formattedReceipt += `  ${idx + 1}. ${invoiceData.sampleItems[idx]}\n`;
        }
      } else if (invoiceData.items && invoiceData.items.length > 0) {
        for (let idx = 0; idx < invoiceData.items.length; idx++) {
          const item = invoiceData.items[idx];
          formattedReceipt += `${idx + 1}. ${item.productName} (${item.quantity} x ${formatMoney(item.unitPrice, 'UZS')}) - ${formatMoney(item.totalPrice, 'UZS')}\n`;
        }
      }
      formattedReceipt += `-----------------------------\n`;
      formattedReceipt += `💰 Jami summa: ${formatMoney(totalSum, 'UZS')}\n`;
      if (discountAmount > 0) {
        formattedReceipt += `🎁 Skidka: -${formatMoney(discountAmount, 'UZS')}\n`;
        formattedReceipt += `💵 Yakuniy summa: ${formatMoney(finalPayable, 'UZS')}\n`;
      }
      formattedReceipt += `📦 Ushbu amaliyotdan keyingi qarz: ${formatMoney(Number(supplier.debtUzs), 'UZS')}\n`;

      await tx.supplierTransaction.create({
        data: {
          supplierId: supplier.id,
          type: 'INCOMING_GOODS',
          amount: finalPayable,
          originalAmount: totalSum,
          discountAmount: discountAmount,
          currency: 'UZS',
          description: `Nakladnoy ${invoiceData.invoiceNo || ''}`.trim(),
          sourceType: 'PHOTO',
          photoFileId: pData.photoFileId || null,
          formattedReceipt: formattedReceipt,
          receiptData: invoiceData
        }
      });

    }, {
      maxWait: 10000,
      timeout: 30000
    });

    await ctx.editMessageText(`✅ Nakladnoy muvaffaqiyatli saqlandi! Ta'minotchiga qarz yozildi: ${formatMoney(finalPayable)}`);

    // Auto-cleanup: remove the heavy photo from chat
    if (userPhotoMsgId) {
      await safeDelete(ctx, ctx.chat?.id || 0, userPhotoMsgId);
    }

    ctx.session.step = undefined;

  } catch (error) {
    logger.error(error, 'Transaction error saving invoice');
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi. Qayta urinib ko\'ring.', show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^confirm_invcash_i_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });

  if (!pendingAction || pendingAction.type !== 'INVOICE') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.", { reply_markup: undefined }).catch(() => { });
  }

  // Pre-emptive deletion to prevent double-spending / race conditions
  await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });

  const pData = pendingAction.data as any;
  const userPhotoMsgId = pData.userPhotoMsgId;
  const invoiceData = pData.data;
  let totalSum = invoiceData.grossTotal || 0;
  if (!invoiceData.grossTotal && Array.isArray(invoiceData.items)) {
    invoiceData.items.forEach((i: any) => totalSum += (i.totalPrice || 0));
  }
  const supplierName = invoiceData.supplierName || 'Umumiy Ta\'minotchi';
  const discountAmount = invoiceData.discountAmount || 0;
  const finalPayable = totalSum - discountAmount;

  try {
    const itemsJson = JSON.stringify(invoiceData.items || invoiceData.sampleItems || []);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Create CashTransaction (Outflow)
      await tx.cashTransaction.create({
        data: {
          partyName: supplierName,
          amount: finalPayable,
          items: itemsJson,
          createdBy: ctx.user?.name || 'Bot'
        }
      });

      // Update DailyRegister for cashUzs (Naqd pul)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      let register = await tx.dailyRegister.findUnique({ where: { date: today } });
      if (!register) {
        register = await tx.dailyRegister.create({
          data: {
            date: today,
            cashUzs: -finalPayable // Naqd pul chiqib ketdi
          }
        });
      } else {
        await tx.dailyRegister.update({
          where: { id: register.id },
          data: { cashUzs: { decrement: finalPayable } }
        });
      }
    });

    await ctx.editMessageText(`✅ Naqd xarid saqlandi: ${supplierName} (${formatMoney(finalPayable)}). Bugungi naqd aylanmaga qo'shildi.`);

    // Auto-cleanup: remove the heavy photo from chat
    if (userPhotoMsgId) {
      await safeDelete(ctx, ctx.chat?.id || 0, userPhotoMsgId);
    }

    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
    ctx.session.step = undefined;

  } catch (error) {
    logger.error(error, 'Transaction error saving cash invoice');
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi. Qayta urinib ko\'ring.', show_alert: true });
  }
});

invoiceHandler.callbackQuery(/^cancel_i_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);

  if (pendingAction) {
    const pData = pendingAction.data as any;
    if (pData.userPhotoMsgId) {
      await safeDelete(ctx, ctx.chat?.id || 0, pData.userPhotoMsgId);
    }
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
  }

  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Nakladnoy bekor qilindi.');
});

// --- DISAMBIGUATION HANDLERS ---
invoiceHandler.callbackQuery(/^isel_idis_(.+)_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const supplierId = ctx.match[2];

  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });
  if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  }

  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");

  const pData = pendingAction.data as any;
  pData.data.exactSupplierId = supplier.id;
  pData.data.supplierName = supplier.name;

  await prisma.pendingAction.delete({ where: { id: pendingId } });
  await ctx.deleteMessage().catch(() => { });

  await processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
});

invoiceHandler.callbackQuery(/^inew_idis_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });

  if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  }

  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: {
      type: 'INVOICE_NEW_SUPP',
      status: 'AWAIT_NEW_SUPPLIER_NAME_INV'
    }
  });

  ctx.session.step = 'await_new_supplier_name_inv';
  ctx.session.tempData = { pendingId: pendingId };

  await ctx.editMessageText("Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):", { reply_markup: undefined });
});

invoiceHandler.callbackQuery(/^cancel_idis_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
  if (pendingAction) {
    const pData = pendingAction.data as any;
    if (pData.userPhotoMsgId) await safeDelete(ctx, ctx.chat?.id || 0, pData.userPhotoMsgId);
    await prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
  }
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Amaliyot bekor qilindi.', { reply_markup: undefined });
});

// --- DISCOUNT HANDLER ---
invoiceHandler.callbackQuery(/^add_discount_(.+)$/, async (ctx) => {
  const pendingId = ctx.match[1];
  const pendingAction = await prisma.pendingAction.findUnique({ where: { id: pendingId } });

  if (!pendingAction || pendingAction.type !== 'INVOICE') {
    return ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.", { reply_markup: undefined });
  }

  const botMessageId = ctx.callbackQuery.message?.message_id;

  const pData = pendingAction.data as any;
  pData.botMessageId = botMessageId;

  await prisma.pendingAction.update({
    where: { id: pendingId },
    data: {
      status: 'AWAIT_DISCOUNT',
      data: pData
    }
  });

  ctx.session.step = 'await_invoice_discount';
  ctx.session.tempData = { pendingId, botMessageId };

  await ctx.reply("🎁 Chegirma miqdorini kiriting:\n• Foizda: masalan, 5% yoki 3.5%\n• Aniq summada: masalan, 50000 yoki 50 ming");
});

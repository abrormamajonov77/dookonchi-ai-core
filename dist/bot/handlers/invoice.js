"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invoiceHandler = void 0;
const grammy_1 = require("grammy");
const ai_service_1 = require("../../services/ai.service");
const image_service_1 = require("../../services/image.service");
const inline_1 = require("../keyboards/inline");
const menu_1 = require("../keyboards/menu");
const logger_1 = require("../../config/logger");
const formatters_1 = require("../../utils/formatters");
const prisma_1 = require("../../database/prisma");
const translit_service_1 = require("../../services/translit.service");
const cache_service_1 = require("../../services/cache.service");
const telegram_1 = require("../../utils/telegram");
const supplier_service_1 = require("../../services/supplier.service");
exports.invoiceHandler = new grammy_1.Composer();
const CASH_REGEX = /naqd\s*pulga|naqdga|naqd|cash/i;
const EXPIRED_MSG = "⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.";
function buildEditableInvoiceText(invoiceData, includeMoreHint = false, modifiedLabel = false) {
    const name = invoiceData.supplierName || "Noma'lum";
    const header = modifiedLabel ? `🏢 Ta'minotchi: ${name} (O'zgartirildi)\n`
        : invoiceData.isCashOverride ? `🏢 Kimdan (Naqd): ${name}\n`
            : invoiceData.isCaptionOverride ? `Ta'minotchi: ${name} (Izohingiz orqali belgilandi)\n`
                : `Ta'minotchi: ${name}\n`;
    let editableText = `${header}Raqam: ${invoiceData.invoiceNo || "Yo'q"}\n\n`;
    let totalSum = invoiceData.total_amount ?? invoiceData.grossTotal ?? 0;
    if (invoiceData.sampleItems?.length > 0) {
        editableText += includeMoreHint ? `📦 Tovarlar (jami ${invoiceData.itemsCount || invoiceData.sampleItems.length} ta):\n` : `📦 Tovarlar:\n`;
        invoiceData.sampleItems.forEach((n, idx) => { editableText += `  ${idx + 1}. ${n}\n`; });
        if (includeMoreHint && invoiceData.itemsCount && invoiceData.itemsCount > invoiceData.sampleItems.length) {
            editableText += `  ... va yana ${invoiceData.itemsCount - invoiceData.sampleItems.length} xil tovar\n`;
        }
    }
    else if (invoiceData.items?.length > 0) {
        invoiceData.items.forEach((item, idx) => {
            editableText += `${idx + 1}. ${item.productName} - ${item.quantity} x ${item.unitPrice}\n`;
            if (!invoiceData.grossTotal)
                totalSum += item.totalPrice;
        });
    }
    return { editableText, totalSum };
}
async function processParsedInvoice(ctx, invoiceData, imageUrl, photoFileId, userPhotoMsgId, rawCaption) {
    if (!invoiceData.exactSupplierId && invoiceData.supplierName && invoiceData.supplierName !== "Noma'lum") {
        const candidates = await supplier_service_1.SupplierService.findMatchingSuppliers(invoiceData.supplierName, rawCaption);
        if (candidates.length === 1) {
            invoiceData.exactSupplierId = candidates[0].id;
            invoiceData.supplierName = candidates[0].name;
        }
        else if (candidates.length > 1) {
            const candidateIds = candidates.map(c => c.id);
            const pendingAction = await prisma_1.prisma.pendingAction.create({
                data: { type: 'INVOICE_DISAMBIGUATION', data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId, rawCaption, candidateIds } }
            });
            return ctx.reply(`⚠️ *Bir nechta ta'minotchi topildi:*\nNakladnoy qaysi "${invoiceData.supplierName}" hisobiga yozilsin?`, { parse_mode: 'Markdown', reply_markup: (0, inline_1.getDisambiguationKeyboard)(candidates, pendingAction.id, 'isel', 'inew', 'cancel_idis') });
        }
    }
    const pendingAction = await prisma_1.prisma.pendingAction.create({
        data: { userId: ctx.from?.id ? BigInt(ctx.from.id) : null, type: 'INVOICE', data: { data: invoiceData, imageUrl, photoFileId, userPhotoMsgId } }
    });
    const actionId = `i_${pendingAction.id}`;
    ctx.session.step = actionId;
    const { editableText, totalSum } = buildEditableInvoiceText(invoiceData, true);
    invoiceData.grossTotal = invoiceData.total_amount = totalSum;
    const discount = (invoiceData.discountAmount = invoiceData.discount = invoiceData.discount ?? invoiceData.discountAmount ?? 0);
    let text = `${invoiceData.isCashOverride ? '🧾 **Naqd Xarid Tahlili**' : '📄 **Nakladnoy Tahlili**'}\n\n\`\`\`\n${editableText}\`\`\`\n\n💰 Jami summa: ${(0, formatters_1.formatMoney)(totalSum)}\n`;
    if (discount > 0)
        text += `🎁 Skidka: -${(0, formatters_1.formatMoney)(discount)}\n💳 K оплате: ${(0, formatters_1.formatMoney)(invoiceData.netTotal || (totalSum - discount))}\n`;
    if (invoiceData.isCashOverride)
        text += `📦 Amal turi: 💵 Naqd xarid (Qarzga ta'sir qilmaydi)\n\n`;
    text += `_💡 Skidka yoki ta'minotchi nomini to'g'irlash uchun chatga yozib yuboring (masalan: "5%" yoki "Azamataka")_\n\nMa'lumotlar to'g'rimi?`;
    const sentMessage = await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: (0, inline_1.getInvoiceConfirmationKeyboard)(actionId, editableText) });
    await prisma_1.prisma.pendingAction.update({ where: { id: pendingAction.id }, data: { data: { ...pendingAction.data, botMessageId: sentMessage.message_id } } });
}
async function handleInvoiceImageUpload(ctx, fileId, mimeType, errLabel) {
    await (0, telegram_1.withChatAction)(ctx, 'upload_photo', async () => {
        try {
            const file = await ctx.api.getFile(fileId);
            if (!file.file_path)
                throw new Error('Rasm fayli topilmadi');
            const [buffer] = await Promise.all([(0, telegram_1.downloadTelegramFile)(file.file_path), cache_service_1.cacheService.getSupplierNames()]);
            const imageHash = image_service_1.ImageService.getImageHash(buffer);
            const [existing, processedBuffer] = await Promise.all([
                prisma_1.prisma.processedImage.findUnique({ where: { hash: imageHash } }).catch(() => null),
                image_service_1.ImageService.optimizeForFastOCR(buffer)
            ]);
            if (existing) {
                const d = existing.data;
                return ctx.reply(`⚠️ Ushbu nakladnoy allaqachon ro'yxatga olingan! (Sana: ${(0, formatters_1.formatDate)(existing.createdAt)}, Ta'minotchi: ${d.supplierName || "Noma'lum"}, Summa: ${(0, formatters_1.formatMoney)(d.grossTotal || 0)})`);
            }
            const caption = ctx.message?.caption?.trim() || '';
            const invoiceData = await ai_service_1.AiService.parseInvoiceImage(processedBuffer, mimeType, caption);
            prisma_1.prisma.processedImage.create({ data: { hash: imageHash, data: invoiceData } }).catch(() => { });
            if (caption) {
                invoiceData.isCaptionOverride = true;
                invoiceData.isCashOverride = CASH_REGEX.test(caption);
                invoiceData.supplierName = invoiceData.isCashOverride ? (caption.replace(CASH_REGEX, '').trim() || "Noma'lum") : caption;
            }
            await processParsedInvoice(ctx, invoiceData, file.file_path, fileId, ctx.message.message_id, caption);
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Error parsing invoice');
            await ctx.reply(`❌ Xatolik yuz berdi. ${errLabel} o'qish imkoni bo'lmadi.\n\nSabab: ${(0, telegram_1.formatFriendlyError)(error)}`);
            (0, telegram_1.clearSession)(ctx);
        }
    });
}
exports.invoiceHandler.on('message:photo', async (ctx) => {
    if (!ctx.user)
        return;
    const photo = ctx.message.photo.pop();
    if (photo)
        await handleInvoiceImageUpload(ctx, photo.file_id, 'image/jpeg', 'Nakladnoyni');
});
exports.invoiceHandler.on('message:document', async (ctx, next) => {
    if (!ctx.user || !ctx.message.document.mime_type?.startsWith('image/'))
        return next();
    await handleInvoiceImageUpload(ctx, ctx.message.document.file_id, ctx.message.document.mime_type, 'Nakladnoy hujjatini');
});
exports.invoiceHandler.hears('➕ Nakladnoy', (ctx) => ctx.reply('📷 Iltimos, nakladnoy chekining rasmini (yoki hujjat shaklida) yuboring. AI uni avtomatik tahlil qiladi.'));
exports.invoiceHandler.on('message:text', async (ctx, next) => {
    if (!ctx.user || ctx.message.text.startsWith('/'))
        return next();
    const rawText = ctx.message.text.trim();
    if ((0, menu_1.isMenuButton)(rawText) || (ctx.session.step && ctx.session.step !== 'await_invoice_discount' && ctx.session.step !== 'await_new_supplier_name_inv'))
        return next();
    const activePending = await prisma_1.prisma.pendingAction.findFirst({
        where: {
            userId: ctx.from?.id ? BigInt(ctx.from.id) : undefined,
            type: { in: ['INVOICE', 'INVOICE_NEW_SUPP'] },
            status: { in: ['PENDING', 'AWAIT_DISCOUNT', 'AWAIT_NEW_SUPPLIER_NAME_INV'] },
            createdAt: { gte: new Date(Date.now() - 3600000) }
        },
        orderBy: { createdAt: 'desc' }
    });
    if (activePending) {
        const pData = activePending.data;
        if (activePending.status === 'AWAIT_NEW_SUPPLIER_NAME_INV') {
            pData.data.exactSupplierId = 'CREATE_NEW';
            pData.data.supplierName = rawText;
            await prisma_1.prisma.pendingAction.delete({ where: { id: activePending.id } });
            (0, telegram_1.clearSession)(ctx);
            return processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
        }
        if (activePending.status === 'AWAIT_DISCOUNT' || (activePending.type === 'INVOICE' && activePending.status === 'PENDING')) {
            const pendingId = activePending.id;
            const invoiceData = pData.data;
            let totalSum = invoiceData.grossTotal || 0;
            if (!invoiceData.grossTotal && invoiceData.items)
                invoiceData.items.forEach((i) => (totalSum += i.totalPrice));
            const percentMatch = rawText.match(/(\d+(?:[.,]\d+)?)\s*%/);
            const fixedMatch = rawText.match(/^(\d[\d\s]*)(?:\s*(?:ming|k|sum|so'm|skidka))?$/i);
            let discountAmount = 0, matchedDiscount = false;
            if (percentMatch) {
                discountAmount = totalSum * (parseFloat(percentMatch[1].replace(',', '.')) / 100);
                matchedDiscount = true;
            }
            else if (fixedMatch) {
                const val = parseFloat(rawText.replace(/[^\d.,]/g, '').replace(',', '.')) * (/ming|k/i.test(rawText) ? 1000 : 1);
                if (!isNaN(val) && val > 0 && val < totalSum)
                    [discountAmount, matchedDiscount] = [val, true];
            }
            const updatePreviewMessage = async (txt, finalAmt) => {
                const kb = (0, inline_1.getDiscountConfirmationKeyboard)(`i_${pendingId}`, finalAmt, !!invoiceData.isCashOverride);
                if (pData.botMessageId) {
                    await ctx.api.editMessageText(ctx.chat?.id || 0, pData.botMessageId, txt, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => { });
                }
                else {
                    pData.botMessageId = (await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb })).message_id;
                    await prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } });
                }
            };
            if (matchedDiscount || activePending.status === 'AWAIT_DISCOUNT') {
                if (!matchedDiscount && rawText.length > 0) {
                    const numStr = rawText.replace(/[^\d.,]/g, '').replace(',', '.');
                    if (numStr)
                        discountAmount = parseFloat(numStr) * (/ming/i.test(rawText) ? 1000 : 1);
                }
                discountAmount = Math.max(0, Math.min(isNaN(discountAmount) ? 0 : discountAmount, totalSum));
                invoiceData.discountAmount = discountAmount;
                invoiceData.discountLabel = rawText;
                await Promise.all([
                    prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
                    (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.message.message_id)
                ]);
                const finalPayable = totalSum - discountAmount;
                const { editableText } = buildEditableInvoiceText(invoiceData);
                const title = invoiceData.isCashOverride ? '🧾 **Naqd Xarid Tahlili (Yangilandi)**' : '📄 **Nakladnoy Tahlili (Yangilandi)**';
                await updatePreviewMessage(`${title}\n\n\`\`\`\n${editableText}\`\`\`\n📊 Tovarlar jami: ${(0, formatters_1.formatMoney)(totalSum)}\n🎁 Skidka (${rawText}): -${(0, formatters_1.formatMoney)(discountAmount)}\n--------------------------------\n💰 Yakuniy ${invoiceData.isCashOverride ? 'summa' : 'qarzga yoziladi'}: ${(0, formatters_1.formatMoney)(finalPayable)}\n`, finalPayable);
                (0, telegram_1.clearSession)(ctx);
                return;
            }
            if (activePending.status === 'PENDING' && rawText.length > 2) {
                invoiceData.supplierName = rawText;
                invoiceData.isCaptionOverride = true;
                await Promise.all([
                    prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } }),
                    (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.message.message_id)
                ]);
                const { editableText } = buildEditableInvoiceText(invoiceData, false, true);
                const title = invoiceData.isCashOverride ? '🧾 **Naqd Xarid Tahlili**' : '📄 **Nakladnoy Tahlili**';
                let txt = `${title}\n\n\`\`\`\n${editableText}\`\`\`\n💰 Umumiy summa: ${(0, formatters_1.formatMoney)(totalSum)}\n`;
                if (invoiceData.discountAmount)
                    txt += `🎁 Skidka: -${(0, formatters_1.formatMoney)(invoiceData.discountAmount)}\n💳 Yakuniy: ${(0, formatters_1.formatMoney)(totalSum - invoiceData.discountAmount)}\n`;
                await updatePreviewMessage(`${txt}\nMa'lumotlar to'g'rimi?`, totalSum - (invoiceData.discountAmount || 0));
                return;
            }
        }
    }
    const cleanText = ctx.message.text.replace(/^@\w+\s+/, '').trim();
    if (/^ta'?minotchi:/i.test(cleanText) || cleanText.includes('Raqam:')) {
        return (0, telegram_1.withChatAction)(ctx, 'typing', async () => {
            try {
                const invoiceData = await ai_service_1.AiService.parseInvoiceText(cleanText);
                if (CASH_REGEX.test(cleanText)) {
                    invoiceData.isCashOverride = true;
                    invoiceData.supplierName = invoiceData.supplierName?.replace(CASH_REGEX, '').trim() || "Noma'lum";
                }
                await processParsedInvoice(ctx, invoiceData, '', null, null, cleanText);
            }
            catch (error) {
                logger_1.logger.error({ error }, 'Error parsing edited invoice');
                await ctx.reply(`❌ Xatolik yuz berdi. Tahrirlangan matnni o'qish imkoni bo'lmadi.\n\nSabab: ${(0, telegram_1.formatFriendlyError)(error)}`);
            }
        });
    }
    return next();
});
const extractPendingInvoice = async (ctx, pendingId) => {
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } });
    if (!pendingAction || pendingAction.type !== 'INVOICE') {
        await ctx.editMessageText("⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.", { reply_markup: undefined }).catch(() => { });
        return null;
    }
    await prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
    const pData = pendingAction.data;
    const invoiceData = pData.data;
    let totalSum = invoiceData.grossTotal || 0;
    if (!invoiceData.grossTotal && Array.isArray(invoiceData.items))
        invoiceData.items.forEach((i) => (totalSum += i.totalPrice || 0));
    const discountAmount = invoiceData.discountAmount || 0;
    return { pData, invoiceData, totalSum, discountAmount, finalPayable: totalSum - discountAmount, supplierName: invoiceData.supplierName || "Umumiy Ta'minotchi" };
};
exports.invoiceHandler.callbackQuery(/^confirm_invdebt_i_(.+)$/, async (ctx) => {
    const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
    if (!extracted)
        return;
    const { pData, invoiceData, totalSum, discountAmount, finalPayable, supplierName } = extracted;
    try {
        let finalDebt = 0;
        await prisma_1.prisma.$transaction(async (tx) => {
            let supplier = invoiceData.exactSupplierId && invoiceData.exactSupplierId !== 'CREATE_NEW'
                ? await tx.supplier.findUnique({ where: { id: invoiceData.exactSupplierId } })
                : null;
            if (!supplier) {
                const found = await tx.supplier.findUnique({ where: { name: supplierName } });
                supplier = found
                    ? await tx.supplier.update({ where: { id: found.id }, data: { debtUzs: { increment: finalPayable } } })
                    : await tx.supplier.create({ data: { name: supplierName, debtUzs: finalPayable } });
            }
            else {
                supplier = await tx.supplier.update({ where: { id: supplier.id }, data: { debtUzs: { increment: finalPayable } } });
            }
            finalDebt = Number(supplier.debtUzs);
            const invoice = await tx.invoice.create({
                data: { supplierId: supplier.id, invoiceNo: invoiceData.invoiceNo, totalAmount: finalPayable, originalAmount: totalSum, discountAmount, currency: 'UZS' }
            });
            const itemsList = Array.isArray(invoiceData.items) ? invoiceData.items : [];
            if (itemsList.length > 0) {
                const resolvedProducts = await Promise.all(itemsList.map(async (item) => {
                    const searchTokens = translit_service_1.TranslitService.generateSearchTokens(item.productName);
                    const foundProd = await tx.product.findFirst({
                        where: { searchTokens: { contains: translit_service_1.TranslitService.toLatin(item.productName).toLowerCase() } },
                        select: { id: true }
                    });
                    const product = foundProd
                        ? await tx.product.update({ where: { id: foundProd.id }, data: { lastPrice: item.unitPrice }, select: { id: true } })
                        : await tx.product.create({ data: { name: item.productName, searchTokens, lastPrice: item.unitPrice }, select: { id: true } });
                    return { invoiceId: invoice.id, productId: product.id, quantity: item.quantity, unitPrice: item.unitPrice, totalPrice: item.totalPrice };
                }));
                await tx.invoiceItem.createMany({ data: resolvedProducts });
            }
            const receiptBody = invoiceData.table_text ? `${invoiceData.table_text}\n`
                : invoiceData.sampleItems?.length > 0 ? `${invoiceData.sampleItems.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n`
                    : itemsList.length > 0 ? `${itemsList.map((it, i) => `${i + 1}. ${it.productName} (${it.quantity} x ${(0, formatters_1.formatMoney)(it.unitPrice, 'UZS')}) - ${(0, formatters_1.formatMoney)(it.totalPrice, 'UZS')}`).join('\n')}\n`
                        : '';
            let formattedReceipt = `🧾 ELEKTRON NAKLADNOY\n🏢 Ta'minotchi: ${supplierName}\n📅 Sana: ${(0, formatters_1.formatDate)(new Date())}\n📥 Kiritish usuli: 📷 Rasm / Matnli Nakladnoy\n-----------------------------\n${receiptBody}-----------------------------\n💰 Jami summa: ${(0, formatters_1.formatMoney)(totalSum, 'UZS')}\n`;
            if (discountAmount > 0)
                formattedReceipt += `🎁 Skidka: -${(0, formatters_1.formatMoney)(discountAmount, 'UZS')}\n💵 Yakuniy summa: ${(0, formatters_1.formatMoney)(finalPayable, 'UZS')}\n`;
            formattedReceipt += `📦 Ushbu amaliyotdan keyingi qarz: ${(0, formatters_1.formatMoney)(Number(supplier.debtUzs), 'UZS')}\n`;
            await tx.supplierTransaction.create({
                data: { supplierId: supplier.id, type: 'INCOMING_GOODS', amount: finalPayable, originalAmount: totalSum, discountAmount, currency: 'UZS', description: `Nakladnoy ${invoiceData.invoiceNo || ''}`.trim(), sourceType: 'PHOTO', photoFileId: pData.photoFileId || null, formattedReceipt, receiptData: invoiceData }
            });
        }, { maxWait: 10000, timeout: 30000 });
        await Promise.all([
            ctx.editMessageText(`✅ Nakladnoy muvaffaqiyatli saqlandi!\n\n` +
                `🏢 Ta'minotchi: **${supplierName}**\n` +
                `📥 Yangi kirim: **+${(0, formatters_1.formatMoney)(finalPayable)}**\n` +
                `📊 **Yakuniy qarz qoldig'i:** **${(0, formatters_1.formatMoney)(finalDebt)}**`, { parse_mode: 'Markdown' }),
            (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, pData.userPhotoMsgId)
        ]);
        ctx.session.step = undefined;
    }
    catch (error) {
        logger_1.logger.error(error, 'Transaction error saving invoice');
        await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi. Qayta urinib ko'ring.", show_alert: true });
    }
});
exports.invoiceHandler.callbackQuery(/^confirm_invcash_i_(.+)$/, async (ctx) => {
    const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
    if (!extracted)
        return;
    const { pData, invoiceData, finalPayable, supplierName } = extracted;
    try {
        const today = (0, formatters_1.getToday)();
        await prisma_1.prisma.$transaction([
            prisma_1.prisma.cashTransaction.create({ data: { partyName: supplierName, amount: finalPayable, items: JSON.stringify(invoiceData.items || invoiceData.sampleItems || []), createdBy: ctx.user?.name || 'Bot' } }),
            prisma_1.prisma.dailyRegister.upsert({ where: { date: today }, create: { date: today, cashUzs: -finalPayable }, update: { cashUzs: { decrement: finalPayable } } })
        ]);
        await Promise.all([
            ctx.editMessageText(`✅ Naqd xarid saqlandi: ${supplierName} (${(0, formatters_1.formatMoney)(finalPayable)}). Bugungi naqd aylanmaga qo'shildi.`),
            (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, pData.userPhotoMsgId)
        ]);
        ctx.session.step = undefined;
    }
    catch (error) {
        logger_1.logger.error(error, 'Transaction error saving cash invoice');
        await ctx.answerCallbackQuery({ text: "Xatolik yuz berdi. Qayta urinib ko'ring.", show_alert: true });
    }
});
exports.invoiceHandler.callbackQuery(/^cancel_(?:i|idis)_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
    if (pendingAction) {
        await Promise.all([
            (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, pendingAction.data?.userPhotoMsgId),
            prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { })
        ]);
    }
    ctx.session.step = undefined;
    await ctx.editMessageText('❌ Nakladnoy bekor qilindi.', { reply_markup: undefined });
});
exports.invoiceHandler.callbackQuery(/^isel_(.+)_(\d+)$/, async (ctx) => {
    const [, pendingId, rawIdx] = ctx.match;
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } });
    if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    const pData = pendingAction.data;
    const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
    const supplier = supplierId ? await prisma_1.prisma.supplier.findUnique({ where: { id: supplierId } }) : null;
    if (!supplier)
        return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    pData.data.exactSupplierId = supplier.id;
    pData.data.supplierName = supplier.name;
    await Promise.all([prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }), ctx.deleteMessage().catch(() => { })]);
    await processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
});
exports.invoiceHandler.callbackQuery(/^inew_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } });
    if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    await prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { type: 'INVOICE_NEW_SUPP', status: 'AWAIT_NEW_SUPPLIER_NAME_INV' } });
    ctx.session.step = 'await_new_supplier_name_inv';
    ctx.session.tempData = { pendingId };
    await ctx.editMessageText("Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):", { reply_markup: undefined });
});
exports.invoiceHandler.callbackQuery(/^add_discount_(?:i_)?(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } });
    if (!pendingAction || pendingAction.type !== 'INVOICE')
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    const botMessageId = ctx.callbackQuery.message?.message_id;
    await prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { status: 'AWAIT_DISCOUNT', data: { ...pendingAction.data, botMessageId } } });
    ctx.session.step = 'await_invoice_discount';
    ctx.session.tempData = { pendingId, botMessageId };
    await ctx.reply('🎁 Chegirma miqdorini kiriting:\n• Foizda: masalan, 5% yoki 3.5%\n• Aniq summada: masalan, 50000 yoki 50 ming');
});

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invoiceHandler = void 0;
exports.buildEditableInvoiceText = buildEditableInvoiceText;
exports.buildPendingPreviewMessage = buildPendingPreviewMessage;
const grammy_1 = require("grammy");
const ai_service_1 = require("../../services/ai.service");
const image_service_1 = require("../../services/image.service");
const inline_1 = require("../keyboards/inline");
const menu_1 = require("../keyboards/menu");
const logger_1 = require("../../config/logger");
const formatters_1 = require("../../utils/formatters");
const prisma_1 = require("../../database/prisma");
const cache_service_1 = require("../../services/cache.service");
const telegram_1 = require("../../utils/telegram");
const supplier_service_1 = require("../../services/supplier.service");
const transliterate_1 = require("../../utils/transliterate");
const local_parser_1 = require("../../utils/local-parser");
exports.invoiceHandler = new grammy_1.Composer();
const CASH_REGEX = /naqd\s*pulga|naqdga|naqd|naqt|cash/i;
const EXPIRED_MSG = '⚠️ Ushbu operatsiya muddati tugagan. Iltimos, boshqatdan yuboring.';
function buildEditableInvoiceText(invoiceData, _includeMoreHint = false, modifiedLabel = false) {
    const name = (0, transliterate_1.toLatinUz)(invoiceData.supplierName || invoiceData.supplier || "Noma'lum");
    const currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
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
    }
    else if (Array.isArray(invoiceData.items) && invoiceData.items.length > 0) {
        editableText += `${(0, ai_service_1.buildVerbatimTableText)(invoiceData.items, currency)}\n`;
        if (!totalSum) {
            totalSum = invoiceData.items.reduce((acc, it) => acc + Number(it.lineTotal ?? it.totalPrice ?? 0), 0);
        }
    }
    else if (invoiceData.table_text && String(invoiceData.table_text).trim()) {
        editableText += `${invoiceData.table_text}\n`;
    }
    return { editableText, totalSum: Number(totalSum.toFixed(2)) };
}
function buildPendingPreviewMessage(invoiceData, editableText) {
    const currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
    const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
    const discount = Number(invoiceData.discountAmount ?? invoiceData.discount ?? 0);
    const math = (0, formatters_1.reconcileInvoiceTotals)({
        rows: invoiceData.items || invoiceData.rows,
        subtotalBeforeDiscount: rawTotal,
        discountPercent: invoiceData.discountPercent,
        discountAmount: discount,
        printedFinalTotal: invoiceData.finalTotal ?? invoiceData.printedFinalTotal,
    });
    const percentText = invoiceData.discountLabel ||
        (math.discountPercent && Number(math.discountPercent) > 0 ? `${math.discountPercent}%` : '');
    const title = invoiceData.isCashOverride
        ? '🧾 **Naqd Xarid Tahlili (100% Kserokopiya)**'
        : '📄 **Nakladnoy Tahlili (100% Kserokopiya)**';
    const safeCodeBlock = String(editableText || '')
        .replace(/```/g, "'''")
        .slice(0, 3200);
    let text = `${title}\n\n\`\`\`\n${safeCodeBlock}\`\`\`\n`;
    text += `💱 Valyuta: **${currency === 'USD' ? 'USD ($)' : "UZS (so'm)"}**\n`;
    text += `📦 Tovarlarning asl summasi: **${(0, formatters_1.formatCurrency)(math.rawTotal, currency)}**\n`;
    if (math.discountAmount > 0) {
        const label = percentText ? ` (${(0, telegram_1.sanitizeMdV1)(percentText)})` : '';
        text += `🏷 Skidka${label}: **-${(0, formatters_1.formatCurrency)(math.discountAmount, currency)}**\n`;
    }
    else {
        text += `🏷 Skidka: **0**\n`;
    }
    text += `💰 Skidkadan keyingi yakuniy summa (Itogo): **${(0, formatters_1.formatCurrency)(math.finalTotal, currency)}**\n`;
    if (invoiceData.isCashOverride) {
        text += `📦 Amal turi: 💵 Naqd xarid (Qarzga ta'sir qilmaydi)\n`;
    }
    text += `\n_💡 Skidka yoki ta'minotchi nomini to'g'rilash uchun pastdagi tugmalardan foydalaning yoki chatga yozing_\n\nMa'lumotlar to'g'rimi?`;
    return text;
}
async function processParsedInvoice(ctx, invoiceData, imageUrl, photoFileId, userPhotoMsgId, rawCaption, statusMsgId) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    if (invoiceData.supplierName) {
        invoiceData.supplierName = (0, transliterate_1.toLatinUz)(invoiceData.supplierName).trim();
    }
    if (!invoiceData.exactSupplierId && invoiceData.supplierName && invoiceData.supplierName !== "Noma'lum") {
        const fuzzyCheck = await supplier_service_1.SupplierService.findOrSuggestSupplier(invoiceData.supplierName, ownerId);
        if (fuzzyCheck.isExactMatch && fuzzyCheck.supplier) {
            invoiceData.exactSupplierId = fuzzyCheck.supplier.id;
            invoiceData.supplierName = fuzzyCheck.supplier.name;
        }
        else if (fuzzyCheck.isFuzzyMatch && fuzzyCheck.suggestedSupplier && fuzzyCheck.promptText) {
            const pendingAction = await prisma_1.prisma.pendingAction.create({
                data: {
                    userId: BigInt(ctx.from.id),
                    type: 'INVOICE_DISAMBIGUATION',
                    data: {
                        ownerId,
                        data: invoiceData,
                        imageUrl,
                        photoFileId,
                        userPhotoMsgId,
                        rawCaption,
                        suggestedSupplierId: fuzzyCheck.suggestedSupplier.id,
                        candidateIds: [fuzzyCheck.suggestedSupplier.id],
                    },
                },
            });
            const fuzzyKb = (0, inline_1.getFuzzySupplierSuggestionKeyboard)(fuzzyCheck.suggestedSupplier.id, fuzzyCheck.suggestedSupplier.name, fuzzyCheck.inputName, `inv_${pendingAction.id}`);
            if (statusMsgId && ctx.chat?.id) {
                return ctx.api
                    .editMessageText(ctx.chat.id, statusMsgId, fuzzyCheck.promptText, { reply_markup: fuzzyKb })
                    .catch(() => ctx.reply(fuzzyCheck.promptText, { reply_markup: fuzzyKb }));
            }
            return ctx.reply(fuzzyCheck.promptText, { reply_markup: fuzzyKb });
        }
        else {
            const candidates = await supplier_service_1.SupplierService.findMatchingSuppliers(invoiceData.supplierName, rawCaption, ownerId);
            if (candidates.length === 1) {
                invoiceData.exactSupplierId = candidates[0].id;
                invoiceData.supplierName = candidates[0].name;
            }
            else if (candidates.length > 1) {
                const candidateIds = candidates.map((c) => c.id);
                const pendingAction = await prisma_1.prisma.pendingAction.create({
                    data: {
                        userId: BigInt(ctx.from.id),
                        type: 'INVOICE_DISAMBIGUATION',
                        data: { ownerId, data: invoiceData, imageUrl, photoFileId, userPhotoMsgId, rawCaption, candidateIds },
                    },
                });
                const disText = `⚠️ *Bir nechta ta'minotchi topildi:*\nNakladnoy qaysi "${(0, telegram_1.sanitizeMdV1)(invoiceData.supplierName)}" hisobiga yozilsin?`;
                const disKb = (0, inline_1.getDisambiguationKeyboard)(candidates, pendingAction.id, 'isel', 'inew', 'cancel_idis');
                if (statusMsgId && ctx.chat?.id) {
                    return (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, statusMsgId, disText, {
                        parse_mode: 'Markdown',
                        reply_markup: disKb,
                    }).catch(() => (0, telegram_1.safeReply)(ctx, disText, { parse_mode: 'Markdown', reply_markup: disKb }));
                }
                return (0, telegram_1.safeReply)(ctx, disText, { parse_mode: 'Markdown', reply_markup: disKb });
            }
        }
    }
    const { editableText, totalSum } = buildEditableInvoiceText(invoiceData, false);
    const math = (0, formatters_1.reconcileInvoiceTotals)({
        rows: invoiceData.items || invoiceData.rows,
        subtotalBeforeDiscount: totalSum,
        discountPercent: invoiceData.discountPercent,
        discountAmount: invoiceData.discountAmount ?? invoiceData.discount ?? 0,
        printedFinalTotal: invoiceData.finalTotal ?? invoiceData.printedFinalTotal,
    });
    invoiceData.rawTotal = invoiceData.grossTotal = invoiceData.total_amount = math.rawTotal;
    invoiceData.discountAmount = invoiceData.discount = math.discountAmount;
    invoiceData.finalTotal = invoiceData.netTotal = math.finalTotal;
    invoiceData.currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
    const contentFingerprint = supplier_service_1.SupplierService.computeContentFingerprint({
        ownerId,
        supplierName: invoiceData.supplierName || "Noma'lum",
        currency: invoiceData.currency,
        finalTotal: math.finalTotal,
        items: Array.isArray(invoiceData.items) ? invoiceData.items : [],
    });
    invoiceData.contentFingerprint = contentFingerprint;
    // MODUL 6: Stage 2 Anti-Duplicate Content Fingerprint check isolated by ownerId
    if (!invoiceData.forceOverrideDuplicate) {
        const dupCheck = await supplier_service_1.SupplierService.checkDuplicateInvoice({
            ownerId,
            imageHash: invoiceData.imageHash || null,
            contentFingerprint,
        });
        if (dupCheck.isDuplicate && dupCheck.warningText) {
            const pendingAction = await prisma_1.prisma.pendingAction.create({
                data: {
                    userId: BigInt(ctx.from.id),
                    type: 'INVOICE',
                    data: { ownerId, data: invoiceData, imageUrl, photoFileId, userPhotoMsgId },
                },
            });
            const dupKb = (0, inline_1.getDuplicateInvoiceWarningKeyboard)(pendingAction.id);
            if (statusMsgId && ctx.chat?.id) {
                return ctx.api
                    .editMessageText(ctx.chat.id, statusMsgId, dupCheck.warningText, { reply_markup: dupKb })
                    .catch(() => ctx.reply(dupCheck.warningText, { reply_markup: dupKb }));
            }
            return ctx.reply(dupCheck.warningText, { reply_markup: dupKb });
        }
    }
    const pendingAction = await prisma_1.prisma.pendingAction.create({
        data: {
            userId: BigInt(ctx.from.id),
            type: 'INVOICE',
            data: { ownerId, data: invoiceData, imageUrl, photoFileId, userPhotoMsgId },
        },
    });
    const actionId = `i_${pendingAction.id}`;
    ctx.session.step = actionId;
    const text = buildPendingPreviewMessage(invoiceData, editableText);
    const kb = (0, inline_1.getInvoiceConfirmationKeyboard)(actionId, editableText, invoiceData.currency);
    let botMessageId = statusMsgId;
    if (statusMsgId && ctx.chat?.id) {
        await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, statusMsgId, text, {
            parse_mode: 'Markdown',
            reply_markup: kb,
        }).catch(async () => {
            const sent = await (0, telegram_1.safeReply)(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
            botMessageId = sent.message_id;
        });
    }
    else {
        const sentMessage = await (0, telegram_1.safeReply)(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
        botMessageId = sentMessage.message_id;
    }
    await prisma_1.prisma.pendingAction.update({
        where: { id: pendingAction.id },
        data: { data: { ...pendingAction.data, botMessageId } },
    });
}
async function handleInvoiceImageUpload(ctx, fileId, _mimeType, errLabel) {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    await (0, telegram_1.withChatAction)(ctx, 'upload_photo', async () => {
        const statusMsg = await ctx.reply('⚡️ Nakladnoy kserokopiya qilinmoqda...').catch(() => null);
        try {
            const file = await ctx.api.getFile(fileId);
            if (!file.file_path)
                throw new Error('Rasm fayli topilmadi');
            const [buffer] = await Promise.all([
                (0, telegram_1.downloadTelegramFile)(file.file_path),
                cache_service_1.cacheService.getSupplierNames(ownerId),
            ]);
            // MODUL 4: High-contrast B&W scanner buffer (<60 KB in <150 ms)
            const processedBuffer = await image_service_1.ImageService.optimizeForFastOCR(buffer);
            const imageHash = image_service_1.ImageService.getImageHash(processedBuffer);
            // MODUL 6: Stage 1 ImageHash check before calling AI (isolated by ownerId)
            const stage1Dup = await supplier_service_1.SupplierService.checkDuplicateInvoice({ ownerId, imageHash });
            if (stage1Dup.isDuplicate && stage1Dup.warningText && stage1Dup.existingInvoice) {
                const dupInvoiceData = {
                    supplierName: stage1Dup.existingInvoice.supplier?.name || "Noma'lum",
                    exactSupplierId: stage1Dup.existingInvoice.supplierId,
                    invoiceNo: stage1Dup.existingInvoice.invoiceNo,
                    rawTotal: Number(stage1Dup.existingInvoice.originalAmount ?? stage1Dup.existingInvoice.totalAmount),
                    discountAmount: Number(stage1Dup.existingInvoice.discountAmount ?? 0),
                    finalTotal: Number(stage1Dup.existingInvoice.totalAmount),
                    currency: stage1Dup.existingInvoice.currency,
                    verbatimText: stage1Dup.existingInvoice.verbatimText || '',
                    imageHash,
                    forceOverrideDuplicate: true,
                };
                const pendingAction = await prisma_1.prisma.pendingAction.create({
                    data: {
                        userId: BigInt(ctx.from.id),
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
                const dupKb = (0, inline_1.getDuplicateInvoiceWarningKeyboard)(pendingAction.id);
                if (statusMsg && ctx.chat?.id) {
                    await ctx.api
                        .editMessageText(ctx.chat.id, statusMsg.message_id, stage1Dup.warningText, { reply_markup: dupKb })
                        .catch(() => ctx.reply(stage1Dup.warningText, { reply_markup: dupKb }));
                }
                else {
                    await ctx.reply(stage1Dup.warningText, { reply_markup: dupKb });
                }
                return;
            }
            const caption = ctx.message?.caption?.trim() || '';
            const invoiceData = await ai_service_1.AiService.parseInvoiceImage(processedBuffer, 'image/jpeg', caption);
            invoiceData.imageHash = imageHash;
            if (caption) {
                invoiceData.isCaptionOverride = true;
                invoiceData.isCashOverride = CASH_REGEX.test(caption);
                const parsedCap = (0, formatters_1.parseCurrencyAndAmount)(caption);
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
            await processParsedInvoice(ctx, invoiceData, file.file_path, fileId, ctx.message.message_id, caption, statusMsg?.message_id);
        }
        catch (error) {
            logger_1.logger.error({ error }, 'Error parsing invoice');
            const errText = `❌ Xatolik yuz berdi. ${errLabel} o'qish imkoni bo'lmadi.\n\nSabab: ${(0, telegram_1.formatFriendlyError)(error)}`;
            if (statusMsg && ctx.chat?.id) {
                await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, errText).catch(() => ctx.reply(errText));
            }
            else {
                await ctx.reply(errText);
            }
            (0, telegram_1.clearSession)(ctx);
        }
    });
}
exports.invoiceHandler.on('message:photo', async (ctx) => {
    if (!ctx.user)
        return;
    (0, telegram_1.clearSession)(ctx);
    const photos = ctx.message.photo;
    const photo = photos[Math.min(photos.length - 1, 2)];
    if (photo)
        await handleInvoiceImageUpload(ctx, photo.file_id, 'image/jpeg', 'Nakladnoyni');
});
exports.invoiceHandler.on('message:document', async (ctx, next) => {
    if (!ctx.user || !ctx.message.document.mime_type?.startsWith('image/'))
        return next();
    (0, telegram_1.clearSession)(ctx);
    await handleInvoiceImageUpload(ctx, ctx.message.document.file_id, ctx.message.document.mime_type, 'Nakladnoy hujjatini');
});
exports.invoiceHandler.hears('➕ Nakladnoy', (ctx) => {
    (0, telegram_1.clearSession)(ctx);
    return ctx.reply('📷 Iltimos, nakladnoy chekining rasmini (yoki hujjat shaklida) yuboring. AI uni 100% kserokopiya shaklida tahlil qiladi.');
});
exports.invoiceHandler.callbackQuery(/^(?:edit_invoice_discount:|add_discount_(?:i_)?)(.+)$/, async (ctx) => {
    const rawId = ctx.match[1];
    const isPending = rawId.startsWith('p_') || !(await prisma_1.prisma.invoice.findUnique({ where: { id: rawId } }).catch(() => null));
    const cleanId = rawId.replace(/^p_/, '');
    if (isPending) {
        const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null);
        if (pendingAction && pendingAction.type === 'INVOICE') {
            const botMessageId = ctx.callbackQuery.message?.message_id;
            await prisma_1.prisma.pendingAction.update({
                where: { id: cleanId },
                data: { status: 'AWAIT_DISCOUNT', data: { ...pendingAction.data, botMessageId } },
            });
            ctx.session.step = 'await_invoice_discount';
            ctx.session.tempData = { pendingId: cleanId, botMessageId };
            return ctx.reply('🏷 **Chegirma (Skidka) miqdorini kiriting:**\n• Foizda: masalan, `5%` yoki `10%`\n• Summada: masalan, `15000`, `50 ming` yoki `$12.50`', { parse_mode: 'Markdown' });
        }
    }
    ctx.session.step = 'AWAIT_SAVED_INVOICE_DISCOUNT';
    ctx.session.tempData = { invoiceId: cleanId, botMessageId: ctx.callbackQuery.message?.message_id };
    await ctx.reply('🏷 **Saqlangan nakladnoy uchun chegirma (skidka) miqdorini kiriting:**\n• Foizda: masalan, `5%` yoki `10%`\n• Summada: masalan, `15000` yoki `$12.50`', { parse_mode: 'Markdown' });
});
exports.invoiceHandler.callbackQuery(/^edit_invoice_total:(.+)$/, async (ctx) => {
    const rawId = ctx.match[1];
    const cleanId = rawId.replace(/^p_/, '');
    const pendingAction = rawId.startsWith('p_')
        ? await prisma_1.prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null)
        : null;
    if (pendingAction && pendingAction.type === 'INVOICE') {
        const botMessageId = ctx.callbackQuery.message?.message_id;
        await prisma_1.prisma.pendingAction.update({
            where: { id: cleanId },
            data: { status: 'AWAIT_MANUAL_TOTAL', data: { ...pendingAction.data, botMessageId } },
        });
        ctx.session.step = 'await_invoice_manual_total';
        ctx.session.tempData = { pendingId: cleanId, botMessageId };
        return ctx.reply("✏️ **Umumiy summani qo'lda kiriting:**\n" +
            "• Faqat yakuniy summa: masalan `880000` yoki `$102.17`\n" +
            "• Yoki Asl summa va Skidkadan keyingi yakuniy summa (bo'sh joy bilan): masalan `1000000 880000`", { parse_mode: 'Markdown' });
    }
    ctx.session.step = 'AWAIT_SAVED_INVOICE_TOTAL';
    ctx.session.tempData = { invoiceId: cleanId, botMessageId: ctx.callbackQuery.message?.message_id };
    await ctx.reply("✏️ **Saqlangan nakladnoy uchun umumiy summani qo'lda kiriting:**\n" +
        "• Faqat yakuniy summa: masalan `880000` yoki `$102.17`\n" +
        "• Yoki Asl summa va Yakuniy summa: masalan `1000000 880000`", { parse_mode: 'Markdown' });
});
exports.invoiceHandler.callbackQuery(/^clear_invoice_discount:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const rawId = ctx.match[1];
    const cleanId = rawId.replace(/^p_/, '');
    const pendingAction = rawId.startsWith('p_')
        ? await prisma_1.prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null)
        : null;
    if (pendingAction && pendingAction.type === 'INVOICE') {
        const pData = pendingAction.data;
        const invoiceData = pData.data;
        const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
        invoiceData.discountAmount = invoiceData.discount = 0;
        invoiceData.discountPercent = 0;
        invoiceData.finalTotal = invoiceData.netTotal = invoiceData.printedFinalTotal = rawTotal;
        invoiceData.discountLabel = null;
        await prisma_1.prisma.pendingAction.update({
            where: { id: cleanId },
            data: { data: pData, status: 'PENDING' },
        });
        const { editableText } = buildEditableInvoiceText(invoiceData);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        const kb = (0, inline_1.getInvoiceConfirmationKeyboard)(`i_${cleanId}`, editableText, invoiceData.currency || 'UZS');
        if (ctx.callbackQuery.message && ctx.chat?.id) {
            await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, txt, {
                parse_mode: 'Markdown',
                reply_markup: kb,
            }).catch(() => { });
        }
        return ctx.answerCallbackQuery({ text: '❌ Skidka olib tashlandi!' });
    }
    try {
        const updated = await supplier_service_1.SupplierService.clearInvoiceDiscount(cleanId, ownerId);
        const cur = updated.currency;
        const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
        await ctx.answerCallbackQuery({ text: '❌ Skidka 0 ga tushirildi va balans yangilandi!' });
        if (ctx.callbackQuery.message && ctx.chat?.id) {
            await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, `✅ **Nakladnoy skidkasi olib tashlandi!**\n\n` +
                `🏢 Ta'minotchi: **${(0, telegram_1.sanitizeMdV1)(updated.supplier.name)}**\n` +
                `💰 Asl summa: **${(0, formatters_1.formatCurrency)(updated.rawTotal, cur)}**\n` +
                `🏷 Skidka: **0**\n` +
                `💵 Yakuniy summa: **${(0, formatters_1.formatCurrency)(updated.finalTotal, cur)}**\n` +
                `📊 Ta'minotchi joriy qarzi (${cur}): **${(0, formatters_1.formatCurrency)(newDebt, cur)}**`, {
                parse_mode: 'Markdown',
                reply_markup: (0, inline_1.getSavedInvoiceCardKeyboard)(updated.invoice.id, updated.supplier.id),
            }).catch(() => { });
        }
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
    }
});
exports.invoiceHandler.callbackQuery(/^toggle_invoice_currency:(.+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const rawId = ctx.match[1];
    const cleanId = rawId.replace(/^p_/, '');
    const pendingAction = rawId.startsWith('p_')
        ? await prisma_1.prisma.pendingAction.findUnique({ where: { id: cleanId } }).catch(() => null)
        : null;
    if (pendingAction && pendingAction.type === 'INVOICE') {
        const pData = pendingAction.data;
        const invoiceData = pData.data;
        invoiceData.currency = invoiceData.currency === 'USD' ? 'UZS' : 'USD';
        if (Array.isArray(invoiceData.items)) {
            invoiceData.items.forEach((it) => (it.currency = invoiceData.currency));
            invoiceData.verbatimText = (0, ai_service_1.buildVerbatimTableText)(invoiceData.items, invoiceData.currency);
        }
        await prisma_1.prisma.pendingAction.update({
            where: { id: cleanId },
            data: { data: pData, status: 'PENDING' },
        });
        const { editableText } = buildEditableInvoiceText(invoiceData);
        const txt = buildPendingPreviewMessage(invoiceData, editableText);
        const kb = (0, inline_1.getInvoiceConfirmationKeyboard)(`i_${cleanId}`, editableText, invoiceData.currency);
        if (ctx.callbackQuery.message && ctx.chat?.id) {
            await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, txt, {
                parse_mode: 'Markdown',
                reply_markup: kb,
            }).catch(() => { });
        }
        return ctx.answerCallbackQuery({ text: `💱 Valyuta ${invoiceData.currency} ga o'zgartirildi!` });
    }
    try {
        const updated = await supplier_service_1.SupplierService.toggleInvoiceCurrency(cleanId, ownerId);
        const cur = updated.currency;
        await ctx.answerCallbackQuery({ text: `💱 Valyuta ${cur} ga o'zgartirildi va balans yangilandi!` });
        if (ctx.callbackQuery.message && ctx.chat?.id) {
            await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, `✅ **Nakladnoy valyutasi ${cur} ga o'zgartirildi!**\n\n` +
                `🏢 Ta'minotchi: **${(0, telegram_1.sanitizeMdV1)(updated.supplier.name)}**\n` +
                `💵 Yakuniy summa: **${(0, formatters_1.formatCurrency)(updated.finalTotal, cur)}**\n` +
                `📊 Qarz balansi (UZS): **${(0, formatters_1.formatCurrency)(updated.supplier.debtUzs, 'UZS')}**\n` +
                `💵 Qarz balansi (USD): **${(0, formatters_1.formatCurrency)(updated.supplier.debtUsd, 'USD')}**`, {
                parse_mode: 'Markdown',
                reply_markup: (0, inline_1.getSavedInvoiceCardKeyboard)(updated.invoice.id, updated.supplier.id),
            }).catch(() => { });
        }
    }
    catch (err) {
        await ctx.answerCallbackQuery({ text: err?.message || 'Xatolik yuz berdi.', show_alert: true });
    }
});
function parseTwoOrOneAmounts(rawText) {
    const parts = rawText
        .trim()
        .split(/[\s/;|-]+/)
        .map((p) => p.trim())
        .filter((p) => /\d/.test(p));
    if (parts.length >= 2) {
        const first = (0, formatters_1.parseCurrencyAndAmount)(parts[0]).amount;
        const second = (0, formatters_1.parseCurrencyAndAmount)(parts[1]).amount;
        if (first > 0 && second >= 0) {
            return { first, second };
        }
    }
    const single = (0, formatters_1.parseCurrencyAndAmount)(rawText).amount;
    return { first: single };
}
exports.invoiceHandler.on('message:text', async (ctx, next) => {
    if (!ctx.user || !ctx.from || ctx.message.text.startsWith('/'))
        return next();
    const ownerId = String(ctx.from.id);
    const rawText = ctx.message.text.trim();
    if ((0, menu_1.isMenuButton)(rawText)) {
        (0, telegram_1.clearSession)(ctx);
        return next();
    }
    // 1. Handle saved invoice discount edit
    if (ctx.session.step === 'AWAIT_SAVED_INVOICE_DISCOUNT') {
        const { invoiceId } = ctx.session.tempData || {};
        (0, telegram_1.clearSession)(ctx);
        if (!invoiceId)
            return next();
        try {
            const updated = await supplier_service_1.SupplierService.updateInvoiceDiscount(invoiceId, rawText, ownerId);
            const cur = updated.currency;
            const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
            return (0, telegram_1.safeReply)(ctx, `✅ **Nakladnoy skidkasi yangilandi!**\n\n` +
                `🏢 Ta'minotchi: **${(0, telegram_1.sanitizeMdV1)(updated.supplier.name)}**\n` +
                `💰 Asl summa: **${(0, formatters_1.formatCurrency)(updated.rawTotal, cur)}**\n` +
                `🏷 Skidka (${(0, telegram_1.sanitizeMdV1)(rawText)}): **-${(0, formatters_1.formatCurrency)(updated.discountAmount, cur)}**\n` +
                `💵 Yakuniy summa: **${(0, formatters_1.formatCurrency)(updated.finalTotal, cur)}**\n` +
                `📊 Ta'minotchi yangilangan qarzi (${cur}): **${(0, formatters_1.formatCurrency)(newDebt, cur)}**`, {
                parse_mode: 'Markdown',
                reply_markup: (0, inline_1.getSavedInvoiceCardKeyboard)(updated.invoice.id, updated.supplier.id),
            });
        }
        catch (err) {
            return ctx.reply(`❌ Xatolik: ${err?.message || "Skidkani yangilab bo'lmadi."}`);
        }
    }
    // 2. Handle saved invoice manual total override
    if (ctx.session.step === 'AWAIT_SAVED_INVOICE_TOTAL') {
        const { invoiceId } = ctx.session.tempData || {};
        (0, telegram_1.clearSession)(ctx);
        if (!invoiceId)
            return next();
        const { first, second } = parseTwoOrOneAmounts(rawText);
        if (!first || first <= 0) {
            return ctx.reply("❌ Iltimos, to'g'ri summa kiriting (masalan: 880000 yoki 1000000 880000).");
        }
        try {
            const updated = await supplier_service_1.SupplierService.overrideInvoiceTotal(invoiceId, first, second, ownerId);
            const cur = updated.currency;
            const newDebt = cur === 'USD' ? updated.supplier.debtUsd : updated.supplier.debtUzs;
            return (0, telegram_1.safeReply)(ctx, `✅ **Nakladnoy summasi qo'lda yangilandi!**\n\n` +
                `🏢 Ta'minotchi: **${(0, telegram_1.sanitizeMdV1)(updated.supplier.name)}**\n` +
                `💰 Asl summa: **${(0, formatters_1.formatCurrency)(updated.rawTotal, cur)}**\n` +
                `🏷 Skidka: **-${(0, formatters_1.formatCurrency)(updated.discountAmount, cur)}**\n` +
                `💵 Yakuniy summa: **${(0, formatters_1.formatCurrency)(updated.finalTotal, cur)}**\n` +
                `📊 Ta'minotchi yangilangan qarzi (${cur}): **${(0, formatters_1.formatCurrency)(newDebt, cur)}**`, {
                parse_mode: 'Markdown',
                reply_markup: (0, inline_1.getSavedInvoiceCardKeyboard)(updated.invoice.id, updated.supplier.id),
            });
        }
        catch (err) {
            return ctx.reply(`❌ Xatolik: ${err?.message || "Summani yangilab bo'lmadi."}`);
        }
    }
    const isInvoiceStep = ctx.session.step === 'await_invoice_discount' ||
        ctx.session.step === 'await_invoice_manual_total' ||
        ctx.session.step === 'await_new_supplier_name_inv' ||
        Boolean(ctx.session.step?.startsWith('i_'));
    const activePending = isInvoiceStep
        ? await prisma_1.prisma.pendingAction.findFirst({
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
    if (activePending &&
        activePending.status === 'PENDING' &&
        (0, local_parser_1.parseTextCommandLocally)(rawText) !== null) {
        (0, telegram_1.clearSession)(ctx);
        return next();
    }
    if (activePending) {
        const pData = activePending.data;
        const pendingId = activePending.id;
        const invoiceData = pData.data;
        if (activePending.status === 'AWAIT_NEW_SUPPLIER_NAME_INV') {
            pData.data.exactSupplierId = 'CREATE_NEW';
            pData.data.supplierName = rawText;
            await prisma_1.prisma.pendingAction.delete({ where: { id: activePending.id } });
            (0, telegram_1.clearSession)(ctx);
            return processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
        }
        const updatePreviewMessage = async (txt, finalAmt) => {
            const currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
            const kb = (0, inline_1.getDiscountConfirmationKeyboard)(`i_${pendingId}`, finalAmt, !!invoiceData.isCashOverride, currency);
            if (pData.botMessageId) {
                await ctx.api
                    .editMessageText(ctx.chat?.id || 0, pData.botMessageId, txt, {
                    parse_mode: 'Markdown',
                    reply_markup: kb,
                })
                    .catch(() => { });
            }
            else {
                pData.botMessageId = (await ctx.reply(txt, { parse_mode: 'Markdown', reply_markup: kb })).message_id;
                await prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } });
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
                    prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
                    (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.message.message_id),
                ]);
                const { editableText } = buildEditableInvoiceText(invoiceData);
                const txt = buildPendingPreviewMessage(invoiceData, editableText);
                await updatePreviewMessage(txt, finalTotal);
                ctx.session.step = `i_${pendingId}`;
                ctx.session.tempData = null;
                return;
            }
        }
        if (activePending.status === 'AWAIT_DISCOUNT' ||
            (activePending.type === 'INVOICE' && activePending.status === 'PENDING')) {
            const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
            const isPercent = /(\d+(?:[.,]\d+)?)\s*%/.test(rawText);
            const isNumericDiscount = /^[\d\s.,$]+(?:\s*(?:ming|k|sum|so'm|skidka|usd|usdt|dollar))?$/i.test(rawText);
            if (isPercent || isNumericDiscount || activePending.status === 'AWAIT_DISCOUNT') {
                const math = (0, formatters_1.calculateDiscountedTotal)(rawTotal, rawText);
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
                    prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData, status: 'PENDING' } }),
                    (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.message.message_id),
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
                    prisma_1.prisma.pendingAction.update({ where: { id: pendingId }, data: { data: pData } }),
                    (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.message.message_id),
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
        await ctx
            .editMessageText("⚠️ Ushbu operatsiya muddati tugagan yoki allaqachon tasdiqlangan. Iltimos, xabarni qaytadan yuboring.", { reply_markup: undefined })
            .catch(() => { });
        return null;
    }
    const pData = pendingAction.data;
    const invoiceData = pData.data;
    const rawTotal = Number(invoiceData.rawTotal ?? invoiceData.grossTotal ?? invoiceData.total_amount ?? 0);
    const math = (0, formatters_1.reconcileInvoiceTotals)({
        rows: invoiceData.items || invoiceData.rows,
        subtotalBeforeDiscount: rawTotal,
        discountPercent: invoiceData.discountPercent,
        discountAmount: invoiceData.discountAmount ?? invoiceData.discount ?? 0,
        printedFinalTotal: invoiceData.finalTotal ?? invoiceData.printedFinalTotal,
    });
    const currency = invoiceData.currency === 'USD' ? 'USD' : 'UZS';
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
exports.invoiceHandler.callbackQuery(/^force_dup_inv:(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
    if (!pendingAction)
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    const pData = pendingAction.data;
    const invoiceData = pData.data || {};
    invoiceData.forceOverrideDuplicate = true;
    await prisma_1.prisma.pendingAction.update({
        where: { id: pendingId },
        data: { data: { ...pData, data: invoiceData } },
    });
    const actionId = `i_${pendingId}`;
    ctx.session.step = actionId;
    const { editableText } = buildEditableInvoiceText(invoiceData);
    const text = buildPendingPreviewMessage(invoiceData, editableText);
    const kb = (0, inline_1.getInvoiceConfirmationKeyboard)(actionId, editableText, invoiceData.currency || 'UZS');
    if (ctx.callbackQuery.message && ctx.chat?.id) {
        await (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, text, {
            parse_mode: 'Markdown',
            reply_markup: kb,
        }).catch(() => { });
    }
    await ctx.answerCallbackQuery({ text: "✅ Qayta kiritishga ruxsat berildi. To'lov turini tanlang." });
});
exports.invoiceHandler.callbackQuery(/^confirm_invdebt_i_(.+)$/, async (ctx) => {
    const extracted = await extractPendingInvoice(ctx, ctx.match[1]);
    if (!extracted)
        return;
    const { pendingId, ownerId, pData, invoiceData, totalSum, discountAmount, finalPayable, currency, supplierName } = extracted;
    try {
        const result = await supplier_service_1.SupplierService.createInvoiceWithItems({
            ownerId,
            supplierId: invoiceData.exactSupplierId && invoiceData.exactSupplierId !== 'CREATE_NEW'
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
        await prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
        (0, telegram_1.clearSession)(ctx);
        if (result.isDuplicate && result.warningText) {
            await ctx.editMessageText(result.warningText, { reply_markup: undefined });
            return;
        }
        const finalDebt = currency === 'USD' ? Number(result.supplier.debtUsd) : Number(result.supplier.debtUzs);
        const savedMsg = `✅ **Nakladnoy (📝 Nasiyaga) muvaffaqiyatli saqlandi!**\n\n` +
            `🏢 Ta'minotchi: **${(0, telegram_1.sanitizeMdV1)(result.supplier.name)}**\n` +
            `📦 Tovarlarning asl summasi: **${(0, formatters_1.formatCurrency)(totalSum, currency)}**\n` +
            (discountAmount > 0 ? `🏷 Skidka: **-${(0, formatters_1.formatCurrency)(discountAmount, currency)}**\n` : '') +
            `💰 Skidkadan keyingi yakuniy summa (Itogo): **+${(0, formatters_1.formatCurrency)(finalPayable, currency)}**\n` +
            `📊 **Yakuniy qarz qoldig'i (${currency}):** **${(0, formatters_1.formatCurrency)(finalDebt, currency)}**`;
        const savedKb = (0, inline_1.getSavedInvoiceCardKeyboard)(result.invoice.id, result.supplier.id, pData.photoFileId, result.transaction?.id);
        await Promise.all([
            ctx.callbackQuery.message && ctx.chat?.id
                ? (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, savedMsg, {
                    parse_mode: 'Markdown',
                    reply_markup: savedKb,
                })
                : (0, telegram_1.safeReply)(ctx, savedMsg, { parse_mode: 'Markdown', reply_markup: savedKb }),
            (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, pData.userPhotoMsgId),
        ]);
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
    const { pendingId, ownerId, pData, invoiceData, totalSum, discountAmount, finalPayable, currency, supplierName } = extracted;
    try {
        const result = await supplier_service_1.SupplierService.createInvoiceWithItems({
            ownerId,
            supplierId: invoiceData.exactSupplierId && invoiceData.exactSupplierId !== 'CREATE_NEW'
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
        await prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { });
        (0, telegram_1.clearSession)(ctx);
        if (result.isDuplicate && result.warningText) {
            await ctx.editMessageText(result.warningText, { reply_markup: undefined });
            return;
        }
        const savedMsg = `✅ **Nakladnoy (💵 Naqdga) muvaffaqiyatli saqlandi!**\n\n` +
            `🏢 Ta'minotchi: **${(0, telegram_1.sanitizeMdV1)(result.supplier.name)}**\n` +
            `📦 Tovarlarning asl summasi: **${(0, formatters_1.formatCurrency)(totalSum, currency)}**\n` +
            (discountAmount > 0 ? `🏷 Skidka: **-${(0, formatters_1.formatCurrency)(discountAmount, currency)}**\n` : '') +
            `💵 Naqd to'langan summa (Itogo): **${(0, formatters_1.formatCurrency)(finalPayable, currency)}**\n` +
            `📊 Qarzga yozilmadi (0). Bugungi Z-Otchyot naqd xaridlariga qo'shildi.`;
        const savedKb = (0, inline_1.getSavedInvoiceCardKeyboard)(result.invoice.id, result.supplier.id, pData.photoFileId, result.transaction?.id);
        await Promise.all([
            ctx.callbackQuery.message && ctx.chat?.id
                ? (0, telegram_1.safeEditMessageText)(ctx, ctx.chat.id, ctx.callbackQuery.message.message_id, savedMsg, {
                    parse_mode: 'Markdown',
                    reply_markup: savedKb,
                })
                : (0, telegram_1.safeReply)(ctx, savedMsg, { parse_mode: 'Markdown', reply_markup: savedKb }),
            (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, pData.userPhotoMsgId),
        ]);
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
            prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { }),
        ]);
    }
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText('❌ Nakladnoy bekor qilindi.', { reply_markup: undefined });
});
exports.invoiceHandler.callbackQuery(/^isel_(.+)_(\d+)$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const [, pendingId, rawIdx] = ctx.match;
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } });
    if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    const pData = pendingAction.data;
    const supplierId = pData.candidateIds?.[parseInt(rawIdx, 10)];
    const supplier = supplierId
        ? await prisma_1.prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
        : null;
    if (!supplier)
        return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    pData.data.exactSupplierId = supplier.id;
    pData.data.supplierName = supplier.name;
    await Promise.all([
        prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }),
        ctx.deleteMessage().catch(() => { }),
    ]);
    await processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
});
exports.invoiceHandler.callbackQuery(/^inew_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } });
    if (!pendingAction || pendingAction.type !== 'INVOICE_DISAMBIGUATION')
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    await prisma_1.prisma.pendingAction.update({
        where: { id: pendingId },
        data: { type: 'INVOICE_NEW_SUPP', status: 'AWAIT_NEW_SUPPLIER_NAME_INV' },
    });
    ctx.session.step = 'await_new_supplier_name_inv';
    ctx.session.tempData = { pendingId };
    await ctx.editMessageText("Ushbu yangi ta'minotchini adashtirmaslik uchun unga qo'shimcha belgi kiriting (masalan: 'Azamat Shakar' yoki 'Azamat Qo'qon'):", { reply_markup: undefined });
});
exports.invoiceHandler.callbackQuery(/^(?:sf_use:inv_(.+)|sup_fuzzy_use:([^:]+):inv_(.+))$/, async (ctx) => {
    if (!ctx.from)
        return;
    const ownerId = String(ctx.from.id);
    const pendingId = ctx.match[1] || ctx.match[3];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
    if (!pendingAction)
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    const pData = pendingAction.data;
    const supplierId = ctx.match[2] || pData.suggestedSupplierId || pData.candidateIds?.[0];
    const supplier = supplierId
        ? await prisma_1.prisma.supplier.findFirst({ where: { id: supplierId, ownerId } })
        : null;
    if (!supplier)
        return ctx.answerCallbackQuery("Ta'minotchi topilmadi.");
    pData.data.exactSupplierId = supplier.id;
    pData.data.supplierName = supplier.name;
    await Promise.all([
        prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }),
        ctx.deleteMessage().catch(() => { }),
    ]);
    await processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
});
exports.invoiceHandler.callbackQuery(/^(?:sf_new|sup_fuzzy_new):inv_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
    if (!pendingAction)
        return ctx.editMessageText(EXPIRED_MSG, { reply_markup: undefined });
    const pData = pendingAction.data;
    pData.data.exactSupplierId = 'CREATE_NEW';
    pData.data.supplierName = (0, transliterate_1.toLatinUz)(pData.data.supplierName || "Noma'lum");
    await Promise.all([
        prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }),
        ctx.deleteMessage().catch(() => { }),
    ]);
    await processParsedInvoice(ctx, pData.data, pData.imageUrl, pData.photoFileId, pData.userPhotoMsgId, pData.rawCaption);
});
exports.invoiceHandler.callbackQuery(/^(?:sf_no|sup_fuzzy_cancel):inv_(.+)$/, async (ctx) => {
    const pendingId = ctx.match[1];
    const pendingAction = await prisma_1.prisma.pendingAction.findUnique({ where: { id: pendingId } }).catch(() => null);
    if (pendingAction) {
        await Promise.all([
            (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, pendingAction.data?.userPhotoMsgId),
            prisma_1.prisma.pendingAction.delete({ where: { id: pendingId } }).catch(() => { }),
        ]);
    }
    (0, telegram_1.clearSession)(ctx);
    await ctx.editMessageText('❌ Nakladnoy bekor qilindi.', { reply_markup: undefined });
});

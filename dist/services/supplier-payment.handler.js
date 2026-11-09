"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanSupplierName = cleanSupplierName;
exports.handleSupplierPayment = handleSupplierPayment;
const prisma_1 = require("../database/prisma");
const formatters_1 = require("../utils/formatters");
// 1. Ismlar oxiridagi qo'shimchalarni tozalash
function cleanSupplierName(name) {
    return name
        .trim()
        .replace(/(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla)$/gi, '')
        .trim();
}
// 2. Qarzdan to'lovni ayirish va yangilangan balansni qaytarish handleri
async function handleSupplierPayment(ctx, rawName, amount, currency = 'UZS', comment) {
    const normalizedName = cleanSupplierName(rawName);
    // Bazadagi barcha o'xshash profillarni olish ("Azamat", "Azamataka" va h.k.)
    const existingSuppliers = await prisma_1.prisma.supplier.findMany({
        where: {
            isActive: true,
            OR: [
                { name: { equals: normalizedName, mode: 'insensitive' } },
                { name: { equals: rawName.trim(), mode: 'insensitive' } },
                { name: { contains: normalizedName, mode: 'insensitive' } }
            ]
        },
        orderBy: { debtUzs: 'desc' }
    });
    if (existingSuppliers.length === 0) {
        return ctx.reply(`❌ "${rawName}" nomli ta'minotchi topilmadi.`);
    }
    // Asosiy profilni tanlash va dublikatlarni bitta hisobga birlashtirish
    const primarySupplier = existingSuppliers[0];
    if (existingSuppliers.length > 1) {
        for (let i = 1; i < existingSuppliers.length; i++) {
            const dup = existingSuppliers[i];
            await prisma_1.prisma.invoice.updateMany({
                where: { supplierId: dup.id },
                data: { supplierId: primarySupplier.id }
            });
            await prisma_1.prisma.supplierTransaction.updateMany({
                where: { supplierId: dup.id },
                data: { supplierId: primarySupplier.id }
            });
            await prisma_1.prisma.supplierPayment.updateMany({
                where: { supplierId: dup.id },
                data: { supplierId: primarySupplier.id }
            }).catch(() => { });
            await prisma_1.prisma.supplier.update({
                where: { id: primarySupplier.id },
                data: {
                    debtUzs: { increment: dup.debtUzs },
                    debtUsd: { increment: dup.debtUsd }
                }
            });
            await prisma_1.prisma.supplier.delete({ where: { id: dup.id } });
        }
    }
    const isUsd = currency === 'USD';
    const [, updatedSupplier] = await prisma_1.prisma.$transaction([
        prisma_1.prisma.supplierTransaction.create({
            data: {
                supplierId: primarySupplier.id,
                type: 'PAYMENT',
                amount: amount,
                currency: currency,
                description: comment || "Qarz to'lovi"
            }
        }),
        prisma_1.prisma.supplier.update({
            where: { id: primarySupplier.id },
            data: isUsd
                ? { debtUsd: { decrement: amount } }
                : { debtUzs: { decrement: amount } }
        })
    ]);
    const remainingText = isUsd
        ? `${(0, formatters_1.formatMoney)(Number(updatedSupplier.debtUsd), 'USD')}`
        : `${(0, formatters_1.formatMoney)(Number(updatedSupplier.debtUzs), 'UZS')}`;
    const replyContent = `✅ *To'lov muvaffaqiyatli saqlandi!*\n\n` +
        `🏢 Ta'minotchi: *${updatedSupplier.name}*\n` +
        `💸 To'langan summa: *-${(0, formatters_1.formatMoney)(amount, currency)}*\n` +
        `--------------------------------\n` +
        `💰 *Qolgan umumiy qarzimiz: ${remainingText}*`;
    if (ctx.callbackQuery) {
        return ctx.editMessageText(replyContent, { parse_mode: 'Markdown' });
    }
    else {
        return ctx.reply(replyContent, { parse_mode: 'Markdown' });
    }
}

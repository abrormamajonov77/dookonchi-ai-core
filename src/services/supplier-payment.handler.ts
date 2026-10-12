import { prisma } from '../database/prisma';
import { formatMoney } from '../utils/formatters';

// 1. Ismlar oxiridagi qo'shimchalarni tozalash
export function cleanSupplierName(name: string): string {
  return name
    .trim()
    .replace(/(aka|oka|opa|toga|tog'a|amma|boy|xon|hon|mulla)$/gi, '')
    .trim();
}

// 2. Qarzdan to'lovni ayirish va yangilangan balansni qaytarish handleri
export async function handleSupplierPayment(ctx: any, rawName: string, amount: number, currency: string = 'UZS', comment?: string) {
  const normalizedName = cleanSupplierName(rawName);

  // Bazadagi barcha o'xshash profillarni olish ("Azamat", "Azamataka" va h.k.)
  const existingSuppliers = await prisma.supplier.findMany({
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
      await prisma.supplierTransaction.updateMany({
        where: { supplierId: dup.id },
        data: { supplierId: primarySupplier.id }
      });
      await prisma.supplier.update({
        where: { id: primarySupplier.id },
        data: { debtUzs: { increment: dup.debtUzs } }
      });
      await prisma.supplier.delete({ where: { id: dup.id } });
    }
  }

  const [, updatedSupplier] = await prisma.$transaction([
    prisma.supplierTransaction.create({
      data: {
        supplierId: primarySupplier.id,
        type: 'PAYMENT',
        amount: amount,
        currency: currency as any,
        description: comment || "Qarz to'lovi"
      }
    }),
    prisma.supplier.update({
      where: { id: primarySupplier.id },
      data: { debtUzs: { decrement: amount } }
    })
  ]);

  // Yangilangan qarz summasini darhol ko'rsatish
  return ctx.editMessageText(
    `✅ *To'lov muvaffaqiyatli saqlandi!*\n\n` +
    `🏢 Ta'minotchi: *${updatedSupplier.name}*\n` +
    `💸 To'langan summa: *-${formatMoney(amount, currency)}*\n` +
    `--------------------------------\n` +
    `💰 *Qolgan umumiy qarzimiz: ${formatMoney(Number(updatedSupplier.debtUzs), 'UZS')}*`,
    { parse_mode: 'Markdown' }
  );
}

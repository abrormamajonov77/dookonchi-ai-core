import { prisma } from '../src/database/prisma';
import { env } from '../src/config/env';

export async function assignOwnerToExistingRecords() {
  const ownerId = String(env.OWNER_TELEGRAM_ID).trim();
  if (!ownerId) {
    throw new Error('OWNER_TELEGRAM_ID is not set in environment');
  }

  console.log(`🔒 Assigning existing business records to Super-Admin (ownerId = ${ownerId})...`);

  const [
    suppliers,
    products,
    invoices,
    invoiceItems,
    supplierPayments,
    supplierTransactions,
    customerDebts,
    expenses,
    cashTransactions,
    dailyRegisters,
    zReports,
  ] = await Promise.all([
    prisma.supplier.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.product.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.invoice.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.invoiceItem.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.supplierPayment.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.supplierTransaction.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.customerDebt.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.expense.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.cashTransaction.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.dailyRegister.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
    prisma.zReport.updateMany({
      where: { OR: [{ ownerId: '' }, { ownerId: 'default' }] },
      data: { ownerId },
    }),
  ]);

  // Ensure Super-Admin User record is ACTIVE with unlimited subscription
  await prisma.user.upsert({
    where: { telegramId: ownerId },
    create: {
      telegramId: ownerId,
      fullName: 'Super Admin',
      name: 'Super Admin',
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      subscriptionPlan: 'UNLIMITED',
      subscriptionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      approvedAt: new Date(),
    },
    update: {
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      subscriptionPlan: 'UNLIMITED',
      subscriptionExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
    },
  });

  // Ensure SystemSettings ('global') exists
  await prisma.systemSettings.upsert({
    where: { id: 'global' },
    create: {
      id: 'global',
      paymentCardNumber: '8600 0000 0000 0000',
      paymentCardHolder: 'ADMIN',
      monthlyPriceUzs: 100000,
      tariffInfoText:
        "1 Oylik: 100,000 so'm | 3 Oy + 15 kun Bonus | 4 Oy + 1 oy Bonus | 6 Oy + 45 kun Bonus | 1 Yil + 2 oy Bonus",
    },
    update: {},
  });

  console.log('✅ Owner migration completed successfully:', {
    ownerId,
    suppliers: suppliers.count,
    products: products.count,
    invoices: invoices.count,
    invoiceItems: invoiceItems.count,
    supplierPayments: supplierPayments.count,
    supplierTransactions: supplierTransactions.count,
    customerDebts: customerDebts.count,
    expenses: expenses.count,
    cashTransactions: cashTransactions.count,
    dailyRegisters: dailyRegisters.count,
    zReports: zReports.count,
  });
}

if (require.main === module) {
  assignOwnerToExistingRecords()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
      console.error('❌ Error in assign-owner.ts:', err);
      await prisma.$disconnect();
      process.exit(1);
    });
}

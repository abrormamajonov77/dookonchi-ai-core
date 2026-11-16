import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { getMainMenu, getPendingRegistrationKeyboard } from '../keyboards/menu';
import { clearSession, safeDelete } from '../../utils/telegram';
import { SubscriptionService } from '../../services/subscription.service';
import { env } from '../../config/env';
import { formatDateShort, formatSom } from '../../utils/formatters';

export const startHandler = new Composer<MyContext>();

startHandler.command('start', async (ctx) => {
  if (!ctx.from) return;
  clearSession(ctx);
  const telegramId = String(ctx.from.id);
  const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
  const username = ctx.from.username || null;

  const { user } = await SubscriptionService.registerOrGetUser({
    telegramId,
    fullName,
    username,
  });
  ctx.user = user;

  // 1. Super-Admin gets immediate full menu + 👑 Admin Panel
  if (SubscriptionService.isSuperAdmin(telegramId)) {
    await ctx.reply(
      `👑 Assalomu alaykum, *${user.fullName || user.name || 'Super Admin'}*!\n\n` +
        `⚡️ *SmartBaqqol AI (SaaS Super-Admin)* tizimiga xush kelibsiz.\n` +
        `Sizning shaxsiy bazangiz va 👑 Admin Panel boshqaruvi tayyor.`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenu('SUPER_ADMIN'),
      }
    );
    return;
  }

  // 2. Active Subscriber
  if (user.status === 'ACTIVE') {
    const expText = user.subscriptionExpiresAt
      ? `\n📅 Faol obuna muddati: *${formatDateShort(user.subscriptionExpiresAt)}* gacha`
      : '';
    await ctx.reply(
      `👋 Assalomu alaykum, *${user.fullName || user.name || "Do'kon egasi"}*!\n\n` +
        `⚡️ *SmartBaqqol AI* shaxsiy bazangiz faol holatda.${expText}\n` +
        `Nakladnoy rasmini, ovozli xabar yoki matn yuborishingiz mumkin!`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenu('STORE_OWNER'),
      }
    );
    return;
  }

  // 3. Pending User (Waiting Room + Immediate Notification to Super-Admin)
  if (user.status === 'PENDING') {
    await ctx.reply(SubscriptionService.buildWelcomePendingMessage(), {
      reply_markup: getPendingRegistrationKeyboard(),
    });

    const adminMsg = SubscriptionService.buildAdminNewUserRequestMessage(user);
    const adminKb = SubscriptionService.getAdminUserGrantKeyboard(user.telegramId);
    await ctx.api
      .sendMessage(env.OWNER_TELEGRAM_ID, adminMsg, { reply_markup: adminKb })
      .catch(() => {});
    return;
  }

  // 4. Expired User
  if (user.status === 'EXPIRED') {
    const kb = new InlineKeyboard().text(
      "📸 To'lov chekini (skrinshot) yuborish",
      'sub:send_receipt'
    );
    await ctx.reply(
      "⏳ Obuna muddatingiz yakunlandi. Davom ettirish uchun to'lov cheki (skrinshot) rasmini yuboring:",
      { reply_markup: kb }
    );
    return;
  }

  if (user.status === 'PAUSED') {
    await ctx.reply(
      "⏸ Sizning obunangiz Admin tomonidan vaqtincha to'xtatilgan. Ma'lumotlaringiz saqlanmoqda."
    );
    return;
  }

  if (user.status === 'BLOCKED') {
    await ctx.reply("⛔️ Kechirasiz, sizning hisobingiz bloklangan.");
    return;
  }
});

// Contact registration handler
startHandler.on('message:contact', async (ctx) => {
  if (!ctx.from || !ctx.message.contact) return;
  const telegramId = String(ctx.from.id);
  const phone = ctx.message.contact.phone_number;
  const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
  const username = ctx.from.username || null;

  const { user } = await SubscriptionService.registerOrGetUser({
    telegramId,
    fullName,
    username,
    phone,
  });
  ctx.user = user;

  if (user.status === 'PENDING') {
    await ctx.reply(
      "✅ Telefon raqamingiz tasdiqlandi! So'rovingiz Adminga yuborildi. Ruxsat berilishi bilan sizga shu yerda xabar keladi.",
      { reply_markup: { remove_keyboard: true } }
    );

    const adminMsg = SubscriptionService.buildAdminNewUserRequestMessage(user);
    const adminKb = SubscriptionService.getAdminUserGrantKeyboard(user.telegramId);
    await ctx.api
      .sendMessage(env.OWNER_TELEGRAM_ID, adminMsg, { reply_markup: adminKb })
      .catch(() => {});
    return;
  }

  await ctx.reply('✅ Telefon raqamingiz yangilandi!', {
    reply_markup: getMainMenu(user.role),
  });
});

// Prompt user to send payment screenshot
startHandler.callbackQuery('sub:send_receipt', async (ctx) => {
  const settings = await SubscriptionService.getSystemSettings();
  ctx.session.step = 'AWAIT_SUBSCRIPTION_RECEIPT';
  await ctx.reply(
    `💳 **Obuna to'lovi uchun ma'lumotlar:**\n` +
      `• Karta: \`${settings.paymentCardNumber}\` (${settings.paymentCardHolder})\n` +
      `• Oylik obuna narxi: **${formatSom(settings.monthlyPriceUzs)}**\n` +
      `(🎁 3, 4, 6 oylik va 1 yillik to'lovlarga BONUS kunlar qo'shib beriladi!)\n\n` +
      `📸 To'lov qilgach, chek (skrinshot) rasmini shu yerga yuboring:`,
    { parse_mode: 'Markdown' }
  );
});

// Handle payment screenshot upload when user is in AWAIT_SUBSCRIPTION_RECEIPT or EXPIRED / PENDING
startHandler.on('message:photo', async (ctx, next) => {
  if (!ctx.from) return next();
  const isWaitingReceipt =
    ctx.session.step === 'AWAIT_SUBSCRIPTION_RECEIPT' ||
    (!SubscriptionService.isSuperAdmin(ctx.from.id) &&
      (ctx.user?.status === 'EXPIRED' || ctx.user?.status === 'PENDING'));

  if (!isWaitingReceipt) return next();

  const photos = ctx.message.photo;
  const bestPhoto = photos[photos.length - 1];
  if (!bestPhoto) return next();

  const telegramId = String(ctx.from.id);
  const payment = await SubscriptionService.submitPaymentScreenshot({
    userTelegramId: telegramId,
    screenshotFileId: bestPhoto.file_id,
  });

  clearSession(ctx);
  await ctx.reply(
    "✅ To'lov cheki (skrinshot) qabul qilindi va Adminga yuborildi!\nAdmin tasdiqlashi bilan botingiz avtomatik yonadi va sizga shu yerda xabar keladi."
  );

  const userFullName =
    ctx.user?.fullName ||
    ctx.user?.name ||
    [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') ||
    "Noma'lum";
  const userPhone = ctx.user?.phone || 'Kiritilmagan';
  const username = ctx.from.username ? `@${ctx.from.username}` : 'Kiritilmagan';

  const caption =
    `🧾 YANGI TO'LOV CHEKI (SKRINSHOT)!\n` +
    `👤 Mijoz: ${userFullName}\n` +
    `📱 Telefon: ${userPhone}\n` +
    `🔗 Username: ${username}\n` +
    `🆔 Telegram ID: ${telegramId}\n\n` +
    `Qaysi tarif va bonus bilan obunasini tasdiqlaysiz?`;

  const kb = SubscriptionService.getAdminPaymentApprovalKeyboard(payment.id);
  await ctx.api
    .sendPhoto(env.OWNER_TELEGRAM_ID, bestPhoto.file_id, {
      caption,
      reply_markup: kb,
    })
    .catch(() => {});
});

// Direct reply from Customer to Super-Admin
startHandler.callbackQuery('user_reply_admin', async (ctx) => {
  ctx.session.step = 'USER_REPLY_TO_ADMIN';
  await ctx.reply("✍️ Adminga yubormoqchi bo'lgan xabaringizni yozing:");
});

startHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'USER_REPLY_TO_ADMIN') return next();
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();

  clearSession(ctx);
  const telegramId = String(ctx.from?.id || '');
  const senderName =
    ctx.user?.fullName ||
    ctx.user?.name ||
    ctx.from?.first_name ||
    "Do'kon egasi";

  const kb = new InlineKeyboard().text('💬 Javob yozish', `adm_msg:${telegramId}`);
  await ctx.api
    .sendMessage(
      env.OWNER_TELEGRAM_ID,
      `📩 **Mijozdan javob xabari keldi!**\n👤 Mijoz: ${senderName} (ID: \`${telegramId}\`)\n\n💬 Xabar:\n${text}`,
      { parse_mode: 'Markdown', reply_markup: kb }
    )
    .catch(() => {});

  await ctx.reply('✅ Xabaringiz Adminga yetkazildi!');
});

startHandler.callbackQuery('menu:main', async (ctx) => {
  await safeDelete(ctx, ctx.chat?.id, ctx.callbackQuery.message?.message_id);
  const role = SubscriptionService.isSuperAdmin(ctx.from?.id || '') ? 'SUPER_ADMIN' : 'STORE_OWNER';
  await ctx.reply('Bosh menyudasiz 👇', { reply_markup: getMainMenu(role) });
});

import { Composer, InlineKeyboard, InputMediaBuilder } from 'grammy';
import { MyContext } from '../context';
import {
  getDashboardInlineKeyboard,
  getMainMenu,
  getPendingRegistrationKeyboard,
  isMenuButton,
} from '../keyboards/menu';
import { getOnboardingCarouselKeyboard } from '../keyboards/inline';
import { clearSession, safeDelete, safeReply, sanitizeMdV1 } from '../../utils/telegram';
import { SubscriptionService } from '../../services/subscription.service';
import {
  AccountRecoveryError,
  generateRecoveryCode,
  recoverAccountByCode,
} from '../../services/account-recovery.service';
import {
  formatOnboardingSlideText,
  getOnboardingMedia,
  ONBOARDING_FINISH_MESSAGE,
  OnboardingMediaConfig,
  OnboardingSlideIndex,
  parseOnboardingSlideCallback,
} from '../../services/onboarding.service';
import { getSuperAdminIds, isSuperAdmin } from '../../utils/admin';
import { formatDateShort, formatSom } from '../../utils/formatters';

export const startHandler = new Composer<MyContext>();

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSubscriptionSummaryUz(user: {
  telegramId: string;
  role?: string | null;
  status: string;
  subscriptionExpiresAt?: Date | string | null;
}): string {
  if (isSuperAdmin(user.telegramId) || user.role === 'SUPER_ADMIN') {
    return '👑 Cheksiz (Super-Admin)';
  }
  if (user.status === 'ACTIVE') {
    if (user.subscriptionExpiresAt) {
      const exp = new Date(user.subscriptionExpiresAt);
      const daysLeft = Math.max(0, Math.ceil((exp.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
      return `🟢 Faol (${formatDateShort(exp)} gacha — ${daysLeft} kun qoldi)`;
    }
    return '🟢 Faol';
  }
  if (user.status === 'EXPIRED') return '⌛️ Muddati tugagan';
  if (user.status === 'PAUSED') return '⏸ Vaqtincha to‘xtatilgan';
  if (user.status === 'BLOCKED') return '⛔️ Bloklangan';
  return '⏳ Tasdiq kutilmoqda';
}

async function notifyAllSuperAdminsMessage(
  ctx: MyContext,
  text: string,
  extra?: Parameters<MyContext['api']['sendMessage']>[2]
) {
  const adminIds = Array.from(getSuperAdminIds());
  await Promise.all(
    adminIds.map((adminId) => ctx.api.sendMessage(adminId, text, extra).catch(() => {}))
  );
}

async function notifyAllSuperAdminsPhoto(
  ctx: MyContext,
  photoFileId: string,
  extra?: Parameters<MyContext['api']['sendPhoto']>[2]
) {
  const adminIds = Array.from(getSuperAdminIds());
  await Promise.all(
    adminIds.map((adminId) => ctx.api.sendPhoto(adminId, photoFileId, extra).catch(() => {}))
  );
}

/**
 * Sends a single onboarding carousel slide with optional photo/animation media
 * and graceful fallback to text-only if media file_id is unavailable or rejected.
 */
export async function sendOnboardingSlide(
  ctx: MyContext,
  slideIndex: OnboardingSlideIndex,
  mediaConfig?: OnboardingMediaConfig
) {
  const media = mediaConfig ?? (await getOnboardingMedia());
  const caption = formatOnboardingSlideText(slideIndex);
  const replyMarkup = getOnboardingCarouselKeyboard(slideIndex);
  const slideMedia = media.slides[slideIndex];

  if (slideMedia?.fileId) {
    try {
      if (slideMedia.type === 'animation') {
        return await ctx.replyWithAnimation(slideMedia.fileId, {
          caption,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
      }
      return await ctx.replyWithPhoto(slideMedia.fileId, {
        caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } catch {
      // Fallback cleanly to text-only slide if Telegram rejects stale file_id
    }
  }

  return await ctx.reply(caption, {
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  });
}

/**
 * Launches the interactive onboarding guide:
 * 1) Optional intro video / video_note (krujochek) if configured by Super-Admin.
 * 2) Slide 1/4 with inline carousel navigation buttons.
 */
export async function sendOnboardingCarousel(
  ctx: MyContext,
  options?: { includeIntroVideo?: boolean }
) {
  const media = await getOnboardingMedia();
  const includeIntro = options?.includeIntroVideo !== false;

  if (includeIntro && media.introVideoFileId) {
    try {
      if (media.introVideoType === 'video_note') {
        await ctx.replyWithVideoNote(media.introVideoFileId);
      } else {
        await ctx.replyWithVideo(media.introVideoFileId);
      }
    } catch {
      // Never block Slide 1 if intro video fails to send
    }
  }

  await sendOnboardingSlide(ctx, 1, media);
}

/**
 * Smooth in-place slide switcher for `onb_slide:<1|2|3|4>`:
 * - Media -> Media: editMessageMedia (0 chat spam)
 * - Text -> Text: editMessageText (0 chat spam)
 * - Media <-> Text: send target slide + delete previous message cleanly
 */
export async function handleOnboardingSlideTransition(
  ctx: MyContext,
  targetIndex: OnboardingSlideIndex
) {
  const media = await getOnboardingMedia();
  const slideMedia = media.slides[targetIndex];
  const caption = formatOnboardingSlideText(targetIndex);
  const replyMarkup = getOnboardingCarouselKeyboard(targetIndex);

  const currentMsg: any = ctx.callbackQuery?.message;
  const currentHasMedia = Boolean(
    currentMsg &&
      ((Array.isArray(currentMsg.photo) && currentMsg.photo.length > 0) ||
        currentMsg.animation ||
        currentMsg.video ||
        currentMsg.document)
  );
  const chatId = ctx.chat?.id;
  const msgId = currentMsg?.message_id;

  // Case 1: Media -> Media (smooth in-place editMessageMedia)
  if (slideMedia?.fileId && currentHasMedia) {
    try {
      const inputMedia =
        slideMedia.type === 'animation'
          ? InputMediaBuilder.animation(slideMedia.fileId, { caption, parse_mode: 'HTML' })
          : InputMediaBuilder.photo(slideMedia.fileId, { caption, parse_mode: 'HTML' });
      await ctx.editMessageMedia(inputMedia, { reply_markup: replyMarkup });
      return;
    } catch (err: any) {
      const desc = String(err?.description || err?.message || '');
      if (/message is not modified/i.test(desc)) return;
      // Fallback: replace cleanly without throwing
      await sendOnboardingSlide(ctx, targetIndex, media);
      await safeDelete(ctx, chatId, msgId);
      return;
    }
  }

  // Case 2: Text -> Text (smooth in-place editMessageText)
  if (!slideMedia?.fileId && !currentHasMedia) {
    try {
      await ctx.editMessageText(caption, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      return;
    } catch (err: any) {
      const desc = String(err?.description || err?.message || '');
      if (/message is not modified/i.test(desc)) return;
      await sendOnboardingSlide(ctx, targetIndex, media);
      await safeDelete(ctx, chatId, msgId);
      return;
    }
  }

  // Case 3 & 4: Mixed transition (Text <-> Media) -> replace cleanly with 0 error
  await sendOnboardingSlide(ctx, targetIndex, media);
  await safeDelete(ctx, chatId, msgId);
}

// ============================================================================
// SELF-SERVICE ACCOUNT RECOVERY (/tiklash <KOD> and /kalit | "🔐 Zaxira kalit")
// ============================================================================
export async function handleRecoverAccountCommand(ctx: MyContext) {
  if (!ctx.from) return;
  clearSession(ctx);

  const matchArg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  const fallbackArg =
    ctx.message?.text?.replace(/^\/tiklash(?:@\S+)?/i, '').trim() || '';
  const rawCode = matchArg || fallbackArg;

  if (!rawCode) {
    await ctx.reply(
      `ℹ️ Akkauntni tiklash uchun zaxira kalitni birga kiriting:\n\n` +
        `Misol: <code>/tiklash DOOKON-XXXX-XXXX</code>`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  try {
    const { user, newRecoveryCode } = await recoverAccountByCode(
      String(ctx.from.id),
      rawCode
    );
    ctx.user = user;

    const role = isSuperAdmin(user.telegramId) ? 'SUPER_ADMIN' : user.role || 'STORE_OWNER';
    const storeName = escapeHtml(user.fullName || user.name || "Do'kon egasi");
    const subSummary = escapeHtml(formatSubscriptionSummaryUz(user));

    await ctx.reply(
      `✅ <b>Akkauntingiz muvaffaqiyatli tiklandi!</b>\n\n` +
        `🏪 Do‘kon egasi: <b>${storeName}</b>\n` +
        `📅 Obuna holati: <b>${subSummary}</b>\n\n` +
        `🔐 <b>Yangi zaxira tiklash kalitingiz:</b> <code>${escapeHtml(newRecoveryCode)}</code>\n\n` +
        `⚠️ Avvalgi kalit xavfsizlik uchun bekor qilindi. Yangi kalitni skrinshot qilib yoki xavfsiz joyga saqlab qo‘ying!`,
      {
        parse_mode: 'HTML',
        reply_markup: getMainMenu(role),
      }
    );
  } catch (err: any) {
    if (err instanceof AccountRecoveryError) {
      await ctx.reply(err.message);
      return;
    }
    throw err;
  }
}

export async function handleGenerateBackupKey(ctx: MyContext) {
  if (!ctx.from) return;
  clearSession(ctx);

  const telegramId = String(ctx.from.id);
  let user = ctx.user;
  if (!user) {
    const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
    const reg = await SubscriptionService.registerOrGetUser({
      telegramId,
      fullName,
      username: ctx.from.username || null,
    });
    user = reg.user;
    ctx.user = user;
  }
  if (!user) return;

  const plainCode = await generateRecoveryCode(user.id);
  const message =
    `🔐 Sizning maxfiy tiklash kalitingiz: <code>${escapeHtml(plainCode)}</code>\n\n` +
    `⚠️ Buni skrinshot qilib yoki xavfsiz joyga yozib qo‘ying. Agar Telegram akkauntingiz bloklansa yoki raqamingiz yo‘qolsa, yangi Telegramdan kirib <code>/tiklash ${escapeHtml(plainCode)}</code> deb yozsangiz, barcha tarixingiz va obunangiz 1 soniyada tiklanadi.`;

  await ctx.reply(message, { parse_mode: 'HTML' });
}

startHandler.command('tiklash', handleRecoverAccountCommand);
startHandler.command('kalit', handleGenerateBackupKey);
startHandler.hears('🔐 Zaxira kalit', handleGenerateBackupKey);

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
  if (isSuperAdmin(telegramId)) {
    await safeReply(
      ctx,
      `👑 Assalomu alaykum, *${sanitizeMdV1(user.fullName || user.name || 'Super Admin')}*!\n\n` +
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
    await safeReply(
      ctx,
      `👋 Assalomu alaykum, *${sanitizeMdV1(user.fullName || user.name || "Do'kon egasi")}*!\n\n` +
        `⚡️ *SmartBaqqol AI* shaxsiy bazangiz faol holatda.${expText}\n` +
        `Nakladnoy rasmini, ovozli xabar yoki matn yuborishingiz mumkin!`,
      {
        parse_mode: 'Markdown',
        reply_markup: getMainMenu('STORE_OWNER'),
      }
    );
    return;
  }

  // 3. Pending User (Prompt to share contact for instant 7-day free trial)
  if (user.status === 'PENDING') {
    await ctx.reply(SubscriptionService.buildWelcomePendingMessage(), {
      reply_markup: getPendingRegistrationKeyboard(),
    });
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

// Interactive Onboarding Guide triggers (/help and "❓ Yo‘riqnoma")
startHandler.command('help', async (ctx) => {
  clearSession(ctx);
  await sendOnboardingCarousel(ctx, { includeIntroVideo: true });
});

startHandler.hears(/^❓\s*Yo[‘'’`]?riqnoma$/i, async (ctx) => {
  clearSession(ctx);
  await sendOnboardingCarousel(ctx, { includeIntroVideo: true });
});

// CEO Dashboard Mini App launcher via InlineKeyboard web_app (always passes signed initData)
const sendDashboardInlineLauncher = async (ctx: MyContext) => {
  clearSession(ctx);
  const inlineKb = getDashboardInlineKeyboard();
  if (!inlineKb) {
    await ctx.reply("⚠️ Dashboard havolasi hali sozlanmagan (APP_URL / RENDER_EXTERNAL_URL).");
    return;
  }
  await ctx.reply(
    '📊 **CEO Dashboard v4.0**\n\nOylik va kunlik taqqoslashlar, xarajat anomaliyalari, yuk olish sikllari va qarzdorlik xaritasini ochish uchun pastdagi tugmani bosing:',
    { parse_mode: 'Markdown', reply_markup: inlineKb }
  );
};

startHandler.hears('📊 Dashboard', sendDashboardInlineLauncher);
startHandler.command('dashboard', sendDashboardInlineLauncher);

// Interactive Onboarding Carousel callbacks
startHandler.callbackQuery(/^onb_slide:(.+)$/, async (ctx) => {
  const targetIndex = parseOnboardingSlideCallback(ctx.callbackQuery.data);
  if (!targetIndex) {
    await ctx.answerCallbackQuery({ text: "Noto'g'ri slayd raqami." }).catch(() => {});
    return;
  }
  await handleOnboardingSlideTransition(ctx, targetIndex);
});

startHandler.callbackQuery('onb_finish', async (ctx) => {
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(ONBOARDING_FINISH_MESSAGE);
});

// Contact registration handler -> Auto 7-Day Free Trial + Interactive Onboarding Carousel
startHandler.on('message:contact', async (ctx) => {
  if (!ctx.from || !ctx.message.contact) return;
  const telegramId = String(ctx.from.id);
  const phone = ctx.message.contact.phone_number;
  const fullName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
  const username = ctx.from.username || null;

  const trialResult = await SubscriptionService.activateAutoTrialOnContact({
    telegramId,
    fullName,
    username,
    phone,
  });
  const user = trialResult.user;
  ctx.user = user;

  // Keep BLOCKED and PAUSED protections strictly intact
  if (!isSuperAdmin(telegramId)) {
    if (user.status === 'BLOCKED') {
      await ctx.reply("⛔️ Kechirasiz, sizning hisobingiz bloklangan.");
      return;
    }
    if (user.status === 'PAUSED') {
      await ctx.reply(
        "⏸ Sizning obunangiz Admin tomonidan vaqtincha to'xtatilgan. Shaxsiy bazangizdagi barcha ma'lumotlar xavfsiz saqlanmoqda."
      );
      return;
    }
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
  }

  if (trialResult.activated && trialResult.onboardingMessage) {
    await safeReply(ctx, trialResult.onboardingMessage, {
      parse_mode: 'Markdown',
      reply_markup: getMainMenu('STORE_OWNER'),
    });

    // Trigger interactive onboarding carousel right after 7-day trial activation
    await sendOnboardingCarousel(ctx, { includeIntroVideo: true }).catch(() => {});

    if (trialResult.adminNotification) {
      await notifyAllSuperAdminsMessage(ctx, trialResult.adminNotification);
    }
    return;
  }

  if (user.status === 'PENDING') {
    await ctx.reply(
      "✅ Telefon raqamingiz tasdiqlandi! So'rovingiz Adminga yuborildi. Ruxsat berilishi bilan sizga shu yerda xabar keladi.",
      { reply_markup: { remove_keyboard: true } }
    );

    const adminMsg = SubscriptionService.buildAdminNewUserRequestMessage(user);
    const adminKb = SubscriptionService.getAdminUserGrantKeyboard(user.telegramId);
    await notifyAllSuperAdminsMessage(ctx, adminMsg, { reply_markup: adminKb });
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
    (!isSuperAdmin(ctx.from.id) &&
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
  await notifyAllSuperAdminsPhoto(ctx, bestPhoto.file_id, {
    caption,
    reply_markup: kb,
  });
});

// Direct reply from Customer to Super-Admin
startHandler.callbackQuery('user_reply_admin', async (ctx) => {
  ctx.session.step = 'USER_REPLY_TO_ADMIN';
  await ctx.reply("✍️ Adminga yubormoqchi bo'lgan xabaringizni yozing:");
});

startHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'USER_REPLY_TO_ADMIN') return next();
  const text = ctx.message.text.trim();
  if (text.startsWith('/') || isMenuButton(text)) {
    clearSession(ctx);
    return next();
  }

  clearSession(ctx);
  const telegramId = String(ctx.from?.id || '');
  const senderName = sanitizeMdV1(
    ctx.user?.fullName ||
      ctx.user?.name ||
      ctx.from?.first_name ||
      "Do'kon egasi"
  );

  const kb = new InlineKeyboard().text('💬 Javob yozish', `adm_msg:${telegramId}`);
  await notifyAllSuperAdminsMessage(
    ctx,
    `📩 **Mijozdan javob xabari keldi!**\n👤 Mijoz: ${senderName} (ID: \`${telegramId}\`)\n\n💬 Xabar:\n${sanitizeMdV1(text)}`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );

  await ctx.reply('✅ Xabaringiz Adminga yetkazildi!');
});

startHandler.callbackQuery('menu:main', async (ctx) => {
  await safeDelete(ctx, ctx.chat?.id, ctx.callbackQuery.message?.message_id);
  const role = isSuperAdmin(ctx.from?.id) ? 'SUPER_ADMIN' : 'STORE_OWNER';
  await ctx.reply('Bosh menyudasiz 👇', { reply_markup: getMainMenu(role) });
});

import { Composer } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney } from '../../utils/formatters';
import { getConfirmationKeyboard } from '../keyboards/inline';

export const closingHandler = new Composer<MyContext>();

closingHandler.hears('📊 Z-Hisobot (Kunlik)', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const existing = await prisma.dailyRegister.findUnique({
    where: { date: today }
  });

  if (existing && existing.isClosed) {
    return ctx.reply(`Bugungi kassa yopilgan. Naqd: ${formatMoney(existing.cashUzs)}`);
  }

  ctx.session.step = 'Z_REPORT_CASH';
  await ctx.reply("Bugungi **Naqd pul** (UZS) miqdorini kiriting:", { parse_mode: 'Markdown' });
});

closingHandler.on('message:text', async (ctx, next) => {
  if (!ctx.session.step?.startsWith('Z_REPORT_')) return next();

  const amount = Number(ctx.message.text.replace(/[^0-9]/g, ''));
  if (isNaN(amount)) {
    return ctx.reply("Faqat raqam kiriting!");
  }

  if (ctx.session.step === 'Z_REPORT_CASH') {
    ctx.session.tempData = { cashUzs: amount };
    ctx.session.step = 'Z_REPORT_CLICK';
    return ctx.reply("Endi **Click** orqali tushgan pulni kiriting:", { parse_mode: 'Markdown' });
  }

  if (ctx.session.step === 'Z_REPORT_CLICK') {
    ctx.session.tempData.clickAmount = amount;
    ctx.session.step = 'Z_REPORT_TERMINAL';
    return ctx.reply("Endi **Terminal** orqali tushgan pulni kiriting:", { parse_mode: 'Markdown' });
  }

  if (ctx.session.step === 'Z_REPORT_TERMINAL') {
    const data = ctx.session.tempData;
    data.terminalAmount = amount;
    ctx.session.step = 'Z_REPORT_CONFIRM';

    const actionId = `zrep_${Date.now()}`;
    ctx.session.step = actionId;

    let text = `📊 **Z-Hisobot tasdiqlash**\n\n`;
    text += `Naqd: ${formatMoney(data.cashUzs)}\n`;
    text += `Click: ${formatMoney(data.clickAmount)}\n`;
    text += `Terminal: ${formatMoney(data.terminalAmount)}\n\n`;
    text += `Jami: ${formatMoney(data.cashUzs + data.clickAmount + data.terminalAmount)}\n\nYopaymi?`;

    await ctx.reply(text, {
      parse_mode: 'Markdown',
      reply_markup: getConfirmationKeyboard(actionId)
    });
  }
});

closingHandler.callbackQuery(/^confirm_zrep_/, async (ctx) => {
  if (!ctx.session.tempData) {
    return ctx.answerCallbackQuery({ text: 'Eskirgan so\'rov!', show_alert: true });
  }

  const data = ctx.session.tempData;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  try {
    await prisma.dailyRegister.upsert({
      where: { date: today },
      update: {
        cashUzs: data.cashUzs,
        clickAmount: data.clickAmount,
        terminalAmount: data.terminalAmount,
        isClosed: true
      },
      create: {
        date: today,
        cashUzs: data.cashUzs,
        clickAmount: data.clickAmount,
        terminalAmount: data.terminalAmount,
        isClosed: true
      }
    });

    await ctx.editMessageText('✅ Kassa muvaffaqiyatli yopildi!');
  } catch (error) {
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.', show_alert: true });
  } finally {
    ctx.session.tempData = null;
    ctx.session.step = undefined;
  }
});

closingHandler.callbackQuery(/^cancel_zrep_/, async (ctx) => {
  ctx.session.tempData = null;
  ctx.session.step = undefined;
  await ctx.editMessageText('❌ Z-Hisobot bekor qilindi.');
});

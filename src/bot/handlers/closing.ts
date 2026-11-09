import { Composer } from 'grammy';
import { MyContext } from '../context';
import { prisma } from '../../database/prisma';
import { formatMoney, getToday } from '../../utils/formatters';
import { getConfirmationKeyboard } from '../keyboards/inline';
import { clearSession } from '../../utils/telegram';

export const closingHandler = new Composer<MyContext>();

closingHandler.hears('📊 Z-Hisobot (Kunlik)', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  const existing = await prisma.dailyRegister.findUnique({ where: { date: getToday() } });
  if (existing?.isClosed) return ctx.reply(`Bugungi kassa yopilgan. Naqd: ${formatMoney(existing.cashUzs)}`);
  ctx.session.step = 'Z_REPORT_CASH';
  await ctx.reply('Bugungi **Naqd pul** (UZS) miqdorini kiriting:', { parse_mode: 'Markdown' });
});

closingHandler.on('message:text', async (ctx, next) => {
  if (!ctx.session.step?.startsWith('Z_REPORT_')) return next();
  const amount = Number(ctx.message.text.replace(/[^0-9]/g, ''));
  if (isNaN(amount)) return ctx.reply('Faqat raqam kiriting!');

  if (ctx.session.step === 'Z_REPORT_CASH') {
    ctx.session.tempData = { cashUzs: amount };
    ctx.session.step = 'Z_REPORT_CLICK';
    return ctx.reply('Endi **Click** orqali tushgan pulni kiriting:', { parse_mode: 'Markdown' });
  }
  if (ctx.session.step === 'Z_REPORT_CLICK') {
    ctx.session.tempData.clickAmount = amount;
    ctx.session.step = 'Z_REPORT_TERMINAL';
    return ctx.reply('Endi **Terminal** orqali tushgan pulni kiriting:', { parse_mode: 'Markdown' });
  }
  if (ctx.session.step === 'Z_REPORT_TERMINAL') {
    const d = ctx.session.tempData;
    d.terminalAmount = amount;
    const actionId = `zrep_${Date.now()}`;
    ctx.session.step = actionId;
    const total = d.cashUzs + d.clickAmount + d.terminalAmount;
    await ctx.reply(`📊 **Z-Hisobot tasdiqlash**\n\nNaqd: ${formatMoney(d.cashUzs)}\nClick: ${formatMoney(d.clickAmount)}\nTerminal: ${formatMoney(d.terminalAmount)}\n\nJami: ${formatMoney(total)}\n\nYopaymi?`, { parse_mode: 'Markdown', reply_markup: getConfirmationKeyboard(actionId) });
  }
});

closingHandler.callbackQuery(/^confirm_zrep_/, async (ctx) => {
  const d = ctx.session.tempData;
  if (!d) return ctx.answerCallbackQuery({ text: "Eskirgan so'rov!", show_alert: true });
  const date = getToday();
  const payload = { cashUzs: d.cashUzs, clickAmount: d.clickAmount, terminalAmount: d.terminalAmount, isClosed: true };
  try {
    await prisma.dailyRegister.upsert({ where: { date }, update: payload, create: { date, ...payload } });
    await ctx.editMessageText('✅ Kassa muvaffaqiyatli yopildi!');
  } catch {
    await ctx.answerCallbackQuery({ text: 'Xatolik yuz berdi.', show_alert: true });
  } finally {
    clearSession(ctx);
  }
});

closingHandler.callbackQuery(/^cancel_zrep_/, async (ctx) => {
  clearSession(ctx);
  await ctx.editMessageText('❌ Z-Hisobot bekor qilindi.');
});

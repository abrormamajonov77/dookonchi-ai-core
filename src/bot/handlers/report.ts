import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { ReportPeriod, ReportService } from '../../services/report.service';
import { replyOrEdit } from '../../utils/telegram';
import { logger } from '../../config/logger';

export const reportHandler = new Composer<MyContext>();

const VALID_PERIODS: ReportPeriod[] = ['current_week', 'last_week', 'current_month', 'last_month'];

export function getReportKeyboard(activePeriod: ReportPeriod): InlineKeyboard {
  return new InlineKeyboard()
    .text(activePeriod === 'current_week' ? '✅ Shu hafta' : '📅 Shu hafta', 'rep:p:current_week')
    .text(activePeriod === 'last_week' ? "✅ O'tgan hafta" : "⏪ O'tgan hafta", 'rep:p:last_week')
    .row()
    .text(activePeriod === 'current_month' ? '✅ Shu oy' : '📆 Shu oy', 'rep:p:current_month')
    .text(activePeriod === 'last_month' ? "✅ O'tgan oy" : "⏮ O'tgan oy", 'rep:p:last_month')
    .row()
    .text('🔄 Yangilash', `rep:p:${activePeriod}`)
    .text('🔙 Asosiy', 'menu:main');
}

async function sendPeriodReport(ctx: MyContext, period: ReportPeriod, isEdit = false) {
  if (ctx.user?.role !== 'OWNER') {
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "Sizda ushbu amal uchun huquq yo'q!", show_alert: true });
    }
    return;
  }

  try {
    const text = await ReportService.generateReport(period);
    const kb = getReportKeyboard(period);
    await replyOrEdit(ctx, text, kb, isEdit);
  } catch (error) {
    logger.error({ error, period }, 'Error generating periodic report');
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Hisobotni shakllantirishda xatolik yuz berdi.', show_alert: true });
    } else {
      await ctx.reply('❌ Hisobotni shakllantirishda xatolik yuz berdi.');
    }
  }
}

reportHandler.hears('📈 Davriy Hisobot', async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  const defaultPeriod: ReportPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
  await sendPeriodReport(ctx, defaultPeriod, false);
});

reportHandler.command(['report', 'hisobot'], async (ctx) => {
  if (ctx.user?.role !== 'OWNER') return;
  const defaultPeriod: ReportPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
  await sendPeriodReport(ctx, defaultPeriod, false);
});

reportHandler.callbackQuery(/^rep:p:(.+)$/, async (ctx) => {
  const period = ctx.match[1] as ReportPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return ctx.answerCallbackQuery({ text: "Noto'g'ri davr tanlandi." });
  }
  await sendPeriodReport(ctx, period, true);
});


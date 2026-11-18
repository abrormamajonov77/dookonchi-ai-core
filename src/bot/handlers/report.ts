import { Composer, InlineKeyboard, InputFile } from 'grammy';
import { MyContext } from '../context';
import { ReportPeriod, ReportService } from '../../services/report.service';
import { ExportService } from '../../services/export.service';
import { clearSession, replyOrEdit, withChatAction } from '../../utils/telegram';
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
    .text('📥 Excel (.csv) yuklab olish', 'export:excel')
    .text('📄 PDF hisobot yuklab olish', 'export:pdf')
    .row()
    .text('🔄 Yangilash', `rep:p:${activePeriod}`)
    .text('🔙 Asosiy', 'menu:main');
}

async function sendPeriodReport(ctx: MyContext, period: ReportPeriod, isEdit = false) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);

  try {
    const text = await ReportService.generateReport(period, new Date(), ownerId);
    const kb = getReportKeyboard(period);
    await replyOrEdit(ctx, text, kb, isEdit);
  } catch (error) {
    logger.error({ error, period, ownerId }, 'Error generating periodic report');
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Hisobotni shakllantirishda xatolik yuz berdi.', show_alert: true });
    } else {
      await ctx.reply('❌ Hisobotni shakllantirishda xatolik yuz berdi.');
    }
  }
}

async function sendOwnerDatabaseExports(
  ctx: MyContext,
  mode: 'all' | 'excel' | 'pdf' = 'all'
) {
  if (!ctx.from) return;
  const ownerId = String(ctx.from.id);

  await withChatAction(ctx, 'upload_document', async () => {
    try {
      const exported = await ExportService.exportOwnerDatabase(ownerId);
      const captionSummary =
        `📊 **Shaxsiy bazangiz hisoboti tayyor!**\n` +
        `• Ta'minotchilar: **${exported.suppliers.length} ta**\n` +
        `• Nakladnoylar: **${exported.invoices.length} ta**\n` +
        `• Z-Otchyotlar: **${exported.zReports.length} ta**`;

      if (mode === 'all' || mode === 'excel') {
        await ctx.replyWithDocument(new InputFile(exported.excelBuffer, exported.excelFilename), {
          caption: `📥 **Excel (.csv) Jadval**\n${captionSummary}`,
          parse_mode: 'Markdown',
        });
      }

      if (mode === 'all' || mode === 'pdf') {
        await ctx.replyWithDocument(new InputFile(exported.pdfBuffer, exported.pdfFilename), {
          caption: `📄 **PDF Hisobot**\n${captionSummary}`,
          parse_mode: 'Markdown',
        });
      }
    } catch (error) {
      logger.error({ error, ownerId }, 'Error exporting database');
      await ctx.reply('❌ Bazani yuklab olishda xatolik yuz berdi.');
    }
  });
}

reportHandler.hears('📈 Davriy Hisobot', async (ctx) => {
  clearSession(ctx);
  const defaultPeriod: ReportPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
  await sendPeriodReport(ctx, defaultPeriod, false);
});

reportHandler.hears('📥 Bazani yuklab olish (Excel / PDF)', async (ctx) => {
  clearSession(ctx);
  await sendOwnerDatabaseExports(ctx, 'all');
});

reportHandler.command(['report', 'hisobot'], async (ctx) => {
  const defaultPeriod: ReportPeriod = new Date().getDay() === 1 ? 'last_week' : 'current_week';
  await sendPeriodReport(ctx, defaultPeriod, false);
});

reportHandler.command('export', async (ctx) => {
  await sendOwnerDatabaseExports(ctx, 'all');
});

reportHandler.callbackQuery(/^rep:p:(.+)$/, async (ctx) => {
  const period = ctx.match[1] as ReportPeriod;
  if (!VALID_PERIODS.includes(period)) {
    return ctx.answerCallbackQuery({ text: "Noto'g'ri davr tanlandi." });
  }
  await sendPeriodReport(ctx, period, true);
});

reportHandler.callbackQuery('export:excel', async (ctx) => {
  await sendOwnerDatabaseExports(ctx, 'excel');
});

reportHandler.callbackQuery('export:pdf', async (ctx) => {
  await sendOwnerDatabaseExports(ctx, 'pdf');
});

reportHandler.callbackQuery('export:all', async (ctx) => {
  await sendOwnerDatabaseExports(ctx, 'all');
});

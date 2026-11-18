import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { SearchService } from '../../services/search.service';
import { isMenuButton } from '../keyboards/menu';
import { clearSession, safeReply } from '../../utils/telegram';

export const searchHandler = new Composer<MyContext>();

searchHandler.hears(['📝 Qidiruv', '🔍 Qidiruv'], async (ctx) => {
  clearSession(ctx);
  ctx.session.step = 'SEARCH';
  await ctx.reply("🔍 Qidirmoqchi bo'lgan mahsulot yoki ta'minotchi nomini yozing (kamida 2 ta harf):");
});

searchHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'SEARCH' || !ctx.from) return next();
  const ownerId = String(ctx.from.id);
  const query = ctx.message.text.trim();
  if (query.startsWith('/') || isMenuButton(query)) {
    clearSession(ctx);
    return next();
  }
  if (query.length < 2) return ctx.reply('Iltimos, kamida 2 ta harf yozing.');

  const r = await SearchService.multiSearch(query, ownerId);
  if (!r.items.length && !r.suppliers.length && !r.customers.length && !r.transactions.length) {
    ctx.session.step = undefined;
    return ctx.reply('Hech narsa topilmadi.');
  }

  const kb = new InlineKeyboard();
  const messageBlocks: string[] = [];

  if (r.items.length > 0) {
    for (const item of r.items.slice(0, 8)) {
      messageBlocks.push(item.formattedCard);
    }
  }

  if (r.suppliers.length > 0) {
    const supLines = r.suppliers.slice(0, 8).map((s) => `• 🏢 ${s.name} (${s.amountText})`).join('\n');
    messageBlocks.push(`🏢 Ta'minotchilar:\n${supLines}`);
    for (const s of r.suppliers.slice(0, 8)) {
      kb.text(`🏢 ${s.name.slice(0, 32)}`, `sup:v:${s.id}`).row();
    }
  }

  if (r.customers.length > 0) {
    const custLines = r.customers.slice(0, 8).map((c) => `• 👤 ${c.name} (${c.amountText})`).join('\n');
    messageBlocks.push(`👥 Nasiyadorlar:\n${custLines}`);
    for (const c of r.customers.slice(0, 8)) {
      kb.text(`👤 ${c.name.slice(0, 32)}`, `debt:v:${c.id}`).row();
    }
  }

  ctx.session.step = undefined;
  await safeReply(ctx, messageBlocks.join('\n\n────────────────────\n\n'), {
    reply_markup: kb.inline_keyboard.length > 0 ? kb : undefined,
  });
});

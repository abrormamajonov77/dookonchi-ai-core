import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { SearchService } from '../../services/search.service';

export const searchHandler = new Composer<MyContext>();

searchHandler.hears(['📝 Qidiruv', '🔍 Qidiruv'], async (ctx) => {
  ctx.session.step = 'SEARCH';
  await ctx.reply("🔍 Qidirmoqchi bo'lgan mahsulot yoki ta'minotchi nomini yozing (kamida 2 ta harf):");
});

searchHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'SEARCH') return next();
  const query = ctx.message.text.trim();
  if (query.startsWith('/')) return next();
  if (query.length < 2) return ctx.reply('Iltimos, kamida 2 ta harf yozing.');

  const r = await SearchService.multiSearch(query);
  if (!r.items.length && !r.suppliers.length && !r.customers.length && !r.transactions.length) {
    ctx.session.step = undefined;
    return ctx.reply('Hech narsa topilmadi.');
  }

  const kb = new InlineKeyboard();
  const messageBlocks: string[] = [];

  // 1. PRODUCT-FIRST: Display matched products with Price Tracker dynamics first!
  if (r.items.length > 0) {
    for (const item of r.items) {
      messageBlocks.push(item.formattedCard);
    }
  }

  // 2. Append matching suppliers/customers below & add supplier buttons
  if (r.suppliers.length > 0) {
    const supLines = r.suppliers.map((s) => `• 🏢 ${s.name} (${s.amountText})`).join('\n');
    messageBlocks.push(`🏢 Ta'minotchilar:\n${supLines}`);
    for (const s of r.suppliers) {
      kb.text(`🏢 ${s.name}`, `sup:v:${s.id}`).row();
    }
  }

  if (r.customers.length > 0) {
    const custLines = r.customers.map((c) => `• 👤 ${c.name} (${c.amountText})`).join('\n');
    messageBlocks.push(`👥 Nasiyadorlar:\n${custLines}`);
    for (const c of r.customers) {
      kb.text(`👤 ${c.name}`, `debt:v:${c.id}`).row();
    }
  }

  ctx.session.step = undefined;
  await ctx.reply(messageBlocks.join('\n\n────────────────────\n\n'), {
    reply_markup: kb.inline_keyboard.length > 0 ? kb : undefined,
  });
});

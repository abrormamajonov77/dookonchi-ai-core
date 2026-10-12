import { Composer, InlineKeyboard } from 'grammy';
import { MyContext } from '../context';
import { SearchService } from '../../services/search.service';

export const searchHandler = new Composer<MyContext>();

searchHandler.hears('📝 Qidiruv', async (ctx) => {
  ctx.session.step = 'SEARCH';
  await ctx.reply("Qidirmoqchi bo'lgan nom yoki so'zni yozing (kamida 2 ta harf):");
});

searchHandler.on('message:text', async (ctx, next) => {
  if (ctx.session.step !== 'SEARCH') return next();

  const query = ctx.message.text.trim();
  
  if (query.length < 2) {
    return ctx.reply("Iltimos, kamida 2 ta harf yozing.");
  }

  const results = await SearchService.multiSearch(query);

  const hasAnyResults = results.suppliers.length > 0 || results.customers.length > 0 || results.transactions.length > 0 || results.items.length > 0;

  if (!hasAnyResults) {
    return ctx.reply("Hech narsa topilmadi.");
  }

  if (results.items && results.items.length > 0) {
    for (const item of results.items) {
      let itemText = `🔍 *Topilgan Tovar:* ${item.productName}\n`;
      itemText += `📦 *Oxirgi partiya:* ${new Intl.DateTimeFormat('uz-UZ', { dateStyle: 'short' }).format(item.date)}\n`;
      itemText += `🏢 *Kimdan olingan:* ${item.partyName}\n`;
      itemText += `💰 *Kirim narxi:* ${item.unitPrice.toLocaleString('uz-UZ')} UZS\n`;
      itemText += `📊 *Kiritilgan miqdor:* ${item.quantity}\n`;

      const itemKb = new InlineKeyboard();
      if (!item.isCash) {
        itemKb.text("📄 Nakladnoy chekini ko'rish", `sup:v:${item.id}`);
      }
      
      await ctx.reply(itemText, { parse_mode: 'Markdown', reply_markup: itemKb.inline_keyboard.length > 0 ? itemKb : undefined });
    }
  }

  let text = `🔍 *Boshqa qidiruv natijalari ("${query}"):*\n\n`;
  const keyboard = new InlineKeyboard();

  text += `🏢 *Ta'minotchilar:*\n`;
  if (results.suppliers.length > 0) {
    results.suppliers.forEach(r => {
      text += `• ${r.name} (${r.amountText})\n`;
      keyboard.text(`🏢 ${r.name.substring(0, 10)}`, `sup:v:${r.id}`);
    });
    keyboard.row();
  } else {
    text += `(Natija yo'q)\n`;
  }
  text += `\n`;

  text += `👥 *Nasiyadorlar:*\n`;
  if (results.customers.length > 0) {
    results.customers.forEach(r => {
      text += `• ${r.name} (${r.amountText})\n`;
      keyboard.text(`👤 ${r.name.substring(0, 10)}`, `debt:v:${r.id}`);
    });
    keyboard.row();
  } else {
    text += `(Natija yo'q)\n`;
  }
  text += `\n`;

  text += `🧾 *Oxirgi amaliyotlar / Cheklar:*\n`;
  if (results.transactions.length > 0) {
    results.transactions.forEach(r => {
      text += `• ${r.name} (${r.amountText})\n`;
      keyboard.text(`🧾 Ch: ${r.name.split('—')[1]?.substring(0, 8) || 'chek'}`, `sup:v:${r.id}`);
    });
    keyboard.row();
  } else {
    text += `(Natija yo'q)\n`;
  }

  ctx.session.step = undefined;
  await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
});

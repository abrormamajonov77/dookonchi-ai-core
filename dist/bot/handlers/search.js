"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHandler = void 0;
const grammy_1 = require("grammy");
const search_service_1 = require("../../services/search.service");
const formatters_1 = require("../../utils/formatters");
exports.searchHandler = new grammy_1.Composer();
exports.searchHandler.hears('📝 Qidiruv', async (ctx) => {
    ctx.session.step = 'SEARCH';
    await ctx.reply("Qidirmoqchi bo'lgan nom yoki so'zni yozing (kamida 2 ta harf):");
});
exports.searchHandler.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'SEARCH')
        return next();
    const query = ctx.message.text.trim();
    if (query.length < 2)
        return ctx.reply('Iltimos, kamida 2 ta harf yozing.');
    const r = await search_service_1.SearchService.multiSearch(query);
    if (!r.suppliers.length && !r.customers.length && !r.transactions.length && !r.items.length)
        return ctx.reply('Hech narsa topilmadi.');
    for (const item of r.items) {
        const kb = !item.isCash ? new grammy_1.InlineKeyboard().text("📄 Nakladnoy chekini ko'rish", `sup:v:${item.id}`) : undefined;
        await ctx.reply(`🔍 *Topilgan Tovar:* ${item.productName}\n📦 *Oxirgi partiya:* ${(0, formatters_1.formatDateShort)(item.date)}\n🏢 *Kimdan olingan:* ${item.partyName}\n💰 *Kirim narxi:* ${item.unitPrice.toLocaleString('uz-UZ')} UZS\n📊 *Kiritilgan miqdor:* ${item.quantity}`, { parse_mode: 'Markdown', reply_markup: kb });
    }
    const kb = new grammy_1.InlineKeyboard();
    const sec = (title, list, btn) => {
        if (!list.length)
            return `${title}\n(Natija yo'q)\n\n`;
        list.forEach(x => kb.text(...btn(x)));
        kb.row();
        return `${title}\n${list.map(x => `• ${x.name} (${x.amountText})`).join('\n')}\n\n`;
    };
    const text = `🔍 *Boshqa qidiruv natijalari ("${query}"):*\n\n` +
        sec("🏢 *Ta'minotchilar:*", r.suppliers, x => [`🏢 ${x.name.substring(0, 10)}`, `sup:v:${x.id}`]) +
        sec('👥 *Nasiyadorlar:*', r.customers, x => [`👤 ${x.name.substring(0, 10)}`, `debt:v:${x.id}`]) +
        sec('🧾 *Oxirgi amaliyotlar / Cheklar:*', r.transactions, x => [`🧾 Ch: ${x.name.split('—')[1]?.substring(0, 8) || 'chek'}`, `sup:v:${x.id}`]);
    ctx.session.step = undefined;
    await ctx.reply(text.trimEnd(), { parse_mode: 'Markdown', reply_markup: kb });
});

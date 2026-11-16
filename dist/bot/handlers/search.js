"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchHandler = void 0;
const grammy_1 = require("grammy");
const search_service_1 = require("../../services/search.service");
exports.searchHandler = new grammy_1.Composer();
exports.searchHandler.hears(['📝 Qidiruv', '🔍 Qidiruv'], async (ctx) => {
    ctx.session.step = 'SEARCH';
    await ctx.reply("🔍 Qidirmoqchi bo'lgan mahsulot yoki ta'minotchi nomini yozing (kamida 2 ta harf):");
});
exports.searchHandler.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'SEARCH' || !ctx.from)
        return next();
    const ownerId = String(ctx.from.id);
    const query = ctx.message.text.trim();
    if (query.startsWith('/'))
        return next();
    if (query.length < 2)
        return ctx.reply('Iltimos, kamida 2 ta harf yozing.');
    const r = await search_service_1.SearchService.multiSearch(query, ownerId);
    if (!r.items.length && !r.suppliers.length && !r.customers.length && !r.transactions.length) {
        ctx.session.step = undefined;
        return ctx.reply('Hech narsa topilmadi.');
    }
    const kb = new grammy_1.InlineKeyboard();
    const messageBlocks = [];
    if (r.items.length > 0) {
        for (const item of r.items) {
            messageBlocks.push(item.formattedCard);
        }
    }
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

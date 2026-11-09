"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cashHandler = void 0;
const grammy_1 = require("grammy");
const prisma_1 = require("../../database/prisma");
const formatters_1 = require("../../utils/formatters");
const inline_1 = require("../keyboards/inline");
const telegram_1 = require("../../utils/telegram");
exports.cashHandler = new grammy_1.Composer();
exports.cashHandler.hears('💵 Naqd', async (ctx) => {
    if (ctx.user?.role !== 'OWNER')
        return;
    const now = new Date();
    const [recentTx, monthStats, dayStats] = await Promise.all([
        prisma_1.prisma.cashTransaction.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
        prisma_1.prisma.cashTransaction.aggregate({ where: { createdAt: { gte: new Date(now.getFullYear(), now.getMonth(), 1) } }, _sum: { amount: true } }),
        prisma_1.prisma.cashTransaction.aggregate({ where: { createdAt: { gte: (0, formatters_1.getToday)() } }, _sum: { amount: true } })
    ]);
    const txLines = recentTx.length
        ? `📝 **Oxirgi 10 ta amaliyot:**\n` + recentTx.map(tx => `🔹 ${(0, formatters_1.formatDate)(tx.createdAt)} | **${tx.partyName}** - ${(0, formatters_1.formatMoney)(tx.amount)}${tx.items ? `\n   ✏️ ${tx.items}` : ''}`).join('\n')
        : "Amaliyotlar yo'q.";
    await ctx.reply(`💵 **Naqd Savdo va Xaridlar Arxiv:**\n\n📊 **Bugungi aylanma:** ${(0, formatters_1.formatMoney)(dayStats._sum.amount || 0)}\n📊 **Shu oydagi aylanma:** ${(0, formatters_1.formatMoney)(monthStats._sum.amount || 0)}\n\n${txLines}`, { parse_mode: 'Markdown', reply_markup: new grammy_1.InlineKeyboard().text('➕ Yangi naqd xarid', 'cash:new') });
});
exports.cashHandler.callbackQuery('cash:new', async (ctx) => {
    ctx.session.step = 'ADD_CASH_TEMPLATE';
    await ctx.reply(`👇 **"Shablonni to'ldirish"** tugmasini bosing!\nShunda shablon matni avtomatik ravishda yozish maydoningizga tushadi va siz faqat kerakli joylarini to'ldirib yuborasiz.\n\n💡 *Eslatma:* Siz oddiy matn orqali (masalan: "Naqdga 200 ming shakar oldik") yozsangiz ham bot buni to'g'ri tushunadi.`, { parse_mode: 'Markdown', reply_markup: new grammy_1.InlineKeyboard().switchInlineCurrent("✍️ Shablonni to'ldirish", `Operatsiya: Naqd xarid\nKimdan/Brend: \nSumma: \nTovar/Izoh: `) });
});
exports.cashHandler.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'ADD_CASH_TEMPLATE')
        return next();
    const text = ctx.message.text;
    if (!text.includes('Operatsiya: Naqd xarid')) {
        ctx.session.step = undefined;
        return next();
    }
    const partyName = text.match(/Kimdan\/Brend:\s*([^\n]+)/i)?.[1]?.trim() || '';
    const amount = Number((text.match(/Summa:\s*([^\n]+)/i)?.[1] || '').replace(/\D/g, ''));
    const items = text.match(/Tovar\/Izoh:\s*([\s\S]+)/i)?.[1]?.trim() || '';
    if (!amount)
        return ctx.reply('❌ Summani aniqlab bo\'lmadi. Iltimos, raqamlarda kiriting.');
    const actionId = `cash_conf_${Date.now()}`;
    ctx.session.tempData = { type: 'CASH_TEMPLATE', data: { amount, partyName, items } };
    ctx.session.step = actionId;
    const confirmText = `🧾 *Naqd Xarid Tahlili:*\n▫️ *Operatsiya:* Naqd\n▫️ *Kimdan:* ${partyName || "Noma'lum"}\n▫️ *Summa:* ${(0, formatters_1.formatMoney)(amount)}\n${items ? `▫️ *Tovar/Izoh:* ${items}\n` : ''}\n*(Bu operatsiya qarzlar balansiga ta'sir qilmaydi)*\nMa'lumotlar to'g'rimi?`;
    await ctx.reply(confirmText, { parse_mode: 'Markdown', reply_markup: (0, inline_1.getTemplateConfirmKeyboard)('cash:edit', actionId) });
});
(0, telegram_1.registerTemplateActions)(exports.cashHandler, 'cash', 'ADD_CASH_TEMPLATE', 'CASH_TEMPLATE', async (_ctx, { amount, partyName, items }) => {
    await prisma_1.prisma.cashTransaction.create({ data: { partyName: partyName || "Noma'lum", amount, items: items || null } });
    return `✅ Naqd xarid saqlandi:\nKimdan: ${partyName || "Noma'lum"}\nSumma: ${(0, formatters_1.formatMoney)(amount)}${items ? `\nIzoh: ${items}` : ''}\n*(Ushbu summa qarzga ta'sir qilmadi)*`;
});

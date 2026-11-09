"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startHandler = void 0;
const grammy_1 = require("grammy");
const menu_1 = require("../keyboards/menu");
const telegram_1 = require("../../utils/telegram");
exports.startHandler = new grammy_1.Composer();
exports.startHandler.command('start', async (ctx) => {
    if (!ctx.user)
        return;
    await ctx.reply(`Assalomu alaykum, ${ctx.user.name}! Meni ismim ⚡️ *SmartBaqqol AI*.\n\nMen do'koningizdagi xarajatlar, nakladnoylar va qarzlar hisobini yuritishga yordam beruvchi aqlli yordamchiman. \nMenga tovarlar yozilgan *chek/nakladnoy rasmini* yuboring yoki *ovozli xabar* orqali amaliyotlarni (masalan: "Ijaraga 200 dollar berdim") ayting, qolganini o'zim hal qilaman!\n\nSizning rolingiz: *${ctx.user.role}*`, { parse_mode: 'Markdown', reply_markup: (0, menu_1.getMainMenu)(ctx.user.role) });
});
exports.startHandler.callbackQuery('menu:main', async (ctx) => {
    await (0, telegram_1.safeDelete)(ctx, ctx.chat?.id, ctx.callbackQuery.message?.message_id);
    await ctx.reply('Bosh menyudasiz 👇', { reply_markup: (0, menu_1.getMainMenu)(ctx.user?.role || 'SELLER') });
});

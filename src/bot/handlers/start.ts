import { Composer } from 'grammy';
import { MyContext } from '../context';
import { getMainMenu } from '../keyboards/menu';
import { safeDelete } from '../../utils/telegram';

export const startHandler = new Composer<MyContext>();

startHandler.command('start', async (ctx) => {
  if (!ctx.user) return;
  await ctx.reply(`Assalomu alaykum, ${ctx.user.name}! Meni ismim ⚡️ *SmartBaqqol AI*.\n\nMen do'koningizdagi xarajatlar, nakladnoylar va qarzlar hisobini yuritishga yordam beruvchi aqlli yordamchiman. \nMenga tovarlar yozilgan *chek/nakladnoy rasmini* yuboring yoki *ovozli xabar* orqali amaliyotlarni (masalan: "Ijaraga 200 dollar berdim") ayting, qolganini o'zim hal qilaman!\n\nSizning rolingiz: *${ctx.user.role}*`, { parse_mode: 'Markdown', reply_markup: getMainMenu(ctx.user.role) });
});

startHandler.callbackQuery('menu:main', async (ctx) => {
  await safeDelete(ctx, ctx.chat?.id, ctx.callbackQuery.message?.message_id);
  await ctx.reply('Bosh menyudasiz 👇', { reply_markup: getMainMenu(ctx.user?.role || 'SELLER') });
});

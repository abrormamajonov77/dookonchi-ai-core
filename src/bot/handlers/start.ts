import { Composer } from 'grammy';
import { MyContext } from '../context';
import { getMainMenu } from '../keyboards/menu';

export const startHandler = new Composer<MyContext>();

startHandler.command('start', async (ctx) => {
  if (!ctx.user) return;
  const menu = getMainMenu(ctx.user.role);
  
  const introText = `Assalomu alaykum, ${ctx.user.name}! Meni ismim ⚡️ *SmartBaqqol AI*.

Men do'koningizdagi xarajatlar, nakladnoylar va qarzlar hisobini yuritishga yordam beruvchi aqlli yordamchiman. 
Menga tovarlar yozilgan *chek/nakladnoy rasmini* yuboring yoki *ovozli xabar* orqali amaliyotlarni (masalan: "Ijaraga 200 dollar berdim") ayting, qolganini o'zim hal qilaman!

Sizning rolingiz: *${ctx.user.role}*`;

  await ctx.reply(introText, {
    parse_mode: 'Markdown',
    reply_markup: menu
  });
});

startHandler.callbackQuery('menu:main', async (ctx) => {
  await ctx.api.deleteMessage(ctx.chat!.id, ctx.callbackQuery.message!.message_id).catch(() => {});
  const menu = getMainMenu(ctx.user?.role || 'SELLER');
  await ctx.reply("Bosh menyudasiz 👇", { reply_markup: menu });
});

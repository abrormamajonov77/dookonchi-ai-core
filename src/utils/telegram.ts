export async function withChatAction<T>(
  ctx: any,
  action: 'typing' | 'upload_photo' | 'record_voice' | 'upload_document' | 'choose_sticker' | 'find_location' | 'record_video' | 'upload_video',
  task: () => Promise<T>
): Promise<T> {
  // 1. Darhol birinchi action'ni yuborish
  await ctx.replyWithChatAction(action).catch(() => {});

  // 2. Har 4 soniyada qayta yuborib turuvchi interval
  const interval = setInterval(() => {
    ctx.replyWithChatAction(action).catch(() => {});
  }, 4000);

  try {
    // 3. Asosiy AI yoki Baza vazifasini bajarish
    return await task();
  } finally {
    // 4. Vazifa qanday tugashidan qat'i nazar intervalni to'xtatish
    clearInterval(interval);
  }
}

export async function handleInlineAction<T>(
  ctx: any,
  task: () => Promise<T>
): Promise<T> {
  try {
    return await task();
  } finally {
    // Vazifa qanday tugashidan qat'i nazar, spinnerni xavfsiz yopish
    await ctx.answerCallbackQuery().catch(() => {});
  }
}

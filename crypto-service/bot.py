import asyncio
import logging
import os
import sys

# Ensure crypto-service directory is on sys.path regardless of cwd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import aiohttp
import aiohttp.connector
import ccxt.async_support as ccxt
from aiogram import Bot, Dispatcher, types
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton

# Windows va cheklangan tarmoqlarda aiodns xatosini oldini olish
try:
    if hasattr(aiohttp.connector, 'DefaultResolver'):
        aiohttp.connector.DefaultResolver = aiohttp.ThreadedResolver
except Exception:
    pass

from config import TELEGRAM_BOT_TOKEN
from database import init_db, add_user, get_all_users
from services.sniper_engine import sniper_scanner_loop
from services.spot_engine import spot_scanner_loop
from services.monitor_engine import background_checker, weekly_reporter, daily_reporter

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
)
logger = logging.getLogger(__name__)


class CustomAiohttpSession(AiohttpSession):
    async def create_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(resolver=aiohttp.ThreadedResolver()),
                timeout=aiohttp.ClientTimeout(total=self.timeout),
                json_serialize=self.json_dumps,
            )
        return self._session


bot = Bot(
    token=TELEGRAM_BOT_TOKEN,
    session=CustomAiohttpSession(),
    default=DefaultBotProperties(parse_mode='HTML'),
)
dp = Dispatcher()

mexc = ccxt.mexc({
    'enableRateLimit': True,
    'options': {'defaultType': 'spot'},
})


# CCXT 'spot' bo'lsa ham orqa fonda fetch_swap_markets orqali contract API'ga
# so'rov yuborib qulamasligi uchun swap marketlarni bo'sh qaytaramiz.
async def mock_fetch_swap_markets(*args, **kwargs):
    return []


mexc.fetch_swap_markets = mock_fetch_swap_markets


@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    user_id = message.from_user.id
    await add_user(user_id)

    warning_text = (
        "⚠️ <b>DIQQAT - MOLIYAVIY MASLAHAT EMAS!</b> ⚠️\n\n"
        "Ushbu bot faqatgina bozor holatini tahlil qilib, <b>yordamchi signallar</b> beradi. "
        "Bot yuborgan signallar 100% to'g'ri chiqishiga kafolat yo'q. "
        "Iltimos, har bir signalni o'zingiz qayta tahlil qiling va faqat o'z xavf-xataringiz ostida savdoga kiring!\n\n"
        "<i>Bot sizga avtomatik signallarni shu yerga yuborishni boshlaydi (Snayper va Spot). Kutib turing... 🚀</i>"
    )
    image_url = "https://images.unsplash.com/photo-1621416894569-0f39ed31d247?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80"
    try:
        await message.answer_photo(photo=image_url, caption=warning_text)
    except Exception:
        await message.answer(warning_text)


@dp.message(Command("status"))
async def cmd_status(message: types.Message):
    """Foydalanuvchi bot ishlayotganini tekshirishi uchun ping komandasi."""
    status_msg = (
        "✅ <b>Cryptoavtoai Bot faol holatda ishlayapti!</b>\n\n"
        "Barcha tizimlar joyida:\n"
        "🚀 Snayper skaneri (15M/1H/4H)\n"
        "🔭 Spot skaneri (1D)\n"
        "🛡 Monitor (TP/SL kuzatish)\n\n"
        "<i>Bozorda qulay imkoniyat paydo bo'lishi bilan signal yuboriladi...</i>"
    )
    await message.answer(status_msg)


async def send_to_all_users(text, symbol=None, reply_to_message_ids=None):
    """Barcha foydalanuvchilarga xabar yuborish (Snayper/Spot uchun)."""
    tv_url = f"https://www.tradingview.com/chart/?symbol=MEXC:{symbol.replace('/', '')}" if symbol else None
    reply_markup = None
    if tv_url:
        kb = [[InlineKeyboardButton(text="📈 TradingView'da ko'rish", url=tv_url)]]
        reply_markup = InlineKeyboardMarkup(inline_keyboard=kb)

    users = await get_all_users()
    sent_messages = {}

    for u in users:
        try:
            reply_to = reply_to_message_ids.get(str(u)) if reply_to_message_ids else None
            sent_msg = await bot.send_message(
                chat_id=u,
                text=text,
                reply_markup=reply_markup,
                reply_to_message_id=reply_to,
                link_preview_options=types.LinkPreviewOptions(is_disabled=True),
            )
            sent_messages[str(u)] = sent_msg.message_id
        except Exception as e:
            logger.error(f"[{symbol}] Telegram yuborishda xatolik user {u} uchun: {e}")

    return sent_messages


def _log_task_exception(task: asyncio.Task) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc:
        logger.error("Background task %s failed with unhandled exception", task.get_name(), exc_info=exc)


async def main():
    logger.info("Cryptoavtoai bot tizimlari ishga tushirilmoqda...")
    await init_db()

    try:
        await bot.delete_webhook(drop_pending_updates=False)
        logger.info("✅ Webhook tozalandi, polling rejimiga o'tildi.")
    except Exception as e:
        logger.warning(f"Webhook tozalashda vaqtinchalik xatolik (polling davom etadi): {e}")

    bg_tasks = [
        asyncio.create_task(sniper_scanner_loop(mexc, send_to_all_users), name="sniper_scanner"),
        asyncio.create_task(spot_scanner_loop(mexc, send_to_all_users), name="spot_scanner"),
        asyncio.create_task(background_checker(mexc, send_to_all_users), name="monitor_checker"),
        asyncio.create_task(weekly_reporter(send_to_all_users), name="weekly_reporter"),
        asyncio.create_task(daily_reporter(send_to_all_users), name="daily_reporter"),
    ]
    for task in bg_tasks:
        task.add_done_callback(_log_task_exception)

    try:
        await dp.start_polling(bot)
    finally:
        for task in bg_tasks:
            task.cancel()
        await asyncio.gather(*bg_tasks, return_exceptions=True)
        await mexc.close()
        await bot.session.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bot to'xtatildi (KeyboardInterrupt).")
    except Exception:
        logger.exception("Cryptoavtoai bot kritik xatolik bilan to'xtadi")
        sys.exit(1)

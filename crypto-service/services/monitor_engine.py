import asyncio
import json
import logging
from datetime import datetime, timedelta
from config import GEMINI_KEY
from database import (
    get_pending_signals,
    update_signal_status,
    update_signal_sl,
    get_weekly_signals_stats,
    get_daily_coin_stats,
)

logger = logging.getLogger(__name__)

# Gemini AI Client (ixtiyoriy - faqat kunlik hisobot xulosasi uchun)
_ai_client = None
if GEMINI_KEY:
    try:
        from google import genai
        _ai_client = genai.Client(api_key=GEMINI_KEY)
    except Exception:
        try:
            import google.generativeai as legacy_genai
            legacy_genai.configure(api_key=GEMINI_KEY)
            _ai_client = legacy_genai.GenerativeModel('gemini-3.5-flash')
        except Exception:
            _ai_client = None


async def background_checker(mexc, telegram_notifier_func):
    """
    Kutayotgan (PENDING, TP1_HIT) signallarni tekshirib boradi, agar TP yoki SL urilsa xabar beradi.
    """
    logger.info("🛡 MonitorBot ishga tushdi! Ochiq signallar nazorat qilinmoqda...")
    while True:
        try:
            pending_signals = await get_pending_signals()
            for sig in pending_signals:
                try:
                    ticker = await mexc.fetch_ticker(sig['symbol'])
                    current_price = ticker['last']

                    sig_id = sig['id']
                    status = sig['status']
                    sig_type = sig['type']
                    entry = sig['entry']
                    tp1 = sig['tp']
                    tp2 = sig['tp2']
                    sl = sig['sl']

                    msg_type = None
                    new_status = None
                    new_sl = None

                    if status == 'PENDING':
                        sig_time_dt = datetime.fromisoformat(sig['timestamp'])
                        if sig['stars'] == 2 and (datetime.now() - sig_time_dt) > timedelta(hours=3):
                            await update_signal_status(sig_id, 'EXPIRED')
                            logger.info(f"{sig['symbol']} Scalp signali eskirgani uchun (3 soat) yopildi.")
                            continue

                        if sig_type == 'LONG':
                            if current_price >= tp1:
                                msg_type, new_status, new_sl = 'TP1', 'TP1_HIT', entry
                            elif current_price <= sl:
                                msg_type, new_status = 'LOSS', 'LOSS'
                        elif sig_type == 'SHORT':
                            if current_price <= tp1:
                                msg_type, new_status, new_sl = 'TP1', 'TP1_HIT', entry
                            elif current_price >= sl:
                                msg_type, new_status = 'LOSS', 'LOSS'

                    elif status == 'TP1_HIT':
                        if sig_type == 'LONG':
                            if tp2 and current_price >= tp2:
                                msg_type, new_status = 'WIN', 'WIN'
                            elif current_price <= sl:
                                msg_type, new_status = 'BREAK_EVEN', 'BREAK_EVEN'
                        elif sig_type == 'SHORT':
                            if tp2 and current_price <= tp2:
                                msg_type, new_status = 'WIN', 'WIN'
                            elif current_price >= sl:
                                msg_type, new_status = 'BREAK_EVEN', 'BREAK_EVEN'

                    if new_status:
                        await update_signal_status(sig_id, new_status)
                        if new_sl:
                            await update_signal_sl(sig_id, new_sl)

                        sig_time_str = datetime.fromisoformat(sig['timestamp']).strftime('%Y-%m-%d %H:%M')

                        if msg_type == 'TP1':
                            emo, res_str = "🎯", "Take-Profit 1 (TP1) urildi! 🥳\nSL kirish narxiga (Break-even) surildi."
                        elif msg_type == 'WIN':
                            emo, res_str = "🏆", "Take-Profit 2 (TP2) urildi! To'liq foyda 💸"
                        elif msg_type == 'LOSS':
                            emo, res_str = "🛑", "Stop-Loss urildi (Zarar bilan yopildi)."
                        else:
                            emo, res_str = "🛡", "Zararsiz yopildi (Break-even). TP1 dan keyin narx orqaga qaytdi."

                        msg = (
                            f"{emo} <b>{sig['symbol']}</b> | {sig_type} signali yangilandi!\n"
                            f"Natija: {res_str}\n\n"
                            f"🕒 Signal vaqti: {sig_time_str}\n"
                            f"💰 Joriy narx: ${current_price:.5f}"
                        )

                        msg_ids = json.loads(sig['message_ids']) if sig['message_ids'] else {}
                        await telegram_notifier_func(msg, sig['symbol'], msg_ids)

                except Exception as e:
                    logger.error(f"Narxni tekshirishda xato {sig['symbol']}: {e}")

        except Exception as e:
            logger.error(f"Background checker xatosi: {e}")

        await asyncio.sleep(60)


async def weekly_reporter(telegram_notifier_func):
    """
    Har yakshanba kechasi haftalik hisobot yuboradi.
    """
    while True:
        try:
            now = datetime.now()
            if now.weekday() == 6 and now.hour == 23 and 50 <= now.minute <= 59:
                last_week_iso = (now - timedelta(days=7)).isoformat()
                stats = await get_weekly_signals_stats(last_week_iso)

                data = {
                    5: {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0},
                    3: {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0},
                    2: {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0},
                }

                for row in stats:
                    stars, status, count = row[0], row[1], row[2]
                    if stars in data and status in data[stars]:
                        data[stars][status] += count

                report_parts = ["📊 <b>HAFTALIK SAVDO HISOBOTI</b> 📊\n━━━━━━━━━━━━━━━━━━━━━\n"]

                for star in [5, 3, 2]:
                    wins = data[star]['WIN']
                    losses = data[star]['LOSS']
                    bes = data[star]['BREAK_EVEN']
                    total = wins + losses + bes

                    if total > 0:
                        win_rate = (wins / total) * 100
                        star_icon = "⭐⭐⭐⭐⭐ (Spot)" if star == 5 else "⭐⭐⭐ (Snayper)" if star == 3 else "⭐⭐ (Scalping)"
                        report_parts.append(
                            f"🔹 <b>{star_icon}</b>\n"
                            f"Jami yopilgan: {total} ta\n"
                            f"🎯 TP: {wins} | 🛑 SL: {losses} | 🛡 BE: {bes}\n"
                            f"🏆 Aniqlik: <b>{win_rate:.1f}%</b>\n"
                            "━━━━━━━━━━━━━━━━━━━━━\n"
                        )

                if len(report_parts) > 1:
                    await telegram_notifier_func("".join(report_parts), None)

                await asyncio.sleep(3600)
            else:
                await asyncio.sleep(60)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Weekly reporter xatosi: {e}")
            await asyncio.sleep(60)


def _sync_generate_summary(prompt: str) -> str:
    if not _ai_client:
        raise RuntimeError("AI client not configured")
    if hasattr(_ai_client, 'models'):
        last_err = None
        for model_name in ('gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'):
            try:
                res = _ai_client.models.generate_content(model=model_name, contents=prompt)
                if res.text:
                    return res.text.strip()
            except Exception as err:
                last_err = err
        raise last_err or RuntimeError("Gemini models failed")
    return _ai_client.generate_content(prompt).text.strip()


async def generate_ai_summary(total_stats_text: str) -> str:
    fallback = "Tavakkalchilikni me'yorda ushlagan holda, intizom bilan davom etish tavsiya qilinadi."
    if not _ai_client:
        return fallback
    try:
        prompt = (
            f"Sen kriptovalyuta savdo boti tahlilchisisan. Bugungi natijalar:\n"
            f"{total_stats_text}\n"
            f"Shu natijaga qarab treyderga 1-2 ta gapdan iborat qisqa, "
            f"kreativ va motivatsion AI xulosasini yozib ber."
        )
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _sync_generate_summary, prompt)
    except Exception as e:
        logger.error(f"AI Summary xatosi: {e}")
        return fallback


async def daily_reporter(telegram_notifier_func):
    """
    Har kuni 17:00 da kunlik kreativ hisobot yuboradi.
    """
    while True:
        try:
            now = datetime.now()
            if now.hour == 17 and 0 <= now.minute <= 9:
                yesterday_iso = (now - timedelta(days=1)).isoformat()
                stats = await get_weekly_signals_stats(yesterday_iso)
                data = {
                    5: {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0},
                    3: {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0},
                    2: {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0},
                }
                total_signals = 0

                for row in stats:
                    stars, status, count = row[0], row[1], row[2]
                    if stars in data and status in data[stars]:
                        data[stars][status] += count
                        total_signals += count

                if total_signals > 0:
                    coin_stats = await get_daily_coin_stats(yesterday_iso)
                    coins_data = {5: {}, 3: {}, 2: {}}

                    for row in coin_stats:
                        stars, sym, status, count = row[0], row[1], row[2], row[3]
                        if stars in coins_data:
                            if sym not in coins_data[stars]:
                                coins_data[stars][sym] = {'WIN': 0, 'LOSS': 0, 'BREAK_EVEN': 0}
                            if status in coins_data[stars][sym]:
                                coins_data[stars][sym][status] += count

                    report_parts = [
                        "📊 <b>OXIRGI 24 SOATLIK SAVDO HISOBOTI</b> 📊\n"
                        "━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                    ]
                    stats_for_ai = ""

                    for star in [5, 3, 2]:
                        wins = data[star]['WIN']
                        losses = data[star]['LOSS']
                        bes = data[star]['BREAK_EVEN']
                        total = wins + losses + bes

                        if total > 0:
                            win_rate = (wins / total) * 100
                            star_icon = "⭐⭐⭐⭐⭐ (Spot)" if star == 5 else "⭐⭐⭐ (Snayper)" if star == 3 else "⭐⭐ (Scalping)"
                            coins_text = "\n".join(
                                f"🔸 {sym}: {cdata['WIN']}✅ | {cdata['LOSS']}❌ | {cdata['BREAK_EVEN']}🛡"
                                for sym, cdata in coins_data[star].items()
                            )
                            stats_for_ai += f"{star} Yulduz: {wins} Foyda, {losses} Zarar. Winrate: {win_rate:.1f}%\n"
                            report_parts.append(
                                f"🔹 <b>{star_icon}</b>\n"
                                f"Jami: {total} ta | 🎯 TP: {wins} | 🛑 SL: {losses} | 🛡 BE: {bes}\n"
                                f"🏆 Aniqlik: <b>{win_rate:.1f}%</b>\n\n"
                                f"🪙 <b>Tangalar bo'yicha:</b>\n"
                                f"{coins_text}\n"
                                "━━━━━━━━━━━━━━━━━━━━━━━━━\n"
                            )

                    ai_conclusion = await generate_ai_summary(stats_for_ai)
                    report_parts.append(
                        "🤖 <b>AI Xulosasi:</b>\n"
                        f"<i>💬 {ai_conclusion}</i>"
                    )
                    await telegram_notifier_func("".join(report_parts), None)

                await asyncio.sleep(3600)
            else:
                await asyncio.sleep(60)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.error(f"Daily reporter xatosi: {e}")
            await asyncio.sleep(60)

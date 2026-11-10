import asyncio
import json
import os
from datetime import datetime, timedelta
import pandas as pd
import pandas_ta as ta
import ccxt.async_support as ccxt
import aiohttp
import aiohttp.connector
from aiogram import Bot, Dispatcher, types
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.filters import Command
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
import feedparser
from dotenv import load_dotenv

# Windows yoki cheklangan tarmoqlarda aiodns xatosini oldini olish
try:
    if hasattr(aiohttp.connector, 'DefaultResolver'):
        aiohttp.connector.DefaultResolver = aiohttp.ThreadedResolver
except Exception:
    pass

load_dotenv()

# --- SOZLAMALAR ---
# 1-Bot (Snayper)
TOKEN = os.getenv('CRYPTO_SNIPER_BOT_TOKEN') or os.getenv('TELEGRAM_BOT_TOKEN')

# 2-Bot (Watcher)
WATCHER_TOKEN = os.getenv('CRYPTO_WATCHER_BOT_TOKEN') or os.getenv('WATCHER_TOKEN')
GEMINI_KEY = os.getenv('GEMINI_API_KEY') or os.getenv('GEMINI_KEY')
TARGET_CHANNEL = os.getenv('TARGET_CHANNEL', '@watcherguruuz')
RSS_URL = os.getenv('RSS_URL', 'https://watcher.guru/news/feed')

if not TOKEN:
    print("XATOLIK: CRYPTO_SNIPER_BOT_TOKEN yoki TELEGRAM_BOT_TOKEN kiritilmagan!")
    exit(1)

# Windows va cheklangan tarmoqlarda barqaror DNS yechimi
class CustomAiohttpSession(AiohttpSession):
    async def create_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(resolver=aiohttp.ThreadedResolver()),
                json_serialize=self.json_dumps,
            )
        return self._session

# Bot obyektlari
bot = Bot(token=TOKEN, session=CustomAiohttpSession(), default=DefaultBotProperties(parse_mode='HTML'))
watcher_bot = Bot(token=WATCHER_TOKEN, session=CustomAiohttpSession(), default=DefaultBotProperties(parse_mode='HTML')) if WATCHER_TOKEN else None
dp = Dispatcher()

# --- GEMINI AI CLIENT SOZLAMALARI ---
ai_client = None
if GEMINI_KEY:
    try:
        from google import genai
        ai_client = genai.Client(api_key=GEMINI_KEY)
    except Exception:
        try:
            import google.generativeai as legacy_genai
            legacy_genai.configure(api_key=GEMINI_KEY)
            ai_client = legacy_genai.GenerativeModel('gemini-3.5-flash')
        except Exception:
            ai_client = None

def translate_title(title: str) -> str:
    if not ai_client:
        return title
    prompt = f"Ushbu inglizcha moliyaviy yangilik sarlavhasini o'zbek tiliga professional, moliya jurnalistlari tilida tarjima qil. Ortiqcha gap qo'shma, faqat tarjimani ber.\nSarlavha: {title}"
    try:
        if hasattr(ai_client, 'models'):
            for model_name in ('gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'):
                try:
                    res = ai_client.models.generate_content(model=model_name, contents=prompt)
                    if res.text:
                        return res.text.strip()
                except Exception as e:
                    print(f"⚠️ {model_name} tarjima xatosi: {e}", flush=True)
        elif hasattr(ai_client, 'generate_content'):
            res = ai_client.generate_content(prompt)
            return res.text.strip()
    except Exception as e:
        print(f"⚠️ Tarjima xatosi: {e}", flush=True)
    return title

def xotirani_oqish():
    if os.path.exists("oxirgi_yangilik.txt"):
        try:
            with open("oxirgi_yangilik.txt", "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            pass
    return ""

def xotiraga_yozish(link):
    try:
        with open("oxirgi_yangilik.txt", "w", encoding="utf-8") as f:
            f.write(link)
    except Exception as e:
        print(f"Xotiraga yozishda xatolik: {e}")

async def check_news_loop():
    if not watcher_bot:
        print("ℹ️ WatcherBot sozlanmagan, yangiliklar moduli to'xtatildi.", flush=True)
        return
    print("🚀 WatcherBot (2-motor) ishga tushdi! Sayt kuzatilmoqda...", flush=True)
    while True:
        try:
            feed = feedparser.parse(RSS_URL)
            if feed.entries:
                latest_news = feed.entries[0]
                news_link = latest_news.link
                oxirgi_link = xotirani_oqish()

                if news_link != oxirgi_link:
                    if oxirgi_link == "":
                        print("🚀 Watcher: Birinchi marta ishga tushdi, xotira bo'sh. Faqat saqlaymiz.", flush=True)
                        xotiraga_yozish(news_link)
                    else:
                        print("🔔 Watcher: Yangi post topildi! Tarjima qilinmoqda...", flush=True)
                        title = latest_news.title
                        tarjima = translate_title(title)
                        
                        xabar = f"📰 <b>{tarjima}</b>\n\n👉 <a href='{news_link}'>Batafsil o'qish</a>\n\n🇺🇿 {TARGET_CHANNEL}"

                        image_url = None
                        if hasattr(latest_news, 'media_content') and len(latest_news.media_content) > 0:
                            image_url = latest_news.media_content[0].get('url')
                        elif hasattr(latest_news, 'enclosures') and len(latest_news.enclosures) > 0:
                            image_url = latest_news.enclosures[0].get('href')

                        if image_url:
                            await watcher_bot.send_photo(chat_id=TARGET_CHANNEL, photo=image_url, caption=xabar, parse_mode="HTML")
                        else:
                            await watcher_bot.send_message(chat_id=TARGET_CHANNEL, text=xabar, parse_mode="HTML")
                        
                        xotiraga_yozish(news_link)
                        print("✅ Watcher: Kanalga muvaffaqiyatli yuborildi!", flush=True)
        except Exception as e:
            print(f"❌ Watcher xatosi: {e}", flush=True)
        
        await asyncio.sleep(180)


# --- SNAYPER BOT QISMI (MEXC SCANNER) ---

USERS_FILE = 'users.json'
SIGNALS_FILE = 'signals.json'

def load_json(filename, default):
    if not os.path.exists(filename): return default
    with open(filename, 'r') as f:
        try: return json.load(f)
        except: return default

def save_json(filename, data):
    with open(filename, 'w') as f:
        json.dump(data, f, indent=4)

users = load_json(USERS_FILE, [])
signals_db = load_json(SIGNALS_FILE, [])
mexc = ccxt.mexc({'enableRateLimit': True})

MIN_24H_VOLUME = 1_000_000
TIMEFRAME = '15m'
MACRO_TIMEFRAME = '4h'
VOLUME_SPIKE_X = 2.5
PAST_CANDLES = 16
CONCURRENT_REQUESTS = 5

sem = asyncio.Semaphore(CONCURRENT_REQUESTS)
seen_signals = {} 

@dp.message(Command("start"))
async def cmd_start(message: types.Message):
    user_id = message.from_user.id
    if user_id not in users:
        users.append(user_id)
        save_json(USERS_FILE, users)
    
    warning_text = (
        "⚠️ <b>DIQQAT - MOLIYAVIY MASLAHAT EMAS!</b> ⚠️\n\n"
        "Ushbu bot faqatgina bozor holatini tahlil qilib, <b>yordamchi signallar</b> beradi. "
        "Bot yuborgan signallar 100% to'g'ri chiqishiga kafolat yo'q. "
        "Iltimos, har bir signalni o'zingiz qayta tahlil qiling va faqat o'z xavf-xataringiz ostida savdoga kiring!\n\n"
        "<i>Bot sizga avtomatik signallarni shu yerga yuborishni boshlaydi. Kutib turing... 🚀</i>"
    )
    image_url = "https://images.unsplash.com/photo-1621416894569-0f39ed31d247?ixlib=rb-1.2.1&auto=format&fit=crop&w=800&q=80"
    try:
        await message.answer_photo(photo=image_url, caption=warning_text)
    except Exception:
        await message.answer(warning_text)

async def send_to_all(text, symbol=None, reply_to_message_ids=None):
    tv_url = f"https://www.tradingview.com/chart/?symbol=MEXC:{symbol.replace('/', '')}" if symbol else None
    reply_markup = None
    if tv_url:
        kb = [[InlineKeyboardButton(text="📈 TradingView'da ko'rish", url=tv_url)]]
        reply_markup = InlineKeyboardMarkup(inline_keyboard=kb)
        
    sent_messages = {}
    for u in users:
        try:
            reply_to = reply_to_message_ids.get(str(u)) if reply_to_message_ids else None
            sent_msg = await bot.send_message(
                chat_id=u, 
                text=text, 
                reply_markup=reply_markup, 
                reply_to_message_id=reply_to,
                link_preview_options=types.LinkPreviewOptions(is_disabled=True)
            )
            sent_messages[str(u)] = sent_msg.message_id
        except Exception as e:
            print(f"[{symbol}] Telegram yuborishda xatolik user {u} uchun: {e}")
            
    return sent_messages

async def analyze_symbol(symbol):
    async with sem:
        try:
            ohlcv_4h = await mexc.fetch_ohlcv(symbol, timeframe=MACRO_TIMEFRAME, limit=10)
            if len(ohlcv_4h) < 10: return
            
            df_4h = pd.DataFrame(ohlcv_4h, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            df_4h['ema9'] = ta.ema(df_4h['close'], length=9)
            if pd.isna(df_4h['ema9'].iloc[-2]): return
            macro_trend_up = df_4h['close'].iloc[-2] > df_4h['ema9'].iloc[-2]
            
            ohlcv = await mexc.fetch_ohlcv(symbol, timeframe=TIMEFRAME, limit=100)
            if len(ohlcv) < (PAST_CANDLES + 2): return
            
            df = pd.DataFrame(ohlcv, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
            df['rsi'] = ta.rsi(df['close'], length=14)
            df['ema20'] = ta.ema(df['close'], length=20)
            df['ema50'] = ta.ema(df['close'], length=50)
            
            closed_candle = df.iloc[-2]
            prev_candles = df.iloc[-(PAST_CANDLES+2):-2]
            
            current_close = closed_candle['close']
            current_volume = closed_candle['volume']
            current_rsi = closed_candle['rsi']
            ema20_val = closed_candle['ema20']
            ema50_val = closed_candle['ema50']
            timestamp = closed_candle['timestamp']
            
            avg_volume = prev_candles['volume'].mean()
            resistance_high = prev_candles['high'].max()
            support_low = prev_candles['low'].min()
            
            if current_volume < (avg_volume * VOLUME_SPIKE_X): return
            volume_spike = current_volume / avg_volume
            
            signal_key = f"{symbol}_{timestamp}"
            if signal_key in seen_signals: return
            
            if current_close > resistance_high and macro_trend_up and current_rsi < 70 and ema20_val > ema50_val:
                entry = current_close
                sl = closed_candle['low'] * 0.995 
                if sl >= entry: sl = entry * 0.99 
                risk = entry - sl
                tp = entry + (risk * 2)
                
                msg = (
                    f"🚀 <b>{symbol}</b> | 15M Breakout (LONG)\n\n"
                    f"💵 <b>Kirish narxi:</b> ${entry:.4f}\n"
                    f"🎯 <b>Take-Profit:</b> ${tp:.4f}\n"
                    f"🛑 <b>Stop-Loss:</b> ${sl:.4f}\n\n"
                    f"📈 <b>RSI kuchi:</b> {current_rsi:.1f}\n"
                    f"📊 <b>Kirgan hajm:</b> {volume_spike:.1f}x o'sish\n\n"
                    f"⚡️ <i>Trend: 4H va 15M o'sishda tasdiqlangan!</i>"
                )
                seen_signals[signal_key] = True
                
                sig_data = {
                    "symbol": symbol, "type": "LONG", "entry": entry,
                    "tp": tp, "sl": sl, "status": "PENDING",
                    "timestamp": datetime.now().isoformat(),
                    "message_ids": {}
                }
                signals_db.append(sig_data)
                sent_msgs = await send_to_all(msg, symbol)
                sig_data["message_ids"] = sent_msgs
                save_json(SIGNALS_FILE, signals_db)
                
                print(f"✅ Snayper LONG: {symbol}")
                
            elif current_close < support_low and not macro_trend_up and current_rsi > 30 and ema20_val < ema50_val:
                entry = current_close
                sl = closed_candle['high'] * 1.005
                if sl <= entry: sl = entry * 1.01
                risk = sl - entry
                tp = entry - (risk * 2)
                
                msg = (
                    f"🩸 <b>{symbol}</b> | 15M Breakdown (SHORT)\n\n"
                    f"💵 <b>Kirish narxi:</b> ${entry:.4f}\n"
                    f"🎯 <b>Take-Profit:</b> ${tp:.4f}\n"
                    f"🛑 <b>Stop-Loss:</b> ${sl:.4f}\n\n"
                    f"📉 <b>RSI kuchi:</b> {current_rsi:.1f}\n"
                    f"📊 <b>Chiqib ketgan hajm:</b> {volume_spike:.1f}x o'sish\n\n"
                    f"⚡️ <i>4H Trend qulashda tasdiqlangan!</i>"
                )
                seen_signals[signal_key] = True
                
                sig_data = {
                    "symbol": symbol, "type": "SHORT", "entry": entry,
                    "tp": tp, "sl": sl, "status": "PENDING",
                    "timestamp": datetime.now().isoformat(),
                    "message_ids": {}
                }
                signals_db.append(sig_data)
                sent_msgs = await send_to_all(msg, symbol)
                sig_data["message_ids"] = sent_msgs
                save_json(SIGNALS_FILE, signals_db)
                
                print(f"🚨 Snayper SHORT: {symbol}")
                
        except Exception as e:
            pass

markets_cache = None

async def scanner_loop():
    global markets_cache
    print("🚀 SnayperBot (1-motor) ishga tushdi! MEXC skanerlanmoqda...", flush=True)
    iteration = 0
    while True:
        try:
            tickers = await mexc.fetch_tickers()
            if markets_cache is None or iteration % 60 == 0:
                markets_cache = await mexc.load_markets()
            iteration += 1
            
            stablecoins = {'USDC/USDT', 'TUSD/USDT', 'USDD/USDT', 'DAI/USDT', 'FDUSD/USDT', 'PYUSD/USDT', 'BUSD/USDT', 'USDP/USDT', 'EURT/USDT'}
            
            valid_symbols = [
                s for s, t in tickers.items() 
                if s.endswith('/USDT') 
                and s not in stablecoins
                and markets_cache.get(s, {}).get('spot') 
                and t.get('quoteVolume', 0) >= MIN_24H_VOLUME
            ]
            
            tasks = [analyze_symbol(sym) for sym in valid_symbols]
            await asyncio.gather(*tasks)
            await asyncio.sleep(60)
        except Exception as e:
            print(f"Snayper kritik xatoligi: {e}")
            await asyncio.sleep(60)

async def background_checker():
    while True:
        try:
            changed = False
            for sig in signals_db:
                if sig['status'] == 'PENDING':
                    try:
                        ticker = await mexc.fetch_ticker(sig['symbol'])
                        current_price = ticker['last']
                        
                        hit_tp = False
                        hit_sl = False
                        
                        if sig['type'] == 'LONG':
                            if current_price >= sig['tp']:
                                hit_tp = True
                            elif current_price <= sig['sl']:
                                hit_sl = True
                        elif sig['type'] == 'SHORT':
                            if current_price <= sig['tp']:
                                hit_tp = True
                            elif current_price >= sig['sl']:
                                hit_sl = True
                                
                        if hit_tp:
                            sig['status'] = 'WIN'
                            changed = True
                            sig_time = datetime.fromisoformat(sig['timestamp']).strftime('%Y-%m-%d %H:%M')
                            msg = f"✅ <b>{sig['symbol']}</b> | {sig['type']} signali foyda bilan yopildi! (Take-Profit urildi) 🎯\n\n🕒 Signal berilgan vaqt: {sig_time}\n💰 Joriy narx: ${current_price:.4f}"
                            await send_to_all(msg, sig['symbol'], reply_to_message_ids=sig.get('message_ids', {}))
                        elif hit_sl:
                            sig['status'] = 'LOSS'
                            changed = True
                            sig_time = datetime.fromisoformat(sig['timestamp']).strftime('%Y-%m-%d %H:%M')
                            msg = f"❌ <b>{sig['symbol']}</b> | {sig['type']} signali zararda yopildi (Stop-Loss urildi) 🛑\n\n🕒 Signal berilgan vaqt: {sig_time}\n💰 Joriy narx: ${current_price:.4f}"
                            await send_to_all(msg, sig['symbol'], reply_to_message_ids=sig.get('message_ids', {}))
                    except Exception as e:
                        print(f"Narxni tekshirishda xato {sig['symbol']}: {e}")
            
            if changed:
                save_json(SIGNALS_FILE, signals_db)
                
        except Exception as e:
            print(f"Background checker xatosi: {e}")
            
        await asyncio.sleep(300)

async def weekly_reporter():
    while True:
        now = datetime.now()
        if now.weekday() == 6 and now.hour == 23 and 50 <= now.minute <= 59:
            last_week = now - timedelta(days=7)
            total, wins, losses = 0, 0, 0
            
            for sig in signals_db:
                try:
                    sig_date = datetime.fromisoformat(sig['timestamp'])
                    if sig_date > last_week and sig['status'] in ['WIN', 'LOSS']:
                        total += 1
                        if sig['status'] == 'WIN': wins += 1
                        if sig['status'] == 'LOSS': losses += 1
                except: pass
            
            if total > 0:
                win_rate = (wins / total) * 100
                report_msg = (
                    "📊 <b>HAFTALIK HISOBOT</b> 📊\n\n"
                    f"Yakunlangan haftada jami <b>{total} ta</b> signal yopildi.\n"
                    f"✅ To'g'ri chiqqan: <b>{wins} ta</b>\n"
                    f"❌ Xato chiqqan: <b>{losses} ta</b>\n\n"
                    f"🏆 <b>Haftalik Aniqlik (WinRate): {win_rate:.1f}%</b>"
                )
                await send_to_all(report_msg)
            
            await asyncio.sleep(3600)
        else:
            await asyncio.sleep(60)

async def main():
    print("Matorlar o't oldirilmoqda...", flush=True)
    asyncio.create_task(scanner_loop())
    asyncio.create_task(background_checker())
    asyncio.create_task(weekly_reporter())
    if watcher_bot:
        asyncio.create_task(check_news_loop())
    else:
        print("ℹ️ WatcherBot o'tkazib yuborildi (CRYPTO_WATCHER_BOT_TOKEN sozlanmagan).", flush=True)
    
    # Aiogram dp faqat SnayperBot (start komandasi) uchun ishlaydi
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())

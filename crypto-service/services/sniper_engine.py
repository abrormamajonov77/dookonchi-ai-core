import asyncio
import logging
import pandas as pd
import pandas_ta as ta
from datetime import datetime
from config import MIN_24H_VOLUME, CONCURRENT_REQUESTS
from database import add_signal
from utils.indicators import calculate_dynamic_tp_sl, is_stablecoin

seen_signals = {}
logger = logging.getLogger(__name__)


async def analyze_symbol(symbol, mexc, tickers):
    """
    Koinni avval 15M, so'ngra 1H va 4H bo'yicha ketma-ket analiz qiladi.
    Shuningdek Order Book (Bids/Asks) va ATR shartlari mavjud.
    """
    try:
        ohlcv_15m = await mexc.fetch_ohlcv(symbol, timeframe='15m', limit=100)
        if len(ohlcv_15m) < 25:
            return None

        df = pd.DataFrame(ohlcv_15m, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df['rsi'] = ta.rsi(df['close'], length=14)
        df['ema20'] = ta.ema(df['close'], length=20)
        df['ema50'] = ta.ema(df['close'], length=50)
        df['atr'] = ta.atr(df['high'], df['low'], df['close'], length=14)

        closed_candle = df.iloc[-2]
        prev_candles = df.iloc[-20:-2]

        current_close = closed_candle['close']
        current_volume = closed_candle['volume']
        current_rsi = closed_candle['rsi']
        ema20_val = closed_candle['ema20']
        ema50_val = closed_candle['ema50']
        timestamp = closed_candle['timestamp']
        current_atr = closed_candle['atr']

        if pd.isna(current_atr) or current_atr == 0:
            return None

        avg_volume = prev_candles['volume'].mean()
        resistance_high = prev_candles['close'].max()
        support_low = prev_candles['close'].min()

        candle_size = abs(closed_candle['close'] - closed_candle['open'])

        if current_volume < (avg_volume * 1.2):
            return None
        if candle_size < (current_atr * 0.6):
            return None

        volume_spike = current_volume / avg_volume

        signal_key = f"{symbol}_{timestamp}"
        if signal_key in seen_signals:
            return None

        is_long_breakout = current_close > resistance_high and current_rsi > 55 and ema20_val > ema50_val
        is_short_breakdown = current_close < support_low and current_rsi < 45 and ema20_val < ema50_val

        ema_diff_percent = abs(ema20_val - ema50_val) / ema50_val
        if ema_diff_percent < 0.0005:
            return None

        if not (is_long_breakout or is_short_breakdown):
            return None

        # 1H trend
        ohlcv_1h = await mexc.fetch_ohlcv(symbol, timeframe='1h', limit=50)
        if len(ohlcv_1h) < 25:
            return None
        df_1h = pd.DataFrame(ohlcv_1h, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df_1h['ema50'] = ta.ema(df_1h['close'], length=50)
        if pd.isna(df_1h['ema50'].iloc[-2]):
            return None
        trend_1h_up = df_1h['close'].iloc[-2] > df_1h['ema50'].iloc[-2]

        # 4H macro trend
        ohlcv_4h = await mexc.fetch_ohlcv(symbol, timeframe='4h', limit=50)
        if len(ohlcv_4h) < 20:
            return None
        df_4h = pd.DataFrame(ohlcv_4h, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df_4h['ema20'] = ta.ema(df_4h['close'], length=20)
        if pd.isna(df_4h['ema20'].iloc[-2]):
            return None
        trend_4h_up = df_4h['close'].iloc[-2] > df_4h['ema20'].iloc[-2]

        # Order flow confirmation
        order_book = await mexc.fetch_order_book(symbol, limit=20)
        bids = sum([bid[1] for bid in order_book['bids']])
        asks = sum([ask[1] for ask in order_book['asks']])

        if bids == 0 or asks == 0:
            return None

        imbalance = bids / asks if bids > asks else asks / bids

        if is_long_breakout and asks > (bids * 5):
            logger.info(f"{symbol} LONG bekor qilindi (Sell Wall bor). Asks: {asks}, Bids: {bids}")
            return None

        if is_short_breakdown and bids > (asks * 5):
            logger.info(f"{symbol} SHORT bekor qilindi (Buy Wall bor). Bids: {bids}, Asks: {asks}")
            return None

        signal_type = "LONG" if is_long_breakout else "SHORT"

        is_macro_aligned = (
            (signal_type == "LONG" and trend_1h_up and trend_4h_up)
            or (signal_type == "SHORT" and not trend_1h_up and not trend_4h_up)
        )

        stars = 2
        if is_macro_aligned:
            stars = 3
            if volume_spike >= 2.0:
                stars = 5

        is_scalp = (stars == 2)
        tp1, tp2, sl, atr = calculate_dynamic_tp_sl(df, current_close, is_long=(signal_type == "LONG"), is_scalp=is_scalp)

        seen_signals[signal_key] = True

        trend_icon = "📈" if signal_type == "LONG" else "📉"
        entry_emoji = "🚀" if signal_type == "LONG" else "🩸"
        star_emoji = "⭐⭐⭐⭐⭐" if stars == 5 else "⭐⭐⭐" if stars == 3 else "⭐⭐"
        star_label = "O'ta ishonchli (Spot)" if stars == 5 else "Trendga mos (Snayper)" if stars == 3 else "Trendga qarshi (Scalping)"
        scalp_warning = (
            "🚨 <b>DIQQAT:</b> Katta trend teskari! Bu qisqa muddatli Skalping (Risk 100% o'zingizda!)\n━━━━━━━━━━━━━━━━━━━━━\n"
            if is_scalp
            else ""
        )

        msg = (
            f"{entry_emoji} <b>{symbol}</b> | 15M Breakout ({signal_type})\n"
            f"Ishonchlilik: {star_emoji} <i>({star_label})</i>\n"
            f"━━━━━━━━━━━━━━━━━━━━━\n"
            f"{scalp_warning}"
            f"💵 <b>Kirish narxi:</b> ${current_close:.5f}\n"
            f"🎯 <b>TP1 (Scalp/Target 1):</b> ${tp1:.5f} (SL'ni nolga tushiring)\n"
            f"🎯 <b>TP2 (Max Profit):</b> ${tp2:.5f}\n"
            f"🛑 <b>Stop-Loss:</b> ${sl:.5f}\n\n"
            f"📊 <b>Hajm o'sishi:</b> {volume_spike:.1f}x\n"
            f"📉 <b>RSI (Tasdiq):</b> {current_rsi:.1f}\n"
            f"🌊 <b>Order Flow Imbalance:</b> {imbalance:.1f}x\n\n"
            f"━━━━━━━━━━━━━━━━━━━━━\n"
            f"{trend_icon} <i>4H {'↑' if trend_4h_up else '↓'} | 1H {'↑' if trend_1h_up else '↓'} | 15M tasdiqlangan</i>"
        )

        logger.info(f"Yangi Snayper Signali: {symbol} - {signal_type} ({stars} yulduz)")
        return {
            "symbol": symbol,
            "type": signal_type,
            "entry": current_close,
            "tp1": tp1,
            "tp2": tp2,
            "sl": sl,
            "message": msg,
            "stars": stars,
        }

    except Exception as e:
        logger.error(f"Xatolik analyze_symbol ({symbol}): {str(e)}")
        raise e


async def sniper_scanner_loop(mexc, telegram_notifier_func):
    """
    MEXC birjasidagi tangalarni skanerlash va signal topsa Telegramga yuborish.
    """
    logger.info("🚀 SnayperBot V2 (15M/1H/4H + OrderFlow) ishga tushdi! MEXC skanerlanmoqda...")
    markets_cache = None
    iteration = 0
    sem = asyncio.Semaphore(CONCURRENT_REQUESTS)

    while True:
        try:
            tickers = await mexc.fetch_tickers()
            if markets_cache is None or iteration % 60 == 0:
                markets_cache = await mexc.load_markets()
            iteration += 1

            valid_symbols = [
                s for s, t in tickers.items()
                if s.endswith('/USDT')
                and not is_stablecoin(s, tickers)
                and markets_cache.get(s, {}).get('spot')
                and t.get('quoteVolume', 0) >= MIN_24H_VOLUME
            ]

            async def sem_task(sym):
                async with sem:
                    for attempt in range(3):
                        try:
                            return await analyze_symbol(sym, mexc, tickers)
                        except Exception as err:
                            if "429" in str(err) or "Rate limit" in str(err):
                                wait_time = 2 ** attempt
                                logger.warning(f"Rate limit for {sym}, waiting {wait_time}s...")
                                await asyncio.sleep(wait_time)
                            else:
                                return None
                    return None

            results = await asyncio.gather(*[sem_task(sym) for sym in valid_symbols])

            valid_res_count = 0
            for res in results:
                if res:
                    valid_res_count += 1
                    sent_messages = await telegram_notifier_func(res['message'], res['symbol'])
                    await add_signal(
                        res['symbol'], res['type'], res['entry'], res['tp1'], res['tp2'], res['sl'],
                        "PENDING", datetime.now().isoformat(), sent_messages, res['stars']
                    )

            logger.info(f"⚡ Snayper iteratsiyasi tugadi: {len(valid_symbols)} ta coin tekshirildi, {valid_res_count} ta signal topildi.")
            await asyncio.sleep(60)

        except Exception as e:
            logger.error(f"Snayper kritik xatoligi: {e}")
            await asyncio.sleep(60)

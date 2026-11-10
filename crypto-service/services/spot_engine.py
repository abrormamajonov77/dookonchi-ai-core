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


async def analyze_spot_symbol(symbol, mexc, tickers):
    """
    Spot uchun uzoq muddatli 1D (Kunlik) tahlil.
    """
    try:
        ohlcv_1d = await mexc.fetch_ohlcv(symbol, timeframe='1d', limit=250)
        if len(ohlcv_1d) < 200:
            return None

        df = pd.DataFrame(ohlcv_1d, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
        df['ema50'] = ta.ema(df['close'], length=50)
        df['ema200'] = ta.ema(df['close'], length=200)
        df['rsi'] = ta.rsi(df['close'], length=14)

        if pd.isna(df['ema200'].iloc[-2]):
            return None

        closed_candle = df.iloc[-2]
        current_close = closed_candle['close']
        current_rsi = closed_candle['rsi']
        ema50 = closed_candle['ema50']
        ema200 = closed_candle['ema200']
        timestamp = closed_candle['timestamp']

        signal_key = f"SPOT_{symbol}_{timestamp}"
        if signal_key in seen_signals:
            return None

        if current_close > ema200 and ema50 > ema200 and 40 < current_rsi < 65:
            avg_vol = df['volume'].tail(15).mean()
            if closed_candle['volume'] > (avg_vol * 1.5):
                _, _, _, atr = calculate_dynamic_tp_sl(df, current_close, is_long=True)
                sl = current_close - (atr * 2)
                tp1 = current_close + (atr * 2)
                tp2 = current_close + (atr * 4)

                seen_signals[signal_key] = True

                msg = (
                    f"💎 <b>{symbol}</b> | SPOT Signali (1D Chart)\n"
                    f"Ishonchlilik: ⭐⭐⭐⭐⭐ <i>(Uzoq muddatli)</i>\n\n"
                    f"💵 <b>Kirish narxi:</b> ${current_close:.5f}\n"
                    f"🎯 <b>TP1 (1:1):</b> ${tp1:.5f}\n"
                    f"🎯 <b>TP2 (1:2):</b> ${tp2:.5f}\n"
                    f"🛑 <b>Stop-Loss:</b> ${sl:.5f}\n\n"
                    f"📈 <b>Sabab:</b> Narx 200 kunlik EMA dan yuqorida, hajm o'sishi kuzatildi.\n"
                    f"⚠️ <i>Spot signallar oylab kutilishi mumkin!</i>"
                )

                logger.info(f"Yangi Spot Signali: {symbol}")
                return {
                    "symbol": symbol,
                    "type": "LONG",
                    "entry": current_close,
                    "tp1": tp1,
                    "tp2": tp2,
                    "sl": sl,
                    "message": msg,
                    "stars": 5,
                }
    except Exception:
        pass

    return None


async def spot_scanner_loop(mexc, telegram_notifier_func):
    logger.info("🔭 SpotBot (1D) ishga tushdi! Uzoq muddatli signallar qidirilmoqda...")
    markets_cache = None
    iteration = 0
    sem = asyncio.Semaphore(CONCURRENT_REQUESTS)

    while True:
        try:
            tickers = await mexc.fetch_tickers()
            if markets_cache is None or iteration % 12 == 0:
                markets_cache = await mexc.load_markets()
            iteration += 1

            valid_symbols = [
                s for s, t in tickers.items()
                if s.endswith('/USDT')
                and not is_stablecoin(s, tickers)
                and markets_cache.get(s, {}).get('spot')
                and t.get('quoteVolume', 0) >= (MIN_24H_VOLUME * 15)
            ]

            async def sem_task(sym):
                async with sem:
                    return await analyze_spot_symbol(sym, mexc, tickers)

            results = await asyncio.gather(*[sem_task(sym) for sym in valid_symbols])

            valid_res_count = 0
            for res in results:
                if res:
                    valid_res_count += 1
                    sent_messages = await telegram_notifier_func(res['message'], res['symbol'])
                    await add_signal(
                        res['symbol'], res['type'], res['entry'], res['tp1'], res['tp2'], res['sl'],
                        "PENDING", datetime.now().isoformat(), sent_messages, stars=5
                    )

            logger.info(f"🔭 Spot iteratsiyasi tugadi: {len(valid_symbols)} ta coin tekshirildi, {valid_res_count} ta signal topildi.")
            await asyncio.sleep(600)

        except Exception as e:
            logger.error(f"Spot kritik xatoligi: {e}")
            await asyncio.sleep(3600)

import pandas_ta as ta
from config import KNOWN_STABLECOINS


def calculate_dynamic_tp_sl(df, current_close, is_long: bool, is_scalp: bool = False):
    """
    Kiritilgan DataFrame asosida dinamik (ATR va Swings) orqali Stop-Loss va Take-Profit hisoblaydi.
    """
    atr = ta.atr(df['high'], df['low'], df['close'], length=14)
    current_atr = atr.iloc[-2] if not atr.isna().iloc[-2] else (df['close'].iloc[-2] * 0.01)

    if is_scalp:
        risk = current_atr * 0.8
        if is_long:
            sl = current_close - risk
            tp1 = current_close + risk
            tp2 = current_close + (risk * 1.5)
        else:
            sl = current_close + risk
            tp1 = current_close - risk
            tp2 = current_close - (risk * 1.5)
        return float(tp1), float(tp2), float(sl), float(current_atr)

    buffer = current_atr * 0.5

    if is_long:
        swing_low = df['low'].tail(15).min()
        sl = swing_low - buffer
        risk = current_close - sl
        tp1 = current_close + risk
        tp2 = current_close + (risk * 2)
    else:
        swing_high = df['high'].tail(15).max()
        sl = swing_high + buffer
        risk = sl - current_close
        tp1 = current_close - risk
        tp2 = current_close - (risk * 2)

    return float(tp1), float(tp2), float(sl), float(current_atr)


def is_stablecoin(symbol: str, tickers_data: dict) -> bool:
    """
    Narxi 1$ atrofida doimiy bo'lgan tangalarni aniqlash.
    """
    if symbol in KNOWN_STABLECOINS:
        return True

    ticker = tickers_data.get(symbol, {})
    last_price = ticker.get('last', 0)
    high_24 = ticker.get('high', 0)
    low_24 = ticker.get('low', 0)

    if last_price and (0.98 <= last_price <= 1.02):
        if high_24 and low_24:
            volatility = (high_24 - low_24) / low_24
            if volatility < 0.01:
                return True

    return False

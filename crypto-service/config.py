import os
from dotenv import load_dotenv

load_dotenv()

# --- TOKENS & API KEYS ---
TELEGRAM_BOT_TOKEN = os.getenv('CRYPTO_SNIPER_BOT_TOKEN') or os.getenv('TELEGRAM_BOT_TOKEN')
GEMINI_KEY = os.getenv('GEMINI_API_KEY') or os.getenv('GEMINI_KEY')

if not TELEGRAM_BOT_TOKEN:
    print("XATOLIK: CRYPTO_SNIPER_BOT_TOKEN yoki TELEGRAM_BOT_TOKEN kiritilmagan!", flush=True)
    exit(1)

# --- TRADING SETTINGS ---
MIN_24H_VOLUME = 300_000
VOLUME_SPIKE_X = 2.5
CONCURRENT_REQUESTS = 5

# Hardcoded stablecoins to filter out immediately before dynamic filtering
KNOWN_STABLECOINS = {
    'USDC/USDT', 'TUSD/USDT', 'USDD/USDT', 'DAI/USDT',
    'FDUSD/USDT', 'PYUSD/USDT', 'BUSD/USDT', 'USDP/USDT', 'EURT/USDT'
}

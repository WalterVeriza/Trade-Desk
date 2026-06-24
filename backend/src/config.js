import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no external dependency)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
  }
}

export const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    '[config] Missing DATABASE_URL. Set it in backend/.env (local) or as an environment variable on your host.'
  );
  process.exit(1);
}

export const PORT = Number(process.env.PORT || 4000);

// The 8 instruments traded on this desk. Internal ids keep the *USDT suffix
// (stable DB keys / UI labels); `cbProduct` maps each to its Coinbase market.
// Data comes from Coinbase, which — unlike Binance — is reachable from US cloud
// hosts such as Render (Binance returns HTTP 451 to those IPs).
export const SYMBOLS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', base: 'BTC', quote: 'USD', cbProduct: 'BTC-USD' },
  { symbol: 'ETHUSDT', name: 'Ethereum', base: 'ETH', quote: 'USD', cbProduct: 'ETH-USD' },
  { symbol: 'BNBUSDT', name: 'BNB', base: 'BNB', quote: 'USD', cbProduct: 'BNB-USD' },
  { symbol: 'SOLUSDT', name: 'Solana', base: 'SOL', quote: 'USD', cbProduct: 'SOL-USD' },
  { symbol: 'XRPUSDT', name: 'XRP', base: 'XRP', quote: 'USD', cbProduct: 'XRP-USD' },
  { symbol: 'ADAUSDT', name: 'Cardano', base: 'ADA', quote: 'USD', cbProduct: 'ADA-USD' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', base: 'DOGE', quote: 'USD', cbProduct: 'DOGE-USD' },
  { symbol: 'AVAXUSDT', name: 'Avalanche', base: 'AVAX', quote: 'USD', cbProduct: 'AVAX-USD' },
];

export const SYMBOL_SET = new Set(SYMBOLS.map((s) => s.symbol));
export const STARTING_CASH = 100000; // USD paper-trading balance

// Strategy bot defaults. Multi-indicator confluence + ATR-based TP/SL.
// Defaults tuned by a robustness sweep over all 8 symbols (see optimize.js).
// vs the old 5m/no-filter baseline (PF 1.05, expectancy 0.03R), this 1h +
// higher-TF-trend-filter profile backtested at PF ~1.44 / expectancy ~0.20R and
// is positive on all 8 symbols. In-sample over a recent window — re-validate
// over time; not a guarantee of future edge.
export const DEFAULT_BOT_CONFIG = {
  timeframe: '1h', // candle timeframe for indicators (1h = far less noise than 5m)
  loopSec: 60, // how often the signal scan runs (1h signals change hourly)
  confidenceMin: 65, // only trade signals at/above this confidence (0-100)
  riskPct: 1, // % of equity risked per trade (drives position size)
  atrSl: 1, // stop-loss distance = atrSl × ATR
  atrTp: 2, // take-profit distance = atrTp × ATR (R:R = 1:2)
  adxMin: 25, // regime filter: skip entries when ADX is below this (no trend)
  beAtR: 1, // move stop to break-even once +1R in profit (cuts avg loss)
  trailR: 0, // trail the stop trailR (in R) behind the best price (0 = off)
  mtfConfirm: true, // require the higher-TF (6h) trend to agree — biggest edge lift
  maxPositions: 4, // max concurrent bot trades
  maxPerDirection: 3, // correlation cap: max trades in the SAME direction at once
  confSizing: true, // scale risk by signal confidence (~0.6× weak … 1.4× strong)
  minNotional: 50, // skip trades smaller than this (USD)
  minStopPct: 0.004, // floor for stop distance (0.4% of price)
  cooldownSec: 90, // wait after closing a symbol before re-entering
  eventGuard: true, // pause NEW entries around high-impact calendar events
  evBeforeMin: 60, // blackout window: minutes before an event
  evAfterMin: 30, // blackout window: minutes after an event
  evMacro: true, // use the macro calendar (FOMC / CPI / NFP)
  evCrypto: true, // use crypto events (CoinMarketCal — needs COINMARKETCAL_KEY)
};
export const BOT_TIMEFRAMES = ['1m', '5m', '15m', '1h'];
// Higher timeframe used to confirm each trading timeframe's trend (MTF filter).
export const HTF_MAP = { '1m': '15m', '5m': '1h', '15m': '6h', '1h': '1d' };
export const POLL_INTERVAL_MS = 3000; // Coinbase polling cadence
export const STATS_EVERY_TICKS = 5; // refresh 24h open/high/low every Nth poll
export const PERSIST_EVERY_TICKS = 5; // store a tick row every Nth poll
export const TICK_RETENTION_DAYS = 7; // purge persisted ticks older than this
export const TICK_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // purge cadence (6h)

// Backtester defaults.
export const BACKTEST_BARS = 500; // candles to replay per symbol
export const BACKTEST_MAX_BARS = 1200; // hard cap (Coinbase paging)
export const SIGNAL_WARMUP = 210; // bars needed before computeSignal is valid

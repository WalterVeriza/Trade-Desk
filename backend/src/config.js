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
export const POLL_INTERVAL_MS = 3000; // Coinbase polling cadence
export const STATS_EVERY_TICKS = 5; // refresh 24h open/high/low every Nth poll
export const PERSIST_EVERY_TICKS = 5; // store a tick row every Nth poll

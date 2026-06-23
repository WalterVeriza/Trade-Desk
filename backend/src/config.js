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

// The 8 instruments traded on this desk (Binance spot pairs vs USDT).
export const SYMBOLS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin', base: 'BTC', quote: 'USDT' },
  { symbol: 'ETHUSDT', name: 'Ethereum', base: 'ETH', quote: 'USDT' },
  { symbol: 'BNBUSDT', name: 'BNB', base: 'BNB', quote: 'USDT' },
  { symbol: 'SOLUSDT', name: 'Solana', base: 'SOL', quote: 'USDT' },
  { symbol: 'XRPUSDT', name: 'XRP', base: 'XRP', quote: 'USDT' },
  { symbol: 'ADAUSDT', name: 'Cardano', base: 'ADA', quote: 'USDT' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin', base: 'DOGE', quote: 'USDT' },
  { symbol: 'AVAXUSDT', name: 'Avalanche', base: 'AVAX', quote: 'USDT' },
];

export const SYMBOL_SET = new Set(SYMBOLS.map((s) => s.symbol));
export const STARTING_CASH = 100000; // USDT paper-trading balance
export const POLL_INTERVAL_MS = 2000; // Binance polling cadence
export const PERSIST_EVERY_TICKS = 5; // store a tick row every Nth poll

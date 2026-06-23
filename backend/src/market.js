import { sql } from './db.js';
import {
  SYMBOLS,
  SYMBOL_SET,
  POLL_INTERVAL_MS,
  STATS_EVERY_TICKS,
  PERSIST_EVERY_TICKS,
  TICK_RETENTION_DAYS,
  TICK_CLEANUP_INTERVAL_MS,
} from './config.js';
import { matchOpenOrders } from './engine.js';

// Coinbase Exchange public API — globally reachable (incl. US cloud hosts like
// Render), no API key required.
const CB = 'https://api.exchange.coinbase.com';
const HEADERS = { 'User-Agent': 'trader-desk', Accept: 'application/json' };

// Map our interval labels to Coinbase candle granularities (seconds).
const GRANULARITY = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '1d': 86400,
};

// In-memory live snapshot + rolling sparkline history + slow-moving 24h stats.
const cache = new Map(); // symbol -> snapshot
const history = new Map(); // symbol -> number[]
const stats24 = new Map(); // symbol -> { open, high, low }
const HISTORY_LEN = 60;

let pollCount = 0;
let onUpdate = null;

export function setBroadcast(fn) {
  onUpdate = fn;
}

export function getPrice(symbol) {
  return cache.get(symbol)?.price ?? null;
}

export function getPriceMap() {
  const map = {};
  for (const [sym, snap] of cache) map[sym] = snap.price;
  return map;
}

export function getMarket() {
  return SYMBOLS.map((s) => cache.get(s.symbol)).filter(Boolean);
}

export function getSparkline(symbol) {
  return history.get(symbol) ?? [];
}

async function cbJson(path) {
  const res = await fetch(CB + path, { headers: HEADERS });
  if (!res.ok) throw new Error(`Coinbase ${res.status} ${path}`);
  return res.json();
}

// 24h open/high/low changes slowly — refresh on a slower cadence than price.
async function refreshStats() {
  await Promise.all(
    SYMBOLS.map(async (s) => {
      try {
        const st = await cbJson(`/products/${s.cbProduct}/stats`);
        stats24.set(s.symbol, {
          open: Number(st.open),
          high: Number(st.high),
          low: Number(st.low),
        });
      } catch {
        /* keep previous stats */
      }
    })
  );
}

async function pollOnce() {
  if (pollCount % STATS_EVERY_TICKS === 0) await refreshStats();

  const updated = [];
  await Promise.all(
    SYMBOLS.map(async (s) => {
      try {
        const tk = await cbJson(`/products/${s.cbProduct}/ticker`);
        const price = Number(tk.price);
        if (!(price > 0)) return;
        const st = stats24.get(s.symbol) || {};
        const open = st.open ?? price;
        const change = price - open;
        const volBase = Number(tk.volume) || 0;
        const snap = {
          symbol: s.symbol,
          name: s.name,
          base: s.base,
          quote: s.quote,
          price,
          changePct: open ? (change / open) * 100 : 0,
          change,
          high: Math.max(st.high ?? price, price),
          low: Math.min(st.low ?? price, price),
          volume: volBase * price, // approximate USD (quote) volume
          bid: Number(tk.bid) || price,
          ask: Number(tk.ask) || price,
          ts: Date.now(),
        };
        cache.set(s.symbol, snap);
        const h = history.get(s.symbol) ?? [];
        h.push(price);
        if (h.length > HISTORY_LEN) h.shift();
        history.set(s.symbol, h);
        updated.push(snap);
      } catch {
        /* keep previous cache entry on transient failure */
      }
    })
  );

  // Fill any resting limit orders the market has crossed.
  let fills = [];
  try {
    fills = await matchOpenOrders(getPriceMap());
  } catch (e) {
    console.error('[market] order matching error:', e.message);
  }

  pollCount += 1;
  if (pollCount % PERSIST_EVERY_TICKS === 0) {
    persistTicks(updated).catch((e) => console.error('[market] persist error:', e.message));
  }

  if (onUpdate) onUpdate({ market: updated, fills });
}

async function persistTicks(snaps) {
  for (const s of snaps) {
    await sql.query(
      'INSERT INTO ticks (symbol, price, change_pct, high, low, volume) VALUES ($1,$2,$3,$4,$5,$6)',
      [s.symbol, s.price, s.changePct, s.high, s.low, s.volume]
    );
  }
}

// The ticks table grows ~every poll forever; trim rows past the retention window
// so it doesn't bloat the database (and the Neon free tier) indefinitely.
async function cleanupOldTicks() {
  try {
    await sql.query('DELETE FROM ticks WHERE ts < now() - make_interval(days => $1)', [
      TICK_RETENTION_DAYS,
    ]);
  } catch (e) {
    console.error('[market] tick cleanup error:', e.message);
  }
}

export async function fetchKlines(symbol, interval = '1m', limit = 120) {
  if (!SYMBOL_SET.has(symbol)) throw new Error('Unknown symbol');
  const meta = SYMBOLS.find((s) => s.symbol === symbol);
  const granularity = GRANULARITY[interval] || 60;
  // Coinbase returns up to 300 rows, newest-first: [time, low, high, open, close, volume].
  const raw = await cbJson(`/products/${meta.cbProduct}/candles?granularity=${granularity}`);
  return raw
    .slice(0, limit)
    .reverse()
    .map((k) => ({
      time: k[0] * 1000,
      low: k[1],
      high: k[2],
      open: k[3],
      close: k[4],
      volume: k[5],
    }));
}

// Seed rolling history from 1-minute candles so sparklines are populated at boot.
async function seedHistory() {
  await Promise.all(
    SYMBOLS.map(async (s) => {
      try {
        const kl = await fetchKlines(s.symbol, '1m', HISTORY_LEN);
        history.set(s.symbol, kl.map((k) => k.close));
      } catch {
        /* non-fatal */
      }
    })
  );
}

export async function startMarketFeed() {
  await refreshStats();
  await seedHistory();
  await pollOnce().catch((e) => console.error('[market] first poll failed:', e.message));
  setInterval(() => {
    pollOnce().catch((e) => console.error('[market] poll error:', e.message));
  }, POLL_INTERVAL_MS);
  cleanupOldTicks();
  setInterval(cleanupOldTicks, TICK_CLEANUP_INTERVAL_MS);
  console.log(`[market] Coinbase live feed started for ${SYMBOLS.length} symbols @ ${POLL_INTERVAL_MS}ms`);
}

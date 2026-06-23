import { sql } from './db.js';
import { SYMBOLS, SYMBOL_SET, POLL_INTERVAL_MS, PERSIST_EVERY_TICKS } from './config.js';
import { matchOpenOrders } from './engine.js';

const BINANCE = 'https://api.binance.com/api/v3';

// In-memory live market snapshot + short rolling history for sparklines.
const cache = new Map(); // symbol -> snapshot
const history = new Map(); // symbol -> number[] (recent prices)
const HISTORY_LEN = 60;

let pollCount = 0;
let onUpdate = null; // broadcast callback set by index.js

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

async function pollOnce() {
  const symbolsParam = JSON.stringify(SYMBOLS.map((s) => s.symbol));
  const url = `${BINANCE}/ticker/24hr?symbols=${encodeURIComponent(symbolsParam)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  const data = await res.json();

  const updated = [];
  for (const t of data) {
    if (!SYMBOL_SET.has(t.symbol)) continue;
    const meta = SYMBOLS.find((s) => s.symbol === t.symbol);
    const snap = {
      symbol: t.symbol,
      name: meta.name,
      base: meta.base,
      quote: meta.quote,
      price: Number(t.lastPrice),
      changePct: Number(t.priceChangePercent),
      change: Number(t.priceChange),
      high: Number(t.highPrice),
      low: Number(t.lowPrice),
      volume: Number(t.quoteVolume),
      bid: Number(t.bidPrice),
      ask: Number(t.askPrice),
      ts: Date.now(),
    };
    cache.set(t.symbol, snap);
    const h = history.get(t.symbol) ?? [];
    h.push(snap.price);
    if (h.length > HISTORY_LEN) h.shift();
    history.set(t.symbol, h);
    updated.push(snap);
  }

  // Fill any resting limit orders the market has crossed.
  let fills = [];
  try {
    fills = await matchOpenOrders(getPriceMap());
  } catch (e) {
    console.error('[market] order matching error:', e.message);
  }

  // Persist a tick snapshot periodically (keeps DB writes bounded).
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

export async function fetchKlines(symbol, interval = '1m', limit = 120) {
  if (!SYMBOL_SET.has(symbol)) throw new Error('Unknown symbol');
  const url = `${BINANCE}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const raw = await res.json();
  return raw.map((k) => ({
    time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

// Seed rolling history from Binance so sparklines are populated immediately.
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
  await seedHistory();
  await pollOnce().catch((e) => console.error('[market] first poll failed:', e.message));
  setInterval(() => {
    pollOnce().catch((e) => console.error('[market] poll error:', e.message));
  }, POLL_INTERVAL_MS);
  console.log(`[market] live feed started for ${SYMBOLS.length} symbols @ ${POLL_INTERVAL_MS}ms`);
}

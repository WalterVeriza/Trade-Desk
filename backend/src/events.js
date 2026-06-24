import { SYMBOLS } from './config.js';

// ---------------------------------------------------------------------------
// Macro calendar — high-impact US releases that move crypto. Hard-coded from the
// official Fed (FOMC) and BLS (CPI / Employment Situation) schedules, in UTC.
// These are published a year ahead and rarely change. REFRESH ~YEARLY.
// (EDT = UTC-4 through 2026-11-01, EST = UTC-5 after. FOMC 14:00 ET, data 08:30 ET.)
// ---------------------------------------------------------------------------
const MACRO_EVENTS = [
  // FOMC rate decisions
  { ts: '2026-07-29T18:00:00Z', kind: 'FOMC', title: 'FOMC rate decision' },
  { ts: '2026-09-16T18:00:00Z', kind: 'FOMC', title: 'FOMC rate decision' },
  { ts: '2026-10-28T18:00:00Z', kind: 'FOMC', title: 'FOMC rate decision' },
  { ts: '2026-12-09T19:00:00Z', kind: 'FOMC', title: 'FOMC rate decision' },
  // CPI (inflation)
  { ts: '2026-07-14T12:30:00Z', kind: 'CPI', title: 'US CPI (Jun)' },
  { ts: '2026-08-12T12:30:00Z', kind: 'CPI', title: 'US CPI (Jul)' },
  { ts: '2026-09-11T12:30:00Z', kind: 'CPI', title: 'US CPI (Aug)' },
  { ts: '2026-10-14T12:30:00Z', kind: 'CPI', title: 'US CPI (Sep)' },
  { ts: '2026-11-10T13:30:00Z', kind: 'CPI', title: 'US CPI (Oct)' },
  { ts: '2026-12-10T13:30:00Z', kind: 'CPI', title: 'US CPI (Nov)' },
  // Nonfarm payrolls (Employment Situation)
  { ts: '2026-07-02T12:30:00Z', kind: 'NFP', title: 'US Nonfarm Payrolls (Jun)' },
  { ts: '2026-08-07T12:30:00Z', kind: 'NFP', title: 'US Nonfarm Payrolls (Jul)' },
  { ts: '2026-09-04T12:30:00Z', kind: 'NFP', title: 'US Nonfarm Payrolls (Aug)' },
  { ts: '2026-10-02T12:30:00Z', kind: 'NFP', title: 'US Nonfarm Payrolls (Sep)' },
  { ts: '2026-11-06T13:30:00Z', kind: 'NFP', title: 'US Nonfarm Payrolls (Oct)' },
  { ts: '2026-12-04T13:30:00Z', kind: 'NFP', title: 'US Nonfarm Payrolls (Nov)' },
].map((e) => ({ ...e, time: Date.parse(e.ts), source: 'macro' }));

// ---------------------------------------------------------------------------
// Crypto calendar — CoinMarketCal (listings, unlocks, mainnet, ETF rulings…).
// Needs a free API key in COINMARKETCAL_KEY; otherwise this half stays dormant
// and only the macro calendar is used.
// ---------------------------------------------------------------------------
const CMC_KEY = process.env.COINMARKETCAL_KEY;
const OUR_COINS = new Set(SYMBOLS.map((s) => s.base.toUpperCase()));
let cryptoEvents = [];
let lastCryptoFetch = 0;

async function fetchCryptoEvents() {
  if (!CMC_KEY) return;
  try {
    const res = await fetch(
      'https://developers.coinmarketcal.com/v1/events?max=75&showOnly=hot_events',
      { headers: { 'x-api-key': CMC_KEY, Accept: 'application/json', 'Accept-Encoding': 'deflate, gzip' } }
    );
    if (!res.ok) throw new Error(`CoinMarketCal ${res.status}`);
    const json = await res.json();
    const rows = json.body || [];
    cryptoEvents = rows
      .map((e) => {
        const coins = (e.coins || []).map((c) => (c.symbol || '').toUpperCase());
        return {
          time: Date.parse(e.date_event),
          kind: 'CRYPTO',
          title: (e.title && e.title.en) || 'Crypto event',
          coins,
          source: 'crypto',
        };
      })
      .filter((e) => e.time && e.coins.some((c) => OUR_COINS.has(c))); // only our 8 coins
    lastCryptoFetch = Date.now();
    console.log(`[events] CoinMarketCal: ${cryptoEvents.length} upcoming events for our coins`);
  } catch (e) {
    console.error('[events] CoinMarketCal fetch error:', e.message);
  }
}

function allEvents(cfg) {
  const list = [];
  if (cfg?.evMacro !== false) list.push(...MACRO_EVENTS);
  if (cfg?.evCrypto !== false) list.push(...cryptoEvents);
  return list;
}

// The active blackout event right now, or null. Window = [t-before, t+after].
export function blackoutEvent(now, cfg) {
  if (cfg?.eventGuard === false) return null;
  const before = (cfg?.evBeforeMin ?? 60) * 60000;
  const after = (cfg?.evAfterMin ?? 30) * 60000;
  for (const e of allEvents(cfg)) {
    if (now >= e.time - before && now <= e.time + after) return e;
  }
  return null;
}

// The next upcoming event (for display), or null.
export function nextEvent(now, cfg) {
  let best = null;
  for (const e of allEvents(cfg)) {
    if (e.time >= now && (!best || e.time < best.time)) best = e;
  }
  return best;
}

export function getEventsSnapshot(cfg) {
  const now = Date.now();
  const bo = blackoutEvent(now, cfg);
  const next = nextEvent(now, cfg);
  return {
    cryptoEnabled: !!CMC_KEY,
    blackout: bo ? { kind: bo.kind, title: bo.title, time: bo.time } : null,
    next: next ? { kind: next.kind, title: next.title, time: next.time } : null,
  };
}

export async function startEvents() {
  if (CMC_KEY) {
    await fetchCryptoEvents();
    setInterval(fetchCryptoEvents, 60 * 60 * 1000); // hourly
  }
  console.log(`[events] guard ready — macro: ${MACRO_EVENTS.length} events, crypto: ${CMC_KEY ? 'on' : 'off (no key)'}`);
}

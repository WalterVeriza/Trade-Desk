// Forex strategy research — ROADMAP step 2.
// Compares three strategy archetypes on free Yahoo FX data, net of a modeled
// spread, on their natural timeframe. No broker/key. Pluggable signal functions
// share one bar-by-bar simulator (same exit/cost logic as the live engine).
//
// Run: DATABASE_URL=<anything> node scripts/forex-research.js

import { rsi, atr } from '../src/indicators.js';
import { computeSignal, manageStop } from '../src/strategy.js';
import { metricsFromTrades } from '../src/backtest.js';
import { DEFAULT_BOT_CONFIG } from '../src/config.js';

const PAIRS = ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCHF=X', 'GBPJPY=X', 'AUDJPY=X', 'EURJPY=X'];
const FEE = 0.00015; // per side (~tight major spread + commission)

async function yahoo(pair, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${pair}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Yahoo ${res.status} ${pair}`);
  const r = (await res.json()).chart.result[0];
  const ts = r.timestamp || [];
  const q = r.indicators.quote[0];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    out.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i] });
  }
  return out.slice(0, -1);
}

// --- small helpers ---
function sma(vals, p) {
  const out = new Array(vals.length).fill(null);
  let s = 0;
  for (let i = 0; i < vals.length; i++) {
    s += vals[i];
    if (i >= p) s -= vals[i - p];
    if (i >= p - 1) out[i] = s / p;
  }
  return out;
}
function rollStd(vals, p, mid) {
  const out = new Array(vals.length).fill(null);
  for (let i = p - 1; i < vals.length; i++) {
    let v = 0;
    for (let k = i - p + 1; k <= i; k++) v += (vals[k] - mid[i]) ** 2;
    out[i] = Math.sqrt(v / p);
  }
  return out;
}

// Generic simulator: signalAt(i) -> {side, entry, sl, tp} | null (decided at close of bar i).
function runStrategy(candles, cfg, warmup, signalAt) {
  const trades = [];
  let pos = null;
  for (let i = warmup; i < candles.length; i++) {
    if (pos) {
      const bar = candles[i];
      let exit = null;
      const trailed = pos.side === 'long' ? pos.sl > pos.initSl : pos.sl < pos.initSl;
      if (pos.side === 'long') {
        if (bar.low <= pos.sl) exit = pos.sl;
        else if (bar.high >= pos.tp) exit = pos.tp;
      } else {
        if (bar.high >= pos.sl) exit = pos.sl;
        else if (bar.low <= pos.tp) exit = pos.tp;
      }
      if (exit != null) {
        const risk = Math.abs(pos.entry - pos.initSl) || 1;
        let r = (pos.side === 'long' ? exit - pos.entry : pos.entry - exit) / risk;
        r -= (FEE * (pos.entry + exit)) / risk;
        trades.push({ side: pos.side, r, reason: trailed ? 'trail' : exit === pos.tp ? 'tp' : 'sl' });
        pos = null;
      } else {
        pos.best = pos.side === 'long' ? Math.max(pos.best, bar.high) : Math.min(pos.best, bar.low);
        pos.sl = manageStop(pos.side, pos.entry, pos.sl, pos.initSl, pos.best, cfg);
      }
    }
    if (!pos) {
      const s = signalAt(i);
      if (s && s.tp !== s.entry && Math.abs(s.entry - s.sl) > 0) {
        pos = { side: s.side, entry: s.entry, tp: s.tp, sl: s.sl, initSl: s.sl, best: s.entry, entryIdx: i };
      }
    }
  }
  return trades;
}

// --- archetype 1: mean-reversion (Bollinger + RSI fade), target = mean ---
function mrSignal(candles) {
  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const mid = sma(close, 20);
  const sd = rollStd(close, 20, mid);
  const r = rsi(close, 14);
  const a = atr(high, low, close, 14);
  return (i) => {
    if (mid[i] == null || sd[i] == null || r[i] == null || a[i] == null) return null;
    const price = close[i];
    const upper = mid[i] + 2 * sd[i];
    const lower = mid[i] - 2 * sd[i];
    if (price < lower && r[i] < 35) return { side: 'long', entry: price, sl: price - a[i], tp: mid[i] };
    if (price > upper && r[i] > 65) return { side: 'short', entry: price, sl: price + a[i], tp: mid[i] };
    return null;
  };
}

// --- archetype 2: session breakout (Asian range, London/NY trigger), 1 trade/day ---
function breakoutSignal(candles, rr = 1.5) {
  const day = candles.map((c) => Math.floor(c.time / 86400000));
  const hour = candles.map((c) => new Date(c.time).getUTCHours());
  const range = new Map(); // day -> {hi, lo} from 00:00-06:59 UTC
  for (let i = 0; i < candles.length; i++) {
    if (hour[i] < 7) {
      const d = day[i];
      const cur = range.get(d) || { hi: -Infinity, lo: Infinity };
      cur.hi = Math.max(cur.hi, candles[i].high);
      cur.lo = Math.min(cur.lo, candles[i].low);
      range.set(d, cur);
    }
  }
  const traded = new Set();
  return (i) => {
    if (hour[i] < 7 || hour[i] >= 17) return null;
    const d = day[i];
    if (traded.has(d)) return null;
    const r = range.get(d);
    if (!r || !isFinite(r.hi)) return null;
    const price = candles[i].close;
    if (price > r.hi) {
      traded.add(d);
      const risk = price - r.lo;
      return risk > 0 ? { side: 'long', entry: price, sl: r.lo, tp: price + rr * risk } : null;
    }
    if (price < r.lo) {
      traded.add(d);
      const risk = r.hi - price;
      return risk > 0 ? { side: 'short', entry: price, sl: r.hi, tp: price - rr * risk } : null;
    }
    return null;
  };
}

// --- archetype 3: trend-following (existing computeSignal) on the daily TF ---
function trendSignal(candles, cfg) {
  return (i) => {
    const sig = computeSignal(candles.slice(0, i + 1), cfg);
    if (!sig) return null;
    const volOk = !cfg.minVolPct || (sig.price ? sig.atr / sig.price : 0) >= cfg.minVolPct;
    if (sig.confidence >= cfg.confidenceMin && (sig.adx ?? 0) >= (cfg.adxMin ?? 0) && volOk) {
      return { side: sig.side, entry: sig.price, sl: sig.sl, tp: sig.tp };
    }
    return null;
  };
}

const fmt = (m) =>
  `trades ${String(m.trades).padStart(4)} | win ${String(m.winRate).padStart(5)}% | PF ${String(m.profitFactor ?? '—').padStart(5)} | expR ${String(m.expectancyR).padStart(6)} | totalR ${String(m.totalR).padStart(7)}`;

async function run() {
  const noManage = { beAtR: 0, trailR: 0 };
  const trendCfg = { ...DEFAULT_BOT_CONFIG, minVolPct: 0.0015, mtfConfirm: false };

  const agg = { mr: [], bo: [], trend: [] };
  for (const pair of PAIRS) {
    const name = pair.replace('=X', '');
    try {
      const [h1, d1] = await Promise.all([yahoo(pair, '1h', '730d'), yahoo(pair, '1d', '2y')]);
      const mr = runStrategy(h1, noManage, 25, mrSignal(h1));
      const bo = runStrategy(h1, noManage, 30, breakoutSignal(h1));
      const tr = runStrategy(d1, { ...trendCfg, ...noManage }, 210, trendSignal(d1, trendCfg));
      agg.mr.push(...mr);
      agg.bo.push(...bo);
      agg.trend.push(...tr);
      console.log(`${name}`);
      console.log(`  mean-rev  | ${fmt(metricsFromTrades(mr))}`);
      console.log(`  breakout  | ${fmt(metricsFromTrades(bo))}`);
      console.log(`  trend(1d) | ${fmt(metricsFromTrades(tr))}`);
    } catch (e) {
      console.log(`${name}: ERROR ${e.message}`);
    }
  }
  console.log('\n=== AGGREGATE (8 pairs, net of ~1.5bps/side) ===');
  console.log(`mean-rev  | ${fmt(metricsFromTrades(agg.mr))}`);
  console.log(`breakout  | ${fmt(metricsFromTrades(agg.bo))}`);
  console.log(`trend(1d) | ${fmt(metricsFromTrades(agg.trend))}`);
}

run();

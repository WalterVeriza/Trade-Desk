// Forex backtest harness — ROADMAP step 1-3.
// Pulls free Yahoo Finance FX candles (no key, no account) and replays the SAME
// strategy as the live bot (computeSignal + simulate) on forex pairs, net of a
// modeled spread/commission. Decoupled from any broker: this only answers
// "does the edge exist on forex?" before committing to a broker integration.
//
// Run: DATABASE_URL=<anything> node scripts/forex-backtest.js
// (config.js requires DATABASE_URL to load; no DB connection is made here.)

import { simulate, metricsFromTrades } from '../src/backtest.js';
import { DEFAULT_BOT_CONFIG } from '../src/config.js';
import { ema } from '../src/indicators.js';

// Trendy crosses + majors. =X is Yahoo's spot-FX suffix.
const PAIRS = [
  'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X',
  'USDCHF=X', 'GBPJPY=X', 'AUDJPY=X', 'EURJPY=X',
];

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
    out.push({ time: ts[i] * 1000, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume?.[i] || 0 });
  }
  return out.slice(0, -1); // drop the still-forming last bar
}

// Higher-timeframe (daily) trend bias aligned to the 1h bars without look-ahead.
function htfBias(tradingCandles, htfCandles) {
  const bias = new Array(tradingCandles.length).fill(0);
  if (htfCandles.length < 200) return bias;
  const closes = htfCandles.map((c) => c.close);
  const e200 = ema(closes, 200);
  const htfTime = htfCandles.map((c) => c.time);
  let j = -1;
  for (let i = 0; i < tradingCandles.length; i++) {
    const t = tradingCandles[i].time;
    while (j + 1 < htfCandles.length && htfTime[j + 1] <= t) j++;
    if (j >= 0 && e200[j] != null) bias[i] = closes[j] > e200[j] ? 1 : closes[j] < e200[j] ? -1 : 0;
  }
  return bias;
}

const fmt = (m) =>
  `trades ${String(m.trades).padStart(4)} | win ${String(m.winRate).padStart(5)}% | ` +
  `PF ${String(m.profitFactor ?? '—').padStart(5)} | expR ${String(m.expectancyR).padStart(6)} | ` +
  `totalR ${String(m.totalR).padStart(7)} | DD ${m.maxDrawdownR}`;

async function run() {
  // Forex config: same strategy, but volatility floor scaled to FX (ATR ~10x lower
  // than crypto) and a modeled cost per side (~1.5 bps ≈ tight major spread+commission).
  const cfg = {
    ...DEFAULT_BOT_CONFIG,
    minVolPct: 0.0015,
    mtfConfirm: true,
    feeRate: 0.00015, // per side, gets charged on entry AND exit inside simulate
    slipRate: 0,
  };
  console.log('Config:', JSON.stringify({ timeframe: '1h', adxMin: cfg.adxMin, atrSl: cfg.atrSl, atrTp: cfg.atrTp, beAtR: cfg.beAtR, mtfConfirm: cfg.mtfConfirm, minVolPct: cfg.minVolPct, feeRate: cfg.feeRate }));
  console.log('');

  let grossAll = [];
  let netAll = [];
  for (const pair of PAIRS) {
    try {
      const [h1, d1] = await Promise.all([yahoo(pair, '1h', '730d'), yahoo(pair, '1d', '2y')]);
      const bias = htfBias(h1, d1);
      const gross = simulate(h1, { ...cfg, feeRate: 0, slipRate: 0 }, bias);
      const net = simulate(h1, cfg, bias);
      grossAll = grossAll.concat(gross);
      netAll = netAll.concat(net);
      const name = pair.replace('=X', '');
      console.log(`${name.padEnd(7)} (${h1.length} h1, ${d1.length} d1)`);
      console.log(`  gross | ${fmt(metricsFromTrades(gross))}`);
      console.log(`  net   | ${fmt(metricsFromTrades(net))}`);
    } catch (e) {
      console.log(`${pair}: ERROR ${e.message}`);
    }
  }
  console.log('\n=== AGGREGATE (8 pairs) ===');
  console.log(`gross | ${fmt(metricsFromTrades(grossAll))}`);
  console.log(`net   | ${fmt(metricsFromTrades(netAll))}`);
}

run();

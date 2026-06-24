// One-off parameter sweep for the strategy bot. Fetches candle history once per
// timeframe, then replays simulate() in-memory across a parameter grid on all 8
// symbols. Ranks by ROBUST edge (generalises across symbols), not peak totalR.
//
//   node optimize.js
import { SYMBOLS, SIGNAL_WARMUP, HTF_MAP, DEFAULT_BOT_CONFIG } from './src/config.js';
import { fetchHistory } from './src/market.js';
import { simulate, metricsFromTrades } from './src/backtest.js';
import { ema } from './src/indicators.js';

const BARS = 1500;
const INTERVALS = ['5m', '15m', '1h'];

// Copy of backtest.buildHtfBias (not exported) for mtfConfirm sweeping.
function buildHtfBias(trading, htf) {
  const bias = new Array(trading.length).fill(0);
  if (htf.length < 200) return bias;
  const closes = htf.map((c) => c.close);
  const e200 = ema(closes, 200);
  const htfTime = htf.map((c) => c.time);
  let j = -1;
  for (let i = 0; i < trading.length; i++) {
    const t = trading[i].time;
    while (j + 1 < htf.length && htfTime[j + 1] <= t) j++;
    if (j >= 0 && e200[j] != null) bias[i] = closes[j] > e200[j] ? 1 : closes[j] < e200[j] ? -1 : 0;
  }
  return bias;
}

const cache = {}; // interval -> { candles:{sym:[]}, bias:{sym:[]} }

async function preload() {
  for (const itv of INTERVALS) {
    cache[itv] = { candles: {}, bias: {} };
    for (const s of SYMBOLS) {
      const c = (await fetchHistory(s.symbol, itv, BARS)).slice(0, -1);
      cache[itv].candles[s.symbol] = c;
      const htf = await fetchHistory(s.symbol, HTF_MAP[itv], 500).catch(() => []);
      cache[itv].bias[s.symbol] = buildHtfBias(c, htf);
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');
}

function run(itv, cfg) {
  let all = [];
  let posSyms = 0;
  for (const s of SYMBOLS) {
    const c = cache[itv].candles[s.symbol];
    const bias = cfg.mtfConfirm ? cache[itv].bias[s.symbol] : null;
    const trades = simulate(c, cfg, bias);
    all = all.concat(trades);
    if (trades.reduce((a, t) => a + t.r, 0) > 0) posSyms += 1;
  }
  return { m: metricsFromTrades(all), posSyms };
}

// Parameter grid.
const GRID = {
  confidenceMin: [55, 65, 75],
  adxMin: [15, 20, 25],
  rr: [
    [1.5, 3],
    [1.0, 2],
    [1.5, 2.25],
    [2, 4],
    [1.0, 3],
  ],
  beAtR: [0, 1],
  trailR: [0, 1.5],
  mtfConfirm: [false, true],
};

function* combos() {
  for (const itv of INTERVALS)
    for (const confidenceMin of GRID.confidenceMin)
      for (const adxMin of GRID.adxMin)
        for (const [atrSl, atrTp] of GRID.rr)
          for (const beAtR of GRID.beAtR)
            for (const trailR of GRID.trailR)
              for (const mtfConfirm of GRID.mtfConfirm)
                yield { itv, cfg: { ...DEFAULT_BOT_CONFIG, confidenceMin, adxMin, atrSl, atrTp, beAtR, trailR, mtfConfirm } };
}

async function main() {
  console.log(`Preloading ${INTERVALS.length} timeframes × ${SYMBOLS.length} symbols …`);
  await preload();

  const results = [];
  for (const { itv, cfg } of combos()) {
    const { m, posSyms } = run(itv, cfg);
    results.push({ itv, cfg, m, posSyms });
  }
  console.log(`Evaluated ${results.length} configs.\n`);

  // Baseline (current defaults) for reference.
  const base = results.find(
    (r) =>
      r.itv === DEFAULT_BOT_CONFIG.timeframe &&
      r.cfg.confidenceMin === DEFAULT_BOT_CONFIG.confidenceMin &&
      r.cfg.adxMin === DEFAULT_BOT_CONFIG.adxMin &&
      r.cfg.atrSl === DEFAULT_BOT_CONFIG.atrSl &&
      r.cfg.atrTp === DEFAULT_BOT_CONFIG.atrTp &&
      r.cfg.beAtR === 0 &&
      r.cfg.trailR === 0 &&
      r.cfg.mtfConfirm === false
  );

  // Robust filter: enough trades, real edge, generalises across symbols.
  const eligible = results.filter(
    (r) => r.m.trades >= 40 && (r.m.profitFactor ?? 0) >= 1.2 && r.posSyms >= 5
  );
  // Rank by edge that generalises: expectancy × symbol-breadth, drawdown-aware.
  const score = (r) => r.m.expectancyR * r.posSyms - r.m.maxDrawdownR * 0.02;
  eligible.sort((a, b) => score(b) - score(a));

  const fmt = (r) =>
    `${r.itv.padEnd(3)} conf${r.cfg.confidenceMin} adx${r.cfg.adxMin} ` +
    `SL${r.cfg.atrSl}/TP${r.cfg.atrTp} be${r.cfg.beAtR} tr${r.cfg.trailR} ` +
    `mtf${r.cfg.mtfConfirm ? 'Y' : 'N'} | ` +
    `n=${String(r.m.trades).padStart(3)} win%=${String(r.m.winRate).padStart(5)} ` +
    `exp=${r.m.expectancyR.toFixed(3)} totR=${String(r.m.totalR).padStart(6)} ` +
    `PF=${r.m.profitFactor} DD=${r.m.maxDrawdownR} pos=${r.posSyms}/8`;

  console.log('=== BASELINE (current defaults) ===');
  console.log(base ? fmt(base) : 'not in grid');
  console.log(`\n=== TOP 15 ROBUST CONFIGS (n≥40, PF≥1.2, ≥5/8 symbols positive) ===`);
  eligible.slice(0, 15).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${fmt(r)}`));
  console.log(`\n(${eligible.length} configs passed the robustness filter)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

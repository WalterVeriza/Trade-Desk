import { SYMBOLS, SIGNAL_WARMUP } from './config.js';
import { fetchHistory } from './market.js';
import { computeSignal } from './strategy.js';

// Replay computeSignal bar by bar over closed candles (oldest -> newest) and
// simulate the same TP/SL the live bot uses. P&L is expressed in R (multiples of
// the risked stop distance), so results are independent of position sizing.
//
// Entry: at the close of a bar whose signal clears confidenceMin and adxMin.
// Exit:  on a later bar whose range touches TP or SL. When a single bar spans
//        both levels we assume the stop hit first (conservative).
export function simulate(candles, cfg) {
  const trades = [];
  let pos = null;
  for (let i = SIGNAL_WARMUP; i < candles.length; i++) {
    if (pos) {
      const bar = candles[i];
      let exit = null;
      let reason = null;
      if (pos.side === 'long') {
        if (bar.low <= pos.sl) (exit = pos.sl), (reason = 'sl');
        else if (bar.high >= pos.tp) (exit = pos.tp), (reason = 'tp');
      } else {
        if (bar.high >= pos.sl) (exit = pos.sl), (reason = 'sl');
        else if (bar.low <= pos.tp) (exit = pos.tp), (reason = 'tp');
      }
      if (exit != null) {
        const risk = Math.abs(pos.entry - pos.sl) || 1;
        const r = ((pos.side === 'long' ? exit - pos.entry : pos.entry - exit) / risk);
        trades.push({ side: pos.side, entry: pos.entry, exit, reason, r, bars: i - pos.entryIdx });
        pos = null;
      }
    }
    if (!pos) {
      const sig = computeSignal(candles.slice(0, i + 1), cfg);
      if (sig && sig.confidence >= cfg.confidenceMin && (sig.adx ?? 0) >= (cfg.adxMin ?? 0)) {
        pos = { side: sig.side, entry: sig.price, tp: sig.tp, sl: sig.sl, entryIdx: i };
      }
    }
  }
  return trades;
}

export function metricsFromTrades(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.r > 0);
  const grossWin = wins.reduce((a, t) => a + t.r, 0);
  const grossLoss = trades.filter((t) => t.r < 0).reduce((a, t) => a + t.r, 0); // <= 0
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDD = Math.min(maxDD, equity - peak);
  }
  const round = (x) => Math.round(x * 100) / 100;
  return {
    trades: n,
    wins: wins.length,
    losses: n - wins.length,
    winRate: round(n ? (wins.length / n) * 100 : 0),
    expectancyR: round(n ? trades.reduce((a, t) => a + t.r, 0) / n : 0),
    totalR: round(equity),
    profitFactor: grossLoss !== 0 ? round(grossWin / Math.abs(grossLoss)) : null,
    maxDrawdownR: round(Math.abs(maxDD)),
    avgWinR: round(wins.length ? grossWin / wins.length : 0),
    avgLossR: round(n - wins.length ? grossLoss / (n - wins.length) : 0),
  };
}

export async function backtestSymbol(symbol, interval, bars, cfg) {
  const candles = (await fetchHistory(symbol, interval, bars)).slice(0, -1); // drop forming bar
  const trades = simulate(candles, cfg);
  return { symbol, interval, candles: candles.length, metrics: metricsFromTrades(trades) };
}

export async function backtestAll(interval, bars, cfg) {
  const perSymbol = [];
  let allTrades = [];
  for (const s of SYMBOLS) {
    try {
      const candles = (await fetchHistory(s.symbol, interval, bars)).slice(0, -1);
      const trades = simulate(candles, cfg);
      allTrades = allTrades.concat(trades);
      perSymbol.push({ symbol: s.symbol, candles: candles.length, metrics: metricsFromTrades(trades) });
    } catch (e) {
      perSymbol.push({ symbol: s.symbol, error: e.message });
    }
  }
  return { interval, bars, config: cfg, perSymbol, aggregate: metricsFromTrades(allTrades) };
}

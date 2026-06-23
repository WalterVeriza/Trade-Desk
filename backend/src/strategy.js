import { ema, rsi, macd, atr, adx, last, prev } from './indicators.js';

// Higher-timeframe trend bias from a candle series (oldest -> newest):
// +1 bullish / -1 bearish / 0 unknown, based on price vs EMA200. Used by the
// MTF filter so the bot only takes trades aligned with the bigger trend.
export function htfTrend(candles) {
  if (!candles || candles.length < 200) return 0;
  const closes = candles.map((c) => c.close);
  const e200 = last(ema(closes, 200));
  if (e200 == null) return 0;
  const price = closes[closes.length - 1];
  return price > e200 ? 1 : price < e200 ? -1 : 0;
}

// Analyse candles (oldest -> newest) and return a confluence signal with
// ATR-based take-profit / stop-loss. Returns null if not enough history.
export function computeSignal(candles, cfg) {
  if (!candles || candles.length < 210) return null; // EMA200 warm-up
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const e20 = last(ema(closes, 20));
  const e50 = last(ema(closes, 50));
  const e200 = last(ema(closes, 200));
  const r = last(rsi(closes, 14));
  const m = macd(closes);
  const hist = last(m.hist);
  const histPrev = prev(m.hist);
  const a = last(atr(highs, lows, closes, 14));
  const ax = last(adx(highs, lows, closes, 14));
  const price = closes[closes.length - 1];
  if ([e20, e50, e200, r, hist, a].some((v) => v == null)) return null;

  // Weighted confluence score for each direction (0-100).
  const longReasons = [];
  let longScore = 0;
  if (price > e200) (longScore += 25), longReasons.push('Prix > EMA200 (tendance haussière)');
  if (e20 > e50) (longScore += 20), longReasons.push('EMA20 > EMA50 (momentum court terme)');
  if (hist > 0) (longScore += 15), longReasons.push('MACD haussier');
  if (histPrev != null && hist > histPrev) (longScore += 10), longReasons.push('MACD se renforce');
  if (r >= 45 && r <= 68) (longScore += 20), longReasons.push(`RSI sain (${r.toFixed(0)})`);
  else if (r >= 35 && r < 45) longScore += 8;
  if (price > e20) (longScore += 10), longReasons.push('Prix > EMA20');

  const shortReasons = [];
  let shortScore = 0;
  if (price < e200) (shortScore += 25), shortReasons.push('Prix < EMA200 (tendance baissière)');
  if (e20 < e50) (shortScore += 20), shortReasons.push('EMA20 < EMA50 (momentum court terme)');
  if (hist < 0) (shortScore += 15), shortReasons.push('MACD baissier');
  if (histPrev != null && hist < histPrev) (shortScore += 10), shortReasons.push('MACD s’affaiblit');
  if (r <= 55 && r >= 32) (shortScore += 20), shortReasons.push(`RSI sain (${r.toFixed(0)})`);
  else if (r > 55 && r <= 65) shortScore += 8;
  if (price < e20) (shortScore += 10), shortReasons.push('Prix < EMA20');

  const side = longScore >= shortScore ? 'long' : 'short';
  const confidence = Math.round(side === 'long' ? longScore : shortScore);
  const reasons = side === 'long' ? longReasons : shortReasons;

  // Regime note: trend strength via ADX. The bot won't open below cfg.adxMin
  // (see bot.scan) — surface it here so the UI explains why a high-confidence
  // signal may still be skipped in a flat market.
  const adxMin = cfg.adxMin ?? 20;
  if (ax != null) {
    reasons.push(ax >= adxMin ? `Tendance forte (ADX ${ax.toFixed(0)})` : `Tendance faible (ADX ${ax.toFixed(0)}) — range`);
  }

  // Floor the stop distance so low-volatility pairs don't get a stop inside the
  // spread (which would trigger instantly). Preserve the configured R:R.
  const minStop = price * (cfg.minStopPct ?? 0.004);
  const slDist = Math.max(cfg.atrSl * a, minStop);
  const tpDist = slDist * (cfg.atrTp / cfg.atrSl);
  const sl = side === 'long' ? price - slDist : price + slDist;
  const tp = side === 'long' ? price + tpDist : price - tpDist;

  return {
    side,
    confidence,
    price,
    tp,
    sl,
    atr: a,
    adx: ax,
    rsi: r,
    ema20: e20,
    ema50: e50,
    ema200: e200,
    macdHist: hist,
    reasons,
    ts: Date.now(),
  };
}

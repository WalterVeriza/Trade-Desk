// Pure technical-indicator functions. Each returns an array aligned to the input
// length (leading nulls during the warm-up period). Read the last value for the
// current reading.

export function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const out = new Array(period - 1).fill(null);
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// Wilder's RSI.
export function rsi(closes, period = 14) {
  if (closes.length <= period) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const out = new Array(period).fill(null);
  out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const start = line.findIndex((v) => v != null);
  const sigTail = start >= 0 ? ema(line.slice(start), signalPeriod) : [];
  const signal = closes.map(() => null);
  for (let i = 0; i < sigTail.length; i++) signal[start + i] = sigTail[i];
  const hist = closes.map((_, i) => (line[i] != null && signal[i] != null ? line[i] - signal[i] : null));
  return { line, signal, hist };
}

// Wilder's Average True Range.
export function atr(highs, lows, closes, period = 14) {
  const tr = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      tr.push(highs[i] - lows[i]);
      continue;
    }
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }
  if (tr.length < period) return [];
  const out = new Array(period - 1).fill(null);
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  out.push(a);
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out.push(a);
  }
  return out;
}

// Last / nth-from-last non-null helpers.
export function last(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

export function prev(arr) {
  let seen = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) {
      seen += 1;
      if (seen === 2) return arr[i];
    }
  }
  return null;
}

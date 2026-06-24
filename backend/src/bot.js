import { SYMBOLS, DEFAULT_BOT_CONFIG, BOT_TIMEFRAMES, HTF_MAP } from './config.js';
import {
  getBotState,
  setBotEnabled,
  setBotConfig,
  insertBotTrade,
  updateBotTradeFill,
  deleteBotTrade,
  getOpenBotTrades,
  claimBotTrade,
  finalizeBotTrade,
  revertBotTrade,
  getRecentClosedBotTrades,
  getBotStats,
  getAccount,
  getPositions,
  getPosition,
  updateBotTradeStop,
} from './db.js';
import { fetchKlines, getPrice, getPriceMap } from './market.js';
import { placeOrder } from './engine.js';
import { computeSignal, htfTrend, manageStop } from './strategy.js';

let enabled = false;
let config = { ...DEFAULT_BOT_CONFIG };
const signals = new Map(); // symbol -> latest signal (display)
let openTrades = []; // in-memory mirror of open bot_trades
const inFlight = new Set(); // symbols currently opening/closing (lock)
const cooldownUntil = new Map(); // symbol -> timestamp; no re-entry before then
const peak = new Map(); // trade id -> best favorable price since entry (for trailing)
let scanning = false;
let loopTimer = null;

let onBot = null; // broadcast full bot snapshot
let onState = null; // push account/positions/orders refresh

export function setBotHooks(hooks) {
  onBot = hooks.onBot;
  onState = hooks.onState;
}

export async function getBotSnapshot() {
  const [recentClosed, stats] = await Promise.all([getRecentClosedBotTrades(25), getBotStats()]);
  return {
    enabled,
    config,
    timeframes: BOT_TIMEFRAMES,
    signals: Object.fromEntries(signals),
    openTrades,
    recentClosed,
    stats,
  };
}

async function broadcast() {
  if (!onBot) return;
  try {
    onBot(await getBotSnapshot());
  } catch (e) {
    console.error('[bot] broadcast error:', e.message);
  }
}

export async function toggle(value) {
  enabled = !!value;
  await setBotEnabled(enabled);
  console.log(`[bot] ${enabled ? 'ENABLED' : 'DISABLED'}`);
  await broadcast();
  return { enabled };
}

export async function updateConfig(patch) {
  const next = { ...config };
  const num = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  if (patch.timeframe && BOT_TIMEFRAMES.includes(patch.timeframe)) next.timeframe = patch.timeframe;
  if (patch.confidenceMin != null) next.confidenceMin = num(patch.confidenceMin, 0, 100, config.confidenceMin);
  if (patch.riskPct != null) next.riskPct = num(patch.riskPct, 0.1, 20, config.riskPct);
  if (patch.atrSl != null) next.atrSl = num(patch.atrSl, 0.2, 10, config.atrSl);
  if (patch.atrTp != null) next.atrTp = num(patch.atrTp, 0.2, 20, config.atrTp);
  if (patch.adxMin != null) next.adxMin = num(patch.adxMin, 0, 60, config.adxMin);
  if (patch.beAtR != null) next.beAtR = num(patch.beAtR, 0, 10, config.beAtR);
  if (patch.trailR != null) next.trailR = num(patch.trailR, 0, 10, config.trailR);
  if (patch.mtfConfirm != null) next.mtfConfirm = !!patch.mtfConfirm;
  if (patch.maxPositions != null) next.maxPositions = Math.round(num(patch.maxPositions, 1, 8, config.maxPositions));
  if (patch.loopSec != null) next.loopSec = Math.round(num(patch.loopSec, 5, 120, config.loopSec));
  const loopChanged = next.loopSec !== config.loopSec;
  config = next;
  await setBotConfig(config);
  if (loopChanged) restartLoop();
  await broadcast();
  return { config };
}

function roundQty(qty) {
  return Number(qty.toFixed(6));
}

// Risk-based position sizing, capped by concentration and available cash.
async function sizeTrade(signal) {
  const [acct, positions] = await Promise.all([getAccount(), getPositions()]);
  const priceMap = getPriceMap();
  let equity = acct.cash;
  for (const p of positions) equity += p.qty * (priceMap[p.symbol] ?? p.avgPrice);

  const price = getPrice(signal.symbol) || signal.price;
  const slDist = Math.abs(price - signal.sl);
  if (!(slDist > 0)) return 0;

  const riskAmount = equity * (config.riskPct / 100);
  let qty = riskAmount / slDist;

  // Cap concentration so several positions can coexist.
  const maxNotional = equity / config.maxPositions;
  if (qty * price > maxNotional) qty = maxNotional / price;
  // A long cannot exceed available cash.
  if (signal.side === 'long' && qty * price > acct.cash) qty = (acct.cash * 0.98) / price;

  qty = roundQty(qty);
  if (qty <= 0 || qty * price < config.minNotional) return 0;
  return qty;
}

async function openTrade(signal) {
  const { symbol } = signal;
  if (inFlight.has(symbol)) return;
  inFlight.add(symbol);
  try {
    const qty = await sizeTrade(signal);
    if (!qty) return;

    // Claim the per-symbol slot FIRST (provisional prices). The partial unique
    // index makes this atomic: if a trade on this symbol is already open — stale
    // mirror or a second instance — the insert throws and we skip without ever
    // placing an order, so we can't stack an opposite position on the symbol.
    let claim;
    try {
      claim = await insertBotTrade({
        symbol,
        side: signal.side,
        qty,
        entryPrice: signal.price,
        tp: signal.tp,
        sl: signal.sl,
        confidence: signal.confidence,
      });
    } catch {
      return; // symbol already has an open trade
    }

    try {
      const orderSide = signal.side === 'long' ? 'buy' : 'sell';
      const { order } = await placeOrder({ symbol, side: orderSide, type: 'market', qty }, getPrice);
      const entry = order.fillPrice;
      // Recompute TP/SL from the actual fill, preserving the ATR distances.
      const slDist = Math.abs(signal.price - signal.sl);
      const tpDist = Math.abs(signal.tp - signal.price);
      const sl = signal.side === 'long' ? entry - slDist : entry + slDist;
      const tp = signal.side === 'long' ? entry + tpDist : entry - tpDist;
      await updateBotTradeFill(claim.id, entry, tp, sl);
      console.log(`[bot] OPEN ${signal.side} ${qty} ${symbol} @ ${entry} (conf ${signal.confidence}%)`);
    } catch (e) {
      await deleteBotTrade(claim.id); // release the slot; no position was opened
      throw e;
    }
    openTrades = await getOpenBotTrades();
    if (onState) await onState();
    await broadcast();
  } catch (e) {
    console.error(`[bot] open ${symbol} failed:`, e.message);
  } finally {
    inFlight.delete(symbol);
  }
}

async function closeTrade(trade, reason) {
  const { symbol } = trade;
  if (inFlight.has(symbol)) return;
  inFlight.add(symbol);
  try {
    // Atomically claim the trade so a concurrent tick can't close it twice.
    const claimed = await claimBotTrade(trade.id);
    if (!claimed) return;
    try {
      // The book is shared with manual trading. Never close more than the book
      // actually holds in our direction — otherwise a manual close/flip of the
      // underlying would make this "close" open an *opposite* position.
      const pos = await getPosition(symbol);
      const available = trade.side === 'long' ? Math.max(0, pos) : Math.max(0, -pos);
      const closeQty = Math.min(trade.qty, available);
      let exit = getPrice(symbol) ?? trade.entryPrice;
      if (closeQty > 0) {
        const orderSide = trade.side === 'long' ? 'sell' : 'buy';
        const { order } = await placeOrder({ symbol, side: orderSide, type: 'market', qty: closeQty }, getPrice);
        exit = order.fillPrice;
      } else {
        // Underlying already flat (closed manually) — settle the trade for the
        // bot's books at the current mark, without touching the position.
        reason = `${reason}/flat`;
      }
      const settledQty = closeQty > 0 ? closeQty : trade.qty;
      const pnl = trade.side === 'long' ? (exit - trade.entryPrice) * settledQty : (trade.entryPrice - exit) * settledQty;
      await finalizeBotTrade(trade.id, exit, reason, pnl);
      peak.delete(trade.id);
      cooldownUntil.set(symbol, Date.now() + config.cooldownSec * 1000);
      console.log(`[bot] CLOSE ${trade.side} ${symbol} @ ${exit} (${reason}) qty=${closeQty} pnl=${pnl.toFixed(2)}`);
    } catch (e) {
      await revertBotTrade(trade.id); // restore so TP/SL stays managed
      throw e;
    }
    openTrades = await getOpenBotTrades();
    if (onState) await onState();
    await broadcast();
  } catch (e) {
    console.error(`[bot] close ${symbol} failed:`, e.message);
  } finally {
    inFlight.delete(symbol);
  }
}

// Called on every market tick: advance break-even/trailing stops, then enforce
// TP/SL on open trades.
export async function onTick() {
  if (!openTrades.length) return;
  const priceMap = getPriceMap();
  for (const t of openTrades) {
    if (inFlight.has(t.symbol)) continue;
    const px = priceMap[t.symbol];
    if (!px) continue;

    const initSl = t.initSl ?? t.sl;
    // Track the best favorable price and ratchet the stop (break-even / trailing).
    const best = t.side === 'long'
      ? Math.max(peak.get(t.id) ?? t.entryPrice, px)
      : Math.min(peak.get(t.id) ?? t.entryPrice, px);
    peak.set(t.id, best);
    const newSl = manageStop(t.side, t.entryPrice, t.sl, initSl, best, config);
    if (newSl !== t.sl) {
      t.sl = newSl;
      try {
        await updateBotTradeStop(t.id, newSl);
      } catch (e) {
        console.error(`[bot] trail persist ${t.symbol}:`, e.message);
      }
    }

    if (t.side === 'long') {
      if (px >= t.tp) await closeTrade(t, 'tp');
      else if (px <= t.sl) await closeTrade(t, newSl > initSl ? 'trail' : 'sl');
    } else {
      if (px <= t.tp) await closeTrade(t, 'tp');
      else if (px >= t.sl) await closeTrade(t, newSl < initSl ? 'trail' : 'sl');
    }
  }
}

// Periodic signal scan: recompute every symbol, open trades when enabled.
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const now = Date.now();
    const openSymbols = new Set(openTrades.map((t) => t.symbol));
    for (const s of SYMBOLS) {
      try {
        // Drop the last, still-forming candle so indicators are computed only on
        // closed bars — otherwise the signal flickers as the live bar updates.
        const candles = (await fetchKlines(s.symbol, config.timeframe, 300)).slice(0, -1);
        const sig = computeSignal(candles, config);
        if (sig) {
          sig.symbol = s.symbol;
          // Multi-timeframe confirmation: only trade with the higher-TF trend.
          let htfBias = 0;
          if (config.mtfConfirm && HTF_MAP[config.timeframe]) {
            try {
              const htf = (await fetchKlines(s.symbol, HTF_MAP[config.timeframe], 300)).slice(0, -1);
              htfBias = htfTrend(htf);
            } catch {
              /* leave bias neutral on a transient HTF fetch error */
            }
          }
          sig.htfBias = htfBias;
          const mtfOk = !config.mtfConfirm || (sig.side === 'long' ? htfBias > 0 : htfBias < 0);
          if (config.mtfConfirm) {
            sig.reasons.push(mtfOk ? `Tendance ${HTF_MAP[config.timeframe]} alignée` : `Contre la tendance ${HTF_MAP[config.timeframe]}`);
          }
          signals.set(s.symbol, sig);
          const cd = cooldownUntil.get(s.symbol);
          const canOpen =
            enabled &&
            sig.confidence >= config.confidenceMin &&
            (sig.adx ?? 0) >= config.adxMin &&
            mtfOk &&
            !openSymbols.has(s.symbol) &&
            openTrades.length < config.maxPositions &&
            !(cd && cd > now);
          if (canOpen) {
            await openTrade(sig);
            openSymbols.add(s.symbol);
          }
        }
      } catch (e) {
        console.error(`[bot] scan ${s.symbol}:`, e.message);
      }
    }
    await broadcast();
  } finally {
    scanning = false;
  }
}

function restartLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(() => scan().catch((e) => console.error('[bot] scan error:', e.message)), config.loopSec * 1000);
}

// Re-sync the in-memory trade mirror from the DB (used after a desk reset).
export async function reloadTrades() {
  openTrades = await getOpenBotTrades();
  cooldownUntil.clear();
  peak.clear();
  await broadcast();
}

export async function startBot() {
  const state = await getBotState();
  enabled = state.enabled;
  config = state.config;
  openTrades = await getOpenBotTrades();
  await scan().catch((e) => console.error('[bot] first scan failed:', e.message));
  restartLoop();
  console.log(`[bot] strategy engine started (${config.timeframe}, scan ${config.loopSec}s, ${enabled ? 'ENABLED' : 'standby'})`);
}

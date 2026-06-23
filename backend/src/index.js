import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { PORT, SYMBOLS, STARTING_CASH, BACKTEST_BARS, BACKTEST_MAX_BARS, SIGNAL_WARMUP } from './config.js';
import { initDb, getAccount, getPositions, getOrders, closeAllOpenBotTrades, getBotState } from './db.js';
import { backtestSymbol, backtestAll } from './backtest.js';
import {
  startMarketFeed,
  setBroadcast,
  getMarket,
  getPrice,
  getSparkline,
  fetchKlines,
} from './market.js';
import { placeOrder, cancelOrder, resetDesk } from './engine.js';
import {
  startBot,
  setBotHooks,
  getBotSnapshot,
  onTick as botOnTick,
  toggle as botToggle,
  updateConfig as botUpdateConfig,
  reloadTrades as botReloadTrades,
} from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Allow the Vercel frontend. CORS_ORIGIN may be a comma-separated list; trailing
// slashes are tolerated (a browser Origin never has one, a common misconfig).
// If CORS_ORIGIN is unset, reflect any origin so local dev works out of the box.
const stripSlash = (s) => s.trim().replace(/\/+$/, '');
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(stripSlash).filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowedOrigins.length === 0) return cb(null, true);
      cb(null, allowedOrigins.includes(stripSlash(origin)));
    },
  })
);
app.use(express.json());

// ----------------------------- REST API -----------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

// Full bootstrap snapshot for the client.
app.get('/api/state', async (req, res, next) => {
  try {
    const [account, positions, orders] = await Promise.all([
      getAccount(),
      getPositions(),
      getOrders(),
    ]);
    res.json({
      symbols: SYMBOLS,
      market: getMarket(),
      sparklines: Object.fromEntries(SYMBOLS.map((s) => [s.symbol, getSparkline(s.symbol)])),
      account,
      positions,
      orders,
      startingCash: STARTING_CASH,
      bot: await getBotSnapshot(),
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/market', (req, res) => res.json(getMarket()));

app.get('/api/klines/:symbol', async (req, res, next) => {
  try {
    const { interval = '1m', limit = '120' } = req.query;
    const data = await fetchKlines(req.params.symbol, interval, Number(limit));
    res.json(data);
  } catch (e) {
    next(e);
  }
});

app.get('/api/account', async (req, res, next) => {
  try {
    res.json(await getAccount());
  } catch (e) {
    next(e);
  }
});

app.get('/api/positions', async (req, res, next) => {
  try {
    res.json(await getPositions());
  } catch (e) {
    next(e);
  }
});

app.get('/api/orders', async (req, res, next) => {
  try {
    res.json(await getOrders(req.query.status));
  } catch (e) {
    next(e);
  }
});

app.post('/api/orders', async (req, res, next) => {
  try {
    const result = await placeOrder(req.body, getPrice);
    await pushState();
    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/orders/:id', async (req, res, next) => {
  try {
    const order = await cancelOrder(Number(req.params.id));
    await pushState();
    res.json(order);
  } catch (e) {
    next(e);
  }
});

app.post('/api/reset', async (req, res, next) => {
  try {
    await resetDesk(STARTING_CASH);
    await closeAllOpenBotTrades('reset');
    await botReloadTrades();
    await pushState();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ----------------------------- Strategy bot -----------------------------
app.get('/api/bot', async (req, res, next) => {
  try {
    res.json(await getBotSnapshot());
  } catch (e) {
    next(e);
  }
});

app.post('/api/bot/toggle', async (req, res, next) => {
  try {
    res.json(await botToggle(req.body?.enabled));
  } catch (e) {
    next(e);
  }
});

app.post('/api/bot/config', async (req, res, next) => {
  try {
    res.json(await botUpdateConfig(req.body || {}));
  } catch (e) {
    next(e);
  }
});

// Backtest the current strategy over recent candle history. Returns P&L in R
// (stop-distance multiples). Optional query: symbol, interval, bars, and config
// overrides (confidenceMin, adxMin, atrSl, atrTp) to A/B-test parameters.
app.get('/api/bot/backtest', async (req, res, next) => {
  try {
    const { config } = await getBotState();
    const interval = req.query.interval || config.timeframe;
    const bars = Math.min(
      Math.max(Number(req.query.bars) || BACKTEST_BARS, SIGNAL_WARMUP + 50),
      BACKTEST_MAX_BARS
    );
    const cfg = { ...config };
    for (const k of ['confidenceMin', 'adxMin', 'atrSl', 'atrTp', 'beAtR', 'trailR']) {
      if (req.query[k] != null && Number.isFinite(Number(req.query[k]))) cfg[k] = Number(req.query[k]);
    }
    if (req.query.mtfConfirm != null) cfg.mtfConfirm = !['0', 'false', 'no'].includes(String(req.query.mtfConfirm).toLowerCase());
    const result = req.query.symbol
      ? await backtestSymbol(req.query.symbol, interval, bars, cfg)
      : await backtestAll(interval, bars, cfg);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Serve the built frontend (production) if present.
const distDir = path.join(__dirname, '..', '..', 'frontend', 'dist');
const distExists = fs.existsSync(distDir);
if (distExists) {
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
      return res.sendFile(path.join(distDir, 'index.html'));
    }
    next();
  });
}

// Error handler
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err.message || 'Server error' });
});

// ----------------------------- WebSocket -----------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// Push fresh account/positions/open-orders to every client.
async function pushState() {
  try {
    const [account, positions, orders] = await Promise.all([
      getAccount(),
      getPositions(),
      getOrders(),
    ]);
    broadcast({ type: 'state', account, positions, orders });
  } catch (e) {
    console.error('[ws] pushState error:', e.message);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'tick', market: getMarket() }));
});

// Bot hooks: push portfolio refreshes and bot snapshots to all clients.
setBotHooks({
  onState: pushState,
  onBot: (bot) => broadcast({ type: 'bot', bot }),
});

// Market feed -> broadcast live ticks; enforce bot TP/SL; refresh on fills.
setBroadcast(({ market, fills }) => {
  broadcast({ type: 'tick', market });
  botOnTick().catch((e) => console.error('[ws] bot tick error:', e.message));
  if (fills && fills.length) pushState();
});

// ----------------------------- Boot -----------------------------
(async () => {
  try {
    console.log('[boot] initializing database...');
    await initDb();
    console.log('[boot] database ready');
    await startMarketFeed();
    await startBot();
    server.listen(PORT, () => {
      console.log(`[boot] Trader Desk backend listening on http://localhost:${PORT}`);
      console.log(`[boot] WebSocket on ws://localhost:${PORT}/ws`);
    });
  } catch (e) {
    console.error('[boot] fatal:', e);
    process.exit(1);
  }
})();

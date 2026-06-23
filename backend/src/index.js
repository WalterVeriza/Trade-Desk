import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { PORT, SYMBOLS, STARTING_CASH } from './config.js';
import { initDb, getAccount, getPositions, getOrders } from './db.js';
import {
  startMarketFeed,
  setBroadcast,
  getMarket,
  getPrice,
  getSparkline,
  fetchKlines,
} from './market.js';
import { placeOrder, cancelOrder, resetDesk } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// Allow the Vercel frontend (set CORS_ORIGIN to its URL in production).
// Defaults to reflecting the request origin so local dev works out of the box.
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
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
    await pushState();
    res.json({ ok: true });
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

// Market feed -> broadcast live ticks; refresh state when fills happen.
setBroadcast(({ market, fills }) => {
  broadcast({ type: 'tick', market });
  if (fills && fills.length) pushState();
});

// ----------------------------- Boot -----------------------------
(async () => {
  try {
    console.log('[boot] initializing database...');
    await initDb();
    console.log('[boot] database ready');
    await startMarketFeed();
    server.listen(PORT, () => {
      console.log(`[boot] Trader Desk backend listening on http://localhost:${PORT}`);
      console.log(`[boot] WebSocket on ws://localhost:${PORT}/ws`);
    });
  } catch (e) {
    console.error('[boot] fatal:', e);
    process.exit(1);
  }
})();

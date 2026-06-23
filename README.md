# Trader Desk — Live Crypto Trading Desk

A complete, operational paper-trading desk with a real-time market data feed,
a full order-management backend, persistent state in **Neon Postgres**, and a
custom **dark-themed** React interface.

![desk](https://img.shields.io/badge/symbols-8-blue) ![feed](https://img.shields.io/badge/data-realtime-2ebd85) ![db-Neon%20Postgres-purple]()

## What it does

- **Live market data** for 8 symbols, pulled from the public **Coinbase** REST API
  every 3 s (no API key required): BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX.
  (Coinbase is used instead of Binance because Binance returns HTTP 451 to US
  cloud IPs such as Render's.)
- **Real-time UI** — the backend pushes ticks to the browser over a WebSocket; the
  watchlist, chart, positions and P&L all update live.
- **Order management** — market & limit orders, resting limit orders that fill when
  the market crosses them, cancellation, and an order blotter.
- **Portfolio accounting** — weighted-average cost basis, realized & unrealized P&L,
  cash balance, equity, long *and* short positions.
- **Persistence** — symbols, ticks, orders, positions and the cash account are all
  stored in Neon Postgres (accessed over HTTPS via `@neondatabase/serverless`,
  so it works even where TCP port 5432 is blocked).
- **Custom dark theme** — bespoke CSS, candlestick chart on `<canvas>`, sparklines,
  live connection indicator.

## Architecture

```
Coinbase REST ─poll 3s─> Backend (Express + ws)  ──WebSocket──> React UI (Vite)
                               │
                               └── Neon Postgres (HTTPS driver)
```

| Layer    | Stack                                                        |
|----------|--------------------------------------------------------------|
| Backend  | Node 20+, Express 5, `ws`, `@neondatabase/serverless`        |
| Frontend | React 18, Vite, custom CSS, canvas candlestick chart         |
| Data     | Coinbase public API (prices + candles)                         |
| Storage  | Neon Postgres                                                |

## Running it

The database URL is already configured in `backend/.env`.

**Terminal 1 — backend (port 4000):**
```bash
cd backend
npm install
npm run dev
```

**Terminal 2 — frontend (port 5173):**
```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` and `/ws` to the
backend, so there is nothing else to configure.

### Production (single process)

```bash
cd frontend && npm run build      # outputs frontend/dist
cd ../backend && npm start        # serves the API, the WebSocket, AND the built UI
```
Then open http://localhost:4000.

## Deployment (Vercel + Render)

The backend needs a long-running Node process (background polling loop + a
persistent WebSocket server), which **Vercel's serverless model does not
support**. So the frontend goes on Vercel and the backend on a host that runs
Node continuously (Render shown here; Railway / Fly.io work the same way).

### 1. Backend → Render

1. Push this repo to GitHub (done).
2. Render → **New → Blueprint**, select this repo. It reads [`render.yaml`](render.yaml).
   (Or **New → Web Service**, Root Directory `backend`, build `npm install`,
   start `npm start`.)
3. Set environment variables:
   - `DATABASE_URL` → your Neon connection string.
   - `CORS_ORIGIN` → your Vercel URL (e.g. `https://trade-desk.vercel.app`).
4. Deploy. Note the service URL, e.g. `https://trade-desk-api.onrender.com`.

### 2. Frontend → Vercel

1. Vercel → **Add New → Project**, import this repo.
2. Set **Root Directory** to `frontend` (Vercel auto-detects Vite + [`vercel.json`](frontend/vercel.json)).
3. Add environment variable `VITE_API_URL` = your Render backend URL
   (e.g. `https://trade-desk-api.onrender.com`).
4. Deploy. The UI will call the backend's REST API and connect to its WebSocket.

> After the first deploy, update the backend's `CORS_ORIGIN` to the final Vercel
> domain and redeploy the backend.

## REST API

| Method | Route                       | Description                              |
|--------|-----------------------------|------------------------------------------|
| GET    | `/api/state`                | Full bootstrap snapshot                  |
| GET    | `/api/market`               | Latest snapshot for all 8 symbols        |
| GET    | `/api/klines/:symbol`       | Candlestick history (Coinbase proxy)     |
| GET    | `/api/positions`            | Open positions with cost basis           |
| GET    | `/api/orders?status=open`   | Orders (optionally filtered)             |
| POST   | `/api/orders`               | Place an order                           |
| DELETE | `/api/orders/:id`           | Cancel an open order                     |
| POST   | `/api/reset`                | Reset cash to $100k & flatten positions  |
| GET    | `/api/bot/backtest`         | Backtest the strategy over recent candles |

**Backtest the strategy**
```bash
# All symbols, current bot config:
curl 'localhost:4000/api/bot/backtest'
# One symbol + parameter overrides to A/B-test:
curl 'localhost:4000/api/bot/backtest?symbol=BTCUSDT&interval=5m&bars=800&adxMin=25'
```
Returns P&L in **R** (multiples of the risked stop distance), so results are
independent of position sizing: `winRate`, `expectancyR`, `totalR`,
`profitFactor`, `maxDrawdownR`. Optional query: `symbol`, `interval`, `bars`,
and config overrides `confidenceMin`, `adxMin`, `atrSl`, `atrTp`, `mtfConfirm`,
`beAtR`, `trailR`.

> ⚠️ This is an **in-sample** backtest over a short recent window — useful for
> comparing parameters, **not** proof of edge. It models neither fees nor
> slippage, and assumes the stop fills first when a bar spans both TP and SL.

**Place an order**
```bash
curl -X POST localhost:4000/api/orders -H 'Content-Type: application/json' \
  -d '{"symbol":"BTCUSDT","side":"buy","type":"market","qty":0.25}'
```

## Database schema

`symbols` · `ticks` · `account` · `positions` · `orders` — created automatically on
first boot (`backend/src/db.js`), idempotent.

## Notes

- This is a **paper-trading** desk: no real funds, no exchange connectivity for order
  routing. Orders fill against the live mark price.
- Starting balance is **100,000 USDT**, configurable in `backend/src/config.js`.
- **Atomic fills.** The check → insert → fill sequence runs in a single Postgres
  transaction (Neon pooled driver) with the account and position rows locked, so
  concurrent orders can't double-spend cash or leave the books half-updated.
- **Cash reservation.** A resting limit buy reserves cash at its limit price, so
  the sum of open buy commitments can never exceed the balance and a fill is
  always funded.
- **Short buying power.** A sell that opens or grows a short is allowed only while
  total gross short notional stays within equity (1×, no leverage) — without this
  a short would be unbounded.
- **Tick retention.** Persisted ticks are purged past a retention window
  (`TICK_RETENTION_DAYS`, default 7) on a periodic sweep so the table can't grow
  without bound on the Neon free tier.
- **Bot ↔ book reconciliation.** The strategy bot never closes more than the book
  actually holds in its direction, so manually closing a position the bot is
  managing can't make its TP/SL open an opposite position.
- **Closed-candle signals.** The bot drops the still-forming candle before
  computing indicators, so signals don't flicker/repaint as the live bar updates.
- **Regime filter (ADX).** Entries are skipped when ADX is below `adxMin`
  (default 20) — no trend, no trade — to avoid getting chopped up in ranges.
- **Backtester.** `GET /api/bot/backtest` replays `computeSignal` over candle
  history with the same TP/SL, reporting expectancy in R — so parameters can be
  tuned against numbers instead of guesswork.
- **Multi-timeframe filter (`mtfConfirm`, opt-in).** Only trades aligned with the
  higher-timeframe trend (EMA200 on 1h for a 5m strategy, etc.). It's **off by
  default**: backtesting showed it cuts ~20% of trades without improving
  per-trade expectancy, only lowering drawdown — a textbook example of validating
  an idea before shipping it. Toggle it on and re-run the backtest for your
  window/regime to decide.
- **Break-even / trailing stops (`beAtR`, `trailR`, opt-in).** The stop can move
  to break-even at +`beAtR` (in R) and/or trail `trailR` behind the best price.
  Also **off by default**: a sweep showed every setting *lowered* expectancy vs a
  plain fixed 1:2 stop/target — trailing truncates the +2R winners that carry a
  trend strategy faster than it saves losers. Implemented and tunable, but the
  data says the simple fixed target wins here.

# Trader Desk — Live Crypto Trading Desk

A complete, operational paper-trading desk with a real-time market data feed,
a full order-management backend, persistent state in **Neon Postgres**, and a
custom **dark-themed** React interface.

![desk](https://img.shields.io/badge/symbols-8-blue) ![feed](https://img.shields.io/badge/data-realtime-2ebd85) ![db-Neon%20Postgres-purple]()

## What it does

- **Live market data** for 8 symbols, pulled from the public **Binance** REST API
  every 2 s (no API key required): BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX.
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
Binance REST ──poll 2s──> Backend (Express + ws)  ──WebSocket──> React UI (Vite)
                               │
                               └── Neon Postgres (HTTPS driver)
```

| Layer    | Stack                                                        |
|----------|--------------------------------------------------------------|
| Backend  | Node 20+, Express 5, `ws`, `@neondatabase/serverless`        |
| Frontend | React 18, Vite, custom CSS, canvas candlestick chart         |
| Data     | Binance public API (prices + klines)                         |
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
| GET    | `/api/klines/:symbol`       | Candlestick history (Binance proxy)      |
| GET    | `/api/positions`            | Open positions with cost basis           |
| GET    | `/api/orders?status=open`   | Orders (optionally filtered)             |
| POST   | `/api/orders`               | Place an order                           |
| DELETE | `/api/orders/:id`           | Cancel an open order                     |
| POST   | `/api/reset`                | Reset cash to $100k & flatten positions  |

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

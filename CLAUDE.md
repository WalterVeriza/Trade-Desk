# Trader Desk — guide pour Claude

Desk de **paper-trading** crypto en temps réel : backend Node qui poll Coinbase et
pousse les ticks en WebSocket, frontend React (Vite) avec graphique canvas, état
persisté dans **Neon Postgres**. Un bot de stratégie auto-trade en option.

## Lancer

```bash
# Backend (port 4000) — nécessite backend/.env avec DATABASE_URL (Neon)
cd backend && npm install && npm run dev      # node --watch ; `npm start` en prod

# Frontend (port 5173) — proxy /api et /ws vers :4000
cd frontend && npm install && npm run dev
cd frontend && npm run build                  # build prod -> frontend/dist
```

## Architecture

```
Coinbase REST ─poll 3s→ Backend (Express + ws) ──WebSocket──> React UI (Vite)
                              └── Neon Postgres (driver HTTPS + pooled)
```

- **backend/src** : `index.js` (API REST + WS + boot), `market.js` (feed Coinbase,
  `fetchKlines`/`fetchHistory`), `engine.js` (ordres + comptabilité positions,
  **transactionnel**), `db.js` (Neon : `sql` HTTP + `withTx` pooled), `config.js`,
  `indicators.js` (EMA/RSI/MACD/ATR/ADX), `strategy.js` (`computeSignal`,
  `htfTrend`, `manageStop`), `bot.js` (scan/ouverture/TP-SL/trailing),
  `backtest.js` (`/api/bot/backtest`), `events.js` (blackout macro/crypto).
- **frontend/src** : `App.jsx` (état + WS, vues `desk`/`history`), `components/*`
  (TopBar, MarketWatch, PriceChart canvas, OrderTicket, Blotter, Positions,
  StrategyBot, **BotHistory**), `styles.css` (thème sombre + responsive).

## Conventions / pièges (IMPORTANT)

- **Commits** : auteur `WalterVeriza <walterveriza@gmail.com>`. **Ne jamais** ajouter
  de ligne `Co-Authored-By: Claude` (ni dans les commits ni les PR).
- **Vercel** bloque un déploiement (`BLOCKED`) si l'email auteur du commit n'est pas
  membre de l'équipe → toujours committer avec `walterveriza@gmail.com`.
- **Neon** : `sql` (driver HTTP) pour les requêtes simples ; `withTx` (driver pooled
  WebSocket, port 443) pour les transactions interactives (fills, reset).
- **DB partagée et vivante** : ne pas lancer un 2ᵉ backend local contre la DB Neon de
  prod pendant que Render tourne (double bot). Ne pas polluer `bot_trades` avec des
  lignes de test.
- **Paper-trading uniquement** : signaux algorithmiques, jamais une prédiction de
  marché ni un conseil financier.

## Bot & backtest

- Signaux calculés sur **bougies clôturées** (la bougie en cours est dropée).
- **Défauts optimisés** (sweep `optimize.js` sur les 8 symboles, in-sample PF ≈ 1.44 /
  expectancy ≈ 0.20R, positif sur 8/8) : `timeframe` **1h**, `adxMin` **25**,
  `atrSl` **1** / `atrTp` **2** (R:R 1:2), `beAtR` **1** (break-even, ON),
  `mtfConfirm` **true** (filtre tendance 6h, ON — plus gros gain d'edge), `trailR` 0
  (OFF, tronque les gagnants). À revalider périodiquement (in-sample, sans frais/slippage).
- **Gestion du risque** : `maxPerDirection` (cap d'exposition corrélée, défaut 3),
  `confSizing` (taille pondérée par la confiance ~0.6×→1.4×, ON).
- **Garde-fou événementiel** (`events.js`) : suspend les NOUVELLES entrées dans une
  fenêtre (`evBeforeMin`/`evAfterMin`, défaut −60/+30) autour d'événements à fort
  impact. Macro = calendrier FOMC/CPI/NFP codé en dur (UTC, **à rafraîchir ~1×/an**).
  Crypto = CoinMarketCal, actif seulement si `COINMARKETCAL_KEY` est définie.
- `GET /api/bot/backtest` rejoue `computeSignal` et renvoie le P&L en **R**
  (overrides : `symbol`, `interval`, `bars`, `confidenceMin`, `adxMin`, `atrSl`,
  `atrTp`, `mtfConfirm`, `beAtR`, `trailR`). In-sample, sans frais/slippage.

## Déploiement

Frontend → **Vercel** (root `frontend/`, `VITE_API_URL` = URL backend).
Backend → **Render** (process long, `render.yaml`, vars `DATABASE_URL` + `CORS_ORIGIN`).
Keep-alive : `.github/workflows/keep-alive.yml` ping `/api/health` (repo public →
Actions gratuites).

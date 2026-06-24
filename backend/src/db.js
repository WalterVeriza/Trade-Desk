import { neon, neonConfig, Pool } from '@neondatabase/serverless';
import ws from 'ws';
import { DATABASE_URL, SYMBOLS, STARTING_CASH, DEFAULT_BOT_CONFIG } from './config.js';

// HTTP one-shot driver for simple reads/writes (works on port 443).
export const sql = neon(DATABASE_URL);

// Pooled WebSocket driver for *interactive* transactions (BEGIN/COMMIT with
// reads and writes interleaved). Also speaks over port 443 via Neon's proxy, so
// it works in the same locked-down environments as the HTTP driver.
neonConfig.webSocketConstructor = ws;
export const pool = new Pool({ connectionString: DATABASE_URL });

// Run `fn` inside a single transaction; commit on success, roll back on throw.
// The callback receives a dedicated client — use `client.query(...)` (pg style).
export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

// Create schema and seed reference / account data. Idempotent.
export async function initDb() {
  await sql`
    CREATE TABLE IF NOT EXISTS symbols (
      symbol TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      base   TEXT NOT NULL,
      quote  TEXT NOT NULL
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS ticks (
      id         BIGSERIAL PRIMARY KEY,
      symbol     TEXT NOT NULL REFERENCES symbols(symbol),
      price      NUMERIC NOT NULL,
      change_pct NUMERIC,
      high       NUMERIC,
      low        NUMERIC,
      volume     NUMERIC,
      ts         TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS ticks_symbol_ts_idx ON ticks(symbol, ts DESC)`;

  await sql`
    CREATE TABLE IF NOT EXISTS account (
      id      INT PRIMARY KEY DEFAULT 1,
      cash    NUMERIC NOT NULL,
      created TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS positions (
      symbol       TEXT PRIMARY KEY REFERENCES symbols(symbol),
      qty          NUMERIC NOT NULL DEFAULT 0,
      avg_price    NUMERIC NOT NULL DEFAULT 0,
      realized_pnl NUMERIC NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS orders (
      id          BIGSERIAL PRIMARY KEY,
      symbol      TEXT NOT NULL REFERENCES symbols(symbol),
      side        TEXT NOT NULL CHECK (side IN ('buy','sell')),
      type        TEXT NOT NULL CHECK (type IN ('market','limit')),
      qty         NUMERIC NOT NULL CHECK (qty > 0),
      limit_price NUMERIC,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','filled','cancelled')),
      fill_price  NUMERIC,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      filled_at   TIMESTAMPTZ
    )`;
  await sql`CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, created_at DESC)`;

  // Strategy bot: single-row state (enabled + config) and managed trades.
  await sql`
    CREATE TABLE IF NOT EXISTS bot_state (
      id      INT PRIMARY KEY DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT false,
      config  JSONB NOT NULL,
      updated TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;

  await sql`
    CREATE TABLE IF NOT EXISTS bot_trades (
      id          BIGSERIAL PRIMARY KEY,
      symbol      TEXT NOT NULL REFERENCES symbols(symbol),
      side        TEXT NOT NULL CHECK (side IN ('long','short')),
      qty         NUMERIC NOT NULL,
      entry_price NUMERIC NOT NULL,
      tp          NUMERIC NOT NULL,
      sl          NUMERIC NOT NULL,
      confidence  NUMERIC NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      exit_price  NUMERIC,
      exit_reason TEXT,
      pnl         NUMERIC,
      opened_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at   TIMESTAMPTZ
    )`;
  await sql`CREATE INDEX IF NOT EXISTS bot_trades_status_idx ON bot_trades(status, opened_at DESC)`;
  // At most ONE open trade per symbol — enforced by the DB so a stale in-memory
  // mirror or two overlapping instances can't stack a long and a short on the
  // same symbol (they would net out in the book and waste the spread).
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS bot_trades_one_open ON bot_trades(symbol) WHERE status = 'open'`;
  // The original stop, kept immutable so break-even/trailing can size risk in R
  // even after `sl` has been ratcheted. Added separately for existing tables.
  await sql`ALTER TABLE bot_trades ADD COLUMN IF NOT EXISTS init_sl NUMERIC`;

  await sql`
    INSERT INTO bot_state (id, enabled, config)
    VALUES (1, false, ${JSON.stringify(DEFAULT_BOT_CONFIG)})
    ON CONFLICT (id) DO NOTHING`;

  // Seed reference symbols
  for (const s of SYMBOLS) {
    await sql`
      INSERT INTO symbols (symbol, name, base, quote)
      VALUES (${s.symbol}, ${s.name}, ${s.base}, ${s.quote})
      ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name`;
    await sql`
      INSERT INTO positions (symbol) VALUES (${s.symbol})
      ON CONFLICT (symbol) DO NOTHING`;
  }

  // Seed account
  await sql`
    INSERT INTO account (id, cash) VALUES (1, ${STARTING_CASH})
    ON CONFLICT (id) DO NOTHING`;
}

export async function getAccount() {
  const rows = await sql`SELECT cash FROM account WHERE id = 1`;
  return { cash: Number(rows[0].cash) };
}

export async function getPositions() {
  const rows = await sql`SELECT symbol, qty, avg_price, realized_pnl FROM positions ORDER BY symbol`;
  return rows.map((r) => ({
    symbol: r.symbol,
    qty: Number(r.qty),
    avgPrice: Number(r.avg_price),
    realizedPnl: Number(r.realized_pnl),
  }));
}

export async function getPosition(symbol) {
  const rows = await sql`SELECT qty FROM positions WHERE symbol = ${symbol}`;
  return rows.length ? Number(rows[0].qty) : 0;
}

export async function getOrders(status) {
  const rows = status
    ? await sql.query(
        'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC LIMIT 200',
        [status]
      )
    : await sql`SELECT * FROM orders ORDER BY created_at DESC LIMIT 200`;
  return rows.map(mapOrder);
}

export function mapOrder(r) {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    side: r.side,
    type: r.type,
    qty: Number(r.qty),
    limitPrice: r.limit_price == null ? null : Number(r.limit_price),
    status: r.status,
    fillPrice: r.fill_price == null ? null : Number(r.fill_price),
    createdAt: r.created_at,
    filledAt: r.filled_at,
  };
}

// --------------------------- Strategy bot ---------------------------
export async function getBotState() {
  const rows = await sql`SELECT enabled, config FROM bot_state WHERE id = 1`;
  if (!rows.length) return { enabled: false, config: { ...DEFAULT_BOT_CONFIG } };
  return { enabled: rows[0].enabled, config: { ...DEFAULT_BOT_CONFIG, ...rows[0].config } };
}

export async function setBotEnabled(enabled) {
  await sql`UPDATE bot_state SET enabled = ${enabled}, updated = now() WHERE id = 1`;
}

export async function setBotConfig(config) {
  await sql`UPDATE bot_state SET config = ${JSON.stringify(config)}, updated = now() WHERE id = 1`;
}

function mapBotTrade(r) {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    side: r.side,
    qty: Number(r.qty),
    entryPrice: Number(r.entry_price),
    tp: Number(r.tp),
    sl: Number(r.sl),
    initSl: r.init_sl == null ? Number(r.sl) : Number(r.init_sl),
    confidence: Number(r.confidence),
    status: r.status,
    exitPrice: r.exit_price == null ? null : Number(r.exit_price),
    exitReason: r.exit_reason,
    pnl: r.pnl == null ? null : Number(r.pnl),
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  };
}

export async function insertBotTrade(t) {
  const rows = await sql.query(
    `INSERT INTO bot_trades (symbol, side, qty, entry_price, tp, sl, init_sl, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [t.symbol, t.side, t.qty, t.entryPrice, t.tp, t.sl, t.sl, t.confidence]
  );
  return mapBotTrade(rows[0]);
}

// Persist a ratcheted stop (break-even / trailing) for an open trade.
export async function updateBotTradeStop(id, sl) {
  await sql.query("UPDATE bot_trades SET sl = $1 WHERE id = $2 AND status = 'open'", [sl, id]);
}

// Set the real entry/TP/SL once the entry order has filled (the row was inserted
// first, with provisional prices, to atomically claim the per-symbol slot).
export async function updateBotTradeFill(id, entryPrice, tp, sl) {
  await sql.query('UPDATE bot_trades SET entry_price=$1, tp=$2, sl=$3 WHERE id=$4', [entryPrice, tp, sl, id]);
}

// Remove a just-claimed slot when the entry order could not be placed.
export async function deleteBotTrade(id) {
  await sql.query('DELETE FROM bot_trades WHERE id=$1', [id]);
}

export async function getOpenBotTrades() {
  const rows = await sql`SELECT * FROM bot_trades WHERE status = 'open' ORDER BY opened_at DESC`;
  return rows.map(mapBotTrade);
}

// Atomically claim an open trade for closing (race-safe). Returns the row only
// to the caller that flipped it from open -> closed.
export async function claimBotTrade(id) {
  const rows = await sql.query(
    "UPDATE bot_trades SET status='closed', closed_at=now() WHERE id=$1 AND status='open' RETURNING *",
    [id]
  );
  return rows.length ? mapBotTrade(rows[0]) : null;
}

export async function finalizeBotTrade(id, exitPrice, reason, pnl) {
  await sql.query('UPDATE bot_trades SET exit_price=$1, exit_reason=$2, pnl=$3 WHERE id=$4', [
    exitPrice,
    reason,
    pnl,
    id,
  ]);
}

// Undo a claim if the closing order could not be placed.
export async function revertBotTrade(id) {
  await sql.query("UPDATE bot_trades SET status='open', closed_at=NULL WHERE id=$1", [id]);
}

export async function closeAllOpenBotTrades(reason = 'reset') {
  await sql.query(
    "UPDATE bot_trades SET status='closed', exit_reason=$1, closed_at=now() WHERE status='open'",
    [reason]
  );
}

export async function getRecentClosedBotTrades(limit = 25) {
  const rows = await sql.query(
    `SELECT * FROM bot_trades WHERE status='closed' ORDER BY closed_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(mapBotTrade);
}

export async function getBotStats() {
  const rows = await sql`
    SELECT COUNT(*)::int AS trades,
           COUNT(*) FILTER (WHERE pnl > 0)::int AS wins,
           COALESCE(SUM(pnl), 0) AS total_pnl
    FROM bot_trades WHERE status = 'closed'`;
  const r = rows[0];
  const trades = Number(r.trades);
  const wins = Number(r.wins);
  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: trades ? (wins / trades) * 100 : 0,
    totalPnl: Number(r.total_pnl),
  };
}

import { neon } from '@neondatabase/serverless';
import { DATABASE_URL, SYMBOLS, STARTING_CASH } from './config.js';

export const sql = neon(DATABASE_URL);

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

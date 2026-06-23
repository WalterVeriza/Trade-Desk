import { sql, mapOrder, withTx } from './db.js';
import { SYMBOL_SET } from './config.js';

// Weighted-average position accounting with realized P&L on reductions/flips.
export function applyFill(oldQty, oldAvg, side, qty, price) {
  const signed = side === 'buy' ? qty : -qty;
  const newQty = oldQty + signed;
  let realized = 0;
  let newAvg = oldAvg;
  const sameDirection = oldQty === 0 || Math.sign(oldQty) === Math.sign(signed);

  if (sameDirection) {
    newAvg = (Math.abs(oldQty) * oldAvg + Math.abs(signed) * price) / (Math.abs(newQty) || 1);
  } else {
    const closing = Math.min(Math.abs(signed), Math.abs(oldQty));
    realized = closing * (price - oldAvg) * Math.sign(oldQty);
    if (Math.abs(signed) > Math.abs(oldQty)) newAvg = price; // position flipped
    else newAvg = newQty === 0 ? 0 : oldAvg;
  }

  const cashDelta = -signed * price; // buy reduces cash, sell adds cash
  return { newQty, newAvg, realized, cashDelta };
}

// Cash already pledged to resting limit BUY orders. We reserve at the limit
// price so a buy can never fill for more than the funds set aside for it; this
// keeps Σ(open buy-limit commitments) ≤ cash as an invariant at all times.
async function committedBuyCash(c) {
  const r = await c.query(
    "SELECT COALESCE(SUM(qty * limit_price), 0) AS c FROM orders WHERE status = 'open' AND side = 'buy' AND type = 'limit'"
  );
  return Number(r.rows[0].c);
}

// Fill an order *inside an existing transaction*. Re-reads and row-locks the
// order (so a concurrent path can't fill it twice) and the position row, applies
// the accounting, and returns the filled order — or null if it was no longer open.
async function fillOrderTx(c, orderId, price) {
  const ordRows = (
    await c.query("SELECT * FROM orders WHERE id = $1 AND status = 'open' FOR UPDATE", [orderId])
  ).rows;
  if (!ordRows.length) return null;
  const order = mapOrder(ordRows[0]);

  const posRows = (
    await c.query('SELECT qty, avg_price, realized_pnl FROM positions WHERE symbol = $1 FOR UPDATE', [
      order.symbol,
    ])
  ).rows;
  const oldQty = Number(posRows[0].qty);
  const oldAvg = Number(posRows[0].avg_price);
  const oldRealized = Number(posRows[0].realized_pnl);

  const { newQty, newAvg, realized, cashDelta } = applyFill(oldQty, oldAvg, order.side, order.qty, price);

  await c.query(
    'UPDATE positions SET qty = $1, avg_price = $2, realized_pnl = $3, updated_at = now() WHERE symbol = $4',
    [newQty, newAvg, oldRealized + realized, order.symbol]
  );
  await c.query('UPDATE account SET cash = cash + $1 WHERE id = 1', [cashDelta]);
  const rows = (
    await c.query(
      "UPDATE orders SET status = 'filled', fill_price = $1, filled_at = now() WHERE id = $2 RETURNING *",
      [price, orderId]
    )
  ).rows;
  return mapOrder(rows[0]);
}

// Validate + place an order. Market orders fill immediately at the live price.
// The whole check-insert-fill sequence runs in one transaction with the account
// and position rows locked, so concurrent orders can't over-spend cash or race.
export async function placeOrder(input, getPrice) {
  const { symbol, side, type } = input;
  const qty = Number(input.qty);
  const limitPrice = input.limitPrice == null || input.limitPrice === '' ? null : Number(input.limitPrice);

  if (!SYMBOL_SET.has(symbol)) throw httpErr(400, 'Unknown symbol');
  if (!['buy', 'sell'].includes(side)) throw httpErr(400, 'side must be buy or sell');
  if (!['market', 'limit'].includes(type)) throw httpErr(400, 'type must be market or limit');
  if (!(qty > 0)) throw httpErr(400, 'qty must be positive');
  if (type === 'limit' && !(limitPrice > 0)) throw httpErr(400, 'limit order needs a positive limitPrice');

  const live = getPrice(symbol);
  if (!live) throw httpErr(503, 'No live price yet for ' + symbol);
  const ref = type === 'market' ? live : limitPrice;

  return withTx(async (c) => {
    // Lock the account row for the duration of the risk check + fill.
    const cash = Number((await c.query('SELECT cash FROM account WHERE id = 1 FOR UPDATE')).rows[0].cash);

    if (side === 'buy') {
      // A buy must be covered by cash not already pledged to resting limit buys.
      const freeCash = cash - (await committedBuyCash(c));
      if (qty * ref > freeCash) throw httpErr(400, 'Insufficient cash for this order');
    } else {
      // A sell that increases net SHORT exposure needs buying power. We cap total
      // gross short notional at current equity (1×, no leverage) — without this a
      // short is unbounded (selling adds cash, so a cash check can't contain it).
      const positions = (await c.query('SELECT symbol, qty, avg_price FROM positions')).rows;
      let equity = cash;
      let otherShort = 0;
      let oldQty = 0;
      for (const p of positions) {
        const q = Number(p.qty);
        const mark = getPrice(p.symbol) ?? Number(p.avg_price);
        equity += q * mark;
        if (p.symbol === symbol) oldQty = q;
        else if (q < 0) otherShort += -q * mark;
      }
      const newQty = oldQty - qty;
      const thisShort = newQty < 0 ? -newQty * ref : 0; // notional of the resulting short
      if (thisShort > 0 && otherShort + thisShort > equity) {
        throw httpErr(400, 'Insufficient buying power for short');
      }
    }

    const inserted = (
      await c.query(
        'INSERT INTO orders (symbol, side, type, qty, limit_price, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [symbol, side, type, qty, limitPrice, 'open']
      )
    ).rows;
    const order = mapOrder(inserted[0]);

    // Market orders, and limit orders already through the market, fill now.
    const marketable =
      type === 'market' ||
      (side === 'buy' && live <= limitPrice) ||
      (side === 'sell' && live >= limitPrice);
    if (marketable) {
      const filled = await fillOrderTx(c, order.id, live);
      return { order: filled, filledNow: true };
    }
    return { order, filledNow: false };
  });
}

export async function cancelOrder(id) {
  const rows = await sql.query(
    "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *",
    [id]
  );
  if (rows.length === 0) throw httpErr(404, 'No open order with that id');
  return mapOrder(rows[0]);
}

// Called on every market tick: fill any resting limit orders the market has
// crossed. Each fill runs in its own transaction (re-checking the order is still
// open under a row lock). Buy fills are already funded by the reservation made at
// placement time, so no extra cash check is needed here.
export async function matchOpenOrders(priceMap) {
  const open = await sql`SELECT id, symbol, side, limit_price FROM orders WHERE status = 'open' AND type = 'limit'`;
  const filled = [];
  for (const row of open) {
    const px = priceMap[row.symbol];
    if (!px) continue;
    const limit = Number(row.limit_price);
    if ((row.side === 'buy' && px <= limit) || (row.side === 'sell' && px >= limit)) {
      const f = await withTx((c) => fillOrderTx(c, Number(row.id), px));
      if (f) filled.push(f);
    }
  }
  return filled;
}

export async function resetDesk(startingCash) {
  await withTx(async (c) => {
    await c.query("UPDATE orders SET status = 'cancelled' WHERE status = 'open'");
    await c.query('UPDATE positions SET qty = 0, avg_price = 0, realized_pnl = 0, updated_at = now()');
    await c.query('UPDATE account SET cash = $1 WHERE id = 1', [startingCash]);
  });
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

import { sql, mapOrder } from './db.js';
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

async function fillOrder(order, price) {
  const posRows = await sql.query('SELECT qty, avg_price, realized_pnl FROM positions WHERE symbol = $1', [order.symbol]);
  const oldQty = Number(posRows[0].qty);
  const oldAvg = Number(posRows[0].avg_price);
  const oldRealized = Number(posRows[0].realized_pnl);

  const { newQty, newAvg, realized, cashDelta } = applyFill(oldQty, oldAvg, order.side, order.qty, price);

  await sql.query(
    'UPDATE positions SET qty = $1, avg_price = $2, realized_pnl = $3, updated_at = now() WHERE symbol = $4',
    [newQty, newAvg, oldRealized + realized, order.symbol]
  );
  await sql.query('UPDATE account SET cash = cash + $1 WHERE id = 1', [cashDelta]);
  const rows = await sql.query(
    "UPDATE orders SET status = 'filled', fill_price = $1, filled_at = now() WHERE id = $2 RETURNING *",
    [price, order.id]
  );
  return mapOrder(rows[0]);
}

// Validate + place an order. Market orders fill immediately at the live price.
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

  // Risk check: a buy must be covered by available cash.
  if (side === 'buy') {
    const ref = type === 'market' ? live : limitPrice;
    const acc = await sql`SELECT cash FROM account WHERE id = 1`;
    if (Number(acc[0].cash) < qty * ref) throw httpErr(400, 'Insufficient cash for this order');
  }

  const inserted = await sql.query(
    'INSERT INTO orders (symbol, side, type, qty, limit_price, status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
    [symbol, side, type, qty, limitPrice, 'open']
  );
  let order = mapOrder(inserted[0]);

  if (type === 'market') {
    order = await fillOrder(order, live);
    return { order, filledNow: true };
  }
  // Marketable limit fills immediately too.
  if ((side === 'buy' && live <= limitPrice) || (side === 'sell' && live >= limitPrice)) {
    order = await fillOrder(order, live);
    return { order, filledNow: true };
  }
  return { order, filledNow: false };
}

export async function cancelOrder(id) {
  const rows = await sql.query(
    "UPDATE orders SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING *",
    [id]
  );
  if (rows.length === 0) throw httpErr(404, 'No open order with that id');
  return mapOrder(rows[0]);
}

// Called on every market tick: fill any resting limit orders the market has crossed.
export async function matchOpenOrders(priceMap) {
  const open = await sql`SELECT * FROM orders WHERE status = 'open' AND type = 'limit'`;
  const filled = [];
  for (const row of open) {
    const o = mapOrder(row);
    const px = priceMap[o.symbol];
    if (!px) continue;
    if ((o.side === 'buy' && px <= o.limitPrice) || (o.side === 'sell' && px >= o.limitPrice)) {
      filled.push(await fillOrder(o, px));
    }
  }
  return filled;
}

export async function resetDesk(startingCash) {
  await sql`UPDATE orders SET status = 'cancelled' WHERE status = 'open'`;
  await sql`UPDATE positions SET qty = 0, avg_price = 0, realized_pnl = 0, updated_at = now()`;
  await sql`UPDATE account SET cash = ${startingCash} WHERE id = 1`;
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

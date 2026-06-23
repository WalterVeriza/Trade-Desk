import { useEffect, useState } from 'react';
import { fmtPrice, fmtUsd } from '../format.js';

export default function OrderTicket({ symbols, market, selected, onSelect, onPlace, notify }) {
  const [side, setSide] = useState('buy');
  const [type, setType] = useState('market');
  const [qty, setQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const snap = market[selected];
  const live = snap?.price;

  // Prefill limit price with the live price when switching to limit.
  useEffect(() => {
    if (type === 'limit' && !limitPrice && live) setLimitPrice(String(live));
  }, [type, live, limitPrice]);

  const ref = type === 'market' ? live : Number(limitPrice) || live;
  const qtyNum = Number(qty) || 0;
  const estCost = ref ? qtyNum * ref : 0;

  async function submit(e) {
    e.preventDefault();
    if (!(qtyNum > 0)) return notify('Enter a quantity', 'error');
    if (type === 'limit' && !(Number(limitPrice) > 0)) return notify('Enter a limit price', 'error');
    setSubmitting(true);
    try {
      await onPlace({
        symbol: selected,
        side,
        type,
        qty: qtyNum,
        limitPrice: type === 'limit' ? Number(limitPrice) : null,
      });
      setQty('');
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel ticket">
      <div className="panel-head">
        <h2>Order Ticket</h2>
        <span className="panel-sub">{live ? fmtPrice(live) : '—'}</span>
      </div>
      <form onSubmit={submit}>
        <div className="side-toggle">
          <button
            type="button"
            className={`side-btn buy ${side === 'buy' ? 'active' : ''}`}
            onClick={() => setSide('buy')}
          >
            BUY
          </button>
          <button
            type="button"
            className={`side-btn sell ${side === 'sell' ? 'active' : ''}`}
            onClick={() => setSide('sell')}
          >
            SELL
          </button>
        </div>

        <label className="field">
          <span>Symbol</span>
          <select value={selected} onChange={(e) => onSelect(e.target.value)}>
            {symbols.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.symbol} · {s.name}
              </option>
            ))}
          </select>
        </label>

        <div className="type-tabs">
          {['market', 'limit'].map((t) => (
            <button
              key={t}
              type="button"
              className={`type-tab ${type === t ? 'active' : ''}`}
              onClick={() => setType(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Quantity ({snap?.base || ''})</span>
          <input
            type="number"
            step="any"
            min="0"
            placeholder="0.00"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
        </label>

        {type === 'limit' && (
          <label className="field">
            <span>Limit Price (USDT)</span>
            <input
              type="number"
              step="any"
              min="0"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
          </label>
        )}

        <div className="est">
          <span>Est. {side === 'buy' ? 'cost' : 'proceeds'}</span>
          <b>{fmtUsd(estCost)}</b>
        </div>

        <button
          type="submit"
          className={`submit-btn ${side}`}
          disabled={submitting || !live}
        >
          {submitting ? '…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${selected.replace('USDT', '')}`}
        </button>
      </form>
    </div>
  );
}

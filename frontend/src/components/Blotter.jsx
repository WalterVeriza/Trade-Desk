import { useState } from 'react';
import { fmtPrice, fmtQty } from '../format.js';

function timeAgo(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour12: false });
}

export default function Blotter({ orders, onCancel }) {
  const [tab, setTab] = useState('open');
  const open = orders.filter((o) => o.status === 'open');
  const history = orders.filter((o) => o.status !== 'open');
  const rows = tab === 'open' ? open : history;

  return (
    <div className="panel blotter">
      <div className="panel-head">
        <h2>Order Blotter</h2>
        <div className="blotter-tabs">
          <button className={tab === 'open' ? 'active' : ''} onClick={() => setTab('open')}>
            Open ({open.length})
          </button>
          <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
            History ({history.length})
          </button>
        </div>
      </div>
      <div className="blotter-scroll">
        {rows.length === 0 ? (
          <div className="empty">No {tab} orders</div>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Type</th>
                <th className="r">Qty</th>
                <th className="r">Price</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td className="mono dim">{timeAgo(o.createdAt)}</td>
                  <td className="sym">{o.symbol.replace('USDT', '')}</td>
                  <td className={o.side === 'buy' ? 'up' : 'down'}>{o.side.toUpperCase()}</td>
                  <td className="dim">{o.type}</td>
                  <td className="r mono">{fmtQty(o.qty)}</td>
                  <td className="r mono">
                    {fmtPrice(o.status === 'filled' ? o.fillPrice : o.limitPrice)}
                  </td>
                  <td>
                    <span className={`badge badge-${o.status}`}>{o.status}</span>
                  </td>
                  <td className="r">
                    {o.status === 'open' && (
                      <button className="cancel-x" onClick={() => onCancel(o.id)} title="Cancel">
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

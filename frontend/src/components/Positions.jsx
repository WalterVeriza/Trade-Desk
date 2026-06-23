import { fmtPrice, fmtUsd, fmtQty, signClass } from '../format.js';

export default function Positions({ positions, market, onSelect }) {
  const open = positions.filter((p) => Math.abs(p.qty) > 1e-9);
  return (
    <div className="panel positions">
      <div className="panel-head">
        <h2>Positions</h2>
        <span className="panel-sub">{open.length} open</span>
      </div>
      {open.length === 0 ? (
        <div className="empty">No open positions</div>
      ) : (
        <table className="grid-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th className="r">Qty</th>
              <th className="r">Avg</th>
              <th className="r">Last</th>
              <th className="r">Value</th>
              <th className="r">uP&L</th>
            </tr>
          </thead>
          <tbody>
            {open.map((p) => {
              const px = market[p.symbol]?.price ?? p.avgPrice;
              const value = p.qty * px;
              const upl = p.qty * (px - p.avgPrice);
              return (
                <tr key={p.symbol} onClick={() => onSelect(p.symbol)}>
                  <td className="sym">
                    {p.symbol.replace('USDT', '')}
                    {p.qty < 0 && <span className="short-tag">SHORT</span>}
                  </td>
                  <td className="r mono">{fmtQty(p.qty)}</td>
                  <td className="r mono">{fmtPrice(p.avgPrice)}</td>
                  <td className="r mono">{fmtPrice(px)}</td>
                  <td className="r mono">{fmtUsd(value)}</td>
                  <td className={`r mono ${signClass(upl)}`}>{fmtUsd(upl)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

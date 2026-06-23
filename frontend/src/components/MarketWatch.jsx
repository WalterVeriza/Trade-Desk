import { memo } from 'react';
import Sparkline from './Sparkline.jsx';
import { fmtPrice, fmtPct, fmtCompact, signClass } from '../format.js';

function Row({ meta, snap, spark, selected, onSelect }) {
  const up = (snap?.changePct ?? 0) >= 0;
  return (
    <button
      className={`watch-row ${selected ? 'is-selected' : ''}`}
      onClick={() => onSelect(meta.symbol)}
    >
      <div className="watch-id">
        <span className="watch-base">{meta.base}</span>
        <span className="watch-name">{meta.name}</span>
      </div>
      <Sparkline data={spark} up={up} />
      <div className="watch-nums">
        <span className="watch-price">{fmtPrice(snap?.price)}</span>
        <span className={`watch-chg ${signClass(snap?.changePct)}`}>{fmtPct(snap?.changePct)}</span>
      </div>
      <div className="watch-vol" title="24h quote volume">
        {fmtCompact(snap?.volume)}
      </div>
    </button>
  );
}

function MarketWatch({ symbols, market, sparks, selected, onSelect }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Market Watch</h2>
        <span className="panel-sub">8 symbols · 24h</span>
      </div>
      <div className="watch-list">
        {symbols.map((meta) => (
          <Row
            key={meta.symbol}
            meta={meta}
            snap={market[meta.symbol]}
            spark={sparks[meta.symbol]}
            selected={selected === meta.symbol}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

export default memo(MarketWatch);

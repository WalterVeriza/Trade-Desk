import { fmtUsd, signClass } from '../format.js';

function Stat({ label, value, cls }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${cls || ''}`}>{value}</span>
    </div>
  );
}

export default function TopBar({ metrics, status, onReset }) {
  const statusText = { live: 'LIVE', connecting: 'CONNECTING', offline: 'RECONNECTING' }[status];
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">◆</span>
        <div>
          <div className="brand-title">TRADER DESK</div>
          <div className="brand-sub">Crypto · Real-time · Neon Postgres</div>
        </div>
      </div>
      <div className="stats">
        <Stat label="Equity" value={fmtUsd(metrics.equity)} />
        <Stat label="Cash" value={fmtUsd(metrics.cash)} />
        <Stat label="Positions" value={fmtUsd(metrics.positionsValue)} />
        <Stat label="Unrealized P&L" value={fmtUsd(metrics.unrealized)} cls={signClass(metrics.unrealized)} />
        <Stat label="Realized P&L" value={fmtUsd(metrics.realized)} cls={signClass(metrics.realized)} />
        <Stat label="Total P&L" value={fmtUsd(metrics.totalPnl)} cls={signClass(metrics.totalPnl)} />
      </div>
      <div className="topbar-right">
        <div className={`conn conn-${status}`}>
          <span className="conn-dot" />
          {statusText}
        </div>
        <button className="btn btn-ghost" onClick={onReset} title="Reset cash & flatten positions">
          Reset
        </button>
      </div>
    </header>
  );
}

import { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { fmtPrice, fmtUsd, signClass } from '../format.js';

const PAGE = 50;

function reasonLabel(r) {
  const map = { tp: 'Take-profit', sl: 'Stop-loss', trail: 'Trailing', 'tp/flat': 'TP (flat)', 'sl/flat': 'SL (flat)' };
  return map[r] || (r ? r.toUpperCase() : '—');
}
function reasonClass(r) {
  if (!r) return 'flat';
  if (r.startsWith('tp')) return 'up';
  if (r.startsWith('sl')) return 'down';
  return 'flat';
}

function dur(openedAt, closedAt) {
  if (!openedAt || !closedAt) return '—';
  const ms = new Date(closedAt) - new Date(openedAt);
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 1440)}j`;
}

function tradeR(t) {
  const risk = Math.abs(t.entryPrice - (t.initSl ?? t.sl)) * t.qty;
  if (!(risk > 0) || t.pnl == null) return null;
  return t.pnl / risk;
}

export default function BotHistory({ stats = {}, onClose }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState({ trades: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [side, setSide] = useState('all'); // all | long | short
  const [outcome, setOutcome] = useState('all'); // all | win | loss

  const load = useCallback((off) => {
    setLoading(true);
    api
      .getBotHistory(PAGE, off)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  // Reload on page change AND whenever a new trade closes (stats.trades grows via
  // the live WS feed) so the list never lags behind the header count.
  useEffect(() => {
    load(offset);
  }, [offset, load, stats.trades]);

  const rows = useMemo(() => {
    return (data.trades || []).filter((t) => {
      if (side !== 'all' && t.side !== side) return false;
      if (outcome === 'win' && !(t.pnl > 0)) return false;
      if (outcome === 'loss' && !(t.pnl < 0)) return false;
      return true;
    });
  }, [data.trades, side, outcome]);

  const total = data.total || 0;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <div className="history-view">
      <div className="history-head">
        <button className="btn btn-ghost back-btn" onClick={onClose}>
          ← Desk
        </button>
        <h1>Historique du bot</h1>
        <span className="history-count">{total} trade{total > 1 ? 's' : ''}</span>
        {stats.trades ? (
          <span className={`history-state ${stats.winRate >= 50 ? 'ok' : 'ko'}`} title="Trades gagnants sur le total">
            ✓ {stats.wins ?? 0}/{stats.trades} OK
          </span>
        ) : null}
      </div>

      <div className="history-summary">
        <div className="hs-card">
          <span>Trades</span>
          <b>{stats.trades ?? total}</b>
        </div>
        <div className="hs-card">
          <span>Gagnants / Perdants</span>
          <b>
            <span className="up">{stats.wins ?? '—'}</span> / <span className="down">{stats.losses ?? '—'}</span>
          </b>
        </div>
        <div className="hs-card">
          <span>Win rate</span>
          <b className={stats.winRate >= 50 ? 'up' : stats.trades ? 'down' : ''}>
            {stats.trades ? `${(stats.winRate || 0).toFixed(1)}%` : '—'}
          </b>
        </div>
        <div className="hs-card">
          <span>P&L total</span>
          <b className={`mono ${signClass(stats.totalPnl)}`}>{fmtUsd(stats.totalPnl || 0)}</b>
        </div>
      </div>

      <div className="history-filters">
        <div className="chip-group">
          {['all', 'long', 'short'].map((s) => (
            <button key={s} className={`chip ${side === s ? 'active' : ''}`} onClick={() => setSide(s)}>
              {s === 'all' ? 'Tous' : s === 'long' ? 'Long' : 'Short'}
            </button>
          ))}
        </div>
        <div className="chip-group">
          {['all', 'win', 'loss'].map((o) => (
            <button key={o} className={`chip ${outcome === o ? 'active' : ''}`} onClick={() => setOutcome(o)}>
              {o === 'all' ? 'Tous' : o === 'win' ? 'Gagnants' : 'Perdants'}
            </button>
          ))}
        </div>
        <span className="filter-note">Filtre sur la page affichée</span>
      </div>

      <div className="history-table-wrap">
        {error ? (
          <div className="empty">Erreur : {error}</div>
        ) : loading ? (
          <div className="empty">Chargement…</div>
        ) : rows.length === 0 ? (
          <div className="empty">Aucun trade sur cette page</div>
        ) : (
          <table className="grid-table history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Paire</th>
                <th>Sens</th>
                <th className="r">Conf</th>
                <th className="r">Entrée</th>
                <th className="r">Sortie</th>
                <th>Motif</th>
                <th className="r">Durée</th>
                <th className="r">R</th>
                <th className="r">P&L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const r = tradeR(t);
                return (
                  <tr key={t.id}>
                    <td data-label="Date" className="mono dim">
                      {new Date(t.closedAt).toLocaleString('fr-FR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td data-label="Paire" className="sym">
                      {t.symbol.replace('USDT', '')}
                    </td>
                    <td data-label="Sens">
                      <span className={`side-pill ${t.side}`}>{t.side === 'long' ? 'LONG' : 'SHORT'}</span>
                    </td>
                    <td data-label="Conf" className="r mono dim">
                      {t.confidence}%
                    </td>
                    <td data-label="Entrée" className="r mono">
                      {fmtPrice(t.entryPrice)}
                    </td>
                    <td data-label="Sortie" className="r mono">
                      {t.exitPrice == null ? '—' : fmtPrice(t.exitPrice)}
                    </td>
                    <td data-label="Motif" className={reasonClass(t.exitReason)}>
                      {reasonLabel(t.exitReason)}
                    </td>
                    <td data-label="Durée" className="r mono dim">
                      {dur(t.openedAt, t.closedAt)}
                    </td>
                    <td data-label="R" className={`r mono ${signClass(r)}`}>
                      {r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}
                    </td>
                    <td data-label="P&L" className={`r mono ${signClass(t.pnl)}`}>
                      {t.pnl == null ? '—' : fmtUsd(t.pnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="history-pager">
        <button className="btn" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          ← Précédent
        </button>
        <span className="pager-info mono">
          Page {page} / {pages}
        </span>
        <button
          className="btn"
          disabled={offset + PAGE >= total || loading}
          onClick={() => setOffset(offset + PAGE)}
        >
          Suivant →
        </button>
      </div>
    </div>
  );
}

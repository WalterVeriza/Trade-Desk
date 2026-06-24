import { useState } from 'react';
import { fmtPrice, fmtUsd, fmtPct, signClass } from '../format.js';

function whenLabel(ts) {
  const mins = Math.round((ts - Date.now()) / 60000);
  const when = new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  if (mins < 0) return when;
  if (mins < 60) return `dans ${mins} min`;
  if (mins < 1440) return `dans ${Math.round(mins / 60)} h`;
  return when;
}

function TradeCard({ trade, price }) {
  const px = price ?? trade.entryPrice;
  const pnl =
    trade.side === 'long'
      ? (px - trade.entryPrice) * trade.qty
      : (trade.entryPrice - px) * trade.qty;
  // Progress of price from SL (0) toward TP (1).
  const span = trade.side === 'long' ? trade.tp - trade.sl : trade.sl - trade.tp;
  const fromSl = trade.side === 'long' ? px - trade.sl : trade.sl - px;
  const progress = Math.max(0, Math.min(1, span ? fromSl / span : 0));
  return (
    <div className="trade-card">
      <div className="trade-top">
        <span className="trade-sym">{trade.symbol.replace('USDT', '')}</span>
        <span className={`side-pill ${trade.side}`}>{trade.side === 'long' ? 'LONG' : 'SHORT'}</span>
        <span className="trade-conf">{trade.confidence}%</span>
        <span className={`trade-pnl mono ${signClass(pnl)}`}>{fmtUsd(pnl)}</span>
      </div>
      <div className="trade-bar">
        <div className="trade-bar-track">
          <span className="trade-bar-fill" style={{ width: `${progress * 100}%` }} />
          <span className="trade-bar-cursor" style={{ left: `${progress * 100}%` }} />
        </div>
      </div>
      <div className="trade-levels mono">
        <span className="lv-sl">SL {fmtPrice(trade.sl)}</span>
        <span className="lv-px">{fmtPrice(px)}</span>
        <span className="lv-tp">TP {fmtPrice(trade.tp)}</span>
      </div>
    </div>
  );
}

export default function StrategyBot({ bot, market, onToggle, onConfig, onShowHistory }) {
  const [open, setOpen] = useState(false);
  const cfg = bot.config || {};
  const stats = bot.stats || {};
  const trades = bot.openTrades || [];
  const closed = bot.recentClosed || [];

  return (
    <div className="panel bot-panel">
      <div className="panel-head">
        <div className="bot-title">
          <h2>Strategy Bot</h2>
          <span className={`bot-state ${bot.enabled ? 'on' : 'off'}`}>
            {bot.enabled ? 'AUTO-TRADING' : 'STANDBY'}
          </span>
        </div>
        <button
          className={`switch ${bot.enabled ? 'on' : ''}`}
          onClick={() => onToggle(!bot.enabled)}
          title={bot.enabled ? 'Stop the bot' : 'Start the bot'}
        >
          <span className="switch-knob" />
        </button>
      </div>

      <div className="bot-stats">
        <div className="bot-stat">
          <span>Trades</span>
          <b>{stats.trades ?? 0}</b>
        </div>
        <div className="bot-stat">
          <span>Win rate</span>
          <b className={stats.winRate >= 50 ? 'up' : stats.trades ? 'down' : ''}>
            {stats.trades ? `${(stats.winRate || 0).toFixed(0)}%` : '—'}
          </b>
        </div>
        <div className="bot-stat">
          <span>Bot P&L</span>
          <b className={`mono ${signClass(stats.totalPnl)}`}>{fmtUsd(stats.totalPnl || 0)}</b>
        </div>
      </div>

      {bot.events && bot.events.blackout && (
        <div className="ev-bar ev-blackout">
          ⏸ Pause — <b>{bot.events.blackout.title}</b> ({whenLabel(bot.events.blackout.time)}) · nouvelles
          entrées suspendues
        </div>
      )}
      {bot.events && !bot.events.blackout && bot.events.next && (
        <div className="ev-bar">
          🗓 Prochain événement : <b>{bot.events.next.title}</b> · {whenLabel(bot.events.next.time)}
          {!bot.events.cryptoEnabled && <span className="ev-note"> · crypto off</span>}
        </div>
      )}

      <button className="bot-config-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Strategy settings · {cfg.timeframe} · conf ≥{cfg.confidenceMin}% · risk{' '}
        {cfg.riskPct}% · cap {cfg.maxPerDirection}/dir
      </button>
      {open && (
        <div className="bot-config">
          <label className="field">
            <span>Timeframe</span>
            <select value={cfg.timeframe} onChange={(e) => onConfig({ timeframe: e.target.value })}>
              {(bot.timeframes || ['1m', '5m', '15m', '1h']).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Confidence min ({cfg.confidenceMin}%)</span>
            <input
              type="range"
              min="40"
              max="100"
              step="5"
              value={cfg.confidenceMin}
              onChange={(e) => onConfig({ confidenceMin: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Risk / trade ({cfg.riskPct}%)</span>
            <input
              type="range"
              min="0.5"
              max="5"
              step="0.5"
              value={cfg.riskPct}
              onChange={(e) => onConfig({ riskPct: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Max same direction ({cfg.maxPerDirection})</span>
            <input
              type="range"
              min="1"
              max={cfg.maxPositions || 4}
              step="1"
              value={cfg.maxPerDirection ?? cfg.maxPositions ?? 4}
              onChange={(e) => onConfig({ maxPerDirection: Number(e.target.value) })}
            />
          </label>
          <label className="bot-check">
            <input
              type="checkbox"
              checked={!!cfg.confSizing}
              onChange={(e) => onConfig({ confSizing: e.target.checked })}
            />
            <span>Taille pondérée par la confiance</span>
          </label>
          <div className="bot-rr">
            R:R fixe — SL {cfg.atrSl}×ATR · TP {cfg.atrTp}×ATR (1:{(cfg.atrTp / cfg.atrSl).toFixed(0)})
          </div>
        </div>
      )}

      <div className="bot-section-label">Active trades ({trades.length})</div>
      <div className="bot-trades">
        {trades.length === 0 ? (
          <div className="empty small">{bot.enabled ? 'Waiting for a signal…' : 'Bot is on standby'}</div>
        ) : (
          trades.map((t) => <TradeCard key={t.id} trade={t} price={market[t.symbol]?.price} />)
        )}
      </div>

      {closed.length > 0 && (
        <>
          <div className="bot-section-label history-label">
            <span>Recent closes</span>
            <button className="see-all" onClick={onShowHistory}>
              Voir tout l'historique →
            </button>
          </div>
          <div className="bot-closed">
            {closed.slice(0, 6).map((t) => (
              <div key={t.id} className="closed-row mono">
                <span className={`dot ${t.exitReason === 'tp' ? 'up' : 'down'}`}>
                  {t.exitReason === 'tp' ? '▲' : t.exitReason === 'sl' ? '▼' : '■'}
                </span>
                <span className="closed-sym">{t.symbol.replace('USDT', '')}</span>
                <span className={`side-mini ${t.side}`}>{t.side === 'long' ? 'L' : 'S'}</span>
                <span className="closed-reason">{t.exitReason?.toUpperCase()}</span>
                <span className={`closed-pnl ${signClass(t.pnl)}`}>{fmtUsd(t.pnl)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="bot-disclaimer">
        Signaux algorithmiques (EMA·RSI·MACD·ATR) sur compte paper. Outil éducatif, pas un conseil
        financier.
      </div>
    </div>
  );
}

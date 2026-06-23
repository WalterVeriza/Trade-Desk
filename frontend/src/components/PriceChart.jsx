import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtPrice, fmtPct, signClass } from '../format.js';

const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'];

export default function PriceChart({ symbol, snapshot }) {
  const [interval, setInterval] = useState('1m');
  const [candles, setCandles] = useState([]);
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);

  // Load historical candles whenever symbol or interval changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getKlines(symbol, interval, 120)
      .then((data) => {
        if (!cancelled) {
          setCandles(data);
          setLoading(false);
        }
      })
      .catch(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [symbol, interval]);

  // Fold the live price into the most recent candle.
  useEffect(() => {
    if (!snapshot?.price) return;
    setCandles((prev) => {
      if (!prev.length) return prev;
      const next = prev.slice();
      const last = { ...next[next.length - 1] };
      last.close = snapshot.price;
      last.high = Math.max(last.high, snapshot.price);
      last.low = Math.min(last.low, snapshot.price);
      next[next.length - 1] = last;
      return next;
    });
  }, [snapshot?.price]);

  // Draw candlesticks.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || candles.length === 0) return;

    const css = getComputedStyle(document.documentElement);
    const upC = css.getPropertyValue('--up').trim() || '#26a17b';
    const downC = css.getPropertyValue('--down').trim() || '#e35d6a';
    const grid = css.getPropertyValue('--grid').trim() || '#1c2230';
    const axis = css.getPropertyValue('--text-dim').trim() || '#6b7689';

    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const padL = 8;
    const padR = 64;
    const padT = 12;
    const padB = 20;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    let hi = -Infinity;
    let lo = Infinity;
    for (const c of candles) {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
    const pad = (hi - lo) * 0.08 || hi * 0.01;
    hi += pad;
    lo -= pad;
    const range = hi - lo || 1;
    const yOf = (p) => padT + (1 - (p - lo) / range) * plotH;

    // Grid + price axis
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = axis;
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    const lines = 5;
    for (let i = 0; i <= lines; i++) {
      const p = lo + (range * i) / lines;
      const y = yOf(p);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(fmtPrice(p), padL + plotW + 6, y);
    }

    const n = candles.length;
    const slot = plotW / n;
    const bw = Math.max(1.5, Math.min(10, slot * 0.62));
    candles.forEach((c, i) => {
      const x = padL + slot * (i + 0.5);
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? upC : downC;
      ctx.fillStyle = up ? upC : downC;
      // wick
      ctx.beginPath();
      ctx.moveTo(x, yOf(c.high));
      ctx.lineTo(x, yOf(c.low));
      ctx.stroke();
      // body
      const yO = yOf(c.open);
      const yC = yOf(c.close);
      const top = Math.min(yO, yC);
      const h = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - bw / 2, top, bw, h);
    });

    // Last price marker line
    const lastP = candles[n - 1].close;
    const ly = yOf(lastP);
    ctx.strokeStyle = axis;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, ly);
    ctx.lineTo(padL + plotW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    const lblUp = candles[n - 1].close >= candles[n - 1].open;
    ctx.fillStyle = lblUp ? upC : downC;
    ctx.fillRect(padL + plotW, ly - 8, padR, 16);
    ctx.fillStyle = '#0a0e16';
    ctx.fillText(fmtPrice(lastP), padL + plotW + 6, ly);
  }, [candles, symbol]);

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <div className="chart-title">
          <h2>{symbol}</h2>
          {snapshot && (
            <>
              <span className="chart-price">{fmtPrice(snapshot.price)}</span>
              <span className={`chart-chg ${signClass(snapshot.changePct)}`}>
                {fmtPct(snapshot.changePct)}
              </span>
            </>
          )}
        </div>
        <div className="interval-tabs">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              className={`iv ${interval === iv ? 'active' : ''}`}
              onClick={() => setInterval(iv)}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-wrap" ref={wrapRef}>
        {loading && <div className="chart-loading">Loading {symbol}…</div>}
        <canvas ref={canvasRef} />
      </div>
      {snapshot && (
        <div className="chart-foot">
          <span>24h H <b>{fmtPrice(snapshot.high)}</b></span>
          <span>24h L <b>{fmtPrice(snapshot.low)}</b></span>
          <span>Bid <b>{fmtPrice(snapshot.bid)}</b></span>
          <span>Ask <b>{fmtPrice(snapshot.ask)}</b></span>
        </div>
      )}
    </div>
  );
}

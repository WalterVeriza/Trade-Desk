import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from './api.js';
import TopBar from './components/TopBar.jsx';
import MarketWatch from './components/MarketWatch.jsx';
import PriceChart from './components/PriceChart.jsx';
import OrderTicket from './components/OrderTicket.jsx';
import Positions from './components/Positions.jsx';
import Blotter from './components/Blotter.jsx';

const MAX_SPARK = 60;

export default function App() {
  const [symbols, setSymbols] = useState([]);
  const [market, setMarket] = useState({}); // symbol -> snapshot
  const [sparks, setSparks] = useState({}); // symbol -> number[]
  const [account, setAccount] = useState({ cash: 0 });
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [startingCash, setStartingCash] = useState(100000);
  const [selected, setSelected] = useState('BTCUSDT');
  const [status, setStatus] = useState('connecting'); // connecting | live | offline
  const [toast, setToast] = useState(null);
  const wsRef = useRef(null);

  const notify = useCallback((message, kind = 'info') => {
    setToast({ message, kind, id: Date.now() });
    setTimeout(() => setToast((t) => (t && t.message === message ? null : t)), 3500);
  }, []);

  const mergeMarket = useCallback((list) => {
    if (!list || !list.length) return;
    setMarket((prev) => {
      const next = { ...prev };
      for (const s of list) next[s.symbol] = s;
      return next;
    });
    setSparks((prev) => {
      const next = { ...prev };
      for (const s of list) {
        const arr = (next[s.symbol] || []).concat(s.price);
        if (arr.length > MAX_SPARK) arr.splice(0, arr.length - MAX_SPARK);
        next[s.symbol] = arr;
      }
      return next;
    });
  }, []);

  // Initial bootstrap
  useEffect(() => {
    let cancelled = false;
    api
      .getState()
      .then((s) => {
        if (cancelled) return;
        setSymbols(s.symbols);
        setStartingCash(s.startingCash);
        setAccount(s.account);
        setPositions(s.positions);
        setOrders(s.orders);
        setSparks(s.sparklines || {});
        const m = {};
        for (const snap of s.market) m[snap.symbol] = snap;
        setMarket(m);
      })
      .catch((e) => notify('Bootstrap failed: ' + e.message, 'error'));
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // WebSocket live feed with auto-reconnect
  useEffect(() => {
    let closedByUs = false;
    let reconnectTimer = null;

    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setStatus('live');
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'tick') mergeMarket(msg.market);
        else if (msg.type === 'state') {
          setAccount(msg.account);
          setPositions(msg.positions);
          setOrders(msg.orders);
        }
      };
      ws.onclose = () => {
        setStatus('offline');
        if (!closedByUs) reconnectTimer = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => {
      closedByUs = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [mergeMarket]);

  const refreshState = useCallback((s) => {
    if (!s) return;
    if (s.account) setAccount(s.account);
    if (s.positions) setPositions(s.positions);
    if (s.orders) setOrders(s.orders);
  }, []);

  const handlePlace = useCallback(
    async (order) => {
      const res = await api.placeOrder(order);
      const o = res.order;
      notify(
        `${o.side.toUpperCase()} ${o.qty} ${o.symbol} — ${o.status}${o.fillPrice ? ' @ ' + o.fillPrice : ''}`,
        o.side === 'buy' ? 'buy' : 'sell'
      );
      return res;
    },
    [notify]
  );

  const handleCancel = useCallback(
    async (id) => {
      await api.cancelOrder(id);
      notify(`Order #${id} cancelled`, 'info');
    },
    [notify]
  );

  const handleReset = useCallback(async () => {
    await api.reset();
    notify('Desk reset to starting balance', 'info');
  }, [notify]);

  // Derived portfolio metrics
  const metrics = useMemo(() => {
    let positionsValue = 0;
    let unrealized = 0;
    let realized = 0;
    for (const p of positions) {
      const px = market[p.symbol]?.price ?? p.avgPrice;
      positionsValue += p.qty * px;
      unrealized += p.qty * (px - p.avgPrice);
      realized += p.realizedPnl;
    }
    const equity = account.cash + positionsValue;
    return {
      cash: account.cash,
      positionsValue,
      equity,
      unrealized,
      realized,
      totalPnl: equity - startingCash,
      startingCash,
    };
  }, [positions, market, account, startingCash]);

  return (
    <div className="app">
      <TopBar metrics={metrics} status={status} onReset={handleReset} />
      <div className="layout">
        <section className="col col-watch">
          <MarketWatch
            symbols={symbols}
            market={market}
            sparks={sparks}
            selected={selected}
            onSelect={setSelected}
          />
        </section>
        <section className="col col-center">
          <PriceChart symbol={selected} snapshot={market[selected]} />
          <Blotter orders={orders} onCancel={handleCancel} />
        </section>
        <section className="col col-right">
          <OrderTicket
            symbols={symbols}
            market={market}
            selected={selected}
            onSelect={setSelected}
            onPlace={handlePlace}
            notify={notify}
          />
          <Positions positions={positions} market={market} onSelect={setSelected} />
        </section>
      </div>
      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}

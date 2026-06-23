const base = '';

async function req(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  getState: () => req('GET', '/api/state'),
  getKlines: (symbol, interval = '1m', limit = 120) =>
    req('GET', `/api/klines/${symbol}?interval=${interval}&limit=${limit}`),
  placeOrder: (order) => req('POST', '/api/orders', order),
  cancelOrder: (id) => req('DELETE', `/api/orders/${id}`),
  reset: () => req('POST', '/api/reset'),
};

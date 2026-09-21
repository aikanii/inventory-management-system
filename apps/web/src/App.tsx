import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api, currentUser, get, money, onSessionExpired, pct, post, saveSession, session, storeName,
} from './api.ts';

type View = 'dashboard' | 'pos' | 'inventory' | 'reorder' | 'reports' | 'assistant';

interface Product {
  id: string;
  sku: string;
  name: string;
  unit: string;
  selling_price_cents: number;
  avg_cost_cents: number;
  on_hand: number;
  reorder_point: number;
}

interface CartLine {
  product: Product;
  quantity: number;
  discountCents: number;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean>(Boolean(session.token));
  const [view, setView] = useState<View>('dashboard');
  const [notice, setNotice] = useState('');

  // The API client drops the tokens when a 401 cannot be refreshed; follow it
  // back to the login screen and say why, rather than rendering a shell whose
  // every request is unauthenticated.
  useEffect(() => onSessionExpired((reason) => {
    setNotice(reason);
    setAuthed(false);
  }), []);

  if (!authed) {
    return (
      <Login
        notice={notice}
        onSuccess={() => {
          setNotice('');
          setView('dashboard');
          setAuthed(true);
        }}
      />
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">IMS</span>
          <div>
            <strong>Inventory</strong>
            <small>{storeName()}</small>
          </div>
        </div>
        <nav>
          <NavItem id="dashboard" label="Dashboard" icon="▦" active={view} onClick={setView} />
          <NavItem id="pos" label="Point of sale" icon="⌘" active={view} onClick={setView} />
          <NavItem id="inventory" label="Stock" icon="▤" active={view} onClick={setView} />
          <NavItem id="reorder" label="Reorder" icon="↻" active={view} onClick={setView} />
          <NavItem id="reports" label="Profit & loss" icon="%" active={view} onClick={setView}
            hidden={session.role === 'CASHIER'} />
          <NavItem id="assistant" label="Assistant" icon="✦" active={view} onClick={setView}
            hidden={session.role === 'CASHIER'} />
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <strong>{currentUser()?.full_name ?? 'Signed in'}</strong>
            <small>{session.role}</small>
          </div>
          <button className="ghost" onClick={() => { session.clear(); setNotice(''); setAuthed(false); }}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        {view === 'dashboard' && <Dashboard onNavigate={setView} />}
        {view === 'pos' && <PointOfSale />}
        {view === 'inventory' && <Inventory />}
        {view === 'reorder' && <Reorder />}
        {view === 'reports' && <Reports />}
        {view === 'assistant' && <Assistant />}
      </main>
    </div>
  );
}

function NavItem({ id, label, icon, active, onClick, hidden }: {
  id: View; label: string; icon: string; active: View; onClick: (v: View) => void; hidden?: boolean;
}) {
  if (hidden) return null;
  return (
    <button className={active === id ? 'nav active' : 'nav'} onClick={() => onClick(id)}>
      <span className="nav-icon">{icon}</span>
      {label}
    </button>
  );
}

// ------------------------------------------------------------------ login

function Login({ onSuccess, notice }: { onSuccess: () => void; notice?: string }) {
  const [email, setEmail] = useState('owner@demo.ims');
  const [password, setPassword] = useState('Demo!Owner2026');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await post('/api/v1/auth/login', { email, password });
      saveSession(data);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const demo = [
    { role: 'Owner', email: 'owner@demo.ims', password: 'Demo!Owner2026' },
    { role: 'Manager', email: 'manager@demo.ims', password: 'Demo!Manager2026' },
    { role: 'Cashier', email: 'cashier@demo.ims', password: 'Demo!Cashier2026' },
    { role: 'Viewer', email: 'viewer@demo.ims', password: 'Demo!Viewer2026' },
  ];

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <h1>Inventory Management System</h1>
        <p className="muted">Sales, stock and profitability for small-scale stores.</p>
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" />
        </label>
        {(error || notice) && <div className="alert error">{error || notice}</div>}
        <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="demo-accounts">
          <span className="muted">Demo accounts</span>
          <div className="demo-row">
            {demo.map((d) => (
              <button type="button" key={d.role} className="chip"
                onClick={() => { setEmail(d.email); setPassword(d.password); }}>
                {d.role}
              </button>
            ))}
          </div>
        </div>
      </form>
    </div>
  );
}

// -------------------------------------------------------------- dashboard

function Dashboard({ onNavigate }: { onNavigate: (v: View) => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await get('/api/v1/reports/dashboard'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="alert error">{error}</div>;
  if (!data) return <Loading />;

  return (
    <section>
      <Header title="Dashboard" subtitle="Where the store stands right now" onRefresh={load} />
      <div className="cards">
        <Card label="Sales today" value={String(data.today.sales_count)}
          sub={money(data.today.net_revenue_cents)} />
        <Card label="Gross margin today" value={pct(data.today.gross_margin_pct)}
          sub={money(data.today.gross_profit_cents)} tone={data.today.gross_profit_cents < 0 ? 'bad' : 'good'} />
        <Card label="Month to date" value={money(data.month_to_date.net_revenue_cents)}
          sub={`Gross ${money(data.month_to_date.gross_profit_cents)}`} />
        <Card label="Net profit MTD" value={money(data.month_to_date.net_profit_cents)}
          sub={`after ${money(data.month_to_date.expenses_cents)} expenses`}
          tone={data.month_to_date.net_profit_cents < 0 ? 'bad' : 'good'} />
      </div>

      <div className="grid-2">
        <div className="panel">
          <h3>Top movers — last 30 days</h3>
          <table>
            <thead><tr><th>SKU</th><th>Product</th><th className="num">Units</th><th className="num">Gross profit</th></tr></thead>
            <tbody>
              {data.top_movers_30d.length === 0 && <tr><td colSpan={4} className="muted">No sales yet.</td></tr>}
              {data.top_movers_30d.map((r: any) => (
                <tr key={r.sku}>
                  <td className="mono">{r.sku}</td>
                  <td>{r.name}</td>
                  <td className="num">{r.units}</td>
                  <td className="num">{money(r.gross_profit_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Needs attention</h3>
          <button className="row-button" onClick={() => onNavigate('reorder')}>
            <span>{data.alerts.low_stock_products} product(s) at or below reorder point</span>
            <span className="chev">→</span>
          </button>
          <button className="row-button" onClick={() => onNavigate('assistant')}>
            <span>{data.alerts.open_anomalies} open anomaly finding(s)</span>
            <span className="chev">→</span>
          </button>
          <p className="muted small">
            Every figure here is computed from the stock ledger and the cost basis recorded at
            the moment of each sale — not from an editable quantity field.
          </p>
        </div>
      </div>
    </section>
  );
}

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <strong className={tone ? `card-value ${tone}` : 'card-value'}>{value}</strong>
      {sub && <span className="card-sub">{sub}</span>}
    </div>
  );
}

// -------------------------------------------------------------------- POS

function PointOfSale() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [lastSale, setLastSale] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (query.trim().length < 1) { setResults([]); return; }
    const timer = setTimeout(async () => {
      try {
        const data = await get<any>(`/api/v1/products?q=${encodeURIComponent(query)}&per_page=12`);
        setResults(data);
      } catch {
        setResults([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const add = (product: Product) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.product.id === product.id);
      if (existing) {
        return prev.map((l) => (l.product.id === product.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { product, quantity: 1, discountCents: 0 }];
    });
    setQuery('');
    setResults([]);
  };

  const setQty = (id: string, quantity: number) =>
    setCart((prev) => prev.flatMap((l) => (l.product.id === id
      ? (quantity <= 0 ? [] : [{ ...l, quantity }])
      : [l])));

  const totals = useMemo(() => {
    const subtotal = cart.reduce((s, l) => s + l.product.selling_price_cents * l.quantity, 0);
    const discount = cart.reduce((s, l) => s + l.discountCents, 0);
    const net = subtotal - discount;
    const gross = cart.reduce(
      (s, l) => s + (l.product.selling_price_cents - l.product.avg_cost_cents) * l.quantity - l.discountCents, 0);
    return { subtotal, discount, net, gross, margin: net === 0 ? 0 : (gross / net) * 100 };
  }, [cart]);

  const checkout = async () => {
    if (cart.length === 0) return;
    setBusy(true);
    setMessage(null);
    try {
      const sale = await post<any>('/api/v1/sales', {
        items: cart.map((l) => ({
          product_id: l.product.id,
          quantity: l.quantity,
          discount_cents: l.discountCents,
        })),
        tenders: [{ method: 'CASH', amount_cents: totals.net }],
      }, { 'idempotency-key': crypto.randomUUID() });
      setLastSale(sale);
      setCart([]);
      setMessage({ kind: 'ok', text: `Sale ${sale.reference} recorded — ${money(sale.gross_profit_cents)} gross profit.` });
    } catch (err) {
      const e = err as Error & { code?: string; details?: any };
      const detail = Array.isArray(e.details) && e.details[0]
        ? ` (${e.details[0].sku}: requested ${e.details[0].requested}, available ${e.details[0].available})`
        : '';
      setMessage({ kind: 'error', text: `${e.message}${detail}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <Header title="Point of sale" subtitle="Barcode-first checkout with a live margin indicator" />
      <div className="pos">
        <div className="panel">
          <input className="search" autoFocus placeholder="Scan a barcode or search by name / SKU…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="search-results">
            {results.map((p) => (
              <button key={p.id} className="result" onClick={() => add(p)} disabled={p.on_hand <= 0}>
                <span className="mono">{p.sku}</span>
                <span className="grow">{p.name}</span>
                <span className="muted">{p.on_hand} on hand</span>
                <span>{money(p.selling_price_cents)}</span>
              </button>
            ))}
            {query && results.length === 0 && <p className="muted small">No match.</p>}
          </div>
        </div>

        <div className="panel">
          <h3>Cart</h3>
          {cart.length === 0 && <p className="muted">Empty. Search or scan to add items.</p>}
          {cart.map((line) => (
            <div className="cart-line" key={line.product.id}>
              <div className="grow">
                <strong>{line.product.name}</strong>
                <small className="mono">{line.product.sku} · {money(line.product.selling_price_cents)}</small>
              </div>
              <input className="qty" type="number" min={1} value={line.quantity}
                onChange={(e) => setQty(line.product.id, Number(e.target.value))} />
              <span className="line-total">
                {money(line.product.selling_price_cents * line.quantity - line.discountCents)}
              </span>
              <button className="ghost" onClick={() => setQty(line.product.id, 0)}>×</button>
            </div>
          ))}

          <dl className="totals">
            <div><dt>Subtotal</dt><dd>{money(totals.subtotal)}</dd></div>
            <div><dt>Discount</dt><dd>{money(-totals.discount)}</dd></div>
            <div><dt>Net</dt><dd>{money(totals.net)}</dd></div>
            <div className={totals.gross < 0 ? 'bad' : ''}>
              <dt>Gross profit</dt><dd>{money(totals.gross)} ({pct(totals.margin)})</dd></div>
          </dl>

          {message && <div className={`alert ${message.kind}`}>{message.text}</div>}
          <button className="primary" onClick={checkout} disabled={busy || cart.length === 0}>
            {busy ? 'Recording…' : `Charge ${money(totals.net)}`}
          </button>

          {lastSale && (
            <div className="receipt">
              <h4>{lastSale.reference}</h4>
              {lastSale.lines.map((l: any) => (
                <div key={l.id} className="receipt-line">
                  <span>{l.quantity} × {l.name}</span>
                  <span>{money(l.unit_price_cents * l.quantity - l.discount_cents)}</span>
                </div>
              ))}
              <div className="receipt-line total"><span>Total</span><span>{money(lastSale.total_cents)}</span></div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// -------------------------------------------------------------- inventory

function Inventory() {
  const [rows, setRows] = useState<any[]>([]);
  const [valuation, setValuation] = useState<any>(null);
  const [onlyLow, setOnlyLow] = useState(false);

  const load = useCallback(async () => {
    const [levels, value] = await Promise.all([
      get<any>('/api/v1/inventory/levels?per_page=200'),
      get<any>('/api/v1/inventory/valuation'),
    ]);
    setRows(levels);
    setValuation(value);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = onlyLow ? rows.filter((r) => r.low_stock) : rows;

  return (
    <section>
      <Header title="Stock" subtitle="On-hand derived from the append-only movement ledger" onRefresh={load} />
      {valuation && (
        <div className="cards">
          <Card label="Units on hand" value={String(valuation.units)} />
          <Card label="Value at cost" value={money(valuation.at_cost_cents)} />
          <Card label="Value at retail" value={money(valuation.at_retail_cents)} />
          <Card label="Potential margin" value={money(valuation.at_retail_cents - valuation.at_cost_cents)} />
        </div>
      )}
      <div className="panel">
        <label className="inline-check">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          Only show items at or below their reorder point
        </label>
        <table>
          <thead>
            <tr>
              <th>SKU</th><th>Product</th><th className="num">On hand</th><th className="num">Reorder at</th>
              <th className="num">Cost</th><th className="num">Price</th><th className="num">Value at cost</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className={r.low_stock ? 'low' : ''}>
                <td className="mono">{r.sku}</td>
                <td>{r.name}</td>
                <td className="num">{r.on_hand}</td>
                <td className="num">{r.reorder_point}</td>
                <td className="num">{money(r.avg_cost_cents)}</td>
                <td className="num">{money(r.selling_price_cents)}</td>
                <td className="num">{money(r.value_at_cost_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- reorder

function Reorder() {
  const [rows, setRows] = useState<any[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await get('/api/v1/ai/reorder-suggestions'));
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runForecasts = async () => {
    setMessage('Running forecasts and anomaly screening…');
    await post('/api/v1/ai/forecasts/run');
    setTimeout(async () => { await load(); setMessage('Done.'); }, 1500);
  };

  const createOrders = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const res = await post<any>('/api/v1/ai/reorder-suggestions/to-purchase-order', { suggestion_ids: ids });
    setMessage(`Created ${res.purchase_order_ids.length} draft purchase order(s) from ${res.suggestions_converted} suggestion(s).`);
    setSelected(new Set());
    await load();
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <section>
      <Header title="Reorder suggestions" subtitle="Derived from forecast demand, supplier lead time and safety stock"
        onRefresh={load} />
      <div className="toolbar">
        <button onClick={runForecasts}>Run forecasts now</button>
        <button className="primary" onClick={createOrders} disabled={selected.size === 0}>
          Create draft purchase order ({selected.size})
        </button>
        {message && <span className="muted small">{message}</span>}
      </div>
      <div className="panel">
        {rows.length === 0 && <p className="muted">Nothing needs reordering. Run the forecasts to refresh.</p>}
        <table>
          <thead>
            <tr>
              <th></th><th>SKU</th><th>Product</th><th className="num">On hand</th><th className="num">On order</th>
              <th className="num">Reorder point</th><th className="num">Days of cover</th><th className="num">Order</th>
              <th>Supplier</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)}
                  disabled={!r.supplier_id} /></td>
                <td className="mono">{r.sku}</td>
                <td>{r.name}</td>
                <td className="num">{r.on_hand}</td>
                <td className="num">{r.on_order}</td>
                <td className="num">{r.reorder_point}</td>
                <td className="num">{r.days_of_cover ?? '∞'}</td>
                <td className="num"><strong>{r.suggested_qty}</strong></td>
                <td>{r.supplier_name ?? <span className="muted">no supplier</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- reports

function Reports() {
  const [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [pl, setPl] = useState<any>(null);
  const [perf, setPerf] = useState<any[]>([]);
  const [ageing, setAgeing] = useState<any>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [profitLoss, performance, ageingReport] = await Promise.all([
        get<any>(`/api/v1/reports/profit-loss?from=${from}&to=${to}`),
        get<any>(`/api/v1/reports/product-performance?from=${from}&to=${to}`),
        get<any>('/api/v1/reports/inventory-ageing'),
      ]);
      setPl(profitLoss);
      setPerf(performance);
      setAgeing(ageingReport);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [from, to]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section>
      <Header title="Profit & loss" subtitle="Gross margin from cost snapshots, net after recorded expenses" />
      <div className="toolbar">
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button onClick={load}>Apply</button>
      </div>
      {error && <div className="alert error">{error}</div>}
      {pl && (
        <>
          <div className="cards">
            <Card label="Net revenue" value={money(pl.net_revenue_cents)} />
            <Card label="Cost of goods sold" value={money(pl.cogs_cents)} />
            <Card label="Gross profit" value={money(pl.gross_profit_cents)} sub={pct(pl.gross_margin_pct)} />
            <Card label="Net profit" value={money(pl.net_profit_cents)} sub={pct(pl.net_margin_pct)}
              tone={pl.net_profit_cents < 0 ? 'bad' : 'good'} />
          </div>
          <div className="grid-2">
            <div className="panel">
              <h3>Operating expenses</h3>
              <table>
                <tbody>
                  {pl.expenses.map((e: any, i: number) => (
                    <tr key={i}><td>{e.category_name ?? 'Uncategorised'}</td>
                      <td className="num">{money(e.amount_cents)}</td></tr>
                  ))}
                  <tr className="total"><td>Total</td><td className="num">{money(pl.total_expenses_cents)}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="panel">
              <h3>Inventory ageing (value at cost)</h3>
              {ageing && (
                <table>
                  <tbody>
                    <tr><td>Sold within 30 days</td><td className="num">{money(ageing.buckets_cents.d0_30)}</td></tr>
                    <tr><td>31–60 days</td><td className="num">{money(ageing.buckets_cents.d31_60)}</td></tr>
                    <tr><td>61–90 days</td><td className="num">{money(ageing.buckets_cents.d61_90)}</td></tr>
                    <tr><td>91–180 days</td><td className="num">{money(ageing.buckets_cents.d91_180)}</td></tr>
                    <tr><td>Over 180 days</td><td className="num">{money(ageing.buckets_cents.d180_plus)}</td></tr>
                    <tr><td>Never sold</td><td className="num">{money(ageing.buckets_cents.never_sold)}</td></tr>
                    <tr className="total"><td>Dead stock</td>
                      <td className="num">{money(ageing.dead_stock_cents)}</td></tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="panel">
            <h3>Product performance</h3>
            <table>
              <thead>
                <tr><th>SKU</th><th>Product</th><th className="num">Units</th><th className="num">Revenue</th>
                  <th className="num">Gross profit</th><th className="num">Margin</th></tr>
              </thead>
              <tbody>
                {perf.slice(0, 40).map((r: any) => (
                  <tr key={r.sku} className={r.gross_profit < 0 ? 'low' : ''}>
                    <td className="mono">{r.sku}</td>
                    <td>{r.name}</td>
                    <td className="num">{r.units}</td>
                    <td className="num">{money(r.revenue)}</td>
                    <td className="num">{money(r.gross_profit)}</td>
                    <td className="num">{pct(r.gross_margin_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// -------------------------------------------------------------- assistant

interface Turn { question: string; answer: string; tools: { id: string; tool: string }[] }

function Assistant() {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    const q = question.trim();
    setQuestion('');
    setBusy(true);
    try {
      const res = await post<any>('/api/v1/ai/chat', { message: q, conversation_id: conversationId });
      setConversationId(res.conversation_id);
      setTurns((prev) => [...prev, { question: q, answer: res.answer, tools: res.tools }]);
    } catch (err) {
      setTurns((prev) => [...prev, { question: q, answer: (err as Error).message, tools: [] }]);
    } finally {
      setBusy(false);
    }
  };

  const suggestions = [
    'Which items lost money this month?',
    'What should I reorder before Friday?',
    'How did this month go?',
    'Any suspicious activity?',
    'What is my dead stock worth?',
  ];

  return (
    <section>
      <Header title="Assistant" subtitle="Read-only. Every figure cites the query that produced it." />
      <div className="panel chat">
        {turns.length === 0 && (
          <div className="chat-empty">
            <p className="muted">Ask about sales, stock or profitability. Try one of these:</p>
            <div className="demo-row">
              {suggestions.map((s) => (
                <button key={s} className="chip" onClick={() => setQuestion(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="turn">
            <div className="bubble question">{t.question}</div>
            <div className="bubble answer">
              <pre>{t.answer}</pre>
              {t.tools.length > 0 && (
                <div className="tools">
                  {t.tools.map((tool) => (
                    <span key={tool.id} className="tool" title="Read-only tool call">
                      [{tool.id}] {tool.tool}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        <form className="chat-input" onSubmit={ask}>
          <input value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this store…" disabled={busy} />
          <button className="primary" disabled={busy || !question.trim()}>
            {busy ? 'Thinking…' : 'Ask'}
          </button>
        </form>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ shared

function Header({ title, subtitle, onRefresh }: { title: string; subtitle?: string; onRefresh?: () => void }) {
  return (
    <header className="page-head">
      <div>
        <h2>{title}</h2>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {onRefresh && <button className="ghost" onClick={onRefresh}>Refresh</button>}
    </header>
  );
}

function Loading() {
  return <p className="muted">Loading…</p>;
}

export { api };

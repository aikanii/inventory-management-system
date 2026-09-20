/**
 * Integration tests: the real Express app, the real SQL, a real PostgreSQL
 * (PGlite, in-memory). Every invariant listed in README section 9.3 is asserted
 * here explicitly rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDatabase, type Database } from '../../src/db/database.js';
import { migrate } from '../../src/db/migrate.js';
import { ensureJwtKeys } from '../../src/shared/security.js';
import type { AppContext } from '../../src/shared/http.js';
import { createApp } from '../../src/main.js';
import { createQueue, buildHandlers, type Queue } from '../../src/worker/index.js';
import { seed, type SeedResult } from '../../src/seed.js';

let db: Database;
let queue: Queue;
let server: Server;
let base = '';
let demo: SeedResult;
let storeId = '';

const tokens: Record<string, { access: string; refresh: string; storeId: string }> = {};

async function login(email: string, password: string) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res;
}

interface CallOptions {
  token?: string;
  store?: string;
  idempotencyKey?: string;
}

async function call<T = any>(method: string, path: string, body?: unknown, opts: CallOptions = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.store) headers['x-store-id'] = opts.store;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json as T };
}

async function sql<T = any>(query: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(query, params)).rows;
}

beforeAll(async () => {
  db = await openDatabase({});           // in-memory PostgreSQL
  await migrate(db);
  const keys = await ensureJwtKeys(db);
  queue = createQueue(db, buildHandlers(db));
  const ctx: AppContext = { db, keys, enqueue: (kind, payload) => queue.enqueue(kind, payload) };
  const app = createApp(ctx);

  demo = await seed(db, { days: 20 });
  storeId = demo.storeId;

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const user of demo.users) {
    const res = await login(user.email, user.password);
    const data = (await res.json()) as any;
    tokens[user.role] = {
      access: data.data.access_token,
      refresh: data.data.refresh_token,
      storeId: data.data.store.id,
    };
  }
}, 180_000);

afterAll(async () => {
  server?.close();
  await db?.close();
});

const owner = () => tokens['OWNER']!;
const manager = () => tokens['MANAGER']!;
const cashier = () => tokens['CASHIER']!;
const viewer = () => tokens['VIEWER']!;

// ------------------------------------------------------------------ invariants

describe('invariant: the ledger is the source of truth', () => {
  it('SUM(stock_movement) equals stock_level.on_hand for every product', async () => {
    const rows = await sql<{ mismatches: number }>(`
      WITH ledger AS (
        SELECT product_id, store_id,
               coalesce(sum(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0)::int AS on_hand
          FROM stock_movement GROUP BY product_id, store_id)
      SELECT count(*)::int AS mismatches
        FROM stock_level sl
        FULL OUTER JOIN ledger l ON l.product_id = sl.product_id AND l.store_id = sl.store_id
       WHERE coalesce(sl.on_hand, 0) <> coalesce(l.on_hand, 0)`);
    expect(rows[0]?.mismatches).toBe(0);
  });

  it('every sale reconciles: line gross profit and tenders', async () => {
    const rows = await sql<{ bad_margin: number; bad_tenders: number }>(`
      SELECT
        (SELECT count(*)::int FROM sale s
          WHERE s.status = 'ACTIVE'
            AND s.gross_profit_cents <> coalesce(
              (SELECT sum(gross_profit_cents) FROM sale_item WHERE sale_id = s.id), 0)) AS bad_margin,
        (SELECT count(*)::int FROM sale s
          WHERE s.total_cents <> coalesce(
              (SELECT sum(amount_cents) FROM payment WHERE sale_id = s.id), 0)) AS bad_tenders`);
    expect(rows[0]?.bad_margin).toBe(0);
    expect(rows[0]?.bad_tenders).toBe(0);
  });

  it('no sale line ever has a negative on-hand movement without a matching IN', async () => {
    const rows = await sql<{ negatives: number }>(
      `SELECT count(*)::int AS negatives FROM stock_level WHERE on_hand < 0`);
    expect(rows[0]?.negatives).toBe(0);
  });
});

// ------------------------------------------------------------------ auth & RBAC

describe('authentication', () => {
  it('rejects a wrong password with the same shape as an unknown account', async () => {
    const wrongPassword = await login('owner@demo.ims', 'not-the-password');
    const unknownAccount = await login('nobody@demo.ims', 'whatever123');
    expect(wrongPassword.status).toBe(401);
    expect(unknownAccount.status).toBe(401);
    expect((await wrongPassword.json()).error.message)
      .toBe((await unknownAccount.json()).error.message);
  });

  it('rotates the refresh token and rejects replay of the old one', async () => {
    const first = await login('manager@demo.ims', 'Demo!Manager2026');
    const { refresh_token: oldToken } = (await first.json()).data;

    const rotated = await call('POST', '/api/v1/auth/refresh', { refresh_token: oldToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.refresh_token).not.toBe(oldToken);

    const replay = await call('POST', '/api/v1/auth/refresh', { refresh_token: oldToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_TOKEN_REUSED');
  });

  it('refuses to act on a store the token was not minted for', async () => {
    const res = await call('GET', '/api/v1/products', undefined, {
      token: owner().access,
      store: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STORE_ACCESS_DENIED');
  });
});

describe('authorization matrix', () => {
  it('blocks a cashier from writing to the catalogue', async () => {
    const res = await call('POST', '/api/v1/products', {
      sku: 'NOPE-1', name: 'Should fail', selling_price_cents: 100,
    }, { token: cashier().access, store: cashier().storeId });
    expect(res.status).toBe(403);
  });

  it('blocks a viewer from selling', async () => {
    const product = await sql<{ id: string }>('SELECT id FROM product LIMIT 1');
    const res = await call('POST', '/api/v1/sales', {
      items: [{ product_id: product[0]!.id, quantity: 1 }],
      tenders: [{ method: 'CASH', amount_cents: 100 }],
    }, { token: viewer().access, store: viewer().storeId });
    expect(res.status).toBe(403);
  });

  it('never leaks a password hash or a refresh token in any response', async () => {
    const endpoints = ['/api/v1/users/me', '/api/v1/products', '/api/v1/inventory/levels'];
    for (const path of endpoints) {
      const res = await call('GET', path, undefined, { token: owner().access, store: owner().storeId });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('$argon2');
      expect(raw).not.toContain('refresh_token');
    }
  });
});

// ------------------------------------------------------------------- POS path

describe('point of sale', () => {
  it('records the cost basis at the moment of sale and prices correctly', async () => {
    const [product] = await sql<{ id: string; selling_price_cents: number; avg_cost_cents: number; on_hand: number }>(`
      SELECT p.id, p.selling_price_cents, p.avg_cost_cents, coalesce(sl.on_hand,0)::int AS on_hand
        FROM product p JOIN stock_level sl ON sl.product_id = p.id
       WHERE sl.on_hand > 5 AND p.avg_cost_cents > 0 LIMIT 1`);

    const quantity = 2;
    const res = await call('POST', '/api/v1/sales', {
      items: [{ product_id: product!.id, quantity }],
      tenders: [{ method: 'CASH', amount_cents: product!.selling_price_cents * quantity }],
    }, { token: cashier().access, store: cashier().storeId });

    expect(res.status).toBe(201);
    const sale = res.body.data;
    expect(sale.net_revenue_cents).toBe(product!.selling_price_cents * quantity);
    expect(sale.gross_profit_cents).toBe(
      (product!.selling_price_cents - product!.avg_cost_cents) * quantity,
    );
    expect(sale.lines[0].unit_cost_cents).toBe(product!.avg_cost_cents);

    const [level] = await sql<{ on_hand: number }>(
      'SELECT on_hand FROM stock_level WHERE product_id = $1', [product!.id]);
    expect(level!.on_hand).toBe(product!.on_hand - quantity);
  });

  it('replays an idempotency key without selling the stock twice', async () => {
    const [product] = await sql<{ id: string; selling_price_cents: number; on_hand: number }>(`
      SELECT p.id, p.selling_price_cents, sl.on_hand FROM product p
        JOIN stock_level sl ON sl.product_id = p.id WHERE sl.on_hand > 10 LIMIT 1`);
    const key = 'test-idempotency-key-0001';
    const body = {
      items: [{ product_id: product!.id, quantity: 1 }],
      tenders: [{ method: 'CASH', amount_cents: product!.selling_price_cents }],
    };

    const first = await call('POST', '/api/v1/sales', body, {
      token: cashier().access, store: cashier().storeId, idempotencyKey: key,
    });
    const second = await call('POST', '/api/v1/sales', body, {
      token: cashier().access, store: cashier().storeId, idempotencyKey: key,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.body.data.replayed).toBe(true);

    const [movements] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM stock_movement WHERE reason = 'SALE' AND product_id = $1
         AND reference_id IN (SELECT id FROM sale_item WHERE sale_id = $2)`,
      [product!.id, first.body.data.id],
    );
    expect(movements!.n).toBe(1);
  });

  it('refuses to oversell and leaves stock untouched', async () => {
    const [product] = await sql<{ id: string; selling_price_cents: number; on_hand: number }>(`
      SELECT p.id, p.selling_price_cents, sl.on_hand FROM product p
        JOIN stock_level sl ON sl.product_id = p.id WHERE sl.on_hand > 0 AND sl.on_hand < 50 LIMIT 1`);
    const res = await call('POST', '/api/v1/sales', {
      items: [{ product_id: product!.id, quantity: product!.on_hand + 100 }],
      tenders: [{ method: 'CASH', amount_cents: product!.selling_price_cents * (product!.on_hand + 100) }],
    }, { token: cashier().access, store: cashier().storeId });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    const [level] = await sql<{ on_hand: number }>(
      'SELECT on_hand FROM stock_level WHERE product_id = $1', [product!.id]);
    expect(level!.on_hand).toBe(product!.on_hand);
  });

  it('blocks a below-cost sale unless it is explicitly overridden', async () => {
    const [product] = await sql<{ id: string; avg_cost_cents: number }>(
      `SELECT id, avg_cost_cents FROM product WHERE avg_cost_cents > 100 LIMIT 1`);
    const res = await call('POST', '/api/v1/sales', {
      items: [{ product_id: product!.id, quantity: 1, unit_price_cents: Math.floor(product!.avg_cost_cents / 2) }],
      tenders: [{ method: 'CASH', amount_cents: Math.floor(product!.avg_cost_cents / 2) }],
    }, { token: cashier().access, store: cashier().storeId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('BELOW_COST_PRICE');
  });

  it('restores stock at the ORIGINAL cost when a line is returned', async () => {
    const [product] = await sql<{ id: string; selling_price_cents: number; avg_cost_cents: number; on_hand: number }>(`
      SELECT p.id, p.selling_price_cents, p.avg_cost_cents, sl.on_hand FROM product p
        JOIN stock_level sl ON sl.product_id = p.id WHERE sl.on_hand > 8 LIMIT 1`);

    const sale = await call('POST', '/api/v1/sales', {
      items: [{ product_id: product!.id, quantity: 3 }],
      tenders: [{ method: 'CASH', amount_cents: product!.selling_price_cents * 3 }],
    }, { token: cashier().access, store: cashier().storeId });
    expect(sale.status).toBe(201);
    const lineId = sale.body.data.lines[0].id;
    const costAtSale = sale.body.data.lines[0].unit_cost_cents;

    const returned = await call('POST', `/api/v1/sales/${sale.body.data.id}/return`, {
      items: [{ sale_item_id: lineId, quantity: 3 }],
      note: 'customer changed their mind',
    }, { token: cashier().access, store: cashier().storeId });

    expect(returned.status).toBe(200);
    expect(returned.body.data.status).toBe('RETURNED');

    const [movement] = await sql<{ unit_cost_cents: number }>(
      `SELECT unit_cost_cents FROM stock_movement
        WHERE reason = 'RETURN_FROM_CUSTOMER' AND reference_id = $1 LIMIT 1`, [lineId]);
    expect(movement!.unit_cost_cents).toBe(costAtSale);

    const [level] = await sql<{ on_hand: number }>(
      'SELECT on_hand FROM stock_level WHERE product_id = $1', [product!.id]);
    expect(level!.on_hand).toBe(product!.on_hand);
  });

  it('puts the stock back when a sale is voided', async () => {
    const [product] = await sql<{ id: string; selling_price_cents: number; on_hand: number }>(`
      SELECT p.id, p.selling_price_cents, sl.on_hand FROM product p
        JOIN stock_level sl ON sl.product_id = p.id WHERE sl.on_hand > 6 LIMIT 1`);
    const sale = await call('POST', '/api/v1/sales', {
      items: [{ product_id: product!.id, quantity: 2 }],
      tenders: [{ method: 'CASH', amount_cents: product!.selling_price_cents * 2 }],
    }, { token: cashier().access, store: cashier().storeId });

    const voided = await call('POST', `/api/v1/sales/${sale.body.data.id}/void`,
      { reason: 'keyed twice' },
      { token: manager().access, store: manager().storeId });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('VOIDED');

    const [level] = await sql<{ on_hand: number }>(
      'SELECT on_hand FROM stock_level WHERE product_id = $1', [product!.id]);
    expect(level!.on_hand).toBe(product!.on_hand);
  });

  it('requires a reason to void, and forbids it for a cashier', async () => {
    const [sale] = await sql<{ id: string }>(`SELECT id FROM sale WHERE status = 'ACTIVE' LIMIT 1`);
    const noReason = await call('POST', `/api/v1/sales/${sale!.id}/void`, { reason: '' },
      { token: manager().access, store: manager().storeId });
    expect(noReason.status).toBe(400);

    const asCashier = await call('POST', `/api/v1/sales/${sale!.id}/void`, { reason: 'not allowed' },
      { token: cashier().access, store: cashier().storeId });
    expect(asCashier.status).toBe(403);
  });
});

// ------------------------------------------------------------------ purchasing

describe('purchasing', () => {
  it('moves a purchase order through its state machine', async () => {
    const [product] = await sql<{ id: string; supplier_id: string }>(
      'SELECT id, supplier_id FROM product WHERE supplier_id IS NOT NULL LIMIT 1');
    const created = await call('POST', '/api/v1/purchase-orders', {
      supplier_id: product!.supplier_id,
      items: [{ product_id: product!.id, quantity: 10, unit_cost_cents: 1000 }],
    }, { token: manager().access, store: manager().storeId });
    expect(created.status).toBe(201);
    const poId = created.body.data.id;

    // A draft cannot be received. Send a well-formed body so the state machine,
    // not the schema validator, is what rejects it.
    const [draftItem] = await sql<{ id: string }>(
      'SELECT id FROM purchase_order_item WHERE purchase_order_id = $1', [poId]);
    const draftReceive = await call('POST', `/api/v1/purchase-orders/${poId}/receive`,
      { items: [{ purchase_order_item_id: draftItem!.id, quantity: 1 }] },
      { token: manager().access, store: manager().storeId });
    expect(draftReceive.status).toBe(422);
    expect(draftReceive.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const sent = await call('POST', `/api/v1/purchase-orders/${poId}/send`, {},
      { token: manager().access, store: manager().storeId });
    expect(sent.body.data.status).toBe('SENT');

    const [item] = await sql<{ id: string }>(
      'SELECT id FROM purchase_order_item WHERE purchase_order_id = $1', [poId]);
    const partial = await call('POST', `/api/v1/purchase-orders/${poId}/receive`,
      { items: [{ purchase_order_item_id: item!.id, quantity: 4 }] },
      { token: manager().access, store: manager().storeId });
    expect(partial.body.data.status).toBe('PARTIALLY_RECEIVED');

    const rest = await call('POST', `/api/v1/purchase-orders/${poId}/receive`,
      { items: [{ purchase_order_item_id: item!.id, quantity: 6 }] },
      { token: manager().access, store: manager().storeId });
    expect(rest.body.data.status).toBe('RECEIVED');
  });

  it('refuses to receive more than was ordered', async () => {
    const [product] = await sql<{ id: string; supplier_id: string }>(
      'SELECT id, supplier_id FROM product WHERE supplier_id IS NOT NULL LIMIT 1');
    const created = await call('POST', '/api/v1/purchase-orders', {
      supplier_id: product!.supplier_id,
      items: [{ product_id: product!.id, quantity: 5, unit_cost_cents: 900 }],
    }, { token: manager().access, store: manager().storeId });
    const poId = created.body.data.id;
    await call('POST', `/api/v1/purchase-orders/${poId}/send`, {},
      { token: manager().access, store: manager().storeId });
    const [item] = await sql<{ id: string }>(
      'SELECT id FROM purchase_order_item WHERE purchase_order_id = $1', [poId]);
    const over = await call('POST', `/api/v1/purchase-orders/${poId}/receive`,
      { items: [{ purchase_order_item_id: item!.id, quantity: 99 }] },
      { token: manager().access, store: manager().storeId });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVER_RECEIPT');
  });

  it('changes the cost basis when goods arrive at a new price', async () => {
    const [product] = await sql<{ id: string; supplier_id: string; avg_cost_cents: number; on_hand: number }>(`
      SELECT p.id, p.supplier_id, p.avg_cost_cents, sl.on_hand FROM product p
        JOIN stock_level sl ON sl.product_id = p.id
       WHERE p.supplier_id IS NOT NULL AND sl.on_hand > 0 LIMIT 1`);
    const newCost = product!.avg_cost_cents + 500;

    const created = await call('POST', '/api/v1/purchase-orders', {
      supplier_id: product!.supplier_id,
      items: [{ product_id: product!.id, quantity: 10, unit_cost_cents: newCost }],
    }, { token: manager().access, store: manager().storeId });
    const poId = created.body.data.id;
    await call('POST', `/api/v1/purchase-orders/${poId}/send`, {},
      { token: manager().access, store: manager().storeId });
    const [item] = await sql<{ id: string }>(
      'SELECT id FROM purchase_order_item WHERE purchase_order_id = $1', [poId]);
    await call('POST', `/api/v1/purchase-orders/${poId}/receive`,
      { items: [{ purchase_order_item_id: item!.id, quantity: 10 }] },
      { token: manager().access, store: manager().storeId });

    const [after] = await sql<{ avg_cost_cents: number }>(
      'SELECT avg_cost_cents FROM product WHERE id = $1', [product!.id]);
    const expected = Math.round((product!.on_hand * product!.avg_cost_cents + 10 * newCost) / (product!.on_hand + 10));
    expect(after!.avg_cost_cents).toBe(expected);
  });
});

// ------------------------------------------------------------------ stocktakes

describe('stocktakes', () => {
  it('posts a counted variance as an adjusting movement', async () => {
    const [product] = await sql<{ id: string; on_hand: number }>(
      `SELECT p.id, sl.on_hand FROM product p JOIN stock_level sl ON sl.product_id = p.id
        WHERE sl.on_hand > 10 LIMIT 1`);
    const counted = product!.on_hand - 3;

    const opened = await call('POST', '/api/v1/inventory/stocktakes',
      { product_ids: [product!.id] },
      { token: manager().access, store: manager().storeId });
    expect(opened.status).toBe(201);

    const completed = await call('POST', `/api/v1/inventory/stocktakes/${opened.body.data.id}/complete`,
      { counts: [{ product_id: product!.id, counted_qty: counted }] },
      { token: manager().access, store: manager().storeId });
    expect(completed.status).toBe(200);
    expect(completed.body.data.posted).toBe(1);

    const [level] = await sql<{ on_hand: number }>(
      'SELECT on_hand FROM stock_level WHERE product_id = $1', [product!.id]);
    expect(level!.on_hand).toBe(counted);
  });
});

// ------------------------------------------------------------------------- AI

describe('AI layer', () => {
  it('generates forecasts and reorder suggestions from the store history', async () => {
    await call('POST', '/api/v1/ai/forecasts/run', {},
      { token: manager().access, store: manager().storeId });
    const { ran, failed } = await queue.drain();
    expect(failed).toBe(0);
    expect(ran).toBeGreaterThanOrEqual(2);

    const forecasts = await call('GET', '/api/v1/ai/forecasts', undefined,
      { token: manager().access, store: manager().storeId });
    expect(forecasts.status).toBe(200);
    expect(forecasts.body.data.length).toBeGreaterThan(0);
    for (const row of forecasts.body.data.slice(0, 20)) {
      expect(Number(row.lower_bound)).toBeLessThanOrEqual(Number(row.predicted_units));
      expect(Number(row.upper_bound)).toBeGreaterThanOrEqual(Number(row.predicted_units));
    }

    const suggestions = await call('GET', '/api/v1/ai/reorder-suggestions', undefined,
      { token: manager().access, store: manager().storeId });
    expect(suggestions.status).toBe(200);
    for (const row of suggestions.body.data) {
      expect(row.suggested_qty % (row.pack_size || 1)).toBe(0);
      expect(row.detail.reorderPoint).toBeGreaterThan(0);
    }
  }, 180_000);

  it('flags the injected below-cost sales as anomalies', async () => {
    const anomalies = await call('GET', '/api/v1/ai/anomalies', undefined,
      { token: manager().access, store: manager().storeId });
    expect(anomalies.status).toBe(200);
    const kinds = anomalies.body.data.map((a: any) => a.kind);
    expect(kinds).toContain('BELOW_COST_SALE');
    for (const a of anomalies.body.data) {
      expect(a.message.length).toBeGreaterThan(0);
      expect(typeof a.metric).toBe('object');
    }
  });

  it('answers from tool results and cites them, with no write capability', async () => {
    const res = await call('POST', '/api/v1/ai/chat',
      { message: 'Which items lost money recently?' },
      { token: manager().access, store: manager().storeId });
    expect(res.status).toBe(200);
    expect(res.body.data.tools.length).toBeGreaterThan(0);
    const toolIds = res.body.data.tools.map((t: any) => t.id);
    for (const id of toolIds) expect(res.body.data.answer).toContain(`[${id}]`);
    expect(res.body.data.tools.every((t: any) => t.tool.startsWith('get_') || t.tool.startsWith('lookup_'))).toBe(true);
  });

  it('refuses off-topic questions instead of inventing a number', async () => {
    const res = await call('POST', '/api/v1/ai/chat',
      { message: 'what is the capital of france' },
      { token: manager().access, store: manager().storeId });
    expect(res.status).toBe(200);
    expect(res.body.data.intent).toBe('lookup');
    expect(res.body.data.answer).toContain('only answer questions about this store');
  });

  it('redacts card numbers and phone numbers before anything is stored', async () => {
    const res = await call('POST', '/api/v1/ai/chat',
      { message: 'refund card 4111 1111 1111 1111 to 09171234567 please' },
      { token: manager().access, store: manager().storeId });
    expect(res.status).toBe(200);
    const stored = await sql<{ content: string }>(
      `SELECT content FROM ai_message WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at DESC LIMIT 1`,
      [res.body.data.conversation_id]);
    expect(stored[0]?.content).not.toContain('4111');
    expect(stored[0]?.content).not.toContain('09171234567');
    expect(stored[0]?.content).toContain('[redacted-card-number]');
  });

  it('converts reorder suggestions into a draft purchase order', async () => {
    const suggestions = await call('GET', '/api/v1/ai/reorder-suggestions', undefined,
      { token: manager().access, store: manager().storeId });
    const withSupplier = suggestions.body.data.filter((s: any) => s.supplier_id);
    if (withSupplier.length === 0) return;

    const converted = await call('POST', '/api/v1/ai/reorder-suggestions/to-purchase-order',
      { suggestion_ids: withSupplier.slice(0, 3).map((s: any) => s.id) },
      { token: manager().access, store: manager().storeId });
    expect(converted.status).toBe(201);
    expect(converted.body.data.purchase_order_ids.length).toBeGreaterThan(0);

    const [po] = await sql<{ status: string }>(
      'SELECT status FROM purchase_order WHERE id = $1', [converted.body.data.purchase_order_ids[0]]);
    expect(po!.status).toBe('DRAFT');
  });
});

// --------------------------------------------------------------------- reports

describe('reporting', () => {
  it('computes a period P&L from gross profit minus recorded expenses', async () => {
    const res = await call('GET', '/api/v1/reports/profit-loss?from=2000-01-01&to=2099-12-31', undefined,
      { token: owner().access, store: owner().storeId });
    expect(res.status).toBe(200);
    const pl = res.body.data;
    expect(pl.net_profit_cents).toBe(pl.gross_profit_cents - pl.total_expenses_cents);
    expect(pl.total_expenses_cents).toBeGreaterThan(0);
    expect(pl.cogs_cents).toBeGreaterThan(0);
  });

  it('denies the P&L to a cashier', async () => {
    const res = await call('GET', '/api/v1/reports/profit-loss', undefined,
      { token: cashier().access, store: cashier().storeId });
    expect(res.status).toBe(403);
  });

  it('buckets dead stock by age', async () => {
    const res = await call('GET', '/api/v1/reports/inventory-ageing', undefined,
      { token: manager().access, store: manager().storeId });
    expect(res.status).toBe(200);
    const b = res.body.data.buckets_cents;
    expect(typeof b.d0_30).toBe('number');
    expect(res.body.data.dead_stock_cents).toBe(b.d91_180 + b.d180_plus + b.never_sold);
  });

  it('shows today and month-to-date on the dashboard', async () => {
    const res = await call('GET', '/api/v1/reports/dashboard', undefined,
      { token: viewer().access, store: viewer().storeId });
    expect(res.status).toBe(200);
    expect(res.body.data.today).toBeDefined();
    expect(res.body.data.month_to_date.net_revenue_cents).toBeGreaterThanOrEqual(0);
    expect(res.body.data.alerts.low_stock_products).toBeGreaterThanOrEqual(0);
  });
});

describe('platform', () => {
  it('answers health and readiness probes without a token', async () => {
    expect((await call('GET', '/healthz')).status).toBe(200);
    const ready = await call('GET', '/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.driver).toBe('pglite');
    expect(ready.body.schema_revision).toBe('0001_init');
  });

  it('records an audit trail of state changes', async () => {
    const rows = await sql<{ actions: string[] }>(
      `SELECT array_agg(DISTINCT action) AS actions FROM audit_log WHERE store_id = $1`, [storeId]);
    const actions = rows[0]?.actions ?? [];
    expect(actions).toContain('sale.create');
    expect(actions).toContain('sale.void');
    expect(actions).toContain('po.receive');
  });
});

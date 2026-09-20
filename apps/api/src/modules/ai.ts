/**
 * The intelligence surface.
 *
 * Two independent subsystems: deterministic forecasting/reorder/anomaly
 * analytics, and an assistant that answers questions. The assistant has no
 * database connection and no write tools — it can only call the read-only,
 * permission-checked tools below, and every number it returns is tagged with
 * the tool result it came from.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { accepted, authenticate, asyncHandler, created, ok, param, parse, requirePermission, resolveStore } from '../shared/http.js';
import { audit } from '../shared/security.js';
import { notFound } from '../shared/errors.js';

export interface ToolResult {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  data: unknown;
}

type ToolFn = (args: Record<string, unknown>, storeId: string) => Promise<unknown>;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** The complete allow-list. Every entry is a SELECT scoped to one store. */
export function buildTools(ctx: AppContext): Record<string, ToolFn> {
  return {
    get_sales_summary: async (args, storeId) => {
      const from = String(args.from ?? daysAgo(30));
      const to = String(args.to ?? today());
      const rows = await ctx.db.query<{ sales: number; revenue: number; gross_profit: number }>(
        `SELECT count(*)::int AS sales,
                coalesce(sum(net_revenue_cents),0)::int AS revenue,
                coalesce(sum(gross_profit_cents),0)::int AS gross_profit
           FROM sale WHERE store_id = $1 AND status = 'ACTIVE'
             AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`,
        [storeId, from, to],
      );
      const r = rows.rows[0];
      return {
        from, to,
        sales: r?.sales ?? 0,
        net_revenue_cents: r?.revenue ?? 0,
        gross_profit_cents: r?.gross_profit ?? 0,
        gross_margin_pct: r && r.revenue > 0 ? Number(((r.gross_profit / r.revenue) * 100).toFixed(1)) : 0,
      };
    },

    get_product_performance: async (args, storeId) => {
      const limit = Math.min(50, Number(args.limit ?? 10));
      const rows = await ctx.db.query<{ sku: string; name: string; units: number; revenue: number; gross_profit: number }>(
        `SELECT p.sku, p.name,
                coalesce(sum(si.quantity - si.returned_qty),0)::int AS units,
                coalesce(sum((si.unit_price_cents * si.quantity) - si.discount_cents),0)::int AS revenue,
                coalesce(sum(si.gross_profit_cents),0)::int AS gross_profit
           FROM product p
           JOIN sale_item si ON si.product_id = p.id
           JOIN sale s ON s.id = si.sale_id AND s.status = 'ACTIVE'
          WHERE p.store_id = $1 AND s.occurred_at >= now() - interval '30 days'
          GROUP BY p.sku, p.name ORDER BY gross_profit ASC LIMIT $2`,
        [storeId, limit],
      );
      return {
        window_days: 30,
        sorted_by: 'gross_profit ascending (worst first)',
        items: rows.rows.map((r) => ({
          ...r,
          gross_margin_pct: r.revenue === 0 ? 0 : Number(((r.gross_profit / r.revenue) * 100).toFixed(1)),
        })),
      };
    },

    get_inventory_levels: async (args, storeId) => {
      const lowStockOnly = args.low_stock === true;
      const rows = await ctx.db.query<{ sku: string; name: string; on_hand: number; reorder_point: number; value_at_cost: number }>(
        `SELECT p.sku, p.name, coalesce(sl.on_hand,0)::int AS on_hand, p.reorder_point,
                (p.avg_cost_cents * coalesce(sl.on_hand,0))::int AS value_at_cost
           FROM product p LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
          WHERE p.store_id = $1 AND p.deleted_at IS NULL
            ${lowStockOnly ? 'AND coalesce(sl.on_hand,0) <= p.reorder_point' : ''}
          ORDER BY p.sku LIMIT 100`,
        [storeId],
      );
      return { low_stock_only: lowStockOnly, count: rows.rows.length, items: rows.rows };
    },

    get_profit_loss: async (args, storeId) => {
      const from = String(args.from ?? `${today().slice(0, 7)}-01`);
      const to = String(args.to ?? today());
      const [sales, expenses] = await Promise.all([
        ctx.db.query<{ revenue: number; gross_profit: number }>(
          `SELECT coalesce(sum(net_revenue_cents),0)::int AS revenue,
                  coalesce(sum(gross_profit_cents),0)::int AS gross_profit
             FROM sale WHERE store_id = $1 AND status = 'ACTIVE'
               AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`,
          [storeId, from, to],
        ),
        ctx.db.query<{ total: number }>(
          `SELECT coalesce(sum(amount_cents),0)::int AS total FROM expense
            WHERE store_id = $1 AND incurred_on BETWEEN $2::date AND $3::date`,
          [storeId, from, to],
        ),
      ]);
      const gross = sales.rows[0]?.gross_profit ?? 0;
      const exp = expenses.rows[0]?.total ?? 0;
      const revenue = sales.rows[0]?.revenue ?? 0;
      return {
        from, to,
        net_revenue_cents: revenue,
        gross_profit_cents: gross,
        expenses_cents: exp,
        net_profit_cents: gross - exp,
        net_margin_pct: revenue === 0 ? 0 : Number((((gross - exp) / revenue) * 100).toFixed(1)),
      };
    },

    get_inventory_ageing: async (_args, storeId) => {
      const rows = await ctx.db.query<{ bucket: string; value: number }>(
        `WITH last_sale AS (
           SELECT product_id, max(created_at) AS at FROM stock_movement
            WHERE store_id = $1 AND reason = 'SALE' GROUP BY product_id)
         SELECT CASE
                  WHEN ls.at IS NULL THEN 'never_sold'
                  WHEN (now() - ls.at) <= interval '30 days' THEN '0-30'
                  WHEN (now() - ls.at) <= interval '60 days' THEN '31-60'
                  WHEN (now() - ls.at) <= interval '90 days' THEN '61-90'
                  ELSE '90_plus' END AS bucket,
                coalesce(sum(p.avg_cost_cents * coalesce(sl.on_hand,0)),0)::int AS value
           FROM product p
           LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
           LEFT JOIN last_sale ls ON ls.product_id = p.id
          WHERE p.store_id = $1 AND p.deleted_at IS NULL AND coalesce(sl.on_hand,0) > 0
          GROUP BY 1`,
        [storeId],
      );
      return { buckets_cents: Object.fromEntries(rows.rows.map((r) => [r.bucket, r.value])) };
    },

    get_forecast: async (args, storeId) => {
      const horizon = Math.min(28, Number(args.horizon ?? 7));
      const rows = await ctx.db.query(
        `SELECT p.sku, p.name, sum(f.predicted_units)::numeric(12,2) AS predicted_units,
                max(f.model) AS model
           FROM forecast f JOIN product p ON p.id = f.product_id
          WHERE f.store_id = $1
            AND f.horizon_date <= (now() AT TIME ZONE 'UTC')::date + $2::int
            AND f.horizon_date >= (now() AT TIME ZONE 'UTC')::date
          GROUP BY p.sku, p.name ORDER BY predicted_units DESC LIMIT 20`,
        [storeId, horizon],
      );
      return { horizon_days: horizon, items: rows.rows };
    },

    get_reorder_suggestions: async (args, storeId) => {
      const limit = Math.min(50, Number(args.limit ?? 10));
      const rows = await ctx.db.query(
        `SELECT rs.id, p.sku, p.name, rs.suggested_qty, rs.reorder_point, rs.on_hand,
                rs.on_order, rs.days_of_cover, rs.detail
           FROM reorder_suggestion rs JOIN product p ON p.id = rs.product_id
          WHERE rs.store_id = $1 AND rs.status = 'SUGGESTED'
          ORDER BY rs.days_of_cover ASC NULLS FIRST, rs.created_at DESC LIMIT $2`,
        [storeId, limit],
      );
      return { count: rows.rows.length, items: rows.rows };
    },

    get_anomalies: async (args, storeId) => {
      const unresolvedOnly = args.unresolved_only !== false;
      const rows = await ctx.db.query(
        `SELECT id, kind, severity, message, metric, status, created_at FROM anomaly
          WHERE store_id = $1 ${unresolvedOnly ? `AND status = 'OPEN'` : ''}
          ORDER BY created_at DESC LIMIT 25`,
        [storeId],
      );
      return { count: rows.rows.length, items: rows.rows };
    },

    lookup_product: async (args, storeId) => {
      const q = `%${String(args.query ?? '')}%`;
      const rows = await ctx.db.query(
        `SELECT p.id, p.sku, p.name, p.selling_price_cents, p.avg_cost_cents,
                coalesce(sl.on_hand,0)::int AS on_hand
           FROM product p LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
          WHERE p.store_id = $1 AND (p.sku ILIKE $2 OR p.name ILIKE $2 OR p.barcode ILIKE $2)
            AND p.deleted_at IS NULL LIMIT 10`,
        [storeId, q],
      );
      return { items: rows.rows };
    },
  };
}

// ---------------------------------------------------------------- assistant

interface Intent {
  name: string;
  tools: { tool: string; args: Record<string, unknown> }[];
  template: (results: ToolResult[]) => string;
}

const money = (cents: number): string => `₱${(cents / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type Json = Record<string, any>;

function asRecord(value: unknown): Json {
  return (value ?? {}) as Json;
}

/**
 * Intent routing is keyword-based and fully deterministic. That is deliberate:
 * it keeps the assistant testable and free of network dependency, and it means
 * the same question always produces the same tool calls.
 */
export function routeIntent(message: string): Intent {
  const q = message.toLowerCase();

  if (/(lose|lost|losing) money|negative margin|worst|unprofitable/.test(q)) {
    return {
      name: 'margin_losers',
      tools: [{ tool: 'get_product_performance', args: { limit: 5 } }],
      template: ([t]) => {
        const data = asRecord(t?.data);
        const items = (data.items ?? []) as any[];
        if (items.length === 0) return `No sales recorded in the last 30 days, so there is nothing to rank yet [${t?.id}].`;
        const losers = items.filter((i) => i.gross_profit < 0);
        if (losers.length === 0) {
          return `Nothing lost money in the last 30 days. The weakest performer was ${items[0]?.sku} (${items[0]?.name}) at ${money(items[0]?.gross_profit ?? 0)} gross profit, a ${items[0]?.gross_margin_pct}% margin [${t?.id}].`;
        }
        return [
          `These items lost money over the last 30 days [${t?.id}]:`,
          ...losers.map((i) => `• ${i.sku} — ${i.name}: ${money(i.gross_profit)} gross profit (${i.gross_margin_pct}% margin) on ${i.units} units`),
        ].join('\n');
      },
    };
  }

  if (/profit|p&l|net|expenses|how did.*(month|week)|earning/.test(q)) {
    return {
      name: 'profit_loss',
      tools: [{ tool: 'get_profit_loss', args: {} }],
      template: ([t]) => {
        const d = asRecord(t?.data);
        return [
          `Profit and loss for ${d.from} to ${d.to} [${t?.id}]:`,
          `• Net revenue: ${money(d.net_revenue_cents ?? 0)}`,
          `• Gross profit: ${money(d.gross_profit_cents ?? 0)}`,
          `• Operating expenses: ${money(d.expenses_cents ?? 0)}`,
          `• Net profit: ${money(d.net_profit_cents ?? 0)} (${d.net_margin_pct ?? 0}% of revenue)`,
        ].join('\n');
      },
    };
  }

  if (/reorder|restock|buy more|purchase|out of stock|running low|order/.test(q)) {
    return {
      name: 'reorder',
      tools: [{ tool: 'get_reorder_suggestions', args: { limit: 8 } }],
      template: ([t]) => {
        const d = asRecord(t?.data);
        const items = (d.items ?? []) as any[];
        if (items.length === 0) return `Nothing needs reordering right now — every SKU is above its reorder point [${t?.id}].`;
        return [
          `${items.length} item(s) are at or below their reorder point [${t?.id}]:`,
          ...items.map((i) => `• ${i.sku} — ${i.name}: order ${i.suggested_qty}, on hand ${i.on_hand}, on order ${i.on_order}, ${i.days_of_cover ?? '∞'} days of cover`),
        ].join('\n');
      },
    };
  }

  if (/forecast|expect|demand|next week|predict/.test(q)) {
    return {
      name: 'forecast',
      tools: [{ tool: 'get_forecast', args: { horizon: 7 } }],
      template: ([t]) => {
        const d = asRecord(t?.data);
        const items = (d.items ?? []) as any[];
        if (items.length === 0) return `No forecasts have been generated yet. Run POST /api/v1/ai/forecasts/run first [${t?.id}].`;
        return [
          `Expected demand over the next ${d.horizon_days} days, highest first [${t?.id}]:`,
          ...items.slice(0, 8).map((i) => `• ${i.sku} — ${i.name}: ~${Number(i.predicted_units).toFixed(1)} units (${i.model})`),
        ].join('\n');
      },
    };
  }

  if (/anomal|shrink|theft|suspicious|flag|unusual/.test(q)) {
    return {
      name: 'anomalies',
      tools: [{ tool: 'get_anomalies', args: { unresolved_only: true } }],
      template: ([t]) => {
        const d = asRecord(t?.data);
        const items = (d.items ?? []) as any[];
        if (items.length === 0) return `No open anomalies. Nothing has crossed a screening threshold [${t?.id}].`;
        return [
          `${items.length} open finding(s) [${t?.id}]:`,
          ...items.slice(0, 8).map((i) => `• [${i.severity}] ${i.kind}: ${i.message}`),
        ].join('\n');
      },
    };
  }

  if (/dead stock|ageing|aging|not moving|stale|obsolete/.test(q)) {
    return {
      name: 'ageing',
      tools: [{ tool: 'get_inventory_ageing', args: {} }],
      template: ([t]) => {
        const d = asRecord(asRecord(t?.data).buckets_cents);
        return [
          `Inventory value by age [${t?.id}]:`,
          `• Sold within 30 days: ${money(Number(d['0-30'] ?? 0))}`,
          `• 31–60 days: ${money(Number(d['31-60'] ?? 0))}`,
          `• 61–90 days: ${money(Number(d['61-90'] ?? 0))}`,
          `• Over 90 days: ${money(Number(d['90_plus'] ?? 0))}`,
          `• Never sold: ${money(Number(d.never_sold ?? 0))}`,
        ].join('\n');
      },
    };
  }

  if (/stock|inventory|on hand|how many|valuation/.test(q)) {
    return {
      name: 'inventory',
      tools: [{ tool: 'get_inventory_levels', args: { low_stock: /low|short|reorder/.test(q) } }],
      template: ([t]) => {
        const d = asRecord(t?.data);
        const items = (d.items ?? []) as any[];
        const value = items.reduce((s: number, i: any) => s + (i.value_at_cost ?? 0), 0);
        return [
          `${d.low_stock_only ? 'Low-stock items' : 'Stock on hand'}: ${d.count} SKU(s), ${money(value)} at cost [${t?.id}].`,
          ...items.slice(0, 6).map((i) => `• ${i.sku} — ${i.name}: ${i.on_hand} on hand (reorder point ${i.reorder_point})`),
        ].join('\n');
      },
    };
  }

  if (/sale|sold|revenue|today|performance|best|top/.test(q)) {
    return {
      name: 'sales',
      tools: [
        { tool: 'get_sales_summary', args: { from: daysAgo(30), to: today() } },
        { tool: 'get_product_performance', args: { limit: 5 } },
      ],
      template: ([summary, perf]) => {
        const s = asRecord(summary?.data);
        const p = asRecord(perf?.data);
        return [
          `Over ${s.from} to ${s.to} [${summary?.id}]: ${s.sales} sales, ${money(s.net_revenue_cents ?? 0)} net revenue, ${money(s.gross_profit_cents ?? 0)} gross profit (${s.gross_margin_pct ?? 0}% margin).`,
          `Weakest performers by gross profit [${perf?.id}]:`,
          ...((p.items ?? []) as any[]).slice(0, 5).map((i) => `• ${i.sku} — ${i.name}: ${money(i.gross_profit)} (${i.gross_margin_pct}%)`),
        ].join('\n');
      },
    };
  }

  return {
    name: 'lookup',
    tools: [{ tool: 'lookup_product', args: { query: message.trim() } }],
    template: ([t]) => {
      const items = (asRecord(t?.data).items ?? []) as any[];
      if (items.length === 0) {
        return `I could not match that to a product, and I only answer questions about this store's sales, stock and profitability. Try "which items lost money this month?" or "what should I reorder?" [${t?.id}].`;
      }
      return [
        `Matching products [${t?.id}]:`,
        ...items.map((i) => `• ${i.sku} — ${i.name}: ${money(i.selling_price_cents)}, cost ${money(i.avg_cost_cents)}, ${i.on_hand} on hand`),
      ].join('\n');
    },
  };
}

export interface AssistantTurn {
  conversationId: string;
  answer: string;
  intent: string;
  tools: ToolResult[];
  tokensIn: number;
  tokensOut: number;
}

/** Redact anything that looks like a payment instrument before it goes anywhere. */
export function redact(input: string): string {
  return input
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[redacted-card-number]')
    .replace(/\b09\d{9}\b/g, '[redacted-phone]')
    .slice(0, 2000);
}

export async function answerQuestion(
  ctx: AppContext,
  storeId: string,
  userId: string,
  message: string,
  conversationId?: string,
): Promise<AssistantTurn> {
  const clean = redact(message);
  const tools = buildTools(ctx);
  const intent = routeIntent(clean);

  const results: ToolResult[] = [];
  for (const [index, call] of intent.tools.entries()) {
    const fn = tools[call.tool];
    if (!fn) continue;
    const data = await fn(call.args, storeId);
    results.push({ id: `t${index + 1}`, tool: call.tool, args: call.args, data });
  }

  const answer = intent.template(results);
  const tokensIn = Math.ceil(clean.length / 4);
  const tokensOut = Math.ceil(answer.length / 4);

  const convId = conversationId ?? await ctx.db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      'INSERT INTO ai_conversation (store_id, user_id, title) VALUES ($1,$2,$3) RETURNING id',
      [storeId, userId, clean.slice(0, 80)],
    );
    return inserted.rows[0]?.id ?? '';
  });

  await ctx.db.query(
    `INSERT INTO ai_message (conversation_id, role, content, tool_calls, provider, tokens_in, tokens_out)
     VALUES ($1,'user',$2,'[]','local',0,0)`,
    [convId, clean],
  );
  await ctx.db.query(
    `INSERT INTO ai_message (conversation_id, role, content, tool_calls, provider, tokens_in, tokens_out)
     VALUES ($1,'assistant',$2,$3::jsonb,'local',$4,$5)`,
    [convId, answer, JSON.stringify(results.map((r) => ({ id: r.id, tool: r.tool, args: r.args }))), tokensIn, tokensOut],
  );

  return { conversationId: convId, answer, intent: intent.name, tools: results, tokensIn, tokensOut };
}

// ---------------------------------------------------------------- routes

export function aiRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(authenticate(ctx), resolveStore(ctx));

  r.get('/forecasts', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT p.sku, p.name, f.horizon_date, f.predicted_units, f.lower_bound, f.upper_bound,
              f.model, f.mape, f.generated_at
         FROM forecast f JOIN product p ON p.id = f.product_id
        WHERE f.store_id = $1
          AND ($2::text IS NULL OR p.sku = $2)
        ORDER BY p.sku, f.horizon_date LIMIT 500`,
      [req.auth.storeId, typeof req.query.sku === 'string' ? req.query.sku : null],
    );
    ok(res, rows.rows);
  }));

  r.post('/forecasts/run', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    await ctx.enqueue('forecast.refresh', { store_id: req.auth.storeId });
    await ctx.enqueue('anomaly.scan', { store_id: req.auth.storeId });
    accepted(res, { queued: ['forecast.refresh', 'anomaly.scan'], store_id: req.auth.storeId });
  }));

  r.get('/reorder-suggestions', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT rs.*, p.sku, p.name, p.pack_size, s.name AS supplier_name, s.id AS supplier_id
         FROM reorder_suggestion rs
         JOIN product p ON p.id = rs.product_id
         LEFT JOIN supplier s ON s.id = p.supplier_id
        WHERE rs.store_id = $1 AND rs.status = 'SUGGESTED'
        ORDER BY rs.days_of_cover ASC NULLS FIRST, rs.created_at DESC LIMIT 100`,
      [req.auth.storeId],
    );
    ok(res, rows.rows);
  }));

  r.post('/reorder-suggestions/to-purchase-order', requirePermission('purchasing:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ suggestion_ids: z.array(z.string().min(1)).min(1) }), req.body);

    const result = await ctx.db.transaction(async (tx) => {
      const rows = await tx.query<{
        id: string; product_id: string; suggested_qty: number; supplier_id: string | null;
      }>(
        `SELECT rs.id, rs.product_id, rs.suggested_qty, p.supplier_id
           FROM reorder_suggestion rs JOIN product p ON p.id = rs.product_id
          WHERE rs.store_id = $1 AND rs.id = ANY($2::uuid[]) AND rs.status = 'SUGGESTED'`,
        [req.auth.storeId, body.suggestion_ids],
      );
      if (rows.rows.length === 0) throw notFound('Reorder suggestion');

      // Group by supplier: one purchase order per vendor.
      const bySupplier = new Map<string, typeof rows.rows>();
      for (const row of rows.rows) {
        if (!row.supplier_id) continue;
        const list = bySupplier.get(row.supplier_id) ?? [];
        list.push(row);
        bySupplier.set(row.supplier_id, list);
      }

      const orders: string[] = [];
      for (const [supplierId, items] of bySupplier) {
        const year = new Date().getUTCFullYear();
        const seq = await tx.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM purchase_order WHERE store_id = $1 AND reference LIKE $2',
          [req.auth.storeId, `PO-${year}-%`],
        );
        const reference = `PO-${year}-${String((seq.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`;
        let total = 0;
        for (const item of items) {
          const cost = await tx.query<{ avg_cost_cents: number }>(
            'SELECT avg_cost_cents FROM product WHERE id = $1', [item.product_id]);
          total += item.suggested_qty * (cost.rows[0]?.avg_cost_cents ?? 0);
        }
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO purchase_order (store_id, supplier_id, reference, created_by, note, total_cost_cents)
           VALUES ($1,$2,$3,$4,'Generated from reorder suggestions',$5) RETURNING id`,
          [req.auth.storeId, supplierId, reference, req.auth.userId, total],
        );
        const poId = inserted.rows[0]?.id ?? '';
        for (const item of items) {
          const cost = await tx.query<{ avg_cost_cents: number }>(
            'SELECT avg_cost_cents FROM product WHERE id = $1', [item.product_id]);
          await tx.query(
            `INSERT INTO purchase_order_item (purchase_order_id, product_id, quantity, unit_cost_cents)
             VALUES ($1,$2,$3,$4)`,
            [poId, item.product_id, item.suggested_qty, cost.rows[0]?.avg_cost_cents ?? 0],
          );
          await tx.query(
            `UPDATE reorder_suggestion SET status = 'ORDERED', resolved_at = now() WHERE id = $1`,
            [item.id],
          );
        }
        orders.push(poId);
      }

      await audit(tx, {
        storeId: req.auth.storeId, actorId: req.auth.userId, action: 'po.from_suggestions',
        entity: 'purchase_order', changes: { orders: orders.length, suggestions: rows.rows.length },
      });
      return { purchase_order_ids: orders, suggestions_converted: rows.rows.length };
    });
    created(res, result);
  }));

  r.get('/anomalies', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT * FROM anomaly WHERE store_id = $1
         AND ($2::text = 'all' OR status = $2::text)
        ORDER BY created_at DESC LIMIT 200`,
      [req.auth.storeId, String(req.query.status ?? 'OPEN')],
    );
    ok(res, rows.rows);
  }));

  r.post('/anomalies/:id/resolve', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ resolution: z.string().min(3) }), req.body);
    const updated = await ctx.db.query<{ id: string }>(
      `UPDATE anomaly SET status = 'RESOLVED', resolution = $1, resolved_at = now()
        WHERE id = $2 AND store_id = $3 RETURNING id`,
      [body.resolution, param(req, 'id'), req.auth.storeId],
    );
    if (!updated.rows[0]) throw notFound('Anomaly');
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'anomaly.resolve',
      entity: 'anomaly', entityId: param(req, 'id'), changes: { resolution: body.resolution },
    });
    ok(res, { id: param(req, 'id'), status: 'RESOLVED' });
  }));

  r.post('/chat', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({
      message: z.string().min(1).max(2000),
      conversation_id: z.string().optional().nullable(),
    }), req.body);
    const turn = await answerQuestion(ctx, req.auth.storeId, req.auth.userId, body.message, body.conversation_id ?? undefined);
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'ai.chat',
      entity: 'ai_conversation', entityId: turn.conversationId,
      changes: { intent: turn.intent, tools: turn.tools.map((t) => t.tool) },
    });
    ok(res, {
      conversation_id: turn.conversationId,
      answer: turn.answer,
      intent: turn.intent,
      provider: 'local',
      tools: turn.tools,
      tokens_in: turn.tokensIn,
      tokens_out: turn.tokensOut,
    });
  }));

  r.get('/conversations', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      'SELECT id, title, created_at FROM ai_conversation WHERE store_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.auth.storeId],
    );
    ok(res, rows.rows);
  }));

  r.get('/conversations/:id', requirePermission('ai:use'), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT role, content, tool_calls, provider, tokens_in, tokens_out, created_at
         FROM ai_message WHERE conversation_id = $1 ORDER BY created_at`,
      [param(req, 'id')],
    );
    ok(res, rows.rows);
  }));

  return r;
}

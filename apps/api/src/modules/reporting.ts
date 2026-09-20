import { Router } from 'express';
import { z } from 'zod';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { authenticate, asyncHandler, created, ok, parse, requirePermission, resolveStore } from '../shared/http.js';
import { audit } from '../shared/security.js';
import { inventoryTurnover } from '../domain/costing.js';

/** One decimal place: a margin is not a 15-significant-digit number. */
function round1(value: number): number {
  return Number(value.toFixed(1));
}

function range(query: Record<string, unknown>): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  return {
    from: String(query.from ?? monthStart),
    to: String(query.to ?? today),
  };
}

export function reportingRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(authenticate(ctx), resolveStore(ctx));

  // -------------------------------------------------------------- expenses
  r.get('/expense-categories', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query('SELECT * FROM expense_category WHERE store_id = $1 ORDER BY name', [req.auth.storeId]);
    ok(res, rows.rows);
  }));

  r.post('/expense-categories', requirePermission('expenses:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ name: z.string().min(1) }), req.body);
    const inserted = await ctx.db.query<{ id: string }>(
      'INSERT INTO expense_category (store_id, name) VALUES ($1,$2) RETURNING id',
      [req.auth.storeId, body.name],
    );
    created(res, { id: inserted.rows[0]?.id, ...body });
  }));

  r.get('/expenses', asyncHandler<AuthedRequest>(async (req, res) => {
    const { from, to } = range(req.query as Record<string, unknown>);
    const rows = await ctx.db.query(
      `SELECT e.*, c.name AS category_name FROM expense e
         LEFT JOIN expense_category c ON c.id = e.category_id
        WHERE e.store_id = $1 AND e.incurred_on BETWEEN $2::date AND $3::date
        ORDER BY e.incurred_on DESC`,
      [req.auth.storeId, from, to],
    );
    ok(res, rows.rows);
  }));

  r.post('/expenses', requirePermission('expenses:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({
      category_id: z.string().optional().nullable(),
      amount_cents: z.number().int().positive(),
      incurred_on: z.string().optional(),
      note: z.string().optional().nullable(),
    }), req.body);
    const inserted = await ctx.db.query<{ id: string }>(
      `INSERT INTO expense (store_id, category_id, amount_cents, incurred_on, note, created_by)
       VALUES ($1,$2,$3,coalesce($4::date, CURRENT_DATE),$5,$6) RETURNING id`,
      [req.auth.storeId, body.category_id ?? null, body.amount_cents, body.incurred_on ?? null,
       body.note ?? null, req.auth.userId],
    );
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'expense.create',
      entity: 'expense', entityId: inserted.rows[0]?.id,
      changes: { amount_cents: body.amount_cents },
    });
    created(res, { id: inserted.rows[0]?.id, ...body });
  }));

  // --------------------------------------------------------------- reports
  r.get('/reports/dashboard', asyncHandler<AuthedRequest>(async (req, res) => {
    const storeId = req.auth.storeId;
    const [today, month, top, lowStock, anomalies] = await Promise.all([
      ctx.db.query<{ sales: number; revenue: number; gross_profit: number }>(
        `SELECT count(*)::int AS sales,
                coalesce(sum(net_revenue_cents),0)::int AS revenue,
                coalesce(sum(gross_profit_cents),0)::int AS gross_profit
           FROM sale
          WHERE store_id = $1 AND status = 'ACTIVE'
            AND (occurred_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`,
        [storeId],
      ),
      ctx.db.query<{ revenue: number; gross_profit: number; expenses: number }>(
        `SELECT
           coalesce((SELECT sum(net_revenue_cents) FROM sale
                      WHERE store_id = $1 AND status = 'ACTIVE'
                        AND occurred_at >= date_trunc('month', now())), 0)::int AS revenue,
           coalesce((SELECT sum(gross_profit_cents) FROM sale
                      WHERE store_id = $1 AND status = 'ACTIVE'
                        AND occurred_at >= date_trunc('month', now())), 0)::int AS gross_profit,
           coalesce((SELECT sum(amount_cents) FROM expense
                      WHERE store_id = $1
                        AND incurred_on >= date_trunc('month', now())::date), 0)::int AS expenses`,
        [storeId],
      ),
      ctx.db.query(
        `SELECT p.sku, p.name, sum(si.quantity)::int AS units,
                sum(si.gross_profit_cents)::int AS gross_profit_cents
           FROM sale_item si
           JOIN sale s ON s.id = si.sale_id AND s.status = 'ACTIVE'
           JOIN product p ON p.id = si.product_id
          WHERE s.store_id = $1 AND s.occurred_at >= now() - interval '30 days'
          GROUP BY p.sku, p.name
          ORDER BY units DESC LIMIT 5`,
        [storeId],
      ),
      ctx.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM product p
           LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
          WHERE p.store_id = $1 AND p.deleted_at IS NULL AND coalesce(sl.on_hand,0) <= p.reorder_point`,
        [storeId],
      ),
      ctx.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM anomaly WHERE store_id = $1 AND status = 'OPEN'`,
        [storeId],
      ),
    ]);

    const t = today.rows[0];
    const m = month.rows[0];
    const marginPct = (gp: number, rev: number) => (rev === 0 ? 0 : round1((gp / rev) * 100));

    ok(res, {
      today: {
        sales_count: t?.sales ?? 0,
        net_revenue_cents: t?.revenue ?? 0,
        gross_profit_cents: t?.gross_profit ?? 0,
        gross_margin_pct: marginPct(t?.gross_profit ?? 0, t?.revenue ?? 0),
      },
      month_to_date: {
        net_revenue_cents: m?.revenue ?? 0,
        gross_profit_cents: m?.gross_profit ?? 0,
        gross_margin_pct: marginPct(m?.gross_profit ?? 0, m?.revenue ?? 0),
        expenses_cents: m?.expenses ?? 0,
        net_profit_cents: (m?.gross_profit ?? 0) - (m?.expenses ?? 0),
      },
      top_movers_30d: top.rows,
      alerts: {
        low_stock_products: lowStock.rows[0]?.n ?? 0,
        open_anomalies: anomalies.rows[0]?.n ?? 0,
      },
    });
  }));

  r.get('/reports/sales-summary', asyncHandler<AuthedRequest>(async (req, res) => {
    const { from, to } = range(req.query as Record<string, unknown>);
    const groupBy = String(req.query.group_by ?? 'day');
    const trunc = groupBy === 'month' ? 'month' : groupBy === 'week' ? 'week' : 'day';
    const rows = await ctx.db.query<{ period: string; sales: number; net_revenue_cents: number; tax_cents: number; gross_profit_cents: number }>(
      `SELECT to_char(date_trunc('${trunc}', occurred_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS period,
              count(*)::int AS sales,
              coalesce(sum(net_revenue_cents),0)::int AS net_revenue_cents,
              coalesce(sum(tax_cents),0)::int AS tax_cents,
              coalesce(sum(gross_profit_cents),0)::int AS gross_profit_cents
         FROM sale
        WHERE store_id = $1 AND status = 'ACTIVE'
          AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
        GROUP BY 1 ORDER BY 1`,
      [req.auth.storeId, from, to],
    );
    ok(res, rows.rows.map((row: { period: string; sales: number; net_revenue_cents: number; tax_cents: number; gross_profit_cents: number }) => ({
      ...row,
      gross_margin_pct: row.net_revenue_cents === 0 ? 0 : round1((row.gross_profit_cents / row.net_revenue_cents) * 100),
    })));
  }));

  /** Gross to net: the answer to "how did this period go?". */
  r.get('/reports/profit-loss', requirePermission('reports:all'), asyncHandler<AuthedRequest>(async (req, res) => {
    const { from, to } = range(req.query as Record<string, unknown>);
    const [sales, expenses, cogs] = await Promise.all([
      ctx.db.query<{ net_revenue: number; tax: number; gross_profit: number }>(
        `SELECT coalesce(sum(net_revenue_cents),0)::int AS net_revenue,
                coalesce(sum(tax_cents),0)::int AS tax,
                coalesce(sum(gross_profit_cents),0)::int AS gross_profit
           FROM sale
          WHERE store_id = $1 AND status = 'ACTIVE'
            AND (occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`,
        [req.auth.storeId, from, to],
      ),
      ctx.db.query<{ category_name: string | null; amount_cents: number }>(
        `SELECT c.name AS category_name, coalesce(sum(e.amount_cents),0)::int AS amount_cents
           FROM expense e LEFT JOIN expense_category c ON c.id = e.category_id
          WHERE e.store_id = $1 AND e.incurred_on BETWEEN $2::date AND $3::date
          GROUP BY c.name ORDER BY 2 DESC`,
        [req.auth.storeId, from, to],
      ),
      ctx.db.query<{ cogs: number }>(
        `SELECT coalesce(sum(si.unit_cost_cents * (si.quantity - si.returned_qty)),0)::int AS cogs
           FROM sale_item si JOIN sale s ON s.id = si.sale_id
          WHERE s.store_id = $1 AND s.status = 'ACTIVE'
            AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`,
        [req.auth.storeId, from, to],
      ),
    ]);

    const netRevenue = sales.rows[0]?.net_revenue ?? 0;
    const grossProfit = sales.rows[0]?.gross_profit ?? 0;
    const totalExpenses = expenses.rows.reduce((s, e) => s + e.amount_cents, 0);

    ok(res, {
      from, to,
      net_revenue_cents: netRevenue,
      cogs_cents: cogs.rows[0]?.cogs ?? 0,
      gross_profit_cents: grossProfit,
      gross_margin_pct: netRevenue === 0 ? 0 : round1((grossProfit / netRevenue) * 100),
      expenses: expenses.rows,
      total_expenses_cents: totalExpenses,
      net_profit_cents: grossProfit - totalExpenses,
      net_margin_pct: netRevenue === 0 ? 0 : round1(((grossProfit - totalExpenses) / netRevenue) * 100),
    });
  }));

  r.get('/reports/product-performance', asyncHandler<AuthedRequest>(async (req, res) => {
    const { from, to } = range(req.query as Record<string, unknown>);
    const rows = await ctx.db.query<{
      sku: string; name: string; units: number; revenue: number; gross_profit: number;
    }>(
      `SELECT p.sku, p.name,
              coalesce(sum(si.quantity - si.returned_qty),0)::int AS units,
              coalesce(sum((si.unit_price_cents * si.quantity) - si.discount_cents),0)::int AS revenue,
              coalesce(sum(si.gross_profit_cents),0)::int AS gross_profit
         FROM product p
         LEFT JOIN sale_item si ON si.product_id = p.id
         LEFT JOIN sale s ON s.id = si.sale_id AND s.status = 'ACTIVE'
              AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date
        WHERE p.store_id = $1 AND p.deleted_at IS NULL
        GROUP BY p.sku, p.name
        ORDER BY revenue DESC`,
      [req.auth.storeId, from, to],
    );
    ok(res, rows.rows.map((row) => ({
      ...row,
      gross_margin_pct: row.revenue === 0 ? 0 : round1((row.gross_profit / row.revenue) * 100),
    })));
  }));

  /** Capital trapped in stock that is not moving, bucketed by age. */
  r.get('/reports/inventory-ageing', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query<{ sku: string; name: string; on_hand: number; value_at_cost: number; days_since_sale: number | null }>(
      `WITH last_sale AS (
         SELECT m.product_id, max(m.created_at) AS last_sold_at
           FROM stock_movement m
          WHERE m.store_id = $1 AND m.reason = 'SALE'
          GROUP BY m.product_id
       )
       SELECT p.sku, p.name,
              coalesce(sl.on_hand,0)::int AS on_hand,
              (p.avg_cost_cents * coalesce(sl.on_hand,0))::int AS value_at_cost,
              CASE WHEN ls.last_sold_at IS NULL THEN NULL
                   ELSE floor(EXTRACT(EPOCH FROM (now() - ls.last_sold_at)) / 86400)::int END AS days_since_sale
         FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
         LEFT JOIN last_sale ls ON ls.product_id = p.id
        WHERE p.store_id = $1 AND p.deleted_at IS NULL AND coalesce(sl.on_hand,0) > 0`,
      [req.auth.storeId],
    );

    const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d91_180: 0, d180_plus: 0, never_sold: 0 };
    for (const row of rows.rows) {
      const d = row.days_since_sale;
      if (d === null) buckets.never_sold += row.value_at_cost;
      else if (d <= 30) buckets.d0_30 += row.value_at_cost;
      else if (d <= 60) buckets.d31_60 += row.value_at_cost;
      else if (d <= 90) buckets.d61_90 += row.value_at_cost;
      else if (d <= 180) buckets.d91_180 += row.value_at_cost;
      else buckets.d180_plus += row.value_at_cost;
    }

    ok(res, {
      buckets_cents: buckets,
      dead_stock_cents: buckets.d91_180 + buckets.d180_plus + buckets.never_sold,
      items: rows.rows.sort((a, b) => b.value_at_cost - a.value_at_cost).slice(0, 100),
    });
  }));

  r.get('/reports/turnover', requirePermission('reports:all'), asyncHandler<AuthedRequest>(async (req, res) => {
    const { from, to } = range(req.query as Record<string, unknown>);
    const [cogs, valuation] = await Promise.all([
      ctx.db.query<{ cogs: number }>(
        `SELECT coalesce(sum(si.unit_cost_cents * (si.quantity - si.returned_qty)),0)::int AS cogs
           FROM sale_item si JOIN sale s ON s.id = si.sale_id
          WHERE s.store_id = $1 AND s.status = 'ACTIVE'
            AND (s.occurred_at AT TIME ZONE 'UTC')::date BETWEEN $2::date AND $3::date`,
        [req.auth.storeId, from, to],
      ),
      ctx.db.query<{ value: number }>(
        `SELECT coalesce(sum(p.avg_cost_cents * coalesce(sl.on_hand,0)),0)::int AS value
           FROM product p LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
          WHERE p.store_id = $1 AND p.deleted_at IS NULL`,
        [req.auth.storeId],
      ),
    ]);
    const turnover = inventoryTurnover(cogs.rows[0]?.cogs ?? 0, valuation.rows[0]?.value ?? 0);
    ok(res, {
      from, to,
      cogs_cents: cogs.rows[0]?.cogs ?? 0,
      inventory_value_at_cost_cents: valuation.rows[0]?.value ?? 0,
      inventory_turnover: Number(turnover.toFixed(2)),
      note: 'Average inventory value is approximated by the current valuation.',
    });
  }));

  return r;
}

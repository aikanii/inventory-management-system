import { Router } from 'express';
import { z } from 'zod';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { authenticate, asyncHandler, created, ok, pageMeta, param, parse, parsePage, requirePermission, resolveStore } from '../shared/http.js';
import { createSale, loadSale, returnSale, voidSale } from '../services/sales.js';
import { notFound } from '../shared/errors.js';

const saleBody = z.object({
  items: z.array(z.object({
    product_id: z.string().min(1),
    quantity: z.number().int().positive(),
    unit_price_cents: z.number().int().min(0).optional(),
    discount_cents: z.number().int().min(0).default(0),
  })).min(1),
  tenders: z.array(z.object({
    method: z.enum(['CASH', 'EWALLET', 'CARD', 'CREDIT']),
    amount_cents: z.number().int().positive(),
  })).min(1),
  customer_id: z.string().optional().nullable(),
  occurred_at: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
  allow_below_cost: z.boolean().default(false),
});

export function salesRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(authenticate(ctx), resolveStore(ctx));

  r.post('/sales', requirePermission('sales:create'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(saleBody, req.body);
    const idempotencyKey = req.header('idempotency-key') ?? null;

    const sale = await createSale(ctx.db, {
      storeId: req.auth.storeId,
      cashierId: req.auth.userId,
      idempotencyKey,
      customerId: body.customer_id ?? null,
      occurredAt: body.occurred_at ?? null,
      note: body.note ?? null,
      allowBelowCost: body.allow_below_cost,
      items: body.items.map((i) => ({
        productId: i.product_id,
        quantity: i.quantity,
        unitPriceCents: i.unit_price_cents,
        discountCents: i.discount_cents,
      })),
      tenders: body.tenders.map((t) => ({ method: t.method, amountCents: t.amount_cents })),
    });

    // Forecasting and anomaly screening are consequences of a sale, never a
    // precondition for it: they are queued, not awaited.
    await ctx.enqueue('sale.post-processed', { sale_id: sale.id, store_id: req.auth.storeId });
    res.status(sale.replayed ? 200 : 201).json({ data: sale });
  }));

  r.get('/sales', asyncHandler<AuthedRequest>(async (req, res) => {
    const page = parsePage(req.query as Record<string, unknown>);
    const where = ['s.store_id = $1'];
    const params: unknown[] = [req.auth.storeId];
    if (req.query.from) { params.push(String(req.query.from)); where.push(`s.occurred_at >= $${params.length}::timestamptz`); }
    if (req.query.to) { params.push(String(req.query.to)); where.push(`s.occurred_at <= $${params.length}::timestamptz`); }
    if (req.query.status) { params.push(String(req.query.status)); where.push(`s.status = $${params.length}`); }
    if (req.auth.role === 'CASHIER') { params.push(req.auth.userId); where.push(`s.cashier_id = $${params.length}`); }

    const clause = `WHERE ${where.join(' AND ')}`;
    const total = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM sale s ${clause}`, params);
    const rows = await ctx.db.query(
      `SELECT s.id, s.reference, s.occurred_at, s.total_cents, s.gross_profit_cents, s.status,
              u.full_name AS cashier_name,
              (SELECT count(*)::int FROM sale_item WHERE sale_id = s.id) AS line_count
         FROM sale s LEFT JOIN app_user u ON u.id = s.cashier_id
         ${clause}
        ORDER BY s.occurred_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.perPage, page.offset],
    );
    ok(res, rows.rows, pageMeta(page, total.rows[0]?.n ?? 0));
  }));

  r.get('/sales/:id', asyncHandler<AuthedRequest>(async (req, res) => {
    const sale = await loadSale(ctx.db, param(req, 'id') ?? '', req.auth.storeId);
    if (!sale) throw notFound('Sale');
    ok(res, sale);
  }));

  /** A receipt is derived data: it is rendered from the stored sale, never stored itself. */
  r.get('/sales/:id/receipt', asyncHandler<AuthedRequest>(async (req, res) => {
    const sale = await loadSale(ctx.db, param(req, 'id') ?? '', req.auth.storeId);
    if (!sale) throw notFound('Sale');
    const store = await ctx.db.query<{ name: string; currency: string }>(
      'SELECT name, currency FROM store WHERE id = $1',
      [req.auth.storeId],
    );
    const format = String(req.query.format ?? 'json');
    const payload = {
      store: store.rows[0]?.name ?? '',
      reference: sale.reference,
      occurred_at: sale.occurred_at,
      currency: store.rows[0]?.currency ?? 'PHP',
      lines: sale.lines.map((l) => ({
        description: l.name,
        quantity: l.quantity,
        unit_price_cents: l.unit_price_cents,
        amount_cents: l.unit_price_cents * l.quantity - l.discount_cents,
      })),
      subtotal_cents: sale.subtotal_cents,
      discount_cents: sale.discount_cents,
      tax_cents: sale.tax_cents,
      total_cents: sale.total_cents,
      tenders: sale.payments,
    };

    if (format === 'text') {
      const money = (c: number) => (c / 100).toFixed(2);
      const lines = [
        payload.store.toUpperCase(),
        `Receipt ${payload.reference}`,
        payload.occurred_at,
        '-'.repeat(32),
        ...payload.lines.map((l) => `${l.description.slice(0, 20).padEnd(20)} ${String(l.quantity).padStart(3)} ${money(l.amount_cents).padStart(8)}`),
        '-'.repeat(32),
        `Subtotal${money(payload.subtotal_cents).padStart(24)}`,
        `Discount${money(-payload.discount_cents).padStart(23)}`,
        `VAT${money(payload.tax_cents).padStart(28)}`,
        `TOTAL${money(payload.total_cents).padStart(26)}`,
        ...payload.tenders.map((t) => `${t.method}${money(t.amount_cents).padStart(26)}`),
        '-'.repeat(32),
        'Thank you!',
      ];
      res.type('text/plain').send(lines.join('\n'));
      return;
    }
    ok(res, payload);
  }));

  r.post('/sales/:id/return', requirePermission('sales:return'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({
      items: z.array(z.object({
        sale_item_id: z.string().min(1),
        quantity: z.number().int().positive(),
      })).min(1),
      note: z.string().optional().nullable(),
    }), req.body);
    const sale = await returnSale(ctx.db, {
      storeId: req.auth.storeId,
      actorId: req.auth.userId,
      saleId: param(req, 'id') ?? '',
      note: body.note ?? null,
      items: body.items.map((i) => ({ saleItemId: i.sale_item_id, quantity: i.quantity })),
    });
    ok(res, sale);
  }));

  r.post('/sales/:id/void', requirePermission('sales:void'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ reason: z.string().min(3) }), req.body);
    const sale = await voidSale(ctx.db, {
      storeId: req.auth.storeId,
      actorId: req.auth.userId,
      saleId: param(req, 'id') ?? '',
      reason: body.reason,
    });
    ok(res, sale);
  }));

  return r;
}

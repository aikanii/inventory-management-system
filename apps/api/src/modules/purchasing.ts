import { Router } from 'express';
import { z } from 'zod';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { authenticate, asyncHandler, created, ok, param, parse, requirePermission, resolveStore } from '../shared/http.js';
import { applyMovement } from '../services/stock.js';
import { audit } from '../shared/security.js';
import { notFound, unprocessable } from '../shared/errors.js';

const poBody = z.object({
  supplier_id: z.string().min(1),
  note: z.string().optional().nullable(),
  items: z.array(z.object({
    product_id: z.string().min(1),
    quantity: z.number().int().positive(),
    unit_cost_cents: z.number().int().min(0),
  })).min(1),
});

const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED_SHORT'],
};

export function purchasingRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(authenticate(ctx), resolveStore(ctx));

  r.get('/purchase-orders', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT count(*)::int FROM purchase_order_item WHERE purchase_order_id = po.id) AS line_count
         FROM purchase_order po JOIN supplier s ON s.id = po.supplier_id
        WHERE po.store_id = $1 ORDER BY po.ordered_at DESC LIMIT 200`,
      [req.auth.storeId],
    );
    ok(res, rows.rows);
  }));

  r.post('/purchase-orders', requirePermission('purchasing:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(poBody, req.body);
    const id = await ctx.db.transaction(async (tx) => {
      const supplier = await tx.query<{ id: string }>(
        'SELECT id FROM supplier WHERE id = $1 AND store_id = $2',
        [body.supplier_id, req.auth.storeId],
      );
      if (!supplier.rows[0]) throw notFound('Supplier');

      const year = new Date().getUTCFullYear();
      const seq = await tx.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM purchase_order WHERE store_id = $1 AND reference LIKE $2',
        [req.auth.storeId, `PO-${year}-%`],
      );
      const reference = `PO-${year}-${String((seq.rows[0]?.n ?? 0) + 1).padStart(5, '0')}`;
      const total = body.items.reduce((s, i) => s + i.quantity * i.unit_cost_cents, 0);

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO purchase_order (store_id, supplier_id, reference, created_by, note, total_cost_cents)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.auth.storeId, body.supplier_id, reference, req.auth.userId, body.note ?? null, total],
      );
      const poId = inserted.rows[0]?.id ?? '';
      for (const item of body.items) {
        await tx.query(
          `INSERT INTO purchase_order_item (purchase_order_id, product_id, quantity, unit_cost_cents)
           VALUES ($1,$2,$3,$4)`,
          [poId, item.product_id, item.quantity, item.unit_cost_cents],
        );
      }
      await audit(tx, {
        storeId: req.auth.storeId, actorId: req.auth.userId, action: 'po.create',
        entity: 'purchase_order', entityId: poId, changes: { reference, total_cost_cents: total },
      });
      return poId;
    });
    created(res, { id });
  }));

  r.get('/purchase-orders/:id', asyncHandler<AuthedRequest>(async (req, res) => {
    const head = await ctx.db.query(
      `SELECT po.*, s.name AS supplier_name FROM purchase_order po
         JOIN supplier s ON s.id = po.supplier_id WHERE po.id = $1 AND po.store_id = $2`,
      [param(req, 'id'), req.auth.storeId],
    );
    if (!head.rows[0]) throw notFound('Purchase order');
    const items = await ctx.db.query(
      `SELECT i.*, p.sku, p.name AS product_name
         FROM purchase_order_item i JOIN product p ON p.id = i.product_id
        WHERE i.purchase_order_id = $1 ORDER BY p.sku`,
      [param(req, 'id')],
    );
    ok(res, { ...head.rows[0], items: items.rows });
  }));

  r.post('/purchase-orders/:id/send', requirePermission('purchasing:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    ok(res, await transition(ctx, req, 'SENT'));
  }));

  r.post('/purchase-orders/:id/cancel', requirePermission('purchasing:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    ok(res, await transition(ctx, req, 'CANCELLED'));
  }));

  r.post('/purchase-orders/:id/close', requirePermission('purchasing:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    ok(res, await transition(ctx, req, 'CLOSED_SHORT'));
  }));

  /**
   * Receiving is the only place the cost basis changes. Each received line
   * posts an IN movement at the delivered unit cost, which recomputes the
   * product's moving weighted average.
   */
  r.post('/purchase-orders/:id/receive', requirePermission('purchasing:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({
      items: z.array(z.object({
        purchase_order_item_id: z.string().min(1),
        quantity: z.number().int().positive(),
        unit_cost_cents: z.number().int().min(0).optional(),
      })).min(1),
    }), req.body);

    const result = await ctx.db.transaction(async (tx) => {
      const head = await tx.query<{ id: string; status: string; supplier_id: string }>(
        'SELECT id, status, supplier_id FROM purchase_order WHERE id = $1 AND store_id = $2 FOR UPDATE',
        [param(req, 'id'), req.auth.storeId],
      );
      const po = head.rows[0];
      if (!po) throw notFound('Purchase order');
      if (!['SENT', 'PARTIALLY_RECEIVED'].includes(po.status)) {
        throw unprocessable('INVALID_STATE_TRANSITION', `Cannot receive a ${po.status} purchase order.`);
      }

      for (const item of body.items) {
        const line = await tx.query<{
          id: string; product_id: string; quantity: number; received_qty: number; unit_cost_cents: number;
        }>('SELECT id, product_id, quantity, received_qty, unit_cost_cents FROM purchase_order_item WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE',
          [item.purchase_order_item_id, po.id]);
        const row = line.rows[0];
        if (!row) throw notFound('Purchase order item');
        if (row.received_qty + item.quantity > row.quantity) {
          throw unprocessable('OVER_RECEIPT', `Cannot receive ${item.quantity}; only ${row.quantity - row.received_qty} outstanding.`, [
            { purchase_order_item_id: row.id, outstanding: row.quantity - row.received_qty },
          ]);
        }
        const unitCost = item.unit_cost_cents ?? row.unit_cost_cents;

        await applyMovement(tx, {
          productId: row.product_id,
          storeId: req.auth.storeId,
          direction: 'IN',
          reason: 'PURCHASE',
          quantity: item.quantity,
          unitCostCents: unitCost,
          referenceType: 'purchase_order_item',
          referenceId: row.id,
          actorId: req.auth.userId,
        });
        await tx.query('UPDATE purchase_order_item SET received_qty = received_qty + $1, unit_cost_cents = $2 WHERE id = $3',
          [item.quantity, unitCost, row.id]);
      }

      const outstanding = await tx.query<{ n: number }>(
        'SELECT coalesce(sum(quantity - received_qty), 0)::int AS n FROM purchase_order_item WHERE purchase_order_id = $1',
        [po.id],
      );
      const next = (outstanding.rows[0]?.n ?? 0) > 0 ? 'PARTIALLY_RECEIVED' : 'RECEIVED';
      await tx.query('UPDATE purchase_order SET status = $1 WHERE id = $2', [next, po.id]);
      await audit(tx, {
        storeId: req.auth.storeId, actorId: req.auth.userId, action: 'po.receive',
        entity: 'purchase_order', entityId: po.id, changes: { received: body.items.length, status: next },
      });
      return { id: po.id, status: next };
    });
    ok(res, result);
  }));

  return r;
}

async function transition(
  ctx: AppContext,
  req: AuthedRequest,
  target: string,
): Promise<{ id: string; status: string }> {
  return ctx.db.transaction(async (tx) => {
    const head = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM purchase_order WHERE id = $1 AND store_id = $2 FOR UPDATE',
      [param(req, 'id'), req.auth.storeId],
    );
    const po = head.rows[0];
    if (!po) throw notFound('Purchase order');
    if (!(VALID_TRANSITIONS[po.status] ?? []).includes(target)) {
      throw unprocessable('INVALID_STATE_TRANSITION', `Cannot move ${po.status} to ${target}.`, [
        { from: po.status, to: target, allowed: VALID_TRANSITIONS[po.status] ?? [] },
      ]);
    }
    await tx.query('UPDATE purchase_order SET status = $1 WHERE id = $2', [target, po.id]);
    await audit(tx, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'po.transition',
      entity: 'purchase_order', entityId: po.id, changes: { from: po.status, to: target },
    });
    return { id: po.id, status: target };
  });
}

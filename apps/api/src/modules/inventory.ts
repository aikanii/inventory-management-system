import { Router } from 'express';
import { z } from 'zod';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { authenticate, asyncHandler, created, ok, pageMeta, param, parse, parsePage, requirePermission, resolveStore } from '../shared/http.js';
import { applyMovement, recomputeLevel } from '../services/stock.js';
import { audit } from '../shared/security.js';
import { notFound, unprocessable } from '../shared/errors.js';

const adjustment = z.object({
  product_id: z.string().min(1),
  quantity: z.number().int().positive(),
  reason: z.enum(['ADJUSTMENT_UP', 'ADJUSTMENT_DOWN', 'SPOILAGE', 'DAMAGE']),
  note: z.string().min(1),
});

const stocktakeLine = z.object({ product_id: z.string().min(1), counted_qty: z.number().int().min(0) });

export function inventoryRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(authenticate(ctx), resolveStore(ctx));

  r.get('/levels', asyncHandler<AuthedRequest>(async (req, res) => {
    const page = parsePage(req.query as Record<string, unknown>, 200);
    const total = await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM product WHERE store_id = $1 AND deleted_at IS NULL',
      [req.auth.storeId],
    );
    const rows = await ctx.db.query(
      `SELECT p.id, p.sku, p.name, p.unit, p.selling_price_cents, p.avg_cost_cents, p.reorder_point,
              coalesce(sl.on_hand, 0) AS on_hand,
              (p.avg_cost_cents * coalesce(sl.on_hand, 0)) AS value_at_cost_cents,
              (p.selling_price_cents * coalesce(sl.on_hand, 0)) AS value_at_retail_cents,
              (coalesce(sl.on_hand,0) <= p.reorder_point) AS low_stock,
              sl.updated_at AS level_updated_at
         FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
        WHERE p.store_id = $1 AND p.deleted_at IS NULL
        ORDER BY p.name
        LIMIT $2 OFFSET $3`,
      [req.auth.storeId, page.perPage, page.offset],
    );
    ok(res, rows.rows, pageMeta(page, total.rows[0]?.n ?? 0));
  }));

  r.get('/low-stock', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT p.id, p.sku, p.name, p.reorder_point, p.pack_size, p.target_cover_days,
              coalesce(sl.on_hand, 0) AS on_hand,
              s.lead_time_days,
              (p.selling_price_cents * coalesce(sl.on_hand, 0)) AS value_at_retail_cents
         FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
         LEFT JOIN supplier s ON s.id = p.supplier_id
        WHERE p.store_id = $1 AND p.deleted_at IS NULL AND p.is_active
          AND coalesce(sl.on_hand, 0) <= p.reorder_point
        ORDER BY (p.selling_price_cents * coalesce(sl.on_hand, 0)) DESC`,
      [req.auth.storeId],
    );
    ok(res, rows.rows);
  }));

  r.get('/valuation', requirePermission('stock:read'), asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query<{ units: number; at_cost_cents: number; at_retail_cents: number }>(
      `SELECT coalesce(sum(coalesce(sl.on_hand,0)),0)::int AS units,
              coalesce(sum(p.avg_cost_cents * coalesce(sl.on_hand,0)),0)::int AS at_cost_cents,
              coalesce(sum(p.selling_price_cents * coalesce(sl.on_hand,0)),0)::int AS at_retail_cents
         FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
        WHERE p.store_id = $1 AND p.deleted_at IS NULL`,
      [req.auth.storeId],
    );
    ok(res, rows.rows[0]);
  }));

  r.post('/adjustments', requirePermission('stock:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(adjustment, req.body);
    const result = await ctx.db.transaction(async (tx) => {
      const product = await tx.query<{ id: string; sku: string; avg_cost_cents: number }>(
        'SELECT id, sku, avg_cost_cents FROM product WHERE id = $1 AND store_id = $2 AND deleted_at IS NULL',
        [body.product_id, req.auth.storeId],
      );
      const row = product.rows[0];
      if (!row) throw notFound('Product');

      const isIn = body.reason === 'ADJUSTMENT_UP';
      const applied = await applyMovement(tx, {
        productId: body.product_id,
        storeId: req.auth.storeId,
        direction: isIn ? 'IN' : 'OUT',
        reason: body.reason,
        quantity: body.quantity,
        unitCostCents: row.avg_cost_cents,
        referenceType: 'adjustment',
        actorId: req.auth.userId,
        note: body.note,
      }, { allowNegative: !isIn });

      await audit(tx, {
        storeId: req.auth.storeId, actorId: req.auth.userId, action: 'stock.adjust',
        entity: 'stock_movement', entityId: applied.movementId,
        changes: { sku: row.sku, reason: body.reason, quantity: body.quantity, note: body.note },
      });
      return { sku: row.sku, ...applied };
    });
    created(res, result);
  }));

  r.get('/adjustments', asyncHandler<AuthedRequest>(async (req, res) => {
    const page = parsePage(req.query as Record<string, unknown>, 100);
    const rows = await ctx.db.query(
      `SELECT m.*, p.sku, p.name AS product_name, u.full_name AS actor_name
         FROM stock_movement m
         JOIN product p ON p.id = m.product_id
         LEFT JOIN app_user u ON u.id = m.actor_id
        WHERE m.store_id = $1
          AND m.reason IN ('ADJUSTMENT_UP','ADJUSTMENT_DOWN','SPOILAGE','DAMAGE')
        ORDER BY m.created_at DESC
        LIMIT $2 OFFSET $3`,
      [req.auth.storeId, page.perPage, page.offset],
    );
    ok(res, rows.rows);
  }));

  // ------------------------------------------------------------- stocktakes
  r.post('/stocktakes', requirePermission('stock:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({
      product_ids: z.array(z.string().min(1)).min(1),
      counts: z.array(stocktakeLine).default([]),
    }), req.body);

    const id = await ctx.db.transaction(async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        'INSERT INTO stocktake (store_id, opened_by) VALUES ($1,$2) RETURNING id',
        [req.auth.storeId, req.auth.userId],
      );
      const stocktakeId = inserted.rows[0]?.id ?? '';
      for (const productId of body.product_ids) {
        const level = await tx.query<{ on_hand: number }>(
          'SELECT coalesce(on_hand,0)::int AS on_hand FROM stock_level WHERE product_id = $1 AND store_id = $2',
          [productId, req.auth.storeId],
        );
        await tx.query(
          'INSERT INTO stocktake_line (stocktake_id, product_id, system_qty, counted_qty) VALUES ($1,$2,$3,$4)',
          [stocktakeId, productId, level.rows[0]?.on_hand ?? 0,
           body.counts.find((c) => c.product_id === productId)?.counted_qty ?? null],
        );
      }
      await audit(tx, {
        storeId: req.auth.storeId, actorId: req.auth.userId, action: 'stocktake.open',
        entity: 'stocktake', entityId: stocktakeId, changes: { lines: body.product_ids.length },
      });
      return stocktakeId;
    });
    created(res, { id });
  }));

  r.get('/stocktakes/:id', asyncHandler<AuthedRequest>(async (req, res) => {
    const head = await ctx.db.query(
      'SELECT * FROM stocktake WHERE id = $1 AND store_id = $2',
      [param(req, 'id'), req.auth.storeId],
    );
    if (!head.rows[0]) throw notFound('Stocktake');
    const lines = await ctx.db.query(
      `SELECT l.*, p.sku, p.name AS product_name,
              (l.counted_qty - l.system_qty) AS variance
         FROM stocktake_line l JOIN product p ON p.id = l.product_id
        WHERE l.stocktake_id = $1 ORDER BY p.sku`,
      [param(req, 'id')],
    );
    ok(res, { ...head.rows[0], lines: lines.rows });
  }));

  r.post('/stocktakes/:id/complete', requirePermission('stock:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ counts: z.array(stocktakeLine).default([]) }), req.body);
    const summary = await ctx.db.transaction(async (tx) => {
      const head = await tx.query<{ id: string; status: string }>(
        'SELECT id, status FROM stocktake WHERE id = $1 AND store_id = $2 FOR UPDATE',
        [param(req, 'id'), req.auth.storeId],
      );
      const row = head.rows[0];
      if (!row) throw notFound('Stocktake');
      if (row.status !== 'OPEN') throw unprocessable('INVALID_STATE_TRANSITION', 'Stocktake is already closed.');

      for (const count of body.counts) {
        await tx.query(
          'UPDATE stocktake_line SET counted_qty = $1 WHERE stocktake_id = $2 AND product_id = $3',
          [count.counted_qty, param(req, 'id'), count.product_id],
        );
      }

      const lines = await tx.query<{ product_id: string; system_qty: number; counted_qty: number | null }>(
        'SELECT product_id, system_qty, counted_qty FROM stocktake_line WHERE stocktake_id = $1',
        [param(req, 'id')],
      );

      let posted = 0;
      for (const line of lines.rows) {
        if (line.counted_qty === null) continue;
        // Always trust the ledger as the starting point, never the snapshot taken
        // when the sheet was printed — stock may have moved since.
        const systemNow = await recomputeLevel(tx, line.product_id, req.auth.storeId);
        const variance = line.counted_qty - systemNow;
        if (variance === 0) continue;
        const product = await tx.query<{ avg_cost_cents: number; sku: string }>(
          'SELECT avg_cost_cents, sku FROM product WHERE id = $1',
          [line.product_id],
        );
        await applyMovement(tx, {
          productId: line.product_id,
          storeId: req.auth.storeId,
          direction: variance > 0 ? 'IN' : 'OUT',
          reason: variance > 0 ? 'ADJUSTMENT_UP' : 'ADJUSTMENT_DOWN',
          quantity: Math.abs(variance),
          unitCostCents: product.rows[0]?.avg_cost_cents ?? 0,
          referenceType: 'stocktake',
          referenceId: param(req, 'id'),
          actorId: req.auth.userId,
          note: `stocktake variance ${variance > 0 ? '+' : ''}${variance}`,
        }, { allowNegative: variance < 0 });
        posted++;
      }

      await tx.query(`UPDATE stocktake SET status = 'POSTED', closed_at = now() WHERE id = $1`, [param(req, 'id')]);
      await audit(tx, {
        storeId: req.auth.storeId, actorId: req.auth.userId, action: 'stocktake.post',
        entity: 'stocktake', entityId: param(req, 'id'), changes: { posted },
      });
      return { posted };
    });
    ok(res, { id: param(req, 'id'), status: 'POSTED', ...summary });
  }));

  return r;
}

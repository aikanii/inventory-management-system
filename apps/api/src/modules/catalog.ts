import { Router } from 'express';
import { z } from 'zod';
import type { AppContext, AuthedRequest } from '../shared/http.js';
import { authenticate, asyncHandler, created, ok, pageMeta, param, parse, parsePage, requirePermission, resolveStore } from '../shared/http.js';
import { audit } from '../shared/security.js';
import { notFound, unprocessable } from '../shared/errors.js';

const productBody = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  barcode: z.string().optional().nullable(),
  unit: z.string().min(1).default('pc'),
  selling_price_cents: z.number().int().min(0),
  avg_cost_cents: z.number().int().min(0).default(0),
  category_id: z.string().optional().nullable(),
  supplier_id: z.string().optional().nullable(),
  tax_rate_bp: z.number().int().min(0).default(0),
  reorder_point: z.number().int().min(0).default(0),
  target_cover_days: z.number().int().min(0).default(14),
  pack_size: z.number().int().min(1).default(1),
});

const productPatch = productBody.partial().extend({ is_active: z.boolean().optional() });

export function catalogRouter(ctx: AppContext): Router {
  const r = Router();
  r.use(authenticate(ctx), resolveStore(ctx));

  // ------------------------------------------------------------- products
  r.get('/products', asyncHandler<AuthedRequest>(async (req, res) => {
    const storeId = req.auth.storeId;
    const page = parsePage(req.query as Record<string, unknown>);
    const q = String(req.query.q ?? '').trim();
    const lowStock = String(req.query.low_stock ?? '') === 'true';

    const where = ['p.store_id = $1', 'p.deleted_at IS NULL'];
    const params: unknown[] = [storeId];
    if (q) {
      params.push(`%${q}%`);
      where.push(`(p.sku ILIKE $${params.length} OR p.name ILIKE $${params.length} OR p.barcode ILIKE $${params.length})`);
    }
    if (lowStock) where.push('coalesce(sl.on_hand, 0) <= p.reorder_point');

    const clause = `WHERE ${where.join(' AND ')}`;
    const total = await ctx.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id ${clause}`,
      params,
    );
    const rows = await ctx.db.query(
      `SELECT p.*, coalesce(sl.on_hand, 0) AS on_hand, c.name AS category_name, s.name AS supplier_name
         FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
         LEFT JOIN category c ON c.id = p.category_id
         LEFT JOIN supplier s ON s.id = p.supplier_id
         ${clause}
        ORDER BY p.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.perPage, page.offset],
    );
    ok(res, rows.rows, pageMeta(page, total.rows[0]?.n ?? 0));
  }));

  r.get('/products/barcode/:code', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT p.*, coalesce(sl.on_hand,0) AS on_hand FROM product p
         LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
        WHERE p.store_id = $1 AND p.barcode = $2 AND p.deleted_at IS NULL`,
      [req.auth.storeId, param(req, 'code')],
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Product');
    ok(res, row);
  }));

  r.post('/products', requirePermission('catalog:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(productBody, req.body);
    const inserted = await ctx.db.query<{ id: string }>(
      `INSERT INTO product (store_id, sku, name, barcode, unit, selling_price_cents, avg_cost_cents,
                            category_id, supplier_id, tax_rate_bp, reorder_point, target_cover_days, pack_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [req.auth.storeId, body.sku, body.name, body.barcode ?? null, body.unit, body.selling_price_cents,
       body.avg_cost_cents, body.category_id ?? null, body.supplier_id ?? null, body.tax_rate_bp,
       body.reorder_point, body.target_cover_days, body.pack_size],
    );
    const id = inserted.rows[0]?.id ?? '';
    await ctx.db.query(
      'INSERT INTO stock_level (product_id, store_id, on_hand) VALUES ($1,$2,0) ON CONFLICT DO NOTHING',
      [id, req.auth.storeId],
    );
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'product.create',
      entity: 'product', entityId: id, changes: body as unknown as Record<string, unknown>,
    });
    created(res, { id, ...body });
  }));

  r.get('/products/:id', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query(
      `SELECT p.*, coalesce(sl.on_hand,0) AS on_hand,
              (p.avg_cost_cents * coalesce(sl.on_hand,0)) AS stock_value_at_cost_cents
         FROM product p LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
        WHERE p.id = $1 AND p.store_id = $2 AND p.deleted_at IS NULL`,
      [param(req, 'id'), req.auth.storeId],
    );
    const row = rows.rows[0];
    if (!row) throw notFound('Product');
    ok(res, row);
  }));

  r.patch('/products/:id', requirePermission('catalog:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(productPatch, req.body);
    const fields: string[] = [];
    const params: unknown[] = [];
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      params.push(value);
      fields.push(`${key} = $${params.length}`);
    }
    if (fields.length === 0) throw unprocessable('VALIDATION_FAILED', 'No fields to update.');
    params.push(param(req, 'id'), req.auth.storeId);
    const updated = await ctx.db.query<{ id: string }>(
      `UPDATE product SET ${fields.join(', ')} WHERE id = $${params.length - 1} AND store_id = $${params.length}
       RETURNING id`,
      params,
    );
    if (!updated.rows[0]) throw notFound('Product');
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'product.update',
      entity: 'product', entityId: param(req, 'id'), changes: body as unknown as Record<string, unknown>,
    });
    ok(res, { id: param(req, 'id'), updated: fields.length });
  }));

  r.delete('/products/:id', requirePermission('catalog:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const history = await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM stock_movement WHERE product_id = $1',
      [param(req, 'id')],
    );
    if ((history.rows[0]?.n ?? 0) > 0) {
      throw unprocessable('CONFLICT', 'Product has stock history; archive it instead of deleting.');
    }
    await ctx.db.query(
      'UPDATE product SET deleted_at = now() WHERE id = $1 AND store_id = $2',
      [param(req, 'id'), req.auth.storeId],
    );
    await audit(ctx.db, {
      storeId: req.auth.storeId, actorId: req.auth.userId, action: 'product.delete',
      entity: 'product', entityId: param(req, 'id'),
    });
    ok(res, { id: param(req, 'id'), deleted: true });
  }));

  r.get('/products/:id/ledger', asyncHandler<AuthedRequest>(async (req, res) => {
    const page = parsePage(req.query as Record<string, unknown>, 100);
    const rows = await ctx.db.query(
      `SELECT m.*, u.full_name AS actor_name FROM stock_movement m
         LEFT JOIN app_user u ON u.id = m.actor_id
        WHERE m.product_id = $1 AND m.store_id = $2
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $3 OFFSET $4`,
      [param(req, 'id'), req.auth.storeId, page.perPage, page.offset],
    );
    ok(res, rows.rows);
  }));

  // --------------------------------------------------- categories/suppliers
  r.get('/categories', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query('SELECT * FROM category WHERE store_id = $1 ORDER BY name', [req.auth.storeId]);
    ok(res, rows.rows);
  }));

  r.post('/categories', requirePermission('catalog:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ name: z.string().min(1), parent_id: z.string().optional().nullable() }), req.body);
    const inserted = await ctx.db.query<{ id: string }>(
      'INSERT INTO category (store_id, name, parent_id) VALUES ($1,$2,$3) RETURNING id',
      [req.auth.storeId, body.name, body.parent_id ?? null],
    );
    created(res, { id: inserted.rows[0]?.id, ...body });
  }));

  r.get('/suppliers', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query('SELECT * FROM supplier WHERE store_id = $1 ORDER BY name', [req.auth.storeId]);
    ok(res, rows.rows);
  }));

  r.post('/suppliers', requirePermission('catalog:write'), asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({
      name: z.string().min(1),
      contact: z.string().optional().nullable(),
      lead_time_days: z.number().int().min(0).default(3),
    }), req.body);
    const inserted = await ctx.db.query<{ id: string }>(
      'INSERT INTO supplier (store_id, name, contact, lead_time_days) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.auth.storeId, body.name, body.contact ?? null, body.lead_time_days],
    );
    created(res, { id: inserted.rows[0]?.id, ...body });
  }));

  r.get('/customers', asyncHandler<AuthedRequest>(async (req, res) => {
    const rows = await ctx.db.query('SELECT * FROM customer WHERE store_id = $1 ORDER BY name', [req.auth.storeId]);
    ok(res, rows.rows);
  }));

  r.post('/customers', asyncHandler<AuthedRequest>(async (req, res) => {
    const body = parse(z.object({ name: z.string().min(1), phone: z.string().optional().nullable() }), req.body);
    const inserted = await ctx.db.query<{ id: string }>(
      'INSERT INTO customer (store_id, name, phone) VALUES ($1,$2,$3) RETURNING id',
      [req.auth.storeId, body.name, body.phone ?? null],
    );
    created(res, { id: inserted.rows[0]?.id, ...body });
  }));

  return r;
}

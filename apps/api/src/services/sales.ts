/**
 * Point of sale.
 *
 * The checkout path holds row locks for the shortest possible time, snapshots
 * the cost basis onto each line, and writes the ledger and the cache in one
 * transaction. Replaying an idempotency key returns the original sale instead
 * of selling the same stock twice.
 */
import { randomUUID } from 'node:crypto';
import { computeSaleTotals, type SaleLineInput } from '../domain/costing.js';
import { applyMovement, lockProduct } from './stock.js';
import { audit } from '../shared/security.js';
import { conflict, unprocessable } from '../shared/errors.js';
import type { Database } from '../db/database.js';

export interface SaleItemInput {
  productId: string;
  quantity: number;
  /** Defaults to the product's current selling price. */
  unitPriceCents?: number;
  discountCents?: number;
}

export interface TenderInput {
  method: 'CASH' | 'EWALLET' | 'CARD' | 'CREDIT';
  amountCents: number;
}

export interface CreateSaleInput {
  storeId: string;
  cashierId: string;
  items: SaleItemInput[];
  tenders: TenderInput[];
  customerId?: string | null;
  idempotencyKey?: string | null;
  occurredAt?: string | null;
  note?: string | null;
  /** Staff purchases and approved clearance may go below cost. */
  allowBelowCost?: boolean;
}

export interface SaleRecord {
  id: string;
  reference: string;
  store_id: string;
  cashier_id: string | null;
  occurred_at: string;
  subtotal_cents: number;
  discount_cents: number;
  net_revenue_cents: number;
  tax_cents: number;
  total_cents: number;
  gross_profit_cents: number;
  gross_margin_pct: number;
  status: string;
  lines: {
    id: string;
    product_id: string;
    sku: string;
    name: string;
    quantity: number;
    unit_price_cents: number;
    unit_cost_cents: number;
    discount_cents: number;
    gross_profit_cents: number;
    returned_qty: number;
  }[];
  payments: { method: string; amount_cents: number }[];
  replayed?: boolean;
}

const SALE_SELECT = `
  SELECT id, reference, store_id, cashier_id, occurred_at, subtotal_cents, discount_cents,
         net_revenue_cents, tax_cents, total_cents, gross_profit_cents, status
    FROM sale`;

export async function loadSale(db: Database, saleId: string, storeId: string): Promise<SaleRecord | null> {
  const sale = await db.query<SaleRecord & { gross_margin_pct?: number }>(
    `${SALE_SELECT} WHERE id = $1 AND store_id = $2`,
    [saleId, storeId],
  );
  const row = sale.rows[0];
  if (!row) return null;
  const [lines, payments] = await Promise.all([
    db.query<SaleRecord['lines'][number]>(
      `SELECT si.id, si.product_id, p.sku, p.name, si.quantity, si.unit_price_cents,
              si.unit_cost_cents, si.discount_cents, si.gross_profit_cents, si.returned_qty
         FROM sale_item si JOIN product p ON p.id = si.product_id
        WHERE si.sale_id = $1 ORDER BY p.sku`,
      [saleId],
    ),
    db.query<{ method: string; amount_cents: number }>(
      'SELECT method, amount_cents FROM payment WHERE sale_id = $1 ORDER BY id',
      [saleId],
    ),
  ]);
  return {
    ...row,
    gross_margin_pct:
      row.net_revenue_cents === 0 ? 0 : (row.gross_profit_cents / row.net_revenue_cents) * 100,
    lines: lines.rows,
    payments: payments.rows,
  };
}

async function nextReference(tx: Database, storeId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM sale WHERE store_id = $1 AND reference LIKE $2`,
    [storeId, `S-${year}-%`],
  );
  return `S-${year}-${String((rows.rows[0]?.n ?? 0) + 1).padStart(6, '0')}`;
}

export async function createSale(db: Database, input: CreateSaleInput): Promise<SaleRecord> {
  if (input.items.length === 0) throw unprocessable('VALIDATION_FAILED', 'A sale needs at least one line.');
  if (input.tenders.length === 0) throw unprocessable('VALIDATION_FAILED', 'A sale needs at least one tender.');

  // Idempotent replay: an ambiguous timeout must never double-sell stock.
  if (input.idempotencyKey) {
    const existing = await db.query<{ id: string }>(
      'SELECT id FROM sale WHERE idempotency_key = $1 AND store_id = $2',
      [input.idempotencyKey, input.storeId],
    );
    const found = existing.rows[0];
    if (found) {
      const sale = await loadSale(db, found.id, input.storeId);
      if (sale) return { ...sale, replayed: true };
    }
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const id = await db.transaction(async (tx) => writeSale(tx, input));
      const sale = await loadSale(db, id, input.storeId);
      if (!sale) throw unprocessable('INTERNAL_ERROR', 'Sale disappeared after commit.');
      return sale;
    } catch (err) {
      const isReferenceCollision = (err as { code?: string })?.code === '23505'
        && /sale_reference_key/.test(String((err as { message?: string })?.message ?? ''));
      if (isReferenceCollision && attempt < 3) continue;
      throw err;
    }
  }
  throw unprocessable('INTERNAL_ERROR', 'Could not allocate a sale reference.');
}

async function writeSale(tx: Database, input: CreateSaleInput): Promise<string> {
  const store = await tx.query<{ id: string; vat_rate_bp: number; tax_mode: 'EXCLUSIVE' | 'INCLUSIVE' }>(
    'SELECT id, vat_rate_bp, tax_mode FROM store WHERE id = $1',
    [input.storeId],
  );
  const storeRow = store.rows[0];
  if (!storeRow) throw unprocessable('STORE_ACCESS_DENIED', 'Unknown store.');

  // Lock and price every line up front, in a stable order to avoid deadlocks.
  const ordered = [...input.items].sort((a, b) => a.productId.localeCompare(b.productId));
  interface PricedLine extends SaleLineInput {
    productId: string;
    sku: string;
    unitPriceCents: number;
    unitCostCents: number;
    discountCents: number;
  }
  const lines: PricedLine[] = [];

  for (const item of ordered) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw unprocessable('VALIDATION_FAILED', 'Quantity must be a positive integer.');
    }
    const product = await lockProduct(tx, item.productId, input.storeId);
    if (!product) throw unprocessable('NOT_FOUND', `Product ${item.productId} not found in this store.`);
    lines.push({
      productId: item.productId,
      sku: product.sku,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents ?? 0,
      unitCostCents: product.avg_cost_cents,
      discountCents: item.discountCents ?? 0,
    });
  }

  // Server-side pricing: a client may not invent a price unless it passes one,
  // and if it does we still compare against the catalogue to catch keying errors.
  for (const [i, item] of ordered.entries()) {
    const line = lines[i];
    if (!line) continue;
    if (item.unitPriceCents === undefined) {
      const priced = await tx.query<{ selling_price_cents: number }>(
        'SELECT selling_price_cents FROM product WHERE id = $1',
        [item.productId],
      );
      line.unitPriceCents = priced.rows[0]?.selling_price_cents ?? 0;
    }
    if (line.discountCents > line.unitPriceCents * line.quantity) {
      throw unprocessable('VALIDATION_FAILED', 'Discount exceeds the line total.');
    }
    if (!input.allowBelowCost && line.unitPriceCents > 0) {
      const netUnit = line.unitPriceCents - line.discountCents / line.quantity;
      if (netUnit < line.unitCostCents) {
        throw unprocessable('BELOW_COST_PRICE', `SKU ${line.sku} would sell below cost.`, [
          { sku: line.sku, netUnitCents: Math.round(netUnit), unitCostCents: line.unitCostCents },
        ]);
      }
    }
  }

  const totals = computeSaleTotals({ lines, vatRateBp: storeRow.vat_rate_bp, taxMode: storeRow.tax_mode });
  const tenderTotal = input.tenders.reduce((s, t) => s + t.amountCents, 0);
  if (tenderTotal !== totals.totalCents) {
    throw unprocessable('TENDER_MISMATCH', 'Tenders do not add up to the sale total.', [
      { tenderTotalCents: tenderTotal, totalCents: totals.totalCents },
    ]);
  }

  const reference = await nextReference(tx, input.storeId);
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();

  const sale = await tx.query<{ id: string }>(
    `INSERT INTO sale
       (store_id, cashier_id, reference, idempotency_key, customer_id, occurred_at,
        subtotal_cents, discount_cents, net_revenue_cents, tax_cents, total_cents, gross_profit_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      input.storeId, input.cashierId, reference, input.idempotencyKey ?? null,
      input.customerId ?? null, occurredAt, totals.subtotalCents, totals.discountCents,
      totals.netRevenueCents, totals.taxCents, totals.totalCents, totals.grossProfitCents,
    ],
  );
  const saleId = sale.rows[0]?.id ?? randomUUID();

  for (const [i, line] of totals.lines.entries()) {
    const source = lines[i];
    if (!source) continue;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO sale_item
         (sale_id, product_id, quantity, unit_price_cents, unit_cost_cents, discount_cents, gross_profit_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [saleId, source.productId, line.quantity, line.unitPriceCents, line.unitCostCents,
       line.discountCents, line.grossProfitCents],
    );
    await applyMovement(tx, {
      productId: source.productId,
      storeId: input.storeId,
      direction: 'OUT',
      reason: 'SALE',
      quantity: line.quantity,
      unitCostCents: line.unitCostCents,
      referenceType: 'sale_item',
      referenceId: inserted.rows[0]?.id ?? null,
      actorId: input.cashierId,
    });
  }

  for (const tender of input.tenders) {
    await tx.query('INSERT INTO payment (sale_id, method, amount_cents) VALUES ($1,$2,$3)', [
      saleId, tender.method, tender.amountCents,
    ]);
  }

  await audit(tx, {
    storeId: input.storeId,
    actorId: input.cashierId,
    action: 'sale.create',
    entity: 'sale',
    entityId: saleId,
    changes: { reference, total_cents: totals.totalCents, gross_profit_cents: totals.grossProfitCents },
  });

  return saleId;
}

// ---------------------------------------------------------------- returns

export interface ReturnInput {
  storeId: string;
  actorId: string;
  saleId: string;
  items: { saleItemId: string; quantity: number }[];
  note?: string | null;
}

/** Restores stock at the ORIGINAL cost snapshot, not at today's cost. */
export async function returnSale(db: Database, input: ReturnInput): Promise<SaleRecord> {
  await db.transaction(async (tx) => {
    const sale = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM sale WHERE id = $1 AND store_id = $2 FOR UPDATE',
      [input.saleId, input.storeId],
    );
    const saleRow = sale.rows[0];
    if (!saleRow) throw unprocessable('NOT_FOUND', 'Sale not found in this store.');
    if (saleRow.status === 'VOIDED') throw conflict('INVALID_STATE_TRANSITION', 'A voided sale cannot be returned.');

    for (const item of input.items) {
      const line = await tx.query<{
        id: string; product_id: string; quantity: number; returned_qty: number; unit_cost_cents: number;
      }>('SELECT id, product_id, quantity, returned_qty, unit_cost_cents FROM sale_item WHERE id = $1 AND sale_id = $2 FOR UPDATE',
        [item.saleItemId, input.saleId]);
      const row = line.rows[0];
      if (!row) throw unprocessable('NOT_FOUND', `Sale item ${item.saleItemId} not found.`);
      const remaining = row.quantity - row.returned_qty;
      if (item.quantity <= 0 || item.quantity > remaining) {
        throw unprocessable('INVALID_RETURN_QUANTITY', `Cannot return ${item.quantity} of ${remaining} remaining.`, [
          { sale_item_id: item.saleItemId, requested: item.quantity, remaining },
        ]);
      }

      await applyMovement(tx, {
        productId: row.product_id,
        storeId: input.storeId,
        direction: 'IN',
        reason: 'RETURN_FROM_CUSTOMER',
        quantity: item.quantity,
        unitCostCents: row.unit_cost_cents,
        referenceType: 'sale_item',
        referenceId: row.id,
        actorId: input.actorId,
        note: input.note ?? null,
      });

      await tx.query('UPDATE sale_item SET returned_qty = returned_qty + $1 WHERE id = $2', [
        item.quantity, row.id,
      ]);
    }

    const remaining = await tx.query<{ n: number }>(
      'SELECT coalesce(sum(quantity - returned_qty), 0)::int AS n FROM sale_item WHERE sale_id = $1',
      [input.saleId],
    );
    if ((remaining.rows[0]?.n ?? 0) <= 0) {
      await tx.query(`UPDATE sale SET status = 'RETURNED' WHERE id = $1`, [input.saleId]);
    }

    await audit(tx, {
      storeId: input.storeId,
      actorId: input.actorId,
      action: 'sale.return',
      entity: 'sale',
      entityId: input.saleId,
      changes: { items: input.items },
    });
  });

  const sale = await loadSale(db, input.saleId, input.storeId);
  if (!sale) throw unprocessable('NOT_FOUND', 'Sale not found.');
  return sale;
}

// ---------------------------------------------------------------- voids

/** Reverses every line and puts the stock back. Never deletes history. */
export async function voidSale(
  db: Database,
  input: { storeId: string; actorId: string; saleId: string; reason: string },
): Promise<SaleRecord> {
  if (!input.reason.trim()) throw unprocessable('VALIDATION_FAILED', 'A void requires a reason.');

  await db.transaction(async (tx) => {
    const sale = await tx.query<{ id: string; status: string }>(
      'SELECT id, status FROM sale WHERE id = $1 AND store_id = $2 FOR UPDATE',
      [input.saleId, input.storeId],
    );
    const row = sale.rows[0];
    if (!row) throw unprocessable('NOT_FOUND', 'Sale not found in this store.');
    if (row.status === 'VOIDED') throw conflict('INVALID_STATE_TRANSITION', 'Sale is already voided.');
    if (row.status === 'RETURNED') throw conflict('INVALID_STATE_TRANSITION', 'A fully returned sale cannot be voided.');

    const lines = await tx.query<{ id: string; product_id: string; quantity: number; returned_qty: number; unit_cost_cents: number }>(
      'SELECT id, product_id, quantity, returned_qty, unit_cost_cents FROM sale_item WHERE sale_id = $1',
      [input.saleId],
    );

    for (const line of lines.rows) {
      const restorable = line.quantity - line.returned_qty;
      if (restorable <= 0) continue;
      await applyMovement(tx, {
        productId: line.product_id,
        storeId: input.storeId,
        direction: 'IN',
        reason: 'ADJUSTMENT_UP',
        quantity: restorable,
        unitCostCents: line.unit_cost_cents,
        referenceType: 'sale_item',
        referenceId: line.id,
        actorId: input.actorId,
        note: `void: ${input.reason}`,
      });
    }

    await tx.query(`UPDATE sale SET status = 'VOIDED', void_reason = $1 WHERE id = $2`, [
      input.reason, input.saleId,
    ]);
    await audit(tx, {
      storeId: input.storeId,
      actorId: input.actorId,
      action: 'sale.void',
      entity: 'sale',
      entityId: input.saleId,
      changes: { reason: input.reason },
    });
  });

  const sale = await loadSale(db, input.saleId, input.storeId);
  if (!sale) throw unprocessable('NOT_FOUND', 'Sale not found.');
  return sale;
}

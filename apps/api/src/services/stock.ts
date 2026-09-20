/**
 * The stock ledger.
 *
 * `applyMovement` is the ONLY function allowed to change on-hand quantity. It
 * writes the ledger row and updates the derived cache in the same transaction,
 * which is what makes invariant #1 (`SUM(ledger) == stock_level.on_hand`)
 * structurally true rather than merely hoped for.
 */
import { movingAverageCost } from '../domain/costing.js';
import { unprocessable } from '../shared/errors.js';
import type { Database } from '../db/database.js';

export type MovementDirection = 'IN' | 'OUT';
export type MovementReason =
  | 'PURCHASE' | 'RETURN_FROM_CUSTOMER' | 'ADJUSTMENT_UP' | 'TRANSFER_IN'
  | 'SALE' | 'SPOILAGE' | 'DAMAGE' | 'ADJUSTMENT_DOWN' | 'TRANSFER_OUT';

export interface MovementInput {
  productId: string;
  storeId: string;
  direction: MovementDirection;
  reason: MovementReason;
  quantity: number;
  /** Cost basis for this movement. For IN movements it may update the average cost. */
  unitCostCents: number;
  referenceType?: string | null;
  referenceId?: string | null;
  actorId?: string | null;
  note?: string | null;
}

export interface ProductStockRow {
  id: string;
  sku: string;
  name: string;
  avg_cost_cents: number;
  on_hand: number;
}

/** Lock the product row and its level so concurrent checkouts serialise. */
export async function lockProduct(
  tx: Database,
  productId: string,
  storeId: string,
): Promise<ProductStockRow | null> {
  const rows = await tx.query<ProductStockRow>(
    `SELECT p.id, p.sku, p.name, p.avg_cost_cents, coalesce(sl.on_hand, 0) AS on_hand
       FROM product p
       LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
      WHERE p.id = $1 AND p.store_id = $2 AND p.deleted_at IS NULL
      FOR UPDATE OF p`,
    [productId, storeId],
  );
  return rows.rows[0] ?? null;
}

export interface ApplyResult {
  movementId: string;
  onHand: number;
  avgCostCents: number;
}

/**
 * Append a ledger row and update the cached level atomically.
 *
 * An OUT movement that would take stock negative is rejected — the caller
 * decides whether that is a hard error (POS) or allowed (an approved write-off).
 */
export async function applyMovement(
  tx: Database,
  input: MovementInput,
  options: { allowNegative?: boolean } = {},
): Promise<ApplyResult> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw unprocessable('VALIDATION_FAILED', 'Movement quantity must be a positive integer.');
  }

  const product = await lockProduct(tx, input.productId, input.storeId);
  if (!product) throw unprocessable('NOT_FOUND', `Product ${input.productId} not found in this store.`);

  const currentOnHand = product.on_hand;
  const nextOnHand = input.direction === 'IN'
    ? currentOnHand + input.quantity
    : currentOnHand - input.quantity;

  if (nextOnHand < 0 && !options.allowNegative) {
    throw unprocessable(
      'INSUFFICIENT_STOCK',
      `Not enough on-hand stock for SKU ${product.sku}.`,
      [{ sku: product.sku, requested: input.quantity, available: currentOnHand }],
    );
  }

  const movement = await tx.query<{ id: string }>(
    `INSERT INTO stock_movement
       (product_id, store_id, direction, reason, quantity, unit_cost_cents, reference_type, reference_id, actor_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.productId, input.storeId, input.direction, input.reason, input.quantity,
      input.unitCostCents, input.referenceType ?? null, input.referenceId ?? null,
      input.actorId ?? null, input.note ?? null,
    ],
  );

  // Only receiving goods changes the cost basis. Consumption does not.
  const nextCost =
    input.direction === 'IN' && input.reason === 'PURCHASE'
      ? movingAverageCost(
          { onHand: currentOnHand, avgCostCents: product.avg_cost_cents },
          input.quantity,
          input.unitCostCents,
        ).avgCostCents
      : product.avg_cost_cents;

  await tx.query(
    `INSERT INTO stock_level (product_id, store_id, on_hand, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (product_id, store_id)
     DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`,
    [input.productId, input.storeId, nextOnHand],
  );

  if (nextCost !== product.avg_cost_cents) {
    await tx.query('UPDATE product SET avg_cost_cents = $1 WHERE id = $2', [nextCost, input.productId]);
  }

  return {
    movementId: movement.rows[0]?.id ?? '',
    onHand: nextOnHand,
    avgCostCents: nextCost,
  };
}

/** Recompute on-hand from the ledger. Used by the reconciliation job and tests. */
export async function recomputeLevel(tx: Database, productId: string, storeId: string): Promise<number> {
  const rows = await tx.query<{ on_hand: number }>(
    `SELECT coalesce(sum(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0)::int AS on_hand
       FROM stock_movement WHERE product_id = $1 AND store_id = $2`,
    [productId, storeId],
  );
  const onHand = rows.rows[0]?.on_hand ?? 0;
  await tx.query(
    `INSERT INTO stock_level (product_id, store_id, on_hand, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (product_id, store_id) DO UPDATE SET on_hand = EXCLUDED.on_hand, updated_at = now()`,
    [productId, storeId, onHand],
  );
  return onHand;
}

/** Daily units sold per product — the input to forecasting. */
export async function dailyDemandSeries(
  db: Database,
  productId: string,
  storeId: string,
  days: number,
): Promise<number[]> {
  const rows = await db.query<{ day: string; units: number }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            coalesce(sum(si.quantity - si.returned_qty), 0)::int AS units
       FROM generate_series(
              (now() AT TIME ZONE 'UTC')::date - ($3::int - 1),
              (now() AT TIME ZONE 'UTC')::date,
              interval '1 day') AS d(day)
       LEFT JOIN sale s
         ON s.store_id = $2
        AND s.status = 'ACTIVE'
        AND (s.occurred_at AT TIME ZONE 'UTC')::date = d.day::date
       LEFT JOIN sale_item si ON si.sale_id = s.id AND si.product_id = $1
      GROUP BY d.day
      ORDER BY d.day`,
    [productId, storeId, days],
  );
  return rows.rows.map((r) => r.units);
}

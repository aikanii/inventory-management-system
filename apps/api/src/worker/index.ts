/**
 * Background work.
 *
 * A durable queue backed by the `job_queue` table with an in-process poller.
 * The README specifies BullMQ on Redis for a multi-replica deployment; this
 * implementation keeps the same contract (enqueue a kind + payload, jobs run at
 * most once per claim, failures are retried with a bounded attempt count) so
 * swapping the transport does not touch any caller.
 */
import type { Database } from '../db/database.js';
import { forecast, isIntermittent, crostonDemandRate, SEASON_LENGTH } from '../domain/forecast.js';
import { reorderDecision } from '../domain/reorder.js';
import {
  checkAdjustmentSpike, checkBelowCostSale, checkCostCreep, checkVelocityBreak, type Finding,
} from '../domain/anomaly.js';
import { dailyDemandSeries } from '../services/stock.js';

export interface Queue {
  enqueue(kind: string, payload?: Record<string, unknown>): Promise<void>;
  start(intervalMs?: number): void;
  stop(): void;
  /** Run every pending job now. Used by the CLI and by tests. */
  drain(): Promise<{ ran: number; failed: number }>;
}

type Handler = (payload: Record<string, unknown>) => Promise<void>;

export function createQueue(db: Database, handlers: Record<string, Handler>): Queue {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  async function claimNext(): Promise<{ id: number; kind: string; payload: Record<string, unknown> } | null> {
    const rows = await db.query<{ id: number; kind: string; payload: Record<string, unknown> }>(
      `UPDATE job_queue SET status = 'RUNNING', attempts = attempts + 1, started_at = now()
        WHERE id = (SELECT id FROM job_queue WHERE status = 'PENDING' ORDER BY id LIMIT 1)
        RETURNING id, kind, payload`,
    );
    return rows.rows[0] ?? null;
  }

  async function drain(): Promise<{ ran: number; failed: number }> {
    if (running) return { ran: 0, failed: 0 };
    running = true;
    let ran = 0;
    let failed = 0;
    try {
      for (;;) {
        const job = await claimNext();
        if (!job) break;
        const handler = handlers[job.kind];
        try {
          if (!handler) throw new Error(`No handler registered for job kind "${job.kind}".`);
          await handler(job.payload ?? {});
          await db.query(
            `UPDATE job_queue SET status = 'DONE', finished_at = now(), last_error = NULL WHERE id = $1`,
            [job.id],
          );
          ran++;
        } catch (err) {
          failed++;
          const message = err instanceof Error ? err.message : String(err);
          const attempts = await db.query<{ attempts: number }>('SELECT attempts FROM job_queue WHERE id = $1', [job.id]);
          const next = (attempts.rows[0]?.attempts ?? 1) >= 3 ? 'FAILED' : 'PENDING';
          await db.query(
            `UPDATE job_queue SET status = $1, last_error = $2, finished_at = now() WHERE id = $3`,
            [next, message.slice(0, 500), job.id],
          );
        }
      }
    } finally {
      running = false;
    }
    return { ran, failed };
  }

  return {
    async enqueue(kind, payload = {}) {
      await db.query('INSERT INTO job_queue (kind, payload) VALUES ($1, $2::jsonb)', [kind, JSON.stringify(payload)]);
    },
    start(intervalMs = 5000) {
      if (timer) return;
      timer = setInterval(() => {
        void drain().catch((err) => console.error('queue drain failed', err));
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    drain,
  };
}

// ---------------------------------------------------------------- jobs

export const HISTORY_DAYS = 120;
export const FORECAST_HORIZON = 28;

/** Refresh forecasts for every active SKU, then re-derive reorder suggestions. */
export async function refreshForecasts(db: Database, storeId: string): Promise<{ products: number }> {
  const products = await db.query<{
    id: string; sku: string; reorder_point: number; target_cover_days: number; pack_size: number;
    supplier_lead_time_days: number | null; on_hand: number;
  }>(
    `SELECT p.id, p.sku, p.reorder_point, p.target_cover_days, p.pack_size,
            s.lead_time_days AS supplier_lead_time_days,
            coalesce(sl.on_hand, 0)::int AS on_hand
       FROM product p
       LEFT JOIN supplier s ON s.id = p.supplier_id
       LEFT JOIN stock_level sl ON sl.product_id = p.id AND sl.store_id = p.store_id
      WHERE p.store_id = $1 AND p.deleted_at IS NULL AND p.is_active`,
    [storeId],
  );

  for (const product of products.rows) {
    const history = await dailyDemandSeries(db, product.id, storeId, HISTORY_DAYS);
    const intermittent = isIntermittent(history);
    const result = forecast(history, FORECAST_HORIZON);

    const meanDailyDemand = intermittent
      ? crostonDemandRate(history)
      : result.meanDailyDemand;
    const model = intermittent ? 'croston' : result.model;

    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM forecast WHERE product_id = $1 AND store_id = $2', [product.id, storeId]);
      for (const point of result.points) {
        await tx.query(
          `INSERT INTO forecast
             (product_id, store_id, horizon_date, predicted_units, lower_bound, upper_bound, model, mape, feature_hash)
           VALUES ($1,$2, (now() AT TIME ZONE 'UTC')::date + $3::int, $4,$5,$6,$7,$8,$9)
           ON CONFLICT (product_id, horizon_date, model) DO UPDATE
             SET predicted_units = EXCLUDED.predicted_units,
                 lower_bound = EXCLUDED.lower_bound,
                 upper_bound = EXCLUDED.upper_bound,
                 mape = EXCLUDED.mape,
                 generated_at = now()`,
          [product.id, storeId, point.offsetDays, point.predictedUnits, point.lowerBound,
           point.upperBound, model, result.mape, `${history.length}:${history.reduce((a, b) => a + b, 0)}`],
        );
      }
    });

    const onOrder = await db.query<{ n: number }>(
      `SELECT coalesce(sum(i.quantity - i.received_qty),0)::int AS n
         FROM purchase_order_item i
         JOIN purchase_order po ON po.id = i.purchase_order_id
        WHERE i.product_id = $1 AND po.store_id = $2
          AND po.status IN ('SENT','PARTIALLY_RECEIVED')`,
      [product.id, storeId],
    );

    const inStocktake = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stocktake_line l
         JOIN stocktake st ON st.id = l.stocktake_id
        WHERE l.product_id = $1 AND st.store_id = $2 AND st.status = 'OPEN'`,
      [product.id, storeId],
    );

    const decision = reorderDecision({
      meanDailyDemand,
      stdDevDailyDemand: result.stdDevDailyDemand,
      leadTimeDays: product.supplier_lead_time_days ?? 3,
      targetCoverDays: product.target_cover_days,
      onHand: product.on_hand,
      onOrder: onOrder.rows[0]?.n ?? 0,
      packSize: product.pack_size,
      model,
      blocked: (inStocktake.rows[0]?.n ?? 0) > 0,
    });

    if (decision.shouldReorder) {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM reorder_suggestion
          WHERE product_id = $1 AND store_id = $2 AND status = 'SUGGESTED'`,
        [product.id, storeId],
      );
      if (existing.rows[0]) {
        await db.query(
          `UPDATE reorder_suggestion
              SET suggested_qty = $1, reorder_point = $2, on_hand = $3, on_order = $4,
                  days_of_cover = $5, detail = $6::jsonb, created_at = now()
            WHERE id = $7`,
          [decision.quantity, decision.reason.reorderPoint, decision.reason.onHand,
           decision.reason.onOrder, decision.reason.daysOfCover, JSON.stringify(decision.reason),
           existing.rows[0].id],
        );
      } else {
        await db.query(
          `INSERT INTO reorder_suggestion
             (product_id, store_id, suggested_qty, reorder_point, on_hand, on_order, days_of_cover, detail)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [product.id, storeId, decision.quantity, decision.reason.reorderPoint,
           decision.reason.onHand, decision.reason.onOrder, decision.reason.daysOfCover,
           JSON.stringify(decision.reason)],
        );
      }
    }
  }

  return { products: products.rows.length };
}

/** Screen a single sale the moment it lands — the cheap, always-on rules. */
export async function screenSale(db: Database, saleId: string, storeId: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  const lines = await db.query<{
    id: string; sku: string; unit_price_cents: number; unit_cost_cents: number;
    discount_cents: number; quantity: number;
  }>(
    `SELECT si.id, p.sku, si.unit_price_cents, si.unit_cost_cents, si.discount_cents, si.quantity
       FROM sale_item si JOIN product p ON p.id = si.product_id
      WHERE si.sale_id = $1`,
    [saleId],
  );
  for (const line of lines.rows) {
    const finding = checkBelowCostSale({
      saleItemId: line.id,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unit_price_cents,
      unitCostCents: line.unit_cost_cents,
      discountCents: line.discount_cents,
    });
    if (finding) findings.push(finding);
  }

  const sale = await db.query<{ id: string; cashier_id: string | null; subtotal_cents: number; discount_cents: number }>(
    'SELECT id, cashier_id, subtotal_cents, discount_cents FROM sale WHERE id = $1',
    [saleId],
  );
  const saleRow = sale.rows[0];
  if (saleRow?.cashier_id && saleRow.subtotal_cents > 0) {
    const history = await db.query<{ rate: number }>(
      `SELECT (discount_cents::numeric / nullif(subtotal_cents,0))::float8 AS rate
         FROM sale
        WHERE cashier_id = $1 AND status = 'ACTIVE' AND id <> $2
        ORDER BY occurred_at DESC LIMIT 60`,
      [saleRow.cashier_id, saleId],
    );
    const { checkDiscountOutlier } = await import('../domain/anomaly.js');
    const finding = checkDiscountOutlier({
      cashierId: saleRow.cashier_id,
      saleId,
      discountRate: saleRow.discount_cents / saleRow.subtotal_cents,
      history: history.rows.map((r) => r.rate),
    });
    if (finding) findings.push(finding);
  }

  await persistFindings(db, storeId, findings, 'sale', saleId);
  return findings;
}

/** Periodic sweep across the catalogue: velocity breaks, adjustment spikes, cost creep. */
export async function scanAnomalies(db: Database, storeId: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  const products = await db.query<{ id: string; sku: string; avg_cost_cents: number; selling_price_cents: number }>(
    `SELECT id, sku, avg_cost_cents, selling_price_cents FROM product
      WHERE store_id = $1 AND deleted_at IS NULL AND is_active`,
    [storeId],
  );

  for (const product of products.rows) {
    const history = await dailyDemandSeries(db, product.id, storeId, 35);
    const recent = history.slice(-7);
    const baseline = history.slice(0, 28);
    const velocity = checkVelocityBreak({
      productId: product.id,
      sku: product.sku,
      recentDailyUnits: recent,
      baselineDailyUnits: baseline,
    });
    if (velocity) findings.push(velocity);

    const adjustments = await db.query<{ id: string; value: number }>(
      `SELECT id, (quantity * unit_cost_cents)::int AS value FROM stock_movement
        WHERE product_id = $1 AND store_id = $2 AND reason IN ('ADJUSTMENT_UP','ADJUSTMENT_DOWN','SPOILAGE','DAMAGE')
        ORDER BY created_at DESC LIMIT 30`,
      [product.id, storeId],
    );
    const [latest, ...rest] = adjustments.rows;
    if (latest && rest.length >= 10) {
      const spike = checkAdjustmentSpike({
        movementId: latest.id,
        sku: product.sku,
        valueCents: latest.value,
        historyValuesCents: rest.map((r) => r.value),
      });
      if (spike) findings.push(spike);
    }

    const costs = await db.query<{ unit_cost_cents: number }>(
      `SELECT unit_cost_cents FROM stock_movement
        WHERE product_id = $1 AND reason = 'PURCHASE' ORDER BY created_at DESC LIMIT 2`,
      [product.id],
    );
    if (costs.rows.length === 2) {
      const creep = checkCostCreep({
        productId: product.id,
        sku: product.sku,
        previousCostCents: costs.rows[1]?.unit_cost_cents ?? 0,
        newCostCents: costs.rows[0]?.unit_cost_cents ?? 0,
        sellingPriceCents: product.selling_price_cents,
      });
      if (creep) findings.push(creep);
    }
  }

  // Historical below-cost lines: a sale written before screening existed, or
  // imported with the catalogue, still deserves to be surfaced.
  const belowCost = await db.query<{
    id: string; sku: string; unit_price_cents: number; unit_cost_cents: number;
    discount_cents: number; quantity: number;
  }>(
    `SELECT si.id, p.sku, si.unit_price_cents, si.unit_cost_cents, si.discount_cents, si.quantity
       FROM sale_item si
       JOIN sale s ON s.id = si.sale_id
       JOIN product p ON p.id = si.product_id
      WHERE s.store_id = $1 AND s.status = 'ACTIVE'
        AND (si.unit_price_cents - (si.discount_cents::numeric / nullif(si.quantity, 0))) <= si.unit_cost_cents
      ORDER BY s.occurred_at DESC LIMIT 25`,
    [storeId],
  );
  for (const line of belowCost.rows) {
    const finding = checkBelowCostSale({
      saleItemId: line.id,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceCents: line.unit_price_cents,
      unitCostCents: line.unit_cost_cents,
      discountCents: line.discount_cents,
    });
    if (finding) findings.push(finding);
  }

  await persistFindings(db, storeId, findings, 'product', null);
  return findings;
}

async function persistFindings(
  db: Database,
  storeId: string,
  findings: Finding[],
  defaultSubjectType: string,
  defaultSubjectId: string | null,
): Promise<void> {
  for (const finding of findings) {
    // Do not pile up duplicates for the same subject while one is still open.
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM anomaly
        WHERE store_id = $1 AND kind = $2 AND status = 'OPEN'
          AND subject_type = $3 AND coalesce(subject_id::text, '') = coalesce($4, '')`,
      [storeId, finding.kind, finding.subjectType, finding.subjectId ?? defaultSubjectId],
    );
    if (existing.rows[0]) continue;
    await db.query(
      `INSERT INTO anomaly (store_id, kind, severity, subject_type, subject_id, message, metric)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [storeId, finding.kind, finding.severity, finding.subjectType ?? defaultSubjectType,
       finding.subjectId ?? defaultSubjectId, finding.message, JSON.stringify(finding.metric)],
    );
  }
}

export function buildHandlers(db: Database): Record<string, Handler> {
  return {
    'forecast.refresh': async (payload) => {
      const storeId = String(payload.store_id ?? '');
      if (!storeId) throw new Error('forecast.refresh requires store_id');
      await refreshForecasts(db, storeId);
    },
    'anomaly.scan': async (payload) => {
      const storeId = String(payload.store_id ?? '');
      if (!storeId) throw new Error('anomaly.scan requires store_id');
      await scanAnomalies(db, storeId);
    },
    'sale.post-processed': async (payload) => {
      const saleId = String(payload.sale_id ?? '');
      const storeId = String(payload.store_id ?? '');
      if (!saleId || !storeId) throw new Error('sale.post-processed requires sale_id and store_id');
      await screenSale(db, saleId, storeId);
    },
  };
}

export { SEASON_LENGTH };

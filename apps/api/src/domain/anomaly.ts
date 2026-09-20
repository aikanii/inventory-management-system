/**
 * Anomaly screening.
 *
 * Cheap, explainable, always-on. Every finding carries the metric that
 * triggered it and the threshold it crossed, because an unexplained alert in a
 * small store gets ignored within a week. Nothing here takes action — the
 * system flags, the owner decides.
 */

import { mean, stdDev } from './forecast.js';

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Finding {
  kind: string;
  severity: Severity;
  subjectType: string;
  subjectId: string | null;
  message: string;
  metric: Record<string, unknown>;
}

/** A line sold at or below its cost basis: keying error or an unauthorised discount. */
export function checkBelowCostSale(line: {
  saleItemId?: string;
  sku: string;
  unitPriceCents: number;
  unitCostCents: number;
  /** Total discount on the line, in centavos. */
  discountCents: number;
  quantity: number;
}): Finding | null {
  const discountPerUnit = line.quantity > 0 ? line.discountCents / line.quantity : 0;
  const netUnitCents = line.unitPriceCents - discountPerUnit;
  if (netUnitCents > line.unitCostCents) return null;
  return {
    kind: 'BELOW_COST_SALE',
    severity: 'WARNING',
    subjectType: 'sale_item',
    subjectId: line.saleItemId ?? null,
    message: `${line.sku} sold at or below cost (net ${netUnitCents.toFixed(0)} vs cost ${line.unitCostCents} centavos).`,
    metric: {
      sku: line.sku,
      unitPriceCents: line.unitPriceCents,
      discountCents: line.discountCents,
      netUnitCents: Number(netUnitCents.toFixed(2)),
      unitCostCents: line.unitCostCents,
    },
  };
}

/** Discount rate more than n standard deviations above a cashier's own history. */
export function checkDiscountOutlier(input: {
  cashierId: string;
  saleId: string;
  discountRate: number;
  history: readonly number[];
  sigmaThreshold?: number;
}): Finding | null {
  const threshold = input.sigmaThreshold ?? 3;
  if (input.history.length < 10) return null;
  const sigma = stdDev(input.history);
  if (sigma <= 0) return null;
  const z = (input.discountRate - mean(input.history)) / sigma;
  if (z < threshold) return null;
  return {
    kind: 'DISCOUNT_OUTLIER',
    severity: 'WARNING',
    subjectType: 'sale',
    subjectId: input.saleId,
    message: `Discount rate ${(input.discountRate * 100).toFixed(1)}% is ${z.toFixed(1)}σ above this cashier's norm.`,
    metric: {
      cashierId: input.cashierId,
      discountRate: Number(input.discountRate.toFixed(4)),
      meanRate: Number(mean(input.history).toFixed(4)),
      sigma: Number(sigma.toFixed(4)),
      zScore: Number(z.toFixed(2)),
    },
  };
}

/** Seven-day velocity collapsed without a stock-out to explain it. */
export function checkVelocityBreak(input: {
  productId: string;
  sku: string;
  recentDailyUnits: readonly number[];
  baselineDailyUnits: readonly number[];
  ratioThreshold?: number;
}): Finding | null {
  const ratioThreshold = input.ratioThreshold ?? 0.4;
  if (input.baselineDailyUnits.length < 14) return null;
  const recent = mean(input.recentDailyUnits);
  const baseline = mean(input.baselineDailyUnits);
  if (baseline <= 0) return null;
  const ratio = recent / baseline;
  if (ratio > ratioThreshold) return null;
  return {
    kind: 'VELOCITY_BREAK',
    severity: 'INFO',
    subjectType: 'product',
    subjectId: input.productId,
    message: `${input.sku} velocity fell to ${(ratio * 100).toFixed(0)}% of its trailing average with stock available.`,
    metric: {
      sku: input.sku,
      recentMean: Number(recent.toFixed(2)),
      baselineMean: Number(baseline.toFixed(2)),
      ratio: Number(ratio.toFixed(3)),
    },
  };
}

/** A supplier's unit cost jumped without a matching price change — silent margin erosion. */
export function checkCostCreep(input: {
  productId: string;
  sku: string;
  previousCostCents: number;
  newCostCents: number;
  sellingPriceCents: number;
  thresholdPct?: number;
}): Finding | null {
  const thresholdPct = input.thresholdPct ?? 10;
  if (input.previousCostCents <= 0) return null;
  const increasePct = ((input.newCostCents - input.previousCostCents) / input.previousCostCents) * 100;
  if (increasePct < thresholdPct) return null;
  const marginBefore = marginPct(input.sellingPriceCents, input.previousCostCents);
  const marginAfter = marginPct(input.sellingPriceCents, input.newCostCents);
  return {
    kind: 'COST_CREEP',
    severity: increasePct >= thresholdPct * 2 ? 'CRITICAL' : 'WARNING',
    subjectType: 'product',
    subjectId: input.productId,
    message: `${input.sku} cost rose ${increasePct.toFixed(1)}% with no price change; margin ${marginBefore.toFixed(1)}% → ${marginAfter.toFixed(1)}%.`,
    metric: {
      sku: input.sku,
      previousCostCents: input.previousCostCents,
      newCostCents: input.newCostCents,
      increasePct: Number(increasePct.toFixed(2)),
      marginBeforePct: Number(marginBefore.toFixed(2)),
      marginAfterPct: Number(marginAfter.toFixed(2)),
    },
  };
}

/** An adjustment far larger than this outlet normally posts. */
export function checkAdjustmentSpike(input: {
  movementId: string;
  sku: string;
  valueCents: number;
  historyValuesCents: readonly number[];
  percentile?: number;
}): Finding | null {
  if (input.historyValuesCents.length < 10) return null;
  const sorted = [...input.historyValuesCents].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(((input.percentile ?? 95) / 100) * sorted.length));
  const cutoff = sorted[idx] ?? 0;
  if (input.valueCents <= cutoff) return null;
  return {
    kind: 'ADJUSTMENT_SPIKE',
    severity: 'WARNING',
    subjectType: 'stock_movement',
    subjectId: input.movementId,
    message: `${input.sku} adjustment of ${input.valueCents} centavos exceeds the outlet's 95th percentile (${cutoff}).`,
    metric: { sku: input.sku, valueCents: input.valueCents, cutoffCents: cutoff },
  };
}

/** Actual demand landed far outside the forecast's own backtested residual spread. */
export function checkForecastResidual(input: {
  productId: string;
  sku: string;
  predicted: number;
  actual: number;
  residualStdDev: number;
  sigmaThreshold?: number;
}): Finding | null {
  const sigmaThreshold = input.sigmaThreshold ?? 3;
  if (input.residualStdDev <= 0) return null;
  const residual = input.actual - input.predicted;
  const z = Math.abs(residual) / input.residualStdDev;
  if (z < sigmaThreshold) return null;
  return {
    kind: 'FORECAST_RESIDUAL',
    severity: z >= sigmaThreshold * 1.5 ? 'CRITICAL' : 'WARNING',
    subjectType: 'product',
    subjectId: input.productId,
    message: `${input.sku} sold ${input.actual} against a forecast of ${input.predicted.toFixed(1)} (${z.toFixed(1)}σ).`,
    metric: {
      sku: input.sku,
      predicted: Number(input.predicted.toFixed(2)),
      actual: input.actual,
      residualStdDev: Number(input.residualStdDev.toFixed(3)),
      zScore: Number(z.toFixed(2)),
    },
  };
}

function marginPct(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return ((priceCents - costCents) / priceCents) * 100;
}

/**
 * Replenishment maths.
 *
 * reorder point  = lead-time demand + safety stock
 * safety stock   = z × σ(daily demand) × √lead time
 * suggested qty  = round up to pack size, never below zero, never double-counting
 *                  stock that is already on an open purchase order.
 */

/** 95% cycle service level. */
export const Z_95 = 1.6449;

export interface ReorderPointInput {
  meanDailyDemand: number;
  stdDevDailyDemand: number;
  leadTimeDays: number;
  serviceLevelZ?: number;
}

export interface ReorderPointResult {
  leadTimeDemand: number;
  safetyStock: number;
  reorderPoint: number;
}

export function reorderPoint(input: ReorderPointInput): ReorderPointResult {
  const z = input.serviceLevelZ ?? Z_95;
  const leadTimeDemand = Math.max(0, input.meanDailyDemand) * Math.max(0, input.leadTimeDays);
  const safetyStock =
    z * Math.max(0, input.stdDevDailyDemand) * Math.sqrt(Math.max(0, input.leadTimeDays));
  return {
    leadTimeDemand,
    safetyStock,
    reorderPoint: Math.ceil(leadTimeDemand + safetyStock),
  };
}

export interface OrderQuantityInput {
  reorderPoint: number;
  targetCoverDays: number;
  meanDailyDemand: number;
  onHand: number;
  /** Units already on an unreceived purchase order. Suppresses double-ordering. */
  onOrder: number;
  packSize: number;
}

export function suggestedOrderQuantity(input: OrderQuantityInput): number {
  const target = input.reorderPoint + Math.max(0, input.targetCoverDays) * Math.max(0, input.meanDailyDemand);
  const raw = target - Math.max(0, input.onHand) - Math.max(0, input.onOrder);
  if (raw <= 0) return 0;
  return roundUpToPackSize(Math.ceil(raw), input.packSize);
}

export function roundUpToPackSize(quantity: number, packSize: number): number {
  const pack = packSize > 0 ? packSize : 1;
  return Math.ceil(quantity / pack) * pack;
}

export function daysOfCover(onHand: number, meanDailyDemand: number): number | null {
  if (meanDailyDemand <= 0) return null;
  return onHand / meanDailyDemand;
}

export interface SuggestionReason {
  onHand: number;
  onOrder: number;
  reorderPoint: number;
  leadTimeDemand: number;
  safetyStock: number;
  targetCoverDays: number;
  meanDailyDemand: number;
  daysOfCover: number | null;
  packSize: number;
  model: string;
}

export interface ReorderDecision {
  shouldReorder: boolean;
  quantity: number;
  reason: SuggestionReason;
}

export interface ReorderInput extends ReorderPointInput, Omit<OrderQuantityInput, 'reorderPoint'> {
  model?: string;
  /** A SKU inside an open stocktake has no trustworthy on-hand figure. */
  blocked?: boolean;
}

export function reorderDecision(input: ReorderInput): ReorderDecision {
  const rp = reorderPoint(input);
  const doc = daysOfCover(input.onHand, input.meanDailyDemand);
  const reason: SuggestionReason = {
    onHand: input.onHand,
    onOrder: input.onOrder,
    reorderPoint: rp.reorderPoint,
    leadTimeDemand: round2(rp.leadTimeDemand),
    safetyStock: round2(rp.safetyStock),
    targetCoverDays: input.targetCoverDays,
    meanDailyDemand: round2(input.meanDailyDemand),
    daysOfCover: doc === null ? null : round2(doc),
    packSize: input.packSize,
    model: input.model ?? 'seasonal-naive',
  };

  if (input.blocked) return { shouldReorder: false, quantity: 0, reason };

  const position = input.onHand + input.onOrder;
  const quantity = suggestedOrderQuantity({ ...input, reorderPoint: rp.reorderPoint });
  return { shouldReorder: position <= rp.reorderPoint && quantity > 0, quantity, reason };
}

function round2(v: number): number {
  return Number(v.toFixed(2));
}

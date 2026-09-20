/**
 * Money and costing maths. Pure functions — no I/O, no clock, no database.
 *
 * Every amount is an integer number of centavos. Tax rates are basis points
 * (1200 = 12%). These functions are the single definition of profitability in
 * the system; the API, the reports and the tests all call into them.
 */

export const BP_DENOMINATOR = 10_000;

/** Round half away from zero, the way a shopkeeper rounds. */
export function roundHalfUp(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export interface SaleLineInput {
  quantity: number;
  unitPriceCents: number;
  unitCostCents: number;
  discountCents?: number;
}

export interface SaleLineResult extends Required<SaleLineInput> {
  grossProfitCents: number;
}

/**
 * gross = (price - cost) × qty - discount
 *
 * The discount is applied against the line, so a discounted line can go
 * negative — that is the truth about the transaction and it must be visible.
 */
export function lineGrossProfit(line: SaleLineInput): number {
  const discount = line.discountCents ?? 0;
  return (line.unitPriceCents - line.unitCostCents) * line.quantity - discount;
}

export function computeSaleLine(line: SaleLineInput): SaleLineResult {
  const discountCents = line.discountCents ?? 0;
  return {
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    unitCostCents: line.unitCostCents,
    discountCents,
    grossProfitCents: lineGrossProfit(line),
  };
}

export type TaxMode = 'EXCLUSIVE' | 'INCLUSIVE';

export interface SaleTotalsInput {
  lines: readonly SaleLineInput[];
  vatRateBp: number;
  taxMode: TaxMode;
}

export interface SaleTotals {
  subtotalCents: number;
  discountCents: number;
  netRevenueCents: number;
  taxCents: number;
  totalCents: number;
  grossProfitCents: number;
  grossMarginPct: number;
  lines: SaleLineResult[];
}

/**
 * subtotal  = Σ price × qty          (before line discounts)
 * net       = subtotal - Σ discount
 * EXCLUSIVE : tax = net × rate,      total = net + tax
 * INCLUSIVE : total = net,           tax = net - net ÷ (1 + rate)
 *
 * Gross margin is always measured against net revenue, never against total:
 * VAT is the government's money, not margin.
 */
export function computeSaleTotals(input: SaleTotalsInput): SaleTotals {
  const lines = input.lines.map(computeSaleLine);
  const subtotalCents = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const discountCents = lines.reduce((s, l) => s + l.discountCents, 0);
  const netRevenueCents = subtotalCents - discountCents;
  const grossProfitCents = lines.reduce((s, l) => s + l.grossProfitCents, 0);

  const rate = input.vatRateBp / BP_DENOMINATOR;
  const taxCents =
    input.taxMode === 'EXCLUSIVE'
      ? roundHalfUp(netRevenueCents * rate)
      : netRevenueCents - roundHalfUp(netRevenueCents / (1 + rate));
  const totalCents = input.taxMode === 'EXCLUSIVE' ? netRevenueCents + taxCents : netRevenueCents;

  return {
    subtotalCents,
    discountCents,
    netRevenueCents,
    taxCents,
    totalCents,
    grossProfitCents,
    grossMarginPct: netRevenueCents === 0 ? 0 : (grossProfitCents / netRevenueCents) * 100,
    lines,
  };
}

export interface AverageCostState {
  onHand: number;
  avgCostCents: number;
}

/**
 * Moving weighted average cost. This is the only place the cost basis changes,
 * and it is called when goods are received.
 *
 * A negative resulting on-hand (oversold ledger) keeps the existing average
 * rather than producing a nonsense negative cost.
 */
export function movingAverageCost(
  state: AverageCostState,
  incomingQty: number,
  incomingUnitCostCents: number,
): AverageCostState {
  if (incomingQty <= 0) return { ...state };
  const newOnHand = state.onHand + incomingQty;
  if (newOnHand <= 0) {
    return { onHand: newOnHand, avgCostCents: state.avgCostCents };
  }
  const totalValue = state.onHand * state.avgCostCents + incomingQty * incomingUnitCostCents;
  return { onHand: newOnHand, avgCostCents: roundHalfUp(totalValue / newOnHand) };
}

/** COGS for a period, taken from the cost snapshots on sold lines. */
export function cogsFromLines(lines: readonly { unitCostCents: number; quantity: number }[]): number {
  return lines.reduce((s, l) => s + l.unitCostCents * l.quantity, 0);
}

export function inventoryTurnover(cogsCents: number, averageInventoryValueCents: number): number {
  if (averageInventoryValueCents <= 0) return 0;
  return cogsCents / averageInventoryValueCents;
}

export function grossMarginPct(grossProfitCents: number, netRevenueCents: number): number {
  if (netRevenueCents === 0) return 0;
  return (grossProfitCents / netRevenueCents) * 100;
}

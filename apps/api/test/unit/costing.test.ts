import { describe, expect, it } from 'vitest';
import {
  computeSaleLine, computeSaleTotals, cogsFromLines, grossMarginPct, inventoryTurnover,
  movingAverageCost, roundHalfUp,
} from '../../src/domain/costing.js';

describe('roundHalfUp', () => {
  it('rounds halves away from zero in both directions', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(2.4)).toBe(2);
  });
});

describe('lineGrossProfit', () => {
  it('subtracts the line discount from the margin', () => {
    expect(computeSaleLine({ quantity: 2, unitPriceCents: 5800, unitCostCents: 4750 }).grossProfitCents).toBe(2100);
    expect(computeSaleLine({ quantity: 1, unitPriceCents: 12500, unitCostCents: 10420, discountCents: 500 }).grossProfitCents).toBe(1580);
  });

  it('allows a negative line, because that is the truth about the transaction', () => {
    expect(computeSaleLine({ quantity: 1, unitPriceCents: 1000, unitCostCents: 1500 }).grossProfitCents).toBe(-500);
  });
});

describe('computeSaleTotals', () => {
  // These are the exact figures published in README section 5.4.
  const readmeExample = [
    { quantity: 2, unitPriceCents: 5800, unitCostCents: 4750, discountCents: 0 },
    { quantity: 1, unitPriceCents: 12500, unitCostCents: 10420, discountCents: 500 },
  ];

  it('reproduces the documented worked example under tax-exclusive pricing', () => {
    const totals = computeSaleTotals({ lines: readmeExample, vatRateBp: 1200, taxMode: 'EXCLUSIVE' });
    expect(totals.subtotalCents).toBe(24100);
    expect(totals.discountCents).toBe(500);
    expect(totals.netRevenueCents).toBe(23600);
    expect(totals.taxCents).toBe(2832);
    expect(totals.totalCents).toBe(26432);
    expect(totals.grossProfitCents).toBe(3680);
    expect(totals.grossMarginPct).toBeCloseTo(15.6, 1);
  });

  it('keeps VAT inside the total under tax-inclusive pricing', () => {
    const totals = computeSaleTotals({ lines: readmeExample, vatRateBp: 1200, taxMode: 'INCLUSIVE' });
    expect(totals.totalCents).toBe(23600);
    expect(totals.taxCents).toBe(23600 - Math.round(23600 / 1.12));
    expect(totals.netRevenueCents - totals.taxCents + totals.taxCents).toBe(23600);
  });

  it('measures margin against net revenue, never against the total', () => {
    const totals = computeSaleTotals({ lines: readmeExample, vatRateBp: 1200, taxMode: 'EXCLUSIVE' });
    expect(totals.grossProfitCents / totals.netRevenueCents * 100).toBeCloseTo(totals.grossMarginPct, 5);
    expect(totals.grossProfitCents / totals.totalCents * 100).not.toBeCloseTo(totals.grossMarginPct, 1);
  });

  it('does not divide by zero on an empty-margin sale', () => {
    const totals = computeSaleTotals({
      lines: [{ quantity: 1, unitPriceCents: 0, unitCostCents: 0 }],
      vatRateBp: 1200,
      taxMode: 'EXCLUSIVE',
    });
    expect(totals.grossMarginPct).toBe(0);
  });
});

describe('movingAverageCost', () => {
  it('blends incoming stock into the existing average', () => {
    // 10 units at 100, receive 10 at 120 -> 20 units at 110
    expect(movingAverageCost({ onHand: 10, avgCostCents: 100 }, 10, 120)).toEqual({
      onHand: 20,
      avgCostCents: 110,
    });
  });

  it('keeps the old average when the ledger is oversold', () => {
    expect(movingAverageCost({ onHand: -5, avgCostCents: 100 }, 3, 900)).toEqual({
      onHand: -2,
      avgCostCents: 100,
    });
  });

  it('ignores non-positive receipts', () => {
    expect(movingAverageCost({ onHand: 10, avgCostCents: 100 }, 0, 999)).toEqual({
      onHand: 10,
      avgCostCents: 100,
    });
  });
});

describe('derived metrics', () => {
  it('computes COGS from the cost snapshots on sold lines', () => {
    expect(cogsFromLines([
      { unitCostCents: 4750, quantity: 2 },
      { unitCostCents: 10420, quantity: 1 },
    ])).toBe(19920);
  });

  it('computes turnover and guards against a zero denominator', () => {
    expect(inventoryTurnover(2000, 1000)).toBe(2);
    expect(inventoryTurnover(2000, 0)).toBe(0);
    expect(grossMarginPct(250, 1000)).toBe(25);
    expect(grossMarginPct(250, 0)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import {
  backtest, crostonDemandRate, forecast, holtWinters, isIntermittent, seasonalNaive, stdDev, mean,
} from '../../src/domain/forecast.js';
import { reorderDecision, reorderPoint, roundUpToPackSize, suggestedOrderQuantity } from '../../src/domain/reorder.js';

/** Sixteen weeks of demand with a strong weekend lift and mild growth. */
function synthetic(weeks = 16, seed = 7): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: number[] = [];
  for (let d = 0; d < weeks * 7; d++) {
    const weekday = d % 7;
    const weekend = weekday === 5 || weekday === 6 ? 1.6 : 1;
    const trend = 1 + (d / (weeks * 7)) * 0.35;
    out.push(Math.max(0, Math.round((6 + rnd() * 3) * weekend * trend)));
  }
  return out;
}

describe('seasonalNaive', () => {
  it('repeats the same weekday from the last season', () => {
    const history = [1, 2, 3, 4, 5, 6, 7, 10, 20, 30, 40, 50, 60, 70];
    expect(seasonalNaive(history, 7)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('falls back to the mean when history is shorter than a season', () => {
    expect(seasonalNaive([2, 4, 6], 3)).toEqual([4, 4, 4]);
  });

  it('never returns a negative forecast', () => {
    expect(seasonalNaive([0, 0, 0, 0, 0, 0, 0], 7).every((v) => v >= 0)).toBe(true);
  });
});

describe('holtWinters', () => {
  it('tracks a trending seasonal series better than the baseline', () => {
    const history = synthetic();
    const naive = backtest(history, 'seasonal-naive', 7);
    const hw = backtest(history, 'holt-winters', 7);
    expect(hw.mape).not.toBeNull();
    expect(hw.mape!).toBeLessThan(naive.mape!);
  });

  it('degrades to the baseline when there is not enough history', () => {
    const short = [3, 4, 5, 6, 7, 8, 9];
    expect(holtWinters(short, 7)).toEqual(seasonalNaive(short, 7));
  });

  it('is deterministic for identical input', () => {
    const history = synthetic(12, 42);
    expect(holtWinters(history, 14)).toEqual(holtWinters(history, 14));
  });
});

describe('forecast', () => {
  it('publishes a point forecast with an 80% interval that contains the point', () => {
    const result = forecast(synthetic(), 14);
    expect(result.points).toHaveLength(14);
    for (const point of result.points) {
      expect(point.lowerBound).toBeLessThanOrEqual(point.predictedUnits);
      expect(point.upperBound).toBeGreaterThanOrEqual(point.predictedUnits);
      expect(point.lowerBound).toBeGreaterThanOrEqual(0);
    }
  });

  it('records which model won and its score', () => {
    const result = forecast(synthetic(), 7);
    expect(['seasonal-naive', 'holt-winters']).toContain(result.model);
    expect(result.baselineMape).not.toBeNull();
  });

  it('reports insufficient history instead of guessing', () => {
    const result = forecast([1, 2, 3], 7);
    expect(result.model).toBe('insufficient-history');
    expect(result.mape).toBeNull();
    expect(result.points).toHaveLength(7);
  });
});

describe('intermittent demand', () => {
  const sparse = [0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 0, 4, 0, 0];

  it('detects SKUs that mostly sell nothing', () => {
    expect(isIntermittent(sparse)).toBe(true);
    expect(isIntermittent([5, 6, 4, 7, 5, 6, 8])).toBe(false);
  });

  it('estimates a per-day rate with Croston smoothing', () => {
    const rate = crostonDemandRate(sparse);
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThan(mean(sparse) * 2);
  });
});

describe('reorder maths', () => {
  it('rounds up to the pack size', () => {
    expect(roundUpToPackSize(13, 12)).toBe(24);
    expect(roundUpToPackSize(24, 12)).toBe(24);
    expect(roundUpToPackSize(1, 1)).toBe(1);
  });

  it('adds safety stock on top of lead-time demand', () => {
    const rp = reorderPoint({ meanDailyDemand: 10, stdDevDailyDemand: 4, leadTimeDays: 4 });
    expect(rp.leadTimeDemand).toBe(40);
    expect(rp.safetyStock).toBeCloseTo(1.6449 * 4 * 2, 3);
    expect(rp.reorderPoint).toBe(Math.ceil(40 + rp.safetyStock));
  });

  it('never orders what is already on an open purchase order', () => {
    const base = {
      meanDailyDemand: 10, stdDevDailyDemand: 2, leadTimeDays: 3,
      targetCoverDays: 14, onHand: 10, packSize: 1,
    };
    const withoutOnOrder = suggestedOrderQuantity({ ...base, reorderPoint: 45, onOrder: 0 });
    const withOnOrder = suggestedOrderQuantity({ ...base, reorderPoint: 45, onOrder: withoutOnOrder });
    expect(withoutOnOrder).toBeGreaterThan(0);
    expect(withOnOrder).toBe(0);
  });

  it('suppresses a suggestion while a stocktake has the SKU locked', () => {
    const decision = reorderDecision({
      meanDailyDemand: 10, stdDevDailyDemand: 2, leadTimeDays: 3, targetCoverDays: 14,
      onHand: 0, onOrder: 0, packSize: 12, blocked: true,
    });
    expect(decision.shouldReorder).toBe(false);
    expect(decision.quantity).toBe(0);
    expect(decision.reason.reorderPoint).toBeGreaterThan(0);
  });

  it('explains itself with the numbers behind the quantity', () => {
    const decision = reorderDecision({
      meanDailyDemand: 8, stdDevDailyDemand: 3, leadTimeDays: 4, targetCoverDays: 14,
      onHand: 5, onOrder: 0, packSize: 10,
    });
    expect(decision.shouldReorder).toBe(true);
    expect(decision.quantity % 10).toBe(0);
    expect(decision.reason).toMatchObject({ onHand: 5, onOrder: 0, packSize: 10, targetCoverDays: 14 });
    expect(typeof decision.reason.safetyStock).toBe('number');
  });
});

describe('dispersion helpers', () => {
  it('computes sample standard deviation', () => {
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
    expect(stdDev([])).toBe(0);
    expect(stdDev([5])).toBe(0);
  });
});

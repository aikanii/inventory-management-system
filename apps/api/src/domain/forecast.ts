/**
 * Demand forecasting.
 *
 * Two models, always scored against each other on the store's own history:
 *   - seasonal naive : "same weekday last week" — the baseline that must be beaten
 *   - Holt-Winters   : additive trend + weekly seasonality
 *
 * A model is only used when it beats the baseline by a material margin, so a
 * noisy SKU can never be made worse by cleverness. Everything here is pure and
 * deterministic: no clock, no randomness, no I/O.
 */

export const SEASON_LENGTH = 7;
/** 80% two-sided interval => z = 1.2816 */
export const Z_80 = 1.2816;
const MIN_HISTORY = 2 * SEASON_LENGTH;
/** Holt-Winters must beat the baseline by this relative margin to be chosen. */
const IMPROVEMENT_MARGIN = 0.05;

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1));
}

export function clampNonNegative(values: readonly number[]): number[] {
  return values.map((v) => (v < 0 ? 0 : v));
}

export interface ModelParams {
  alpha: number;
  beta: number;
  gamma: number;
  seasonLength: number;
}

export const DEFAULT_PARAMS: ModelParams = { alpha: 0.35, beta: 0.05, gamma: 0.25, seasonLength: SEASON_LENGTH };

export type ModelName = 'seasonal-naive' | 'holt-winters' | 'insufficient-history';

/** "What sold on this weekday last week", repeated across the horizon. */
export function seasonalNaive(
  history: readonly number[],
  horizon: number,
  seasonLength: number = SEASON_LENGTH,
): number[] {
  if (history.length === 0) return new Array(horizon).fill(0);
  if (history.length < seasonLength) {
    const m = mean(history);
    return new Array(horizon).fill(Number(m.toFixed(3)));
  }
  const n = history.length;
  const out: number[] = [];
  for (let k = 1; k <= horizon; k++) {
    const sourceIndex = n - seasonLength + ((k - 1) % seasonLength);
    out.push(Math.max(0, history[sourceIndex] ?? 0));
  }
  return out;
}

/** Holt-Winters triple exponential smoothing with additive seasonality. */
export function holtWinters(
  history: readonly number[],
  horizon: number,
  params: ModelParams = DEFAULT_PARAMS,
): number[] {
  const L = params.seasonLength;
  const n = history.length;
  if (n < MIN_HISTORY) return seasonalNaive(history, horizon, L);

  const firstSeason = history.slice(0, L);
  const secondSeason = history.slice(L, 2 * L);
  let level = mean(firstSeason);
  let trend = (mean(secondSeason) - level) / L;
  const seasonals = firstSeason.map((v) => v - level);

  for (let t = L; t < n; t++) {
    const y = history[t] ?? 0;
    const idx = t % L;
    const previousLevel = level;
    level = params.alpha * (y - (seasonals[idx] ?? 0)) + (1 - params.alpha) * (level + trend);
    trend = params.beta * (level - previousLevel) + (1 - params.beta) * trend;
    seasonals[idx] = params.gamma * (y - level) + (1 - params.gamma) * (seasonals[idx] ?? 0);
  }

  const out: number[] = [];
  for (let k = 1; k <= horizon; k++) {
    const idx = (n + k - 1) % L;
    out.push(Math.max(0, level + k * trend + (seasonals[idx] ?? 0)));
  }
  return out;
}

export function forecastWith(
  model: ModelName,
  history: readonly number[],
  horizon: number,
  params: ModelParams = DEFAULT_PARAMS,
): number[] {
  return model === 'holt-winters'
    ? holtWinters(history, horizon, params)
    : seasonalNaive(history, horizon, params.seasonLength);
}

export interface BacktestResult {
  mape: number | null;
  bias: number;
  residuals: number[];
  folds: number;
}

/**
 * Expanding-window backtest. Fits on everything before the origin, predicts
 * `horizon` steps, compares with what actually happened. MAPE is computed only
 * over days with real demand — dividing by a zero actual is meaningless.
 */
export function backtest(
  history: readonly number[],
  model: ModelName,
  horizon: number,
  params: ModelParams = DEFAULT_PARAMS,
): BacktestResult {
  const minTrain = Math.max(MIN_HISTORY, horizon + params.seasonLength);
  const residuals: number[] = [];
  const absoluteErrors: number[] = [];
  const signed: number[] = [];
  let folds = 0;

  for (let origin = minTrain; origin + horizon <= history.length; origin++) {
    const train = history.slice(0, origin);
    const predicted = forecastWith(model, train, horizon, params);
    folds++;
    for (let k = 0; k < horizon; k++) {
      const actual = history[origin + k] ?? 0;
      const p = predicted[k] ?? 0;
      residuals.push(actual - p);
      signed.push(p - actual);
      if (actual > 0) absoluteErrors.push(Math.abs(actual - p) / actual);
    }
  }

  return {
    mape: absoluteErrors.length === 0 ? null : (mean(absoluteErrors) * 100),
    bias: mean(signed),
    residuals,
    folds,
  };
}

export interface ForecastPoint {
  offsetDays: number;
  predictedUnits: number;
  lowerBound: number;
  upperBound: number;
}

export interface ForecastResult {
  model: ModelName;
  mape: number | null;
  baselineMape: number | null;
  points: ForecastPoint[];
  meanDailyDemand: number;
  stdDevDailyDemand: number;
}

/**
 * Pick the better model, then publish an 80% interval derived from that
 * model's own backtest residuals — not from an arbitrary percentage.
 */
export function forecast(
  history: readonly number[],
  horizon: number,
  params: ModelParams = DEFAULT_PARAMS,
): ForecastResult {
  if (history.length < MIN_HISTORY) {
    const naive = seasonalNaive(history, horizon, params.seasonLength);
    const m = mean(history);
    return {
      model: 'insufficient-history',
      mape: null,
      baselineMape: null,
      meanDailyDemand: m,
      stdDevDailyDemand: stdDev(history),
      points: naive.map((p, i) => ({
        offsetDays: i + 1,
        predictedUnits: round3(p),
        lowerBound: round3(Math.max(0, p - (0.25 * p + 0.5))),
        upperBound: round3(p + (0.25 * p + 0.5)),
      })),
    };
  }

  const naiveScore = backtest(history, 'seasonal-naive', horizon, params);
  const hwScore = backtest(history, 'holt-winters', horizon, params);

  let model: ModelName = 'seasonal-naive';
  if (naiveScore.mape !== null && hwScore.mape !== null) {
    const improvement = (naiveScore.mape - hwScore.mape) / naiveScore.mape;
    if (improvement > IMPROVEMENT_MARGIN) model = 'holt-winters';
  } else if (naiveScore.mape === null && hwScore.mape !== null) {
    model = 'holt-winters';
  }

  const chosen = model === 'holt-winters' ? hwScore : naiveScore;
  const sigma = stdDev(chosen.residuals);
  const predicted = forecastWith(model, history, horizon, params);

  return {
    model,
    mape: chosen.mape,
    baselineMape: naiveScore.mape,
    meanDailyDemand: mean(history),
    stdDevDailyDemand: stdDev(history),
    points: predicted.map((p, i) => {
      const band = sigma > 0 ? Z_80 * sigma : 0.25 * p + 0.5;
      return {
        offsetDays: i + 1,
        predictedUnits: round3(p),
        lowerBound: round3(Math.max(0, p - band)),
        upperBound: round3(p + band),
      };
    }),
  };
}

/**
 * Croston-style smoothing for intermittent demand — SKUs that sell on fewer
 * than ~40% of days. Smoothing models chase the zeros and over-forecast these.
 */
export function crostonDemandRate(history: readonly number[], alpha = 0.15): number {
  let sizeEstimate = 0;
  let intervalEstimate = 0;
  let periodsSinceSale = 0;
  let initialised = false;

  for (const demand of history) {
    periodsSinceSale++;
    if (demand > 0) {
      if (!initialised) {
        sizeEstimate = demand;
        intervalEstimate = periodsSinceSale;
        initialised = true;
      } else {
        sizeEstimate = alpha * demand + (1 - alpha) * sizeEstimate;
        intervalEstimate = alpha * periodsSinceSale + (1 - alpha) * intervalEstimate;
      }
      periodsSinceSale = 0;
    }
  }
  if (!initialised || intervalEstimate <= 0) return 0;
  return sizeEstimate / intervalEstimate;
}

export function isIntermittent(history: readonly number[], threshold = 0.6): boolean {
  if (history.length === 0) return true;
  const zeros = history.filter((v) => v <= 0).length;
  return zeros / history.length > threshold;
}

function round3(v: number): number {
  return Number(v.toFixed(3));
}

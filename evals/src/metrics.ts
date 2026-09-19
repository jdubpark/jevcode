export interface EvalTargets {
  shouldSurfacePrecision: number;
  shouldSurfaceRecall: number;
  scoreMae: number;
  representationSetAccuracy: number;
}

export const SPEC16_TARGETS: EvalTargets = {
  shouldSurfacePrecision: 0.9,
  shouldSurfaceRecall: 0.85,
  scoreMae: 0.15,
  representationSetAccuracy: 0.75,
};

export interface BinaryScoreResult {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
}

export function binaryScores(
  predicted: readonly boolean[],
  expected: readonly boolean[],
): BinaryScoreResult {
  if (predicted.length !== expected.length) {
    throw new Error("predicted and expected must have the same length");
  }
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    const p = predicted[i] === true;
    const e = expected[i] === true;
    if (p && e) tp += 1;
    else if (p && !e) fp += 1;
    else if (!p && e) fn += 1;
    else tn += 1;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
  };
}

export function mae(
  predicted: readonly number[],
  expected: readonly number[],
): number {
  if (predicted.length !== expected.length) {
    throw new Error("predicted and expected must have the same length");
  }
  if (predicted.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    sum += Math.abs((predicted[i] ?? 0) - (expected[i] ?? 0));
  }
  return sum / predicted.length;
}

export interface SetAccuracyCase {
  predicted: string;
  acceptable: readonly string[];
}

export interface SetAccuracyResult {
  hits: number;
  total: number;
  accuracy: number | null;
}

export function setAccuracy(cases: readonly SetAccuracyCase[]): SetAccuracyResult {
  const hits = cases.filter((entry) => entry.acceptable.includes(entry.predicted))
    .length;
  return {
    hits,
    total: cases.length,
    accuracy: cases.length > 0 ? hits / cases.length : null,
  };
}

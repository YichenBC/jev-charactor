import type { EvaluationManifest, EvaluationMetrics, EvaluationRecord, EvaluationSummary } from './types.js';

function nearestRank(values: number[], probability: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(probability * sorted.length) - 1];
}
function metrics(records: readonly EvaluationRecord[], plannedCount: number): EvaluationMetrics {
  const validAnswerCount = records.filter(record => record.status === 'valid-answer').length;
  const acceptableCount = records.filter(record => record.status === 'valid-answer' && record.acceptable).length;
  const knownCosts = records.flatMap(record => record.costUSD === null ? [] : [record.costUSD]);
  const knownCostUSD = knownCosts.reduce((sum, cost) => sum + cost, 0);
  const unknownCostCount = records.length - knownCosts.length;
  const failures: Record<string, number> = {};
  for (const record of records) {
    if (record.status === 'valid-answer') continue;
    const reason = record.errorCode ?? record.status;
    failures[reason] = (failures[reason] ?? 0) + 1;
  }
  const latencies = records.map(record => record.latencyMs);
  return {
    plannedCount, attemptedCount: records.length, unattemptedCount: plannedCount - records.length,
    validAnswerCount, failureCount: records.length - validAnswerCount, acceptableCount,
    validAnswerRate: plannedCount ? validAnswerCount / plannedCount : null,
    acceptableRateAllTrials: plannedCount ? acceptableCount / plannedCount : null,
    acceptableRateValidAnswers: validAnswerCount ? acceptableCount / validAnswerCount : null,
    latencyMs: { p50: nearestRank(latencies, 0.5), p95: nearestRank(latencies, 0.95) },
    knownCostUSD, totalCostUSD: unknownCostCount ? null : knownCostUSD,
    knownCostCount: knownCosts.length, unknownCostCount, outstandingRequestCount: 0, failures,
  };
}

/** Planned opportunities stay in the primary denominator even when a run stops early. */
export function summarizeRecords(
  records: readonly EvaluationRecord[], plannedCount = records.length, plannedByFamily?: Record<string, number>,
): EvaluationSummary {
  if (!Number.isSafeInteger(plannedCount) || plannedCount < records.length) throw new Error('Invalid planned count');
  if (plannedByFamily && (Object.values(plannedByFamily).some(count => !Number.isSafeInteger(count) || count < 0) ||
      Object.values(plannedByFamily).reduce((sum, count) => sum + count, 0) !== plannedCount)) {
    throw new Error('Family planned counts must sum to total planned count');
  }
  if (plannedByFamily && records.some(record => !Object.hasOwn(plannedByFamily, record.familyId))) throw new Error('Missing family planned count');
  const families = new Map<string, EvaluationRecord[]>();
  for (const family of Object.keys(plannedByFamily ?? {})) families.set(family, []);
  for (const record of records) {
    if (!families.has(record.familyId)) families.set(record.familyId, []);
    families.get(record.familyId)!.push(record);
  }
  const byFamily = Object.fromEntries([...families].map(([family, values]) => {
    const count = plannedByFamily?.[family] ?? values.length;
    if (!Number.isSafeInteger(count) || count < values.length) throw new Error('Invalid family planned count');
    return [family, metrics(values, count)];
  }));
  return { ...metrics(records, plannedCount), byFamily };
}

/** Reconcile crash checkpoints against durable records before interpreting total billing. */
export function summarizeRun(records: readonly EvaluationRecord[], manifest: EvaluationManifest): EvaluationSummary {
  const plannedByFamily: Record<string, number> = Object.fromEntries(manifest.cases.map(item => [item.familyId, 0]));
  for (const item of manifest.cases) plannedByFamily[item.familyId] += manifest.config.repeats;
  const summary = summarizeRecords(records, manifest.plannedCount, plannedByFamily);
  const pending = manifest.inFlight;
  if (pending && !records.some(record => record.sequence === pending.sequence)) {
    summary.outstandingRequestCount = 1;
    summary.totalCostUSD = null;
    const family = manifest.cases.find(item => item.id === pending.caseId)?.familyId;
    if (family === undefined) throw new Error('Unknown in-flight case');
    summary.byFamily[family].outstandingRequestCount = 1;
    summary.byFamily[family].totalCostUSD = null;
  }
  return summary;
}

import type { ControlledPair } from './controlled-character-cases';
import type { EvaluationRecord } from './types';

export function controlledPairReport(definitions: ControlledPair[], records: EvaluationRecord[], repeats: number) {
  const indexed = new Map<string, EvaluationRecord>();
  for (const record of records) {
    const key = JSON.stringify([record.caseId, record.trial]);
    if (indexed.has(key)) throw new Error('Duplicate case/trial evidence');
    indexed.set(key, record);
  }
  const pairs = definitions.flatMap(pair => Array.from({ length: repeats }, (_, i) => {
    const trial = i + 1, matched = pair.caseIds.map(id => indexed.get(JSON.stringify([id, trial])));
    const complete = matched.every(r => r?.status === 'valid-answer' && r.response !== null);
    const actualChange = complete ? matched[0]!.response!.choice !== matched[1]!.response!.choice : null;
    const bothCorrect = complete && matched.every(r => r!.acceptable);
    return { ...pair, trial, complete, actualChange, bothCorrect,
      success: bothCorrect && actualChange === (pair.expectedRelation === 'change'),
      statuses: matched.map(r => r?.status ?? 'unattempted'), choices: matched.map(r => r?.response?.choice ?? null) };
  }));
  return { scope: 'Synthetic development-only authored contract compliance; human character quality and true-world correctness are unmeasured.',
    plannedPairs: pairs.length, completePairs: pairs.filter(p => p.complete).length,
    incompletePairs: pairs.filter(p => !p.complete).length, successfulPairs: pairs.filter(p => p.success).length,
    expectedChangePairs: pairs.filter(p => p.expectedRelation === 'change').length,
    expectedInvariancePairs: pairs.filter(p => p.expectedRelation === 'invariance').length, pairs };
}

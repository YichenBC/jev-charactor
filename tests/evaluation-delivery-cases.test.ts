import { describe, expect, it } from 'vitest';
import { deliveryCases, prepareDeliveryCase, summarizeDelivery, verifyDeliveryExecution } from '../scripts/evaluation/delivery-cases';
import { prepareScenario } from '../scripts/evaluate-characters';
import { decisionInput } from '../server/jev';
import { getOptions, loadWorld, serializeWorld } from '../src/sim';
import type { EvaluationCase, EvaluationRecord } from '../scripts/evaluation/types';

function record(scenario: EvaluationCase, trial = 1): EvaluationRecord {
  const forgiving = scenario.id.includes('/forgiving/'), timely = scenario.id.includes('/timely/');
  const choice = timely ? forgiving ? 'receive_tip' : 'receive_exact' : forgiving ? 'receive_reduced' : 'refuse_delivery';
  return { schemaVersion: 1, sequence: trial, caseId: scenario.id, familyId: scenario.familyId, split: 'development', trial,
    permutationSeed: `test-${trial}`, startedAt: '2026-09-26T00:00:00.000Z', finishedAt: '2026-09-26T00:00:00.001Z',
    provider: { id: 'synthetic-test', requestedModel: 'fixture-v1', responseModel: 'fixture-v1' }, input: structuredClone(scenario.input),
    scoring: { acceptableChoices: scenario.acceptableChoices, rationale: scenario.rationale, tags: scenario.tags },
    response: { choice, affect: forgiving ? 'warm' : 'irritated', latencyMs: 1 }, status: 'valid-answer', errorCode: null, acceptable: true, latencyMs: 1, costUSD: 0,
  };
}

describe('controlled delivery development fixtures', () => {
  it('reuses all sixteen old cells without changing legacy inputs and keeps labels descriptive only', () => {
    const cases = deliveryCases(); expect(cases).toHaveLength(16); expect(cases).toEqual(deliveryCases());
    expect(new Set(cases.map(scenario => scenario.id)).size).toBe(16);
    for (const scenario of cases) {
      const prepared = prepareDeliveryCase(scenario.id), legacy = prepareScenario(prepared.factors);
      expect(scenario.tags).toContain('descriptive-only'); expect(scenario.split).toBe('development');
      expect(scenario.rationale).toContain('not personality accuracy');
      expect(scenario.rationale).toContain('late and cold');
      expect(scenario.rationale).toContain('not a normal timely-gameplay menu');
      expect(decisionInput.safeParse(scenario.input).success).toBe(true);
      expect(scenario.acceptableChoices).toEqual(getOptions(prepared.world, prepared.npcId).map(option => option.id));
      expect(scenario.input.state.situation).not.toHaveProperty('options');
      expect(legacy.input.state.situation).toHaveProperty('options');
      const legacyInput = structuredClone(legacy.input); delete (legacyInput.state.situation as Record<string, unknown>).options;
      expect(scenario.input).toEqual(legacyInput);
      expect(scenario.input).not.toHaveProperty('acceptableChoices'); expect(scenario.input.state).not.toHaveProperty('rationale');
      expect(loadWorld(serializeWorld(prepared.world))).not.toBeNull();
    }
  });
  it('replays every legal settlement through the engine with matching payout and commitment', () => {
    for (const scenario of deliveryCases()) for (const choice of scenario.acceptableChoices) {
      const { order } = prepareDeliveryCase(scenario.id);
      const result = verifyDeliveryExecution(scenario.id, choice, 'focused');
      const payout = choice === 'receive_tip' ? order.reward + 6 : choice === 'receive_exact' ? order.reward : choice === 'receive_reduced' ? Math.ceil(order.reward * .6) : 0;
      expect(result).toMatchObject({ applied: true, validSave: true, moneyDelta: payout,
        settlement: { status: choice === 'refuse_delivery' ? 'rejected' : 'delivered', payout, commitment: choice === 'refuse_delivery' ? 'broken' : 'fulfilled' } });
      expect(result.text).toEqual(expect.any(String)); expect(result.text!.length).toBeGreaterThan(0);
      expect(result.decisions).toHaveLength(1); expect(result.decisions[0].choice).toBe(choice);
    }
  });
  it('rejects unknown IDs and illegal outcomes without substituting a settlement', () => {
    expect(() => prepareDeliveryCase('delivery/unknown')).toThrow('Unknown delivery development case');
    const result = verifyDeliveryExecution('delivery/impatient/timely/reliable/unexplained', 'refuse_delivery', 'focused');
    expect(result).toMatchObject({ applied: false, validSave: true, moneyDelta: 0, settlement: { status: 'carrying', payout: 0, commitment: 'active' }, decisions: [] });
  });
});

describe('descriptive delivery pairing', () => {
  it('matches same-trial factor pairs, reports ordinal direction, and separates candidate-space changes', () => {
    const summary = summarizeDelivery(deliveryCases().map(scenario => record(scenario)));
    expect(summary).toMatchObject({ analysis: 'descriptive-only', observedTrials: [1], expectedRecordsForObservedTrials: 16, validRecords: 16, invalidRecords: 0, missingRecords: 0 });
    expect(summary.factors.persona).toMatchObject({ plannedEligiblePairs: 8, validPairs: 8, changedAction: 8, changedAffect: 8, generosityDirection: { increase: 8, decrease: 0, same: 0 }, candidateSets: { same: 8, different: 0, unknown: 0 } });
    expect(summary.factors.timing).toMatchObject({ plannedEligiblePairs: 8, validPairs: 8, generosityDirection: { increase: 0, decrease: 8, same: 0 }, candidateSets: { same: 0, different: 8, unknown: 0 } });
    expect(summary.factors.history.changedAction).toBe(0); expect(summary.factors.explanation.changedAffect).toBe(0);
    expect(summary.factors.persona.pairs[0]).toMatchObject({ trial: 1, valid: true, sameCandidateSet: true, generosityDelta: 1 });
    expect(summary.stability.every(item => item.allValidChoicesSame === null)).toBe(true);
  });
  it('counts failures and missing cells in eligible-pair denominators instead of dropping them', () => {
    const records = deliveryCases().map(scenario => record(scenario));
    records.shift(); records[0] = { ...records[0], status: 'error', response: null, errorCode: 'timeout', acceptable: false, costUSD: null };
    const summary = summarizeDelivery(records);
    expect(summary).toMatchObject({ observedTrials: [1], expectedRecordsForObservedTrials: 16, validRecords: 14, invalidRecords: 1, missingRecords: 1 });
    expect(summary.factors.persona).toMatchObject({ plannedEligiblePairs: 8, validPairs: 7, missingPairs: 1, invalidPairs: 1, unavailablePairs: 1 });
    expect(summary.factors.timing).toMatchObject({ plannedEligiblePairs: 8, validPairs: 6, missingPairs: 1, invalidPairs: 1, unavailablePairs: 2 });
    expect(summary.factors.persona.pairs.filter(pair => !pair.valid)).toEqual([expect.objectContaining({ missingRecords: 1, invalidRecords: 1, generosityDelta: null, changedAction: null })]);
  });
  it('reports repeat choice stability and uncertainty separately from inter-factor changes', () => {
    const cases = deliveryCases(), records = cases.flatMap(scenario => [record(scenario, 1), record(scenario, 2)]);
    records[1].response!.choice = 'receive_tip';
    records[3] = { ...records[3], status: 'invalid-answer', acceptable: false, errorCode: 'invalid_response' };
    records.splice(5, 1);
    const summary = summarizeDelivery(records);
    expect(summary.observedTrials).toEqual([1, 2]); expect(summary.factors.persona.plannedEligiblePairs).toBe(16);
    expect(summary.stability[0]).toMatchObject({ caseId: cases[0].id, plannedTrials: 2, validTrials: 2, failedTrials: 0, missingTrials: 0, allValidChoicesSame: false, eligibleRepeatPairs: 1, validRepeatPairs: 1, changedChoicePairs: 1 });
    expect(summary.stability[1]).toMatchObject({ validTrials: 1, failedTrials: 1, allValidChoicesSame: null, validRepeatPairs: 0 });
    expect(summary.stability[2]).toMatchObject({ validTrials: 1, missingTrials: 1, allValidChoicesSame: null });
    expect(summary.stability[3]).toMatchObject({ validTrials: 2, allValidChoicesSame: true, sameChoicePairs: 1 });
  });
  it('handles observed trial scope honestly and rejects cross-provider or ambiguous records', () => {
    expect(summarizeDelivery([])).toMatchObject({ observedTrials: [], expectedRecordsForObservedTrials: 0, missingRecords: 0 });
    const cases = deliveryCases(), first = record(cases[0], 4), second = record(cases[1], 4);
    expect(summarizeDelivery([first])).toMatchObject({ observedTrials: [4], expectedRecordsForObservedTrials: 16, missingRecords: 15 });
    expect(() => summarizeDelivery([{ ...first, caseId: 'mei/social-lonely' }])).toThrow('Unknown delivery development case');
    expect(() => summarizeDelivery([first, first])).toThrow('Duplicate delivery case and trial');
    expect(() => summarizeDelivery([first, { ...second, provider: { ...second.provider, id: 'another-provider' } }])).toThrow('Use a single provider and requested model');
  });
  it('does not trust a valid status with an invalid choice, affect, or upstream contract', () => {
    const records = deliveryCases().slice(0, 3).map(scenario => record(scenario));
    records[0].response!.choice = 'invented'; records[1].response!.affect = 'invented'; records[2].response!.contractValid = false;
    expect(summarizeDelivery(records)).toMatchObject({ validRecords: 0, invalidRecords: 3, missingRecords: 13 });
  });
});

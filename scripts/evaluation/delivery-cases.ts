import assert from 'node:assert/strict';
import { prepareScenario, type Scenario } from '../evaluate-characters';
import { REACTION_OPTIONS } from '../../src/character';
import { applyDecision, loadWorld, serializeWorld } from '../../src/sim';
import type { EvaluationCase, EvaluationRecord } from './types';

const factorValues = {
  persona: ['impatient', 'forgiving'], timing: ['timely', 'late_cold'],
  history: ['reliable', 'repeated_broken'], explanation: [false, true],
} as const;
type Factor = keyof Scenario;
const factorNames = ['persona', 'timing', 'history', 'explanation'] as const;
const configurations: Scenario[] = [];
for (const timing of factorValues.timing) for (const history of factorValues.history)
  for (const explanation of factorValues.explanation) for (const persona of factorValues.persona)
    configurations.push({ persona, timing, history, explanation });
const caseId = (scenario: Scenario) => `delivery/${scenario.persona}/${scenario.timing}/${scenario.history}/${scenario.explanation ? 'explained' : 'unexplained'}`;
const configurationsById = new Map(configurations.map(scenario => [caseId(scenario), scenario]));
const generosity: Record<string, number> = { receive_tip: 2, receive_exact: 1, receive_reduced: 0, refuse_delivery: -1 };

function factorsFor(id: string): Scenario {
  const factors = configurationsById.get(id);
  assert(factors, 'Unknown delivery development case');
  return { ...factors };
}

/** Reuse the legacy controlled setup; its CLI and model-visible input remain unchanged. */
export function prepareDeliveryCase(id: string) {
  const factors = factorsFor(id);
  const { world, npc, order, input } = prepareScenario(factors);
  delete (input.state.situation as Record<string, unknown>).options;
  const scenario: EvaluationCase = {
    id, familyId: 'controlled-delivery-response', split: 'development', input,
    acceptableChoices: input.options.map(option => option.id),
    rationale: 'Authored development, descriptive-only: all legal settlement choices are acceptable for mechanical coverage, not personality accuracy. Persona jointly changes traits, values and speaking style; prior reliable/broken deliveries and heard explanations are fictional interventions. Timing jointly changes late and cold status and the legal candidate set. The timely/explained statement is a controlled intervention, not a normal timely-gameplay menu. No label establishes which personality response is correct.',
    tags: ['authored', 'descriptive-only', 'controlled-delivery', 'scenario-version:1',
      `persona:${factors.persona}`, `timing:${factors.timing}`, `history:${factors.history}`, `explanation:${factors.explanation ? 'explained' : 'unexplained'}`],
  };
  return { scenario, world, npcId: npc.id, order, factors };
}

export function deliveryCases(): EvaluationCase[] {
  return configurations.map(factors => prepareDeliveryCase(caseId(factors)).scenario);
}

/** The recorded selection is applied once, without retries, substitution, or invented later choices. */
export function verifyDeliveryExecution(id: string, choice: string, affect: string) {
  const { world, npcId, order } = prepareDeliveryCase(id);
  const npc = world.npcs.find(candidate => candidate.id === npcId)!;
  const selectedAffect = REACTION_OPTIONS.find(option => option.id === affect)?.id;
  assert(selectedAffect, 'Unknown evaluation affect');
  const money = world.player.money, firstDecision = world.decisions.length;
  const applied = applyDecision(world, npcId, choice, 'delivery-evaluation-replay', { revision: npc.revision, affect: selectedAffect });
  return {
    applied, validSave: loadWorld(serializeWorld(world)) !== null, npcId, text: applied ? npc.bubble ?? null : null,
    settlement: { status: order.status, payout: order.payout ?? 0, commitment: npc.mind.commitments.find(commitment => commitment.id === order.id)?.status ?? null },
    moneyDelta: world.player.money - money, decisions: world.decisions.slice(firstDecision),
  };
}

function validRecord(record: EvaluationRecord | undefined): record is EvaluationRecord & { response: NonNullable<EvaluationRecord['response']> } {
  if (!record || record.status !== 'valid-answer' || !record.response || record.response.contractValid === false) return false;
  const legal = factorsFor(record.caseId).timing === 'timely'
    ? ['receive_exact', 'receive_tip'] : ['receive_exact', 'receive_reduced', 'refuse_delivery'];
  return legal.includes(record.response.choice) && record.input.options.some(option => option.id === record.response!.choice) &&
    REACTION_OPTIONS.some(option => option.id === record.response!.affect);
}
const recordKey = (id: string, trial: number) => JSON.stringify([id, trial]);
const candidateKey = (record: EvaluationRecord) => JSON.stringify([...new Set(record.input.options.map(option => option.id))].sort());
const chooseTwo = (count: number) => count * (count - 1) / 2;

function summarizeFactor(factor: Factor, trials: number[], byKey: Map<string, EvaluationRecord>) {
  const pairs = trials.flatMap(trial => configurations.filter(factors => factors[factor] === factorValues[factor][0]).map(from => {
    const to = { ...from, [factor]: factorValues[factor][1] } as Scenario;
    const aId = caseId(from), bId = caseId(to), a = byKey.get(recordKey(aId, trial)), b = byKey.get(recordKey(bId, trial));
    const aValid = validRecord(a), bValid = validRecord(b), valid = aValid && bValid;
    return {
      trial, from: aId, to: bId, valid,
      fromStatus: a?.status ?? 'missing', toStatus: b?.status ?? 'missing',
      missingRecords: Number(!a) + Number(!b), invalidRecords: Number(Boolean(a) && !aValid) + Number(Boolean(b) && !bValid),
      sameCandidateSet: a && b ? candidateKey(a) === candidateKey(b) : null,
      sameResponseModel: a && b && a.provider.responseModel && b.provider.responseModel ? a.provider.responseModel === b.provider.responseModel : null,
      choices: [a?.response?.choice ?? null, b?.response?.choice ?? null], affects: [a?.response?.affect ?? null, b?.response?.affect ?? null],
      changedAction: valid ? a.response.choice !== b.response.choice : null,
      changedAffect: valid ? a.response.affect !== b.response.affect : null,
      generosityDelta: valid ? generosity[b.response.choice] - generosity[a.response.choice] : null,
    };
  }));
  const valid = pairs.filter(pair => pair.valid);
  return {
    direction: factor === 'explanation' ? 'unexplained -> explained' : `${factorValues[factor][0]} -> ${factorValues[factor][1]}`,
    plannedEligiblePairs: pairs.length, validPairs: valid.length, unavailablePairs: pairs.length - valid.length,
    missingPairs: pairs.filter(pair => pair.missingRecords > 0).length,
    invalidPairs: pairs.filter(pair => pair.invalidRecords > 0).length,
    changedAction: valid.filter(pair => pair.changedAction).length, changedAffect: valid.filter(pair => pair.changedAffect).length,
    generosityDirection: {
      increase: valid.filter(pair => pair.generosityDelta! > 0).length,
      decrease: valid.filter(pair => pair.generosityDelta! < 0).length,
      same: valid.filter(pair => pair.generosityDelta === 0).length,
    },
    candidateSets: {
      same: pairs.filter(pair => pair.sameCandidateSet === true).length,
      different: pairs.filter(pair => pair.sameCandidateSet === false).length,
      unknown: pairs.filter(pair => pair.sameCandidateSet === null).length,
    },
    pairs,
  };
}

/** Descriptive comparisons only. Trial IDs absent from every record cannot be inferred without a manifest. */
export function summarizeDelivery(records: EvaluationRecord[]) {
  const byKey = new Map<string, EvaluationRecord>();
  const providers = new Set<string>();
  for (const record of records) {
    factorsFor(record.caseId);
    assert(record.split === 'development', 'Delivery fixtures must be development records');
    assert(Number.isSafeInteger(record.trial) && record.trial >= 1 && record.trial <= 20, 'Invalid delivery trial');
    const key = recordKey(record.caseId, record.trial);
    assert(!byKey.has(key), 'Duplicate delivery case and trial');
    byKey.set(key, record);
    providers.add(JSON.stringify([record.provider.id, record.provider.requestedModel]));
  }
  assert(providers.size <= 1, 'Use a single provider and requested model');
  const observedTrials = [...new Set(records.map(record => record.trial))].sort((a, b) => a - b);
  const validRecords = records.filter(validRecord).length;
  const expectedRecordsForObservedTrials = configurations.length * observedTrials.length;
  const factors = Object.fromEntries(factorNames.map(factor => [factor, summarizeFactor(factor, observedTrials, byKey)])) as Record<Factor, ReturnType<typeof summarizeFactor>>;
  const stability = configurations.map(configuration => {
    const id = caseId(configuration);
    const available = observedTrials.flatMap(trial => {
      const record = byKey.get(recordKey(id, trial)); return record ? [record] : [];
    });
    const valid = available.filter(validRecord);
    const choices = [...new Set(valid.map(record => record.response.choice))];
    const affects = [...new Set(valid.map(record => record.response.affect))];
    let sameChoicePairs = 0, sameAffectPairs = 0;
    for (let a = 0; a < valid.length; a++) for (let b = a + 1; b < valid.length; b++) {
      if (valid[a].response.choice === valid[b].response.choice) sameChoicePairs++;
      if (valid[a].response.affect === valid[b].response.affect) sameAffectPairs++;
    }
    const validRepeatPairs = chooseTwo(valid.length);
    return {
      caseId: id, plannedTrials: observedTrials.length, recordedTrials: available.length, validTrials: valid.length,
      failedTrials: available.length - valid.length, missingTrials: observedTrials.length - available.length,
      distinctChoices: choices, distinctAffects: affects,
      allValidChoicesSame: valid.length >= 2 ? choices.length === 1 : null,
      eligibleRepeatPairs: chooseTwo(observedTrials.length), validRepeatPairs,
      sameChoicePairs, changedChoicePairs: validRepeatPairs - sameChoicePairs,
      sameAffectPairs, changedAffectPairs: validRepeatPairs - sameAffectPairs,
    };
  });
  return {
    analysis: 'descriptive-only' as const, observedTrials, expectedRecordsForObservedTrials,
    recordedRecords: records.length, validRecords, invalidRecords: records.length - validRecords,
    missingRecords: expectedRecordsForObservedTrials - records.length,
    generosityScale: { ...generosity }, factors, stability,
    limitations: [
      'All legal choices are accepted for mechanical coverage, not personality accuracy or a human role-playing quality score.',
      'Eligible pairs cover the fixed 16-cell design only for trial IDs observed at least once; wholly absent planned trials cannot be inferred from records alone.',
      'Missing-pair and invalid-pair counts can overlap when a pair contains one missing and one failed answer; unavailablePairs counts the union.',
      'Persona changes traits, values and speaking style jointly. History and explanations are authored interventions, not independently verified natural experiences.',
      'Timing combines late and cold delivery with different legal candidate sets; timely/explained is not a normal timely-gameplay menu.',
      'Generosity is an ordinal description of selected settlement, not actual payout, causal effect, or evidence of correct personality. Execution evidence is recorded separately.',
      'Repeat variation can reflect option-order perturbation, remote sampling, or model-version drift. Same-trial pairing does not synchronize remote randomness.',
      'Pairs and repeated choices are descriptive observations, not independent samples, confidence intervals, or significance tests.',
    ],
  };
}

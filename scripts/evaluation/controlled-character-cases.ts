import { controlledCards } from './controlled-character-cards';
import type { EvaluationCase } from './types';

export interface ControlledPair {
  id: string;
  familyId: string;
  observationId: string;
  caseIds: [string, string];
  expectedRelation: 'change' | 'invariance';
}
const options = (items: [string, string][]) => items.map(([id, description]) => ({ id, label: id, description }));
const families = [
  {
    id: 'help-energy', identity: 'Lin is a neighborhood repair worker.', cards: ['lin-a', 'lin-b'],
    policies: [controlledCards['lin-a'], controlledCards['lin-b']],
    options: options([['help', 'Help the neighbor with the current request.'], ['rest', 'Rest now to recover energy.'], ['decline', 'Decline the request and leave.'], ['continue', 'Continue the current personal activity.']]),
    observations: [
      { energy: 10, emergency: false }, { energy: 35, emergency: false },
      { energy: 70, emergency: false }, { energy: 35, emergency: true },
    ],
    gold: [['rest', 'rest'], ['help', 'rest'], ['help', 'help'], ['help', 'help']],
    reasons: ['Both energy thresholds require rest.', 'Only the lower threshold permits ordinary help.', 'Both energy thresholds permit help.', 'Both policies prioritize emergency help.'],
  },
  {
    id: 'promise-income', identity: 'Qiao is a neighborhood courier.', cards: ['qiao-a', 'qiao-b'],
    policies: [controlledCards['qiao-a'], controlledCards['qiao-b']],
    options: options([['keep', 'Continue existing or routine duties, honoring any accepted promise.'], ['renegotiate', 'Openly ask to renegotiate the promise before changing assignments.'], ['newpaid', 'Take the new paid assignment now without renegotiating any existing promise.'], ['emergency', 'Check on and assist an urgent need.']]),
    observations: [
      { acceptedPromise: true, extraPay: 5, emergency: false }, { acceptedPromise: true, extraPay: 25, emergency: false },
      { acceptedPromise: false, extraPay: 25, emergency: false, currentActivity: 'Routine courier duties with no accepted promise.' }, { acceptedPromise: true, extraPay: 25, emergency: true },
    ],
    gold: [['keep', 'keep'], ['keep', 'renegotiate'], ['newpaid', 'newpaid'], ['emergency', 'emergency']],
    reasons: ['Both policies keep promises for this small increase.', 'Only the flexible policy permits explicit renegotiation.', 'Neither policy has an accepted promise to preserve.', 'Both policies prioritize emergency assistance.'],
  },
  {
    id: 'disclosure', identity: 'Mei is a neighborhood archivist.', cards: ['mei-a', 'mei-b'],
    policies: [controlledCards['mei-a'], controlledCards['mei-b']],
    options: options([['share', 'Share what you believe is the fact with the player.'], ['askpurpose', 'Ask what the player wants to know.'], ['refuse', 'Refuse to disclose the information.'], ['unknown', 'Acknowledge that no verified fact is known.']]),
    observations: [
      { permission: false, verifiedFact: 'The entrusted parcel is stored in locker nine.', directQuestion: true },
      { permission: true, verifiedFact: null, directQuestion: true },
      { permission: true, verifiedFact: 'The entrusted parcel is stored in locker nine.', directQuestion: true },
      { permission: true, verifiedFact: 'The entrusted parcel is stored in locker nine.', directQuestion: false },
    ],
    gold: [['refuse', 'refuse'], ['unknown', 'unknown'], ['share', 'share'], ['share', 'askpurpose']],
    reasons: ['Both policies refuse without permission.', 'Both policies acknowledge missing verified knowledge.', 'Both policies answer a direct permitted question.', 'Only the open policy volunteers permitted information.'],
  },
];

/** Explicit authored contract labels; neither human quality nor hidden-world correctness. */
export function controlledCharacterSuite(): { cases: EvaluationCase[]; pairs: ControlledPair[] } {
  const cases: EvaluationCase[] = [], pairs: ControlledPair[] = [];
  for (const family of families) family.observations.forEach((observation, index) => {
    const id = `${family.id}/observation-${index + 1}`;
    const caseIds: [string, string] = [`${id}/a`, `${id}/b`];
    pairs.push({ id, familyId: family.id, observationId: `observation-${index + 1}`, caseIds,
      expectedRelation: family.gold[index][0] === family.gold[index][1] ? 'invariance' : 'change' });
    family.cards.forEach((cardId, variant) => cases.push({
      id: caseIds[variant], familyId: family.id, split: 'development', permutationGroup: id,
      input: { npcId: family.cards[0].split('-')[0], revision: 0,
        state: { character: { identity: family.identity, policy: family.policies[variant] }, observation: structuredClone(observation) },
        options: structuredClone(family.options) },
      acceptableChoices: [family.gold[index][variant]], rationale: `${family.reasons[index]} Authored contract compliance only.`,
      tags: [cardId, 'synthetic', 'development-only', 'authored-contract'],
    }));
  });
  return { cases, pairs };
}

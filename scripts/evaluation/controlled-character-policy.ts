import { controlledCards } from './controlled-character-cards';
import { z } from 'zod';
import type { DecisionInput, EvaluationProvider } from './types';

// Frozen independent implementation of each published character contract.
const policies = Object.freeze({
  'lin-a': { kind: 'help', threshold: 20 }, 'lin-b': { kind: 'help', threshold: 50 },
  'qiao-a': { kind: 'promise', renegotiate: false }, 'qiao-b': { kind: 'promise', renegotiate: true },
  'mei-a': { kind: 'disclosure', volunteer: true }, 'mei-b': { kind: 'disclosure', volunteer: false },
} as const);
export function authoredPolicyChoice(input: DecisionInput): string {
  const character = z.object({ policy: z.string() }).parse(input.state.character);
  const card = (Object.keys(controlledCards) as (keyof typeof controlledCards)[]).find(id => controlledCards[id] === character.policy);
  if (!card) throw new Error('Unknown frozen character contract');
  const policy = policies[card];
  let choice: string;
  if (policy.kind === 'help') {
    const o = z.object({ energy: z.number().finite(), emergency: z.boolean() }).parse(input.state.observation);
    choice = o.emergency || o.energy >= policy.threshold ? 'help' : 'rest';
  } else if (policy.kind === 'promise') {
    const o = z.object({ acceptedPromise: z.boolean(), extraPay: z.number().finite(), emergency: z.boolean() }).parse(input.state.observation);
    choice = o.emergency ? 'emergency' : !o.acceptedPromise ? 'newpaid' : policy.renegotiate && o.extraPay >= 20 ? 'renegotiate' : 'keep';
  } else {
    const o = z.object({ permission: z.boolean(), verifiedFact: z.string().min(1).nullable(), directQuestion: z.boolean() }).parse(input.state.observation);
    choice = !o.permission ? 'refuse' : o.verifiedFact === null ? 'unknown' : o.directQuestion || policy.volunteer ? 'share' : 'askpurpose';
  }
  if (!input.options.some(o => o.id === choice)) throw new Error('Policy action unavailable');
  return choice;
}
export const authoredPolicyProvider: EvaluationProvider = {
  id: 'authored-policy', model: 'controlled-contract-v1', paid: false,
  protocolVersion: 'controlled-authored-policy-v1',
  async decide(input) {
    const start = performance.now();
    return { choice: authoredPolicyChoice(input), affect: 'focused', cost: 0, latencyMs: performance.now() - start, model: 'controlled-contract-v1' };
  },
};

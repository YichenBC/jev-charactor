import { describe, expect, it } from 'vitest';
import { compileResponses } from '../src/character/response';
const facts = [{ id: 'meal', text: '厨房有汤。', basis: 'observation:1', disclosable: true, validFrom: 0, validUntil: 10 }];
const plans = [{ id: 'offer', intent: 'share-observation', parts: [{ literal: '我刚看到，' }, { fact: 'meal' }] }];
describe('portable response synthesis', () => {
  it('composes detached speech with inspectable provenance', () => {
    expect(compileResponses(plans, facts, 2)).toEqual([{ id: 'offer', intent: 'share-observation', text: '我刚看到，厨房有汤。', evidence: [{ id: 'meal', basis: 'observation:1' }] }]);
    expect(facts[0].text).toBe('厨房有汤。');
  });
  it('omits the whole plan for private, unknown, future or expired facts', () => {
    expect(compileResponses(plans, [], 2)).toEqual([]);
    expect(compileResponses(plans, [{ ...facts[0], disclosable: false }], 2)).toEqual([]);
    expect(compileResponses(plans, facts, 10)).toEqual([]);
    expect(compileResponses(plans, [{ ...facts[0], validFrom: 3 }], 2)).toEqual([]);
  });
  it('fails closed on ambiguous IDs, malformed parts and unbounded content', () => {
    expect(() => compileResponses(plans, [...facts, ...facts], 2)).toThrow();
    expect(() => compileResponses([...plans, ...plans], facts, 2)).toThrow();
    expect(() => compileResponses([{ ...plans[0], parts: [{ literal: 'hi', fact: 'meal' }] }], facts, 2)).toThrow();
    expect(() => compileResponses(plans, facts, NaN)).toThrow();
    expect(() => compileResponses(plans, [{ ...facts[0], text: 'x'.repeat(1001) }], 2)).toThrow();
    expect(() => compileResponses([{ ...plans[0], parts: [{ fact: 'meal' }, { fact: 'meal' }] }], [{ ...facts[0], text: 'x'.repeat(801) }], 2)).toThrow('1600');
  });
});

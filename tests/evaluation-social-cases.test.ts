import { describe, expect, it } from 'vitest';
import { decisionInput } from '../server/jev';
import { getContext, getOptions, loadWorld, serializeWorld } from '../src/sim';
import { socialCases, prepareSocialCase, verifySocialExecution } from '../scripts/evaluation/social-cases';

describe('authored social invitation development cases', () => {
  it('builds eight reproducible real invitation contexts with independent receiver alternatives', () => {
    const cases = socialCases();
    expect(cases).toHaveLength(8); expect(cases).toEqual(socialCases());
    expect(new Set(cases.map(item => item.id)).size).toBe(8);
    expect(new Set(cases.map(item => item.input.npcId))).toEqual(new Set(['mei', 'tang']));
    for (const scenario of cases) {
      const { world, npcId, proposerId } = prepareSocialCase(scenario.id);
      const proposer = world.npcs.find(npc => npc.id === proposerId)!;
      expect(world.time).toBeGreaterThan(0);
      expect(proposer.job).toMatchObject({ kind: 'social', phase: 'invite', consent: 'pending', partnerId: npcId });
      expect(world.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ npcId: proposerId, choice: `seek:${npcId}`, source: 'social-fixture-setup' })]));
      expect(world.decisions.filter(item => item.npcId === npcId)).toHaveLength(0);
      expect(scenario.split).toBe('development'); expect(scenario.rationale).toContain('Authored development');
      expect(decisionInput.safeParse(scenario.input).success).toBe(true);
      expect(scenario.input.options.map(option => option.id)).toEqual(expect.arrayContaining(['social:accept', 'social:decline', 'social:defer', 'wait']));
      expect(scenario.input.options.map(option => option.id)).toEqual(getOptions(world, npcId).map(option => option.id));
      expect(scenario.acceptableChoices.length).toBeGreaterThan(0);
      expect(scenario.acceptableChoices.every(id => scenario.input.options.some(option => option.id === id))).toBe(true);
      expect(loadWorld(serializeWorld(world))).not.toBeNull();
      expect(scenario.input.state).not.toHaveProperty('acceptableChoices');
      expect(scenario.input.state).not.toHaveProperty('rationale');
      expect(scenario.input.state.situation).not.toHaveProperty('options');
    }
  });
  it('scores priorities rather than assigning acceptance to every invitation', () => {
    for (const npcId of ['mei', 'tang']) {
      expect(prepareSocialCase(`${npcId}/social-lonely`).scenario.acceptableChoices).toEqual(['social:accept']);
      expect(prepareSocialCase(`${npcId}/social-hungry`).scenario.acceptableChoices).toEqual(['eat:tavern']);
      expect(prepareSocialCase(`${npcId}/social-tired`).scenario.acceptableChoices).toEqual(['rest:home', 'rest:watch']);
      expect(prepareSocialCase(`${npcId}/social-overworked`).scenario.acceptableChoices).toEqual(['work']);
    }
  });
  it('keeps the proposer’s private needs, memories and goals out of the receiver input', () => {
    for (const scenario of socialCases()) {
      const { world, npcId, proposerId } = prepareSocialCase(scenario.id);
      const before = getContext(world, npcId);
      const proposer = world.npcs.find(npc => npc.id === proposerId)!;
      proposer.needs = { hunger: 1, energy: 2, social: 3, workPressure: 99 };
      proposer.secret = 'PRIVATE-SOCIAL-FIXTURE-SECRET';
      proposer.memories.push({ time: world.time, kind: 'private', text: 'PRIVATE-SOCIAL-FIXTURE-MEMORY' });
      proposer.mind.personal.goals[0].label = 'PRIVATE-SOCIAL-FIXTURE-GOAL';
      expect(getContext(world, npcId)).toEqual(before);
      expect(JSON.stringify(scenario.input)).not.toContain('PRIVATE-SOCIAL-FIXTURE');
      const observation = (scenario.input.state.situation as Record<string, unknown>).publicObservation as { nearbyPeople: unknown[] };
      expect(observation.nearbyPeople).toEqual(expect.arrayContaining([expect.objectContaining({ id: proposerId })]));
      for (const person of observation.nearbyPeople) expect(person).not.toHaveProperty('needs');
    }
  });
  it('executes acceptance through eight seconds and rewards both participants only through simulation', () => {
    const result = verifySocialExecution('mei/social-lonely', 'social:accept', 'focused');
    expect(result).toMatchObject({ applied: true, validSave: true, socialCompleted: true, selectedActivityCompleted: true });
    expect(result.elapsedSeconds).toBeGreaterThanOrEqual(8);
    expect(result.needsDelta.recipient.social).toBeGreaterThan(29);
    expect(result.needsDelta.proposer.social).toBeGreaterThan(29);
    expect(result.decisions.filter(item => item.source === 'social-evaluation-replay')).toHaveLength(1);
    expect(result.decisions.every(item => item.source === 'social-evaluation-replay' || item.source === 'simulation')).toBe(true);
    expect(result.decisions.some(item => item.npcId === result.proposerId && item.choice === 'completed:social')).toBe(true);
  });
  it.each(['social:decline', 'social:defer'])('executes %s without inventing a later acceptance or social reward', choice => {
    const result = verifySocialExecution('tang/social-lonely', choice, 'guarded');
    expect(result).toMatchObject({ applied: true, validSave: true, socialCompleted: false, selectedActivityCompleted: false });
    expect(result.needsDelta.recipient.social).toBe(0); expect(result.needsDelta.proposer.social).toBe(0);
    expect(result.decisions).toHaveLength(1);
  });
  it('replays real meal/rest/work consequences while the unaccepted invitation ends', () => {
    for (const npcId of ['mei', 'tang']) {
      for (const kind of ['hungry', 'tired', 'overworked']) {
        const scenario = prepareSocialCase(`${npcId}/social-${kind}`).scenario;
        for (const choice of scenario.acceptableChoices) {
          const result = verifySocialExecution(scenario.id, choice, 'focused');
          expect(result).toMatchObject({ applied: true, validSave: true, socialCompleted: false, selectedActivityCompleted: true });
          if (kind === 'hungry') expect(result.needsDelta.recipient.hunger).toBeGreaterThan(40);
          if (kind === 'tired') expect(result.needsDelta.recipient.energy).toBeGreaterThan(20);
          if (kind === 'overworked') expect(result.needsDelta.recipient.workPressure).toBeLessThan(-30);
          expect(result.needsDelta.proposer.social).toBeLessThanOrEqual(0);
          expect(result.decisions.filter(item => item.source === 'social-evaluation-replay')).toHaveLength(1);
        }
      }
    }
  });
  it('rejects unknown scenarios and illegal answers without advancing another character', () => {
    expect(() => prepareSocialCase('mei/unknown')).toThrow('Unknown social development case');
    const result = verifySocialExecution('mei/social-hungry', 'invented', 'focused');
    expect(result).toMatchObject({ applied: false, validSave: true, socialCompleted: false, elapsedSeconds: 0 });
    expect(result.decisions).toEqual([]); expect(result.needsAfter).toEqual(result.needsBefore);
  });
});

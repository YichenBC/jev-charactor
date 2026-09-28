import { describe, expect, it } from 'vitest';
import { getOptions, getPlayerInteractions, serializeWorld } from '../src/sim';
import { interactionScenarios } from '../scripts/evaluation/interaction-scenarios';
import { ruleProvider, utilityProvider } from '../scripts/evaluation/providers';
import { replayInteractionTrajectory, runInteractionTrajectory } from '../scripts/evaluation/interaction-trajectory';

const roles = ['mei', 'tang', 'lin', 'lan'];
const cases = roles.flatMap(npcId => ['continuity', 'needs-feedback'].map(kind => `${npcId}-${kind}`));

describe('authored cross-character development fixtures', () => {
  it('creates independent, byte-reproducible worlds for both mechanisms in every role', () => {
    const first = interactionScenarios(), second = interactionScenarios();
    expect(first.map(s => s.id).sort()).toEqual([...cases].sort());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map(s => serializeWorld(s.initialWorld))).toEqual(second.map(s => serializeWorld(s.initialWorld)));
    expect(new Set(first.map(s => s.initialWorld)).size).toBe(first.length);
    first[0].initialWorld.player.inventory.length = 0;
    expect(second.every(s => s.initialWorld.player.inventory.length > 0)).toBe(true);
    expect(first.slice(1).every(s => s.initialWorld.player.inventory.length > 0)).toBe(true);
  });

  it.each(roles)('%s offers legal initial questions and carried gifts, with an idle needs opportunity', npcId => {
    const scenarios = interactionScenarios().filter(s => s.npcId === npcId);
    expect(scenarios).toHaveLength(2);
    const continuity = scenarios.find(s => s.id === `${npcId}-continuity`)!;
    const world = structuredClone(continuity.initialWorld), npc = world.npcs.find(n => n.id === npcId)!;
    Object.assign(world.player, { x: npc.x, y: npc.y }); // Same approach policy as the runner.
    const menu = getPlayerInteractions(world, npcId).map(option => option.id);
    for (const action of ['greet', 'ask:feelings', 'ask:plans', 'ask']) expect(menu).toContain(action);
    const gift = continuity.steps.find(s => s.kind === 'interact' && s.action.startsWith('gift:'))!;
    expect(gift.kind).toBe('interact');
    if (gift.kind === 'interact') expect(menu).toContain(gift.action);
    expect(continuity.steps).toContainEqual({ id: 'return-to-plan', kind: 'followup', topic: 'plan', anchor: 'plans' });
    const needs = scenarios.find(s => s.id === `${npcId}-needs-feedback`)!;
    const actor = needs.initialWorld.npcs.find(n => n.id === npcId)!;
    expect(actor.cooldown).toBe(0);
    expect(actor.job).toBeNull();
    expect(actor.path).toEqual([]);
    expect(actor.pendingInteraction).toBeUndefined();
    expect(getOptions(needs.initialWorld, npcId).length).toBeGreaterThan(1);
    expect(needs.steps[0].kind).toBe('autonomy');
  });

  describe.each([ruleProvider, utilityProvider])('$id offline execution', provider => {
    it.each(cases)('%s records decisions, feedback, budget bounds and exact replay', async id => {
      const scenario = interactionScenarios().find(s => s.id === id);
      expect(scenario).toBeDefined();
      if (!scenario) return;
      const initial = serializeWorld(scenario.initialWorld);
      const result = await runInteractionTrajectory({ scenario, provider, maxRequests: 16, maxReportedCostUSD: 0 });
      expect(result.complete).toBe(true);
      expect(result.validSave).toBe(true);
      expect(result.config).toMatchObject({ maxRequests: 16, maxReportedCostUSD: 0, peerPolicy: 'engine-rule-v1' });
      expect(result.attempts.length).toBeLessThanOrEqual(16);
      expect(result.attempts.every(a => a.applied && a.error === null)).toBe(true);
      expect(result.records).toHaveLength(scenario.steps.length);
      const autonomy = result.records.filter(r => r.kind === 'autonomy');
      expect(autonomy.some(r => r.status === 'applied')).toBe(true);
      const feedback = result.records.filter(r => r.kind === 'advance');
      expect(feedback.every(r => r.status === 'advanced' && r.after.time > r.before.time)).toBe(true);
      expect(feedback.some(r => JSON.stringify(r.before.needs) !== JSON.stringify(r.after.needs))).toBe(true);
      expect(result.finalWorld.decisions.some(d => d.npcId === scenario.npcId && d.choice.startsWith('completed:'))).toBe(true);
      for (const skipped of result.records.filter(r => r.status === 'skipped')) {
        expect(['menu-unavailable', 'actor-busy', 'decision-unavailable']).toContain(skipped.reason);
        expect(skipped.attemptSequence).toBeUndefined();
      }
      expect(serializeWorld(scenario.initialWorld)).toBe(initial);
      expect(await replayInteractionTrajectory(JSON.parse(JSON.stringify(result)))).toEqual({
        verified: true, attempts: result.attempts.length, records: result.records.length,
      });
      const bounded = await runInteractionTrajectory({ scenario, provider, maxRequests: 1, maxReportedCostUSD: 0 });
      expect(bounded.stopReason).toBe('request-budget');
      expect(bounded.attempts).toHaveLength(1);
      expect(await replayInteractionTrajectory(bounded)).toMatchObject({ verified: true, attempts: 1 });
    });
  });
});

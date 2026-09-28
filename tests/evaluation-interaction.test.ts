import { describe, expect, it } from 'vitest';
import { createWorld, serializeWorld } from '../src/sim';
import type { EvaluationProvider } from '../scripts/evaluation/types';
import { interactionScenarios } from '../scripts/evaluation/interaction-scenarios';
import { utilityProvider } from '../scripts/evaluation/providers';
import { runInteractionTrajectory, replayInteractionTrajectory, type InteractionScenario } from '../scripts/evaluation/interaction-trajectory';

function fixture(): InteractionScenario {
  return { id: 'test-dialogue', version: 1, npcId: 'mei', initialWorld: createWorld(), steps: [
    { id: 'hello', kind: 'interact', action: 'greet' },
    { id: 'plans', kind: 'interact', action: 'ask:plans' },
    { id: 'follow', kind: 'followup', topic: 'plan' },
    { id: 'gift', kind: 'interact', action: 'gift:热茶' },
    { id: 'settle', kind: 'advance', seconds: 6 },
    { id: 'act', kind: 'autonomy' },
    { id: 'time', kind: 'advance', seconds: 3 },
    { id: 'after', kind: 'interact', action: 'greet' },
  ] };
}

const generated: EvaluationProvider = {
  id: 'scripted-generated', model: 'fixture', paid: false, expressionMode: 'generated',
  async decide(input) {
    const pending = (input.state.situation as Record<string, unknown>).pendingInteraction;
    const wanted = pending === 'gift' ? 'accept_gift' : pending === 'ask' ? 'reply:detail' : 'reply';
    const choice = input.options.find(o => o.id === wanted)?.id ?? input.options.find(o => o.id === 'reply:goal')?.id ?? 'wait';
    return { choice, affect: 'focused', latencyMs: 1, cost: 0, model: 'fixture',
      dialogue: pending ? `我记住了这次交流，选择 ${choice}。` : null,
      rawContent: 'original response', contractValid: true };
  },
};

describe('multi-turn interaction trajectory', () => {
  it('retains unmeasured self-hosted cost and usage without stopping for a commercial bill', async () => {
    const provider: EvaluationProvider = { ...generated, billingMode: 'self-hosted-unmetered',
      async decide(input) { return { ...await generated.decide(input), cost: undefined,
        tokenUsage: { promptTokens: 120, completionTokens: 25, totalTokens: 145 } }; } };
    const result = await runInteractionTrajectory({ scenario: fixture(), provider, maxRequests: 12, maxReportedCostUSD: 0 });
    expect(result.complete).toBe(true);
    expect(result.totalCostUSD).toBeNull();
    expect(result.unknownCostCount).toBe(result.attempts.length);
    expect(result.attempts.every(a => a.costUSD === null)).toBe(true);
    expect(result.provider.billingMode).toBe('self-hosted-unmetered');
    expect(result.attempts[0].response?.tokenUsage?.totalTokens).toBe(145);
    expect(await replayInteractionTrajectory(result)).toMatchObject({ verified: true });
  });
  it('stops self-hosted errors and enforces the request budget despite absent commercial billing', async () => {
    const provider: EvaluationProvider = { ...generated, billingMode: 'self-hosted-unmetered' };
    const one = await runInteractionTrajectory({ scenario: fixture(), provider, maxRequests: 1, maxReportedCostUSD: 0 });
    expect(one.stopReason).toBe('request-budget');
    expect(one.attempts[0].costUSD).toBeNull();
    const failed = await runInteractionTrajectory({ scenario: fixture(), provider: { ...provider,
      async decide() { throw new Error('connection_timeout'); } }, maxRequests: 12, maxReportedCostUSD: 0 });
    expect(failed.stopReason).toBe('provider-error');
    expect(failed.attempts).toHaveLength(1);
    expect(failed.totalCostUSD).toBeNull();
    expect(await replayInteractionTrajectory(failed)).toMatchObject({ verified: true });
  });
  it('starts the needs fixture at an actual autonomous decision opportunity and observes completion', async () => {
    const scenario = interactionScenarios().find(s => s.id === 'mei-needs-feedback')!;
    const result = await runInteractionTrajectory({ scenario, provider: utilityProvider, maxRequests: 12, maxReportedCostUSD: 0 });
    expect(result.records[0].status).toBe('applied');
    expect(result.attempts[0].response?.choice).toBe('eat:tavern');
    expect(result.records[1].after.needs.hunger).toBeGreaterThan(result.records[0].before.needs.hunger);
    expect(await replayInteractionTrajectory(result)).toMatchObject({ verified: true });
  });
  it('uses actual generated history, executes transactions, advances the world and replays exactly', async () => {
    const scenario = fixture(), initial = serializeWorld(scenario.initialWorld);
    const result = await runInteractionTrajectory({ scenario, provider: generated, maxRequests: 12, maxReportedCostUSD: .1, seed: 'test' });
    expect(result.complete).toBe(true);
    expect(result.attempts.flatMap(a => a.input.options).every(o => !o.description.includes(' Say: '))).toBe(true);
    expect(result.attempts).toHaveLength(6);
    expect(JSON.stringify(result.attempts[1].input)).toContain('我记住了这次交流');
    expect(result.finalWorld.player.inventory).not.toContain('热茶');
    expect(result.finalWorld.time).toBe(9);
    expect(result.totalCostUSD).toBe(0);
    expect(result.records.find(r => r.stepId === 'follow')?.playerAction?.id).toMatch(/^followup:/);
    expect(serializeWorld(scenario.initialWorld)).toBe(initial);
    expect(await replayInteractionTrajectory(JSON.parse(JSON.stringify(result)))).toEqual({ verified: true, attempts: 6, records: 8 });
  });

  it('rejects a tampered input or final world in offline replay', async () => {
    const result = await runInteractionTrajectory({ scenario: fixture(), provider: generated, maxRequests: 12, maxReportedCostUSD: .1 });
    const changed = structuredClone(result);
    changed.attempts[0].input.options.reverse();
    await expect(replayInteractionTrajectory(changed)).rejects.toThrow(/replay/);
    result.finalWorld.player.money++;
    await expect(replayInteractionTrajectory(result)).rejects.toThrow(/replay/);
  });

  it('records unavailable contextual follow-ups as skipped instead of inventing a player option', async () => {
    const scenario = fixture(); scenario.steps = [{ id: 'unknown', kind: 'followup', topic: 'unknown' }];
    const result = await runInteractionTrajectory({ scenario, provider: generated, maxRequests: 1, maxReportedCostUSD: .1 });
    expect(result.complete).toBe(true);
    expect(result.attempts).toHaveLength(0);
    expect(result.records[0]).toMatchObject({ status: 'skipped', reason: 'menu-unavailable' });
  });

  it('returns to the anchored plan when a different plan has since been discussed', async () => {
    const scenario = fixture();
    scenario.steps = [
      { id: 'first-plan', kind: 'interact', action: 'ask:plans' },
      { id: 'different-plan', kind: 'interact', action: 'ask:plans' },
      { id: 'return', kind: 'followup', topic: 'plan', anchor: 'first-plan' },
    ];
    let turn = 0;
    const result = await runInteractionTrajectory({ scenario, provider: { ...generated,
      async decide(input) {
        const choice = ['reply:goal', 'reply:goal:personal-interest', 'reply:detail'][turn++];
        return { ...await generated.decide(input), choice, dialogue: `Actual utterance ${turn}` };
      } }, maxRequests: 12, maxReportedCostUSD: 0 });
    expect(result.complete).toBe(true);
    const original = result.records[0].after.dialogue.turns.at(-1)!;
    expect(result.records[1].after.dialogue.turns.at(-1)?.subject).not.toBe(original.subject);
    expect(result.records[2].playerAction?.parameters.turn).toBe(original.sequence);
  });

  it('stops on unknown paid billing and retains in-flight checkpoint evidence', async () => {
    const checkpoints: any[] = [];
    const provider = { ...generated, paid: true, async decide(input: Parameters<EvaluationProvider['decide']>[0]) {
      return { ...await generated.decide(input), cost: undefined };
    } };
    const result = await runInteractionTrajectory({ scenario: fixture(), provider, maxRequests: 12, maxReportedCostUSD: .1,
      onCheckpoint: async value => { checkpoints.push(value); } });
    expect(result.stopReason).toBe('unknown-billing');
    expect(result.complete).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.totalCostUSD).toBeNull();
    expect(checkpoints.find(c => c.inFlight)).toMatchObject({ totalCostUSD: null, outstandingRequestCount: 1 });
    expect(checkpoints.find(c => c.inFlight).inFlight.input).toEqual(result.attempts[0].input);
    expect(await replayInteractionTrajectory(result)).toMatchObject({ verified: true });
  });

  it('does not fall back or silently replace missing generated speech', async () => {
    const result = await runInteractionTrajectory({ scenario: fixture(), provider: { ...generated, paid: true,
      async decide() { return { choice: 'reply', affect: 'focused', latencyMs: 1, cost: .01, rawContent: 'bad', dialogue: null }; } },
      maxRequests: 12, maxReportedCostUSD: .1 });
    expect(result.stopReason).toBe('invalid-answer');
    expect(result.attempts[0].response?.rawContent).toBe('bad');
    expect(result.attempts[0].applied).toBe(false);
    expect(result.finalWorld.npcs.find(n => n.id === 'mei')!.mind.dialogue.turns).toHaveLength(0);
    expect(result.totalCostUSD).toBe(.01);
  });

  it('checks request and cost bounds before the next paid call', async () => {
    const provider = { ...generated, paid: true, async decide(input: Parameters<EvaluationProvider['decide']>[0]) {
      return { ...await generated.decide(input), cost: .02 };
    } };
    const result = await runInteractionTrajectory({ scenario: fixture(), provider, maxRequests: 12, maxReportedCostUSD: .01 });
    expect(result.attempts).toHaveLength(1);
    expect(result.stopReason).toBe('reported-cost-budget');
    expect(result.knownCostUSD).toBe(.02);
    const zero = await runInteractionTrajectory({ scenario: fixture(), provider, maxRequests: 12, maxReportedCostUSD: 0 });
    expect(zero.attempts).toHaveLength(0);
    const one = await runInteractionTrajectory({ scenario: fixture(), provider: generated, maxRequests: 1, maxReportedCostUSD: .1 });
    expect(one.attempts).toHaveLength(1);
    expect(one.stopReason).toBe('request-budget');
  });

  it('redacts errors and reproduces failed attempts without network', async () => {
    const result = await runInteractionTrajectory({ scenario: fixture(), provider: { ...generated, paid: true,
      async decide() { throw new Error('private-key upstream problem'); } }, maxRequests: 12, maxReportedCostUSD: .1 });
    expect(result.stopReason).toBe('provider-error');
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(result.totalCostUSD).toBeNull();
    expect(await replayInteractionTrajectory(result)).toMatchObject({ verified: true });
  });

  it.each([['upstream_401', 'authentication-error'], ['upstream_403', 'access-denied'], ['upstream_402', 'billing-error'], ['connection_timeout', 'timeout'], ['transport_socket_closed', 'transport_socket_closed'], ['transport_timeout', 'transport_timeout']])(
    'replays classified failure %s without changing its error code', async (message, code) => {
      const result = await runInteractionTrajectory({ scenario: fixture(), provider: { ...generated, paid: true,
        async decide() { throw new Error(message); } }, maxRequests: 12, maxReportedCostUSD: .1 });
      expect(result.attempts[0].error).toBe(code);
      if (message.startsWith('upstream_')) expect(result.attempts[0].upstreamStatus).toBe(Number(message.slice(9)));
      expect(await replayInteractionTrajectory(result)).toMatchObject({ verified: true });
    });
});

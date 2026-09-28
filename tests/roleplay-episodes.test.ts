import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorld, serializeWorld } from '../src/sim';
import { CHORE_REWARD, RETURN_SECONDS } from '../src/sim/work';
import { ruleProvider } from '../scripts/evaluation/providers';
import { roleplayEpisodes } from '../scripts/evaluation/roleplay-episodes';
import { interactionScenarios } from '../scripts/evaluation/interaction-scenarios';
import { reportRoleplayEpisode } from '../scripts/evaluation/roleplay-episode-report';
import { replayInteractionTrajectory, runInteractionTrajectory, type InteractionScenario } from '../scripts/evaluation/interaction-trajectory';
import type { EvaluationProvider } from '../scripts/evaluation/types';

const accepting: EvaluationProvider = { id: 'mechanism-fixture', model: 'test', paid: false,
  async decide(input) {
    const choice = ['request_help', 'accept_promise', 'accept_help', 'accept_apology', 'reply:history', 'reply:detail', 'reply:feeling', 'wait']
      .find(id => input.options.some(o => o.id === id)) ?? input.options[0].id;
    return { choice, affect: 'focused', latencyMs: 0, cost: 0 };
  } };
const refusing: EvaluationProvider = { ...accepting, id: 'refusing-fixture', async decide(input) {
  return { choice: input.options.some(o => o.id === 'refuse') ? 'refuse' : 'wait', affect: 'guarded', latencyMs: 0, cost: 0 };
} };
const run = (scenario: InteractionScenario, provider = ruleProvider, maxRequests = 12) =>
  runInteractionTrajectory({ scenario, provider, maxRequests, maxReportedCostUSD: 0, seed: 'roleplay-episodes-development-v1' });

describe('original authored development roleplay episodes', () => {
  it('defines four independent, matched starting worlds without fabricating game state', () => {
    const episodes = roleplayEpisodes();
    expect(episodes.map(s => s.id)).toEqual(['mei-promise-kept', 'mei-promise-broken', 'lan-promise-kept', 'lan-promise-broken']);
    for (const npcId of ['mei', 'lan']) {
      const pair = episodes.filter(s => s.npcId === npcId);
      expect(pair[0].initialWorld).toEqual(pair[1].initialWorld);
      expect(pair[0].initialWorld).not.toBe(pair[1].initialWorld);
      const expected = createWorld();
      Object.assign(expected.npcs.find(n => n.id === npcId)!.needs, { hunger: 70, energy: 80, social: 45, workPressure: 55 });
      expect(pair[0].initialWorld).toEqual(expected);
      pair[0].initialWorld.player.money++;
      expect(pair[1].initialWorld.player.money).toBe(20);
    }
    expect(roleplayEpisodes()[0].initialWorld.player.money).toBe(20);
    expect(interactionScenarios().some(s => episodes.some(e => e.id === s.id))).toBe(false);
    for (const scenario of episodes) {
      expect(scenario.steps.filter(s => s.kind !== 'advance').length).toBeLessThanOrEqual(12);
      expect(scenario.steps.filter(s => s.kind === 'advance').every(s => s.seconds <= 120)).toBe(true);
      if (scenario.id.endsWith('broken')) expect(scenario.steps.find(s => s.id === 'missed-return')).toMatchObject({ seconds: RETURN_SECONDS + 1 });
    }
  });

  for (const provider of [ruleProvider, accepting]) for (const id of ['mei-promise-kept', 'mei-promise-broken', 'lan-promise-kept', 'lan-promise-broken']) {
    it(`${provider.id}: ${id} records real transitions, consequences, visible history and exact replay`, async () => {
      const scenario = roleplayEpisodes().find(s => s.id === id)!;
      const initial = serializeWorld(scenario.initialWorld), trace = await run(scenario, provider);
      const report = reportRoleplayEpisode(trace), kept = id.endsWith('kept');
      expect(trace.complete).toBe(true);
      expect(report.complete).toBe(true);
      expect(report.commitments.initial).toEqual([]);
      expect(report.commitments.final).toEqual([expect.objectContaining({ status: kept ? 'fulfilled' : 'broken' })]);
      expect(report.commitments.transitions.map(t => t.to)).toEqual(['active', kept ? 'fulfilled' : 'broken']);
      expect(report.commitments.transitions[0].stepId).toBe('return-promise');
      expect(report.commitments.transitions[1].stepId).toBe(kept ? 'settle-help' : 'missed-return');
      expect(report.deltas.player.money).toBe(kept ? CHORE_REWARD : 0);
      expect(report.deltas.trust).toBe(kept ? 2 : -1);
      expect(report.deltas.needs.hunger).not.toBe(0);
      expect(report.deltas.needs.hunger).toBe(trace.finalWorld.npcs.find(n => n.id === scenario.npcId)!.needs.hunger - 70);
      expect(report.work.settlements).toHaveLength(kept ? 1 : 0);
      if (kept) {
        expect(report.work.settlements[0]).toMatchObject({ stepId: 'settle-help', moneyDelta: CHORE_REWARD, taskId: expect.stringMatching(/^work-/) });
        expect(trace.records.find(r => r.stepId === 'settle-help')!.after.needs.workPressure).toBeLessThan(trace.records.find(r => r.stepId === 'settle-help')!.before.needs.workPressure);
      } else {
        expect(trace.records.find(r => r.stepId === 'missed-return')!.after.trust).toBe(-2);
        expect(trace.records.find(r => r.stepId === 'apology')!.after.trust).toBe(-1);
      }
      expect(report.visiblePostEventHistory).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: 'feelings-after-event', commitment: expect.objectContaining({ status: kept ? 'fulfilled' : 'broken' }) })]));
      const history = report.visiblePostEventHistory[0];
      expect(trace.attempts.find(a => a.sequence === history.attemptSequence)!.input.state.commitments).toContainEqual(history.commitment);
      expect(report.dialogue.replyCount).toBe(trace.records.filter(r => r.reply).length);
      expect(report.branching.every(b => b.consequenceKinds.length >= 2)).toBe(true);
      expect(report.steps.unexecuted).toEqual([]);
      expect(report).not.toHaveProperty('score');
      expect(serializeWorld(scenario.initialWorld)).toBe(initial);
      expect(await replayInteractionTrajectory(JSON.parse(JSON.stringify(trace)))).toMatchObject({ verified: true });
    });
  }

  it.each(['mei', 'lan'])('does not invent accepted promises or work when %s refuses', async npcId => {
    for (const scenario of roleplayEpisodes().filter(s => s.npcId === npcId)) {
      const trace = await run(scenario, refusing), report = reportRoleplayEpisode(trace);
      expect(report.complete).toBe(true); // Scheduled coverage is not an outcome success score.
      expect(report.commitments.final).toEqual([]);
      expect(report.commitments.transitions).toEqual([]);
      expect(report.work.settlements).toEqual([]);
      expect(report.deltas.player.money).toBe(0);
      expect(report.steps.skipped).toContainEqual(expect.objectContaining({ stepId: 'return-promise', reason: 'menu-unavailable' }));
      expect(report.visiblePostEventHistory).toEqual([]);
      expect(await replayInteractionTrajectory(trace)).toMatchObject({ verified: true });
    }
  });

  it('keeps partial runs and provider failures incomplete, with unexecuted steps and error evidence', async () => {
    const scenario = roleplayEpisodes()[0];
    const trace = await run(scenario, accepting, 2), report = reportRoleplayEpisode(trace);
    expect(report.complete).toBe(false);
    expect(report.stopReason).toBe('request-budget');
    expect(report.commitments.final[0].status).toBe('active');
    expect(report.work.settlements).toEqual([]);
    expect(report.steps.unexecuted).toContain('begin-help');
    expect(await replayInteractionTrajectory(trace)).toMatchObject({ verified: true });
    const broken = await run(roleplayEpisodes()[1], accepting, 2), partial = reportRoleplayEpisode(broken);
    expect(partial).toMatchObject({ complete: false, stopReason: 'request-budget' });
    expect(partial.commitments.final[0].status).toBe('broken');
    expect(partial.visiblePostEventHistory).toEqual([]);
    expect(await replayInteractionTrajectory(broken)).toMatchObject({ verified: true });
    const failure = await run(scenario, { ...accepting, async decide() { throw new Error('timeout'); } });
    expect(reportRoleplayEpisode(failure)).toMatchObject({ complete: false, stopReason: 'provider-error', errors: [{ stepId: 'work-request', error: 'timeout', attemptSequence: 1 }] });
    expect(await replayInteractionTrajectory(failure)).toMatchObject({ verified: true });
  });

  it('does not call settled unpromised work a fulfilled promise or unstarted work settled', async () => {
    for (const declined of ['accept_promise', 'accept_help']) {
      const trace = await run(roleplayEpisodes()[0], { ...accepting, async decide(input) {
        const response = await accepting.decide(input);
        return response.choice === declined ? { ...response, choice: 'refuse' } : response;
      } });
      const report = reportRoleplayEpisode(trace);
      expect(report.commitments.final.map(c => c.status)).toEqual(declined === 'accept_promise' ? [] : ['active']);
      expect(report.work.settlements).toHaveLength(declined === 'accept_promise' ? 1 : 0);
      expect(report.visiblePostEventHistory).toEqual([]);
      expect(await replayInteractionTrajectory(trace)).toMatchObject({ verified: true });
    }
  });

  it('never substitutes audit history for evidence in the actual subsequent input', async () => {
    const trace = await run(roleplayEpisodes()[0], accepting);
    for (const attempt of trace.attempts) attempt.input.state.commitments = [];
    const report = reportRoleplayEpisode(trace);
    expect(report.commitments.final[0].status).toBe('fulfilled');
    expect(report.visiblePostEventHistory).toEqual([]);
  });

  it('keeps paired candidate permutations identical until the scripted event diverges', async () => {
    for (const npcId of ['mei', 'lan']) {
      const pair = await Promise.all(roleplayEpisodes().filter(s => s.npcId === npcId).map(s => run(s)));
      expect(pair[0].attempts.slice(0, 2).map(a => a.input)).toEqual(pair[1].attempts.slice(0, 2).map(a => a.input));
    }
  });

  it('rejects an empty or invalid optional permutation group', async () => {
    for (const permutationGroup of ['', '   ', 123]) {
      const scenario = Object.assign(roleplayEpisodes()[0], { permutationGroup });
      await expect(run(scenario)).rejects.toThrow();
    }
  });

  it('preserves the historical scenario-id permutation when the optional group is absent', async () => {
    const scenario = interactionScenarios()[0];
    scenario.steps = scenario.steps.slice(0, 2);
    const legacy = await run(scenario), explicit = await run({ ...scenario, permutationGroup: scenario.id });
    expect(legacy.attempts.map(a => a.input)).toEqual(explicit.attempts.map(a => a.input));
    expect(await replayInteractionTrajectory(legacy)).toMatchObject({ verified: true });
  });

  it('CLI discovers new episodes and saves a separate consequence report with replay', () => {
    const directory = mkdtempSync(join(tmpdir(), 'roleplay-episode-'));
    try {
      const out = join(directory, 'run');
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/evaluate-interactions.ts', '--provider', 'rules',
        '--scenario', 'mei-promise-kept', '--max-requests', '12', '--max-cost', '0', '--out', out], { stdio: 'pipe' });
      expect(JSON.parse(readFileSync(join(out, 'consequences.json'), 'utf8'))).toMatchObject({ complete: true, scenario: 'mei-promise-kept' });
      expect(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).replay.verified).toBe(true);
      for (const file of ['trajectory.json', 'provenance.json', 'transcript.md']) expect(readFileSync(join(out, file), 'utf8').length).toBeGreaterThan(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

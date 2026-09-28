import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { controlledCharacterSuite } from '../scripts/evaluation/controlled-character-cases';
import { authoredPolicyProvider } from '../scripts/evaluation/controlled-character-policy';
import { controlledPairReport } from '../scripts/evaluation/controlled-character-report';
import { runEvaluation } from '../scripts/evaluation/runner';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function run(maxRequests = 24, repeats = 1) {
  const root = await mkdtemp(join(tmpdir(), 'controlled-')); roots.push(root);
  const suite = controlledCharacterSuite();
  return { suite, result: await runEvaluation({ cases: suite.cases, provider: authoredPolicyProvider,
    outputDir: join(root, 'run'), repeats, maxRequests, seed: 'test', maxReportedCostUSD: 1, gitRevision: 'test' }) };
}
it('authors 24 development inputs with matched options and observations and no scoring leakage', () => {
  const { cases, pairs } = controlledCharacterSuite();
  expect(cases).toHaveLength(24); expect(pairs).toHaveLength(12);
  for (const pair of pairs) {
    const [a, b] = pair.caseIds.map(id => cases.find(c => c.id === id)!);
    expect(a.split).toBe('development'); expect(b.split).toBe('development');
    expect(a.input.options).toEqual(b.input.options); expect(a.input.options).toHaveLength(4);
    expect(a.input.state.observation).toEqual(b.input.state.observation);
    expect(a.input.npcId).toBe(b.input.npcId);
    const ca = structuredClone(a.input), cb = structuredClone(b.input);
    (ca.state.character as Record<string, unknown>).policy = ''; (cb.state.character as Record<string, unknown>).policy = '';
    expect(ca).toEqual(cb);
    for (const c of [a, b]) {
      const json = JSON.stringify(c.input);
      for (const forbidden of ['acceptableChoices', 'rationale', 'pairId', 'caseId', 'trueWorld']) expect(json).not.toContain(forbidden);
      expect(json).not.toContain(c.id);
      expect(Object.keys(c.input.state).sort()).toEqual(['character', 'observation']);
    }
  }
});
it('independently follows every contract and ignores candidate ordering or altered gold', async () => {
  for (const c of controlledCharacterSuite().cases) {
    expect((await authoredPolicyProvider.decide(c.input)).choice).toBe(c.acceptableChoices[0]);
    const changed = structuredClone(c); changed.acceptableChoices = ['fake']; changed.id = 'unrelated';
    changed.input.options.reverse();
    expect((await authoredPolicyProvider.decide(changed.input)).choice).toBe(c.acceptableChoices[0]);
  }
  const source = await readFile(new URL('../scripts/evaluation/controlled-character-policy.ts', import.meta.url), 'utf8');
  expect(source).not.toMatch(/controlled-character-cases|acceptableChoices|caseId|pairId/);
});
it('computes counterfactual inclusive thresholds beyond the frozen observations', async () => {
  const cases = controlledCharacterSuite().cases;
  for (const [cardId, threshold] of [['lin-a', 20], ['lin-b', 50]] as const) {
    const input = structuredClone(cases.find(c => c.tags.includes(cardId))!.input);
    for (const energy of [threshold - 1, threshold, threshold + 1]) {
      input.state.observation = { energy, emergency: false };
      expect((await authoredPolicyProvider.decide(input)).choice).toBe(energy >= threshold ? 'help' : 'rest');
    }
    input.state.observation = { energy: 0, emergency: true };
    expect((await authoredPolicyProvider.decide(input)).choice).toBe('help');
  }
  const input = structuredClone(cases.find(c => c.tags.includes('qiao-b'))!.input);
  for (const extraPay of [19, 20, 21]) {
    input.state.observation = { acceptedPromise: true, extraPay, emergency: false };
    expect((await authoredPolicyProvider.decide(input)).choice).toBe(extraPay >= 20 ? 'renegotiate' : 'keep');
  }
});
it('matches each pair and trial by IDs, preserving incomplete and failed pairs', async () => {
  const { suite, result } = await run();
  const complete = controlledPairReport(suite.pairs, result.records.slice().reverse(), 1);
  expect(complete).toMatchObject({ plannedPairs: 12, completePairs: 12, incompletePairs: 0, successfulPairs: 12, expectedChangePairs: 3, expectedInvariancePairs: 9 });
  expect(complete.pairs.filter(p => p.actualChange)).toHaveLength(3);
  for (const pair of suite.pairs) {
    const [a, b] = pair.caseIds.map(id => result.records.find(r => r.caseId === id)!);
    expect(a.permutationGroup).toBe(pair.id); expect(b.permutationGroup).toBe(pair.id);
    expect(a.permutationSeed).toBe(b.permutationSeed); expect(a.input.options).toEqual(b.input.options);
  }
  const records = result.records.map(r => ({ ...r }));
  const failedId = suite.pairs.find(p => p.expectedRelation === 'invariance')!.caseIds[0];
  const failed = records.find(r => r.caseId === failedId)!;
  failed.status = 'error'; failed.response = null; failed.acceptable = false;
  const report = controlledPairReport(suite.pairs, records, 2);
  expect(report).toMatchObject({ plannedPairs: 24, completePairs: 11, incompletePairs: 13, successfulPairs: 11 });
  expect(report.pairs.find(p => p.caseIds.includes(failedId) && p.trial === 1)).toMatchObject({ actualChange: null, bothCorrect: false, success: false });
  expect(report.pairs.filter(p => p.trial === 2).every(p => p.actualChange === null && !p.success)).toBe(true);
  const partial = await run(3);
  expect(controlledPairReport(partial.suite.pairs, partial.result.records, 1).successfulPairs).toBeLessThan(3);
});
it('retains declared raw response evidence while enforcing choice and protocol validity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controlled-evidence-')); roots.push(root);
  for (const [choice, contractValid] of [['help', true], ['missing', true], ['help', false]] as const) {
    const result = await runEvaluation({ cases: controlledCharacterSuite().cases.slice(0, 1),
      provider: { id: 'evidence', model: 'fixture', paid: false, async decide() { return { choice, affect: 'focused', latencyMs: 1, cost: 0,
        contractValid, rawContent: '{"original":"response"}', dialogue: null, finishReason: 'stop', tokenUsage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; } },
      outputDir: join(root, `${choice}-${contractValid}`), repeats: 1, seed: 'test', maxRequests: 1, maxReportedCostUSD: 1, gitRevision: 'test' });
    expect(result.records[0].response).toMatchObject({ rawContent: '{"original":"response"}', dialogue: null, finishReason: 'stop', tokenUsage: { totalTokens: 5 } });
    expect(result.records[0].status).toBe(choice === 'help' && contractValid ? 'valid-answer' : 'invalid-answer');
  }
});

it('retains raw evidence independently of a malformed answer field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controlled-malformed-')); roots.push(root);
  const result = await runEvaluation({ cases: controlledCharacterSuite().cases.slice(0, 1),
    provider: { id: 'bad', model: 'fixture', paid: false, async decide() { return { choice: 'rest', affect: 'invalid', latencyMs: 1, cost: 0.2, rawContent: 'malformed source', finishReason: 'length' }; } },
    outputDir: join(root, 'run'), repeats: 1, seed: 'test', maxRequests: 1, maxReportedCostUSD: 1, gitRevision: 'test' });
  expect(result.records[0]).toMatchObject({ response: null, status: 'invalid-answer', costUSD: 0.2,
    responseEvidence: { rawContent: 'malformed source', finishReason: 'length' } });
});
it('persists provenance before calling a provider and keeps raw evidence despite malformed token metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'controlled-provenance-')); roots.push(root);
  const outputDir = join(root, 'run'), provenance = { sourceGitSHA: 'frozen', runtimeSettings: { thinking: false } };
  const result = await runEvaluation({ cases: controlledCharacterSuite().cases.slice(0, 1), provenance,
    provider: { id: 'bad-tokens', model: 'fixture', paid: false, async decide() {
      expect(JSON.parse(await readFile(join(outputDir, 'provenance.json'), 'utf8'))).toEqual(provenance);
      return { choice: 'rest', affect: 'focused', latencyMs: 1, cost: 0, rawContent: 'original envelope', tokenUsage: { promptTokens: -1, completionTokens: 2, totalTokens: 1 } };
    } }, outputDir, repeats: 1, seed: 'test', maxRequests: 1, maxReportedCostUSD: 1, gitRevision: 'test' });
  expect(result.records[0]).toMatchObject({ status: 'invalid-answer', responseEvidence: { rawContent: 'original envelope' } });
  expect(result.records[0].responseEvidence).not.toHaveProperty('tokenUsage');
});

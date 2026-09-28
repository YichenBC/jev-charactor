import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runEvaluation, seededPermutation } from '../scripts/evaluation/runner';
import { summarizeRecords, summarizeRun } from '../scripts/evaluation/summary';
import type { EvaluationCase, EvaluationProvider } from '../scripts/evaluation/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
const fixture = (id = 'one'): EvaluationCase => ({ id, familyId: 'knowledge', split: 'development',
  input: { npcId: 'npc', revision: 0, state: { observation: 'visible only' }, options: [
    { id: 'wait', label: 'Wait', description: 'Wait for evidence' },
    { id: 'guess', label: 'Guess', description: 'Assume a hidden fact' },
  ] }, acceptableChoices: ['wait'], rationale: 'Do not infer hidden facts', tags: ['synthetic'] });
const provider = (overrides: Partial<EvaluationProvider> = {}): EvaluationProvider => ({ id: 'fake', model: 'fake-v1', paid: false,
  decide: async () => ({ choice: 'wait', affect: 'focused', latencyMs: 12, cost: 0 }), ...overrides });
async function config() {
  const root = await mkdtemp(join(tmpdir(), 'jev-eval-')); roots.push(root);
  return { outputDir: join(root, 'run'), cases: [fixture()], provider: provider(), repeats: 1, seed: 'pilot', maxRequests: 20, maxReportedCostUSD: 0.1, gitRevision: 'abc123', gitDirty: false };
}

describe('evaluation runner', () => {
  it('permutes deterministically without mutating candidates and changes with seed', () => {
    const values = Array.from({ length: 20 }, (_, i) => i);
    expect(seededPermutation(values, 'a')).toEqual(seededPermutation(values, 'a'));
    expect(seededPermutation(values, 'a')).not.toEqual(seededPermutation(values, 'b'));
    expect(seededPermutation(values, 'a').sort((a, b) => a - b)).toEqual(values);
  });
  it('validates every fixture before any provider call or artifact creation', async () => {
    const c = await config(); const decide = vi.fn(c.provider.decide);
    c.cases.push({ ...fixture('bad'), acceptableChoices: ['not-an-option'] });
    await expect(runEvaluation({ ...c, provider: provider({ paid: true, decide }) })).rejects.toThrow('Acceptable choices must be unique candidate IDs');
    expect(decide).not.toHaveBeenCalled();
    await expect(readFile(join(c.outputDir, 'manifest.json'))).rejects.toThrow();
  });
  it('checkpoints each request, separates scoring data, and never overwrites a run', async () => {
    const c = await config();
    const decide = vi.fn(async (input) => {
      expect(input).not.toHaveProperty('acceptableChoices');
      expect(input).not.toHaveProperty('rationale');
      expect(JSON.parse(await readFile(join(c.outputDir, 'manifest.json'), 'utf8')).inFlight).not.toBeNull();
      return { choice: 'wait', affect: 'focused', latencyMs: 12, cost: 0 };
    });
    const result = await runEvaluation({ ...c, provider: provider({ decide, protocolVersion: 'fake-prompt-v1' }) });
    expect(result.manifest).toMatchObject({ complete: true, actualCount: 1, plannedCount: 1, inFlight: null, gitDirty: false });
    expect(result.manifest.caseDefinitionsSha256).toBe(createHash('sha256').update(await readFile(join(c.outputDir, 'cases.json'))).digest('hex'));
    const record = JSON.parse((await readFile(join(c.outputDir, 'records.jsonl'), 'utf8')).trim());
    expect(record.input).toEqual(decide.mock.calls[0][0]);
    expect(record.scoring.acceptableChoices).toEqual(['wait']);
    await expect(runEvaluation(c)).rejects.toThrow();
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it('checkpoints unknown total cost while a request is outstanding', async () => {
    const c = await config(); let savedSummary: unknown;
    const result = await runEvaluation({ ...c, provider: provider({ paid: true, decide: async () => {
      savedSummary = JSON.parse(await readFile(join(c.outputDir, 'summary.json'), 'utf8'));
      return { choice: 'wait', affect: 'focused', latencyMs: 12, cost: 0.01 };
    } }) });
    expect(savedSummary).toMatchObject({ totalCostUSD: null, outstandingRequestCount: 1, byFamily: { knowledge: { totalCostUSD: null, outstandingRequestCount: 1 } } });
    expect(result.summary).toMatchObject({ totalCostUSD: 0.01, outstandingRequestCount: 0 });
  });
  it('persists the request evidence and stops if a checkpoint cannot be written', async () => {
    const c = await config();
    const decide = vi.fn(async () => {
      await mkdir(join(c.outputDir, 'summary.json.tmp'));
      return { choice: 'wait', affect: 'focused', latencyMs: 12, cost: 0 };
    });
    await expect(runEvaluation({ ...c, repeats: 3, provider: provider({ decide }) })).rejects.toThrow();
    expect(decide).toHaveBeenCalledTimes(1);
    expect((await readFile(join(c.outputDir, 'records.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
    const manifest = JSON.parse(await readFile(join(c.outputDir, 'manifest.json'), 'utf8'));
    const records = (await readFile(join(c.outputDir, 'records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(manifest.complete).toBe(false);
    expect(manifest.inFlight.sequence).toBe(records[0].sequence);
    expect(JSON.parse(await readFile(join(c.outputDir, 'summary.json'), 'utf8'))).toMatchObject({ totalCostUSD: null, outstandingRequestCount: 1 });
    expect(summarizeRun(records, manifest)).toMatchObject({ totalCostUSD: 0, outstandingRequestCount: 0 });
    expect(summarizeRun([], manifest)).toMatchObject({ totalCostUSD: null, outstandingRequestCount: 1 });
  });
  it('stops on three consecutive failures and counts unattempted opportunities', async () => {
    const c = await config(); const decide = vi.fn(async () => { throw new Error('network failure'); });
    const result = await runEvaluation({ ...c, repeats: 5, provider: provider({ decide }) });
    expect(decide).toHaveBeenCalledTimes(3);
    expect(result.manifest).toMatchObject({ complete: false, stopReason: 'consecutive-errors', actualCount: 3, plannedCount: 5 });
    expect(result.summary).toMatchObject({ plannedCount: 5, attemptedCount: 3, failureCount: 3, unattemptedCount: 2, acceptableRateAllTrials: 0, acceptableRateValidAnswers: null });
    expect((await readFile(join(c.outputDir, 'records.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
  });
  it('stops immediately on authentication errors without retry', async () => {
    const c = await config(); const decide = vi.fn(async () => { throw new Error('upstream_401'); });
    const result = await runEvaluation({ ...c, repeats: 5, provider: provider({ decide }) });
    expect(decide).toHaveBeenCalledTimes(1); expect(result.manifest.stopReason).toBe('authentication-error');
  });
  it('stops immediately when the service reports exhausted billing credit', async () => {
    const c = await config(); const decide = vi.fn(async () => { throw new Error('upstream_402'); });
    const result = await runEvaluation({ ...c, repeats: 5, provider: provider({ paid: true, decide }) });
    expect(decide).toHaveBeenCalledTimes(1); expect(result.manifest.stopReason).toBe('billing-error');
    expect(result.records[0].errorCode).toBe('billing_error');
  });
  it('stops at known-cost budget and discloses one-request overshoot', async () => {
    const c = await config(); const result = await runEvaluation({ ...c, repeats: 5,
      provider: provider({ paid: true, decide: async () => ({ choice: 'wait', affect: 'focused', latencyMs: 12, cost: 0.06 }) }) });
    expect(result.manifest.stopReason).toBe('reported-cost-budget');
    expect(result.summary).toMatchObject({ attemptedCount: 2, knownCostUSD: 0.12, knownCostCount: 2, unknownCostCount: 0 });
    expect(result.manifest.budget.overshootUSD).toBeCloseTo(0.02);
  });
  it('stops paid calls when billing is missing including timed-out calls', async () => {
    for (const decide of [async () => ({ choice: 'wait', affect: 'focused', latencyMs: 12 }), async () => { throw new Error('connection_timeout'); }]) {
      const c = await config(); const result = await runEvaluation({ ...c, repeats: 5, provider: provider({ paid: true, decide }) });
      expect(result.manifest.stopReason).toBe('unknown-billing'); expect(result.records).toHaveLength(1);
      expect(result.summary).toMatchObject({ unknownCostCount: 1, knownCostCount: 0, knownCostUSD: 0, totalCostUSD: null });
    }
  });
  it('uses request limits and validates bounded repetition', async () => {
    const c = await config(); await expect(runEvaluation({ ...c, repeats: 21 })).rejects.toThrow();
    const result = await runEvaluation({ ...c, repeats: 5, maxRequests: 2 });
    expect(result.manifest.stopReason).toBe('request-budget'); expect(result.records).toHaveLength(2);
  });
  it('retains actual model and billing independently from a malformed affect', async () => {
    const c = await config();
    const result = await runEvaluation({ ...c, provider: provider({ paid: true, decide: async () => ({
      choice: 'wait', affect: 'not-an-affect', latencyMs: 12, cost: 0.01, model: 'resolved-malformed-model',
    }) }) });
    expect(result.records[0]).toMatchObject({ status: 'invalid-answer', errorCode: 'invalid_response', acceptable: false, costUSD: 0.01,
      provider: { responseModel: 'resolved-malformed-model' }, response: null,
    });
  });
  it('rejects invalid upstream contracts while retaining billing and actual model metadata', async () => {
    const c = await config();
    const result = await runEvaluation({ ...c, provider: provider({ paid: true, decide: async () => ({
      choice: 'wait', affect: 'focused', latencyMs: 12, cost: 0.01, model: 'resolved-model-v2', contractValid: false,
    }) }) });
    expect(result.records[0]).toMatchObject({ status: 'invalid-answer', errorCode: 'invalid_response', acceptable: false, costUSD: 0.01,
      provider: { responseModel: 'resolved-model-v2' }, response: { choice: 'wait', contractValid: false, cost: 0.01, model: 'resolved-model-v2' },
    });
    expect(result.summary).toMatchObject({ validAnswerCount: 0, failureCount: 1, acceptableCount: 0, knownCostUSD: 0.01, unknownCostCount: 0 });
  });
  it('preserves invalid answers and reports conditional and all-trial scores separately', async () => {
    const c = await config(); let count = 0;
    const result = await runEvaluation({ ...c, repeats: 3, provider: provider({ decide: async () => ({ choice: ++count === 2 ? 'bad' : 'wait', affect: 'focused', latencyMs: 12, cost: 0 }) }) });
    expect(result.records[1]).toMatchObject({ status: 'invalid-answer', response: { choice: 'bad' }, acceptable: false });
    expect(result.summary).toMatchObject({ validAnswerCount: 2, failureCount: 1, acceptableCount: 2, acceptableRateAllTrials: 2 / 3, acceptableRateValidAnswers: 1 });
    const records = result.records.map((record, i) => ({ ...record, latencyMs: [10, 20, 100][i] }));
    const summary = summarizeRecords(records, 4, { knowledge: 4 });
    expect(summary.latencyMs).toEqual({ p50: 20, p95: 100 });
    expect(() => summarizeRecords(records, 4, { knowledge: 3 })).toThrow('Family planned counts must sum to total planned count');
    expect(summary.byFamily.knowledge).toMatchObject({ plannedCount: 4, acceptableRateAllTrials: 0.5, acceptableRateValidAnswers: 1 });
  });
});

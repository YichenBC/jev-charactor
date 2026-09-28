import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReleaseReport, renderReleaseMarkdown, writeReleaseReport } from '../scripts/evaluation/report';
import { main as reportMain } from '../scripts/report-release';
import { runEvaluation } from '../scripts/evaluation/runner';
import { deliveryCases } from '../scripts/evaluation/delivery-cases';
import type { EvaluationCase, EvaluationConfig, EvaluationRecord } from '../scripts/evaluation/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
const baseCase = (id: string, acceptableChoices = ['a'], tags: string[] = []): EvaluationCase => ({
  id, familyId: 'fixture-family', split: 'development', rationale: 'Authored criterion', tags, acceptableChoices,
  input: { npcId: 'npc', revision: 0, state: { visible: true }, options: [{ id: 'a', label: 'A', description: 'Choose A' }, { id: 'b', label: 'B', description: 'Choose B' }] },
});
async function makeRun(providerId = 'first', overrides: Partial<EvaluationConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'jev-report-')); roots.push(root);
  const outputDir = join(root, 'run');
  const result = await runEvaluation({ outputDir, cases: [baseCase('task-one'), baseCase('task-two', ['b']), baseCase('descriptive', ['a', 'b'], ['descriptive-only'])],
    provider: { id: providerId, model: 'fixture-v1', paid: false, decide: async input => ({ choice: input.options.find(option => option.id === 'a')?.id ?? input.options[0].id, affect: 'focused', latencyMs: 1, cost: 0, model: 'resolved-fixture-v1' }) },
    seed: 'freeze-v1', repeats: 2, maxRequests: 100, maxReportedCostUSD: 1, gitRevision: 'a'.repeat(40), gitDirty: false, ...overrides });
  return { root, outputDir, result };
}
async function mutateJson(path: string, mutate: (value: Record<string, unknown>) => void) {
  const value = JSON.parse(await readFile(path, 'utf8')); mutate(value); await writeFile(path, `${JSON.stringify(value)}\n`);
}
async function rewriteRecords(directory: string, records: EvaluationRecord[]) { await writeFile(join(directory, 'records.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n'); }

describe('frozen release reports', () => {
  it('recomputes gold and descriptive denominators from definitions, ignoring cached summaries and record scoring labels', async () => {
    const run = await makeRun();
    await writeFile(join(run.outputDir, 'summary.json'), '{"acceptableRateAllTrials":1}');
    for (const record of run.result.records) { record.acceptable = true; record.scoring.tags = record.caseId === 'descriptive' ? [] : ['descriptive-only']; record.scoring.acceptableChoices = ['a']; }
    await rewriteRecords(run.outputDir, run.result.records);
    const report = await buildReleaseReport([run.outputDir]);
    expect(report.freeze).toMatchObject({ sourceCommit: 'a'.repeat(40), seed: 'freeze-v1', repeats: 2, caseCount: 3, taskCriterionCaseCount: 2, descriptiveCaseCount: 1 });
    expect(report.providers[0].taskCriterion).toMatchObject({ plannedCount: 4, validAnswerCount: 4, acceptableCount: 2, acceptableRateAllTrials: 0.5 });
    expect(report.providers[0].taskCriterion.byFamily['fixture-family'].plannedCount).toBe(4);
    expect(report.providers[0].descriptiveCoverage).toMatchObject({ plannedCount: 2, validAnswerCount: 2 });
    expect(report.providers[0].descriptiveCoverage).not.toHaveProperty('acceptableRateAllTrials');
    expect(report.providers[0].overall).not.toHaveProperty('acceptableCount');
    expect(report.providers[0].actualModels).toEqual(['resolved-fixture-v1']);
    expect(renderReleaseMarkdown(report)).toContain('not personality accuracy');
  });
  it('keeps all planned opportunities and unknown billing in a partial report', async () => {
    const run = await makeRun('paid', { provider: { id: 'paid', model: 'fixture-v1', paid: true, decide: async () => ({ choice: 'a', affect: 'focused', latencyMs: 1 }) } });
    const report = await buildReleaseReport([run.outputDir]);
    expect(report.providers[0]).toMatchObject({ complete: false, stopReason: 'unknown-billing',
      overall: { plannedCount: 6, attemptedCount: 1, unattemptedCount: 5, totalCostUSD: null, unknownCostCount: 1 },
      taskCriterion: { plannedCount: 4, acceptableRateAllTrials: 0.25 }, descriptiveCoverage: { plannedCount: 2, attemptedCount: 0 } });
  });
  it('reconciles unresolved in-flight cost without assuming an exact zero total', async () => {
    const run = await makeRun('first', { maxRequests: 1 });
    await mutateJson(join(run.outputDir, 'manifest.json'), manifest => { manifest.inFlight = { sequence: 2, caseId: 'task-one', trial: 2 }; });
    const report = await buildReleaseReport([run.outputDir]);
    expect(report.providers[0].overall).toMatchObject({ outstandingRequestCount: 1, totalCostUSD: null });
    expect(report.providers[0].taskCriterion).toMatchObject({ outstandingRequestCount: 1, totalCostUSD: null });
  });
  it('checks exact case file bytes and rejects mixed case definitions even with updated hashes', async () => {
    const a = await makeRun('a'), b = await makeRun('b');
    await writeFile(join(b.outputDir, 'cases.json'), (await readFile(join(b.outputDir, 'cases.json'), 'utf8')) + ' ');
    await expect(buildReleaseReport([b.outputDir])).rejects.toThrow('Case definitions hash mismatch');
    const changed = await readFile(join(b.outputDir, 'cases.json'));
    await mutateJson(join(b.outputDir, 'manifest.json'), manifest => { manifest.caseDefinitionsSha256 = createHash('sha256').update(changed).digest('hex'); });
    await expect(buildReleaseReport([a.outputDir, b.outputDir])).rejects.toThrow('Runs do not share the same freeze');
  });
  it('rejects dirty or cross-source, seed and repetition comparisons', async () => {
    const a = await makeRun('a');
    for (const change of [{ gitDirty: true }, { gitRevision: 'b'.repeat(40) }, { seed: 'different' }, { repeats: 1 }]) {
      const b = await makeRun('b', change);
      await expect(buildReleaseReport([a.outputDir, b.outputDir])).rejects.toThrow(/clean frozen source|same freeze/);
    }
  });
  it('rejects duplicate providers, duplicate/misassigned records, and forged model-visible input', async () => {
    const a = await makeRun('same'), b = await makeRun('same');
    await expect(buildReleaseReport([a.outputDir, b.outputDir])).rejects.toThrow('Duplicate provider ID');
    const bad = await makeRun('bad', { maxRequests: 1 });
    await rewriteRecords(bad.outputDir, [bad.result.records[0], bad.result.records[0]]);
    await expect(buildReleaseReport([bad.outputDir])).rejects.toThrow(/sequence|Duplicate/);
    const record = structuredClone(bad.result.records[0]); record.provider.id = 'mixed'; await rewriteRecords(bad.outputDir, [record]);
    await expect(buildReleaseReport([bad.outputDir])).rejects.toThrow('Record provider does not match manifest');
    record.provider.id = 'bad'; record.permutationSeed = 'another-freeze'; await rewriteRecords(bad.outputDir, [record]);
    await expect(buildReleaseReport([bad.outputDir])).rejects.toThrow('Record seed does not match freeze');
    record.permutationSeed = bad.result.records[0].permutationSeed; Object.assign(record.input, { unexpectedModelVisibleField: true }); await rewriteRecords(bad.outputDir, [record]);
    await expect(buildReleaseReport([bad.outputDir])).rejects.toThrow('Record input has unsupported fields');
    record.input = structuredClone(bad.result.records[0].input); record.input.state.visible = false; await rewriteRecords(bad.outputDir, [record]);
    await expect(buildReleaseReport([bad.outputDir])).rejects.toThrow('Record input differs from frozen case');
  });
  it('rejects candidate-order tampering even when the candidate set and permutation seed match', async () => {
    const run = await makeRun('order', { maxRequests: 1 });
    run.result.records[0].input.options.reverse();
    await rewriteRecords(run.outputDir, run.result.records);
    await expect(buildReleaseReport([run.outputDir])).rejects.toThrow('Record input differs from frozen case');
  });
  it('verifies the nested state.options projection against the same frozen permutation', async () => {
    const scenario = baseCase('projection'); scenario.input.state.options = structuredClone(scenario.input.options);
    const run = await makeRun('projection', { cases: [scenario], maxRequests: 1 });
    expect((await buildReleaseReport([run.outputDir])).providers[0].overall.attemptedCount).toBe(1);
    (run.result.records[0].input.state.options as unknown[]).reverse();
    await rewriteRecords(run.outputDir, run.result.records);
    await expect(buildReleaseReport([run.outputDir])).rejects.toThrow('Record input differs from frozen case');
  });
  it('rejects records beyond the frozen planned count', async () => {
    const run = await makeRun();
    await rewriteRecords(run.outputDir, [...run.result.records, { ...run.result.records[0], sequence: 7 }]);
    await expect(buildReleaseReport([run.outputDir])).rejects.toThrow('Record count exceeds planned opportunities');
  });
  it('checks optional provenance and execution without claiming absent evidence', async () => {
    const a = await makeRun('a'), b = await makeRun('b');
    await writeFile(join(a.outputDir, 'provenance.json'), JSON.stringify({ sourceHashes: { 'source.ts': '1'.repeat(64) } }));
    await writeFile(join(b.outputDir, 'provenance.json'), JSON.stringify({ sourceHashes: { 'source.ts': '2'.repeat(64) } }));
    await expect(buildReleaseReport([a.outputDir, b.outputDir])).rejects.toThrow('Source hash provenance mismatch');
    await writeFile(join(a.outputDir, 'execution.json'), JSON.stringify(a.result.records.map(record => ({ sequence: record.sequence, caseId: record.caseId, provider: record.provider, status: record.status, execution: { applied: true, validSave: record.sequence !== 2 } }))));
    const report = await buildReleaseReport([a.outputDir]);
    expect(report.providers[0].mechanical).toMatchObject({ evidenceAvailable: true, checkedResults: 6, appliedCount: 6, invalidSaveCount: 1 });
    const absent = await buildReleaseReport([b.outputDir]); expect(absent.providers[0].mechanical.evidenceAvailable).toBe(false);
  });
  it('reports wholly missing delivery trials outside the observed-trial paired summary', async () => {
    const run = await makeRun('delivery', { cases: deliveryCases(), maxRequests: 1 });
    const report = await buildReleaseReport([run.outputDir]);
    expect(report.freeze).toMatchObject({ taskCriterionCaseCount: 0, descriptiveCaseCount: 16 });
    expect(report.providers[0].taskCriterion.plannedCount).toBe(0);
    expect(report.providers[0].delivery).toMatchObject({ expectedPlannedTrials: [1, 2], observedTrials: [1], missingWholeTrials: [2], completePlannedCoverage: false });
    expect(report.providers[0].delivery!.matched.factors.persona.plannedEligiblePairs).toBe(8);
  });
  it('accepts positional run directories in the offline report CLI', async () => {
    const run = await makeRun(), outputDir = join(run.root, 'cli-report');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const paths = await reportMain([run.outputDir, '--out', outputDir]);
      expect(JSON.parse(await readFile(paths.json, 'utf8')).providers).toHaveLength(1);
      await expect(reportMain([run.outputDir])).rejects.toThrow('Provide run directories');
    } finally { output.mockRestore(); }
  });
  it('writes reviewable JSON and Markdown into an exclusive directory without overwriting', async () => {
    const run = await makeRun(), report = await buildReleaseReport([run.outputDir]), outputDir = join(run.root, 'report');
    const paths = await writeReleaseReport(report, outputDir);
    expect(JSON.parse(await readFile(paths.json, 'utf8')).freeze.caseCount).toBe(3);
    expect(await readFile(paths.markdown, 'utf8')).toContain('Task criterion');
    await expect(writeReleaseReport(report, outputDir)).rejects.toThrow();
  });
});

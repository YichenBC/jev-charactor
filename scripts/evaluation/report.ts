import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { decisionInput } from '../../server/jev';
import { REACTION_OPTIONS } from '../../src/character';
import { summarizeDelivery } from './delivery-cases';
import { summarizeRun } from './summary';
import { seededPermutation } from './runner';
import type { DecisionInput, EvaluationCase, EvaluationManifest, EvaluationMetrics, EvaluationRecord, EvaluationSummary } from './types';

const text = z.string().min(1), count = z.number().int().nonnegative(), nonnegative = z.number().finite().nonnegative();
const caseIdentity = z.object({ id: text, familyId: text, split: z.enum(['development', 'test']) });
const caseSchema = caseIdentity.extend({ input: decisionInput, acceptableChoices: z.array(text).min(1), rationale: text, tags: z.array(text) });
const responseSchema = z.object({ choice: z.string(), affect: z.string(), latencyMs: nonnegative, cost: nonnegative.optional(), model: text.optional(), contractValid: z.boolean().optional() });
const recordProvider = z.object({ id: text, requestedModel: text, responseModel: text.nullable() });
const recordSchema = z.object({
  schemaVersion: z.literal(1), sequence: z.number().int().positive(), caseId: text, familyId: text, split: z.enum(['development', 'test']),
  trial: z.number().int().min(1).max(20), permutationSeed: text, startedAt: text, finishedAt: text, provider: recordProvider,
  input: decisionInput, scoring: z.object({ acceptableChoices: z.array(text), rationale: z.string(), tags: z.array(z.string()) }),
  response: responseSchema.nullable(), status: z.enum(['valid-answer', 'invalid-answer', 'error']), errorCode: z.string().nullable(),
  acceptable: z.boolean(), latencyMs: nonnegative, costUSD: nonnegative.nullable(),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1), caseDefinitionsSha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: text, updatedAt: text,
  gitRevision: text, gitDirty: z.boolean().nullable(), runtime: z.object({ node: text, platform: text, arch: text }),
  provider: z.object({ id: text, model: text, paid: z.boolean(), protocolVersion: text.nullable() }),
  config: z.object({ seed: text, repeats: z.number().int().min(1).max(20), maxRequests: z.number().int().positive(), maxReportedCostUSD: nonnegative,
    concurrency: z.literal(1), retries: z.literal(0), optionOrder: text }),
  cases: z.array(caseIdentity).min(1), plannedCount: z.number().int().positive(), actualCount: count, complete: z.boolean(),
  stopReason: z.enum(['request-budget', 'reported-cost-budget', 'unknown-billing', 'authentication-error', 'billing-error', 'consecutive-errors']).nullable(),
  inFlight: z.object({ caseId: text, trial: z.number().int().positive(), sequence: z.number().int().positive() }).nullable(),
  budget: z.object({ knownCostUSD: nonnegative, unknownCostCount: count, overshootUSD: nonnegative, note: z.string() }),
});

async function optionalJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
/** Reproduce the exact model-visible ordering frozen by runner.ts, rather than comparing sets. */
function expectedInput(input: DecisionInput, permutationSeed: string) {
  const expected = structuredClone(input);
  expected.options = seededPermutation(expected.options, permutationSeed);
  if (Array.isArray(expected.state.options)) {
    const duplicates = expected.state.options as { id?: unknown }[];
    if (duplicates.length === expected.options.length && duplicates.every(option => option && expected.options.some(candidate => candidate.id === option.id))) {
      expected.state.options = expected.options.map(option => duplicates.find(candidate => candidate.id === option.id));
    }
  }
  return expected;
}
function coverageMetrics(metrics: EvaluationMetrics) {
  const { acceptableCount: _count, acceptableRateAllTrials: _all, acceptableRateValidAnswers: _valid, ...coverage } = metrics;
  return coverage;
}
function coverageSummary(summary: EvaluationSummary) {
  const { byFamily, ...total } = summary;
  return { ...coverageMetrics(total), byFamily: Object.fromEntries(Object.entries(byFamily).map(([family, metrics]) => [family, coverageMetrics(metrics)])) };
}
function subsetSummary(cases: EvaluationCase[], records: EvaluationRecord[], manifest: EvaluationManifest) {
  const ids = new Set(cases.map(item => item.id));
  return summarizeRun(records.filter(record => ids.has(record.caseId)), {
    ...manifest, cases: cases.map(({ id, familyId, split }) => ({ id, familyId, split })), plannedCount: cases.length * manifest.config.repeats,
    inFlight: manifest.inFlight && ids.has(manifest.inFlight.caseId) ? manifest.inFlight : null,
  });
}
function mechanicalSummary(raw: unknown | null, records: EvaluationRecord[], plannedCount: number) {
  const entries = raw === null ? [] : z.array(z.object({ sequence: z.number().int().positive(), caseId: text, provider: recordProvider,
    status: z.enum(['valid-answer', 'invalid-answer', 'error']), execution: z.object({ applied: z.boolean(), validSave: z.boolean() }).passthrough().nullable(),
  })).parse(raw);
  const seen = new Set<number>();
  for (const item of entries) {
    const record = records.find(record => record.sequence === item.sequence);
    assert(record && !seen.has(item.sequence), 'Invalid or duplicate execution sequence');
    assert(item.caseId === record.caseId && item.status === record.status && isDeepStrictEqual(item.provider, record.provider), 'Execution does not match raw record');
    assert(item.execution === null || record.status === 'valid-answer', 'Execution attached to an invalid answer');
    seen.add(item.sequence);
  }
  const results = entries.flatMap(item => item.execution === null ? [] : [item.execution]);
  return { evidenceAvailable: raw !== null, plannedCount, checkedResults: results.length,
    appliedCount: results.filter(item => item.applied).length, rejectedCount: results.filter(item => !item.applied).length,
    invalidSaveCount: results.filter(item => !item.validSave).length,
    missingValidAnswerExecutions: records.filter(record => record.status === 'valid-answer' && !entries.some(item => item.sequence === record.sequence && item.execution)).length };
}

async function readRun(directory: string) {
  const runDirectory = resolve(directory);
  const [caseBytes, manifestText, recordsText, provenanceRaw, executionRaw] = await Promise.all([
    readFile(join(runDirectory, 'cases.json')), readFile(join(runDirectory, 'manifest.json'), 'utf8'), readFile(join(runDirectory, 'records.jsonl'), 'utf8'),
    optionalJson(join(runDirectory, 'provenance.json')), optionalJson(join(runDirectory, 'execution.json')),
  ]);
  const manifest: EvaluationManifest = manifestSchema.parse(JSON.parse(manifestText));
  assert(manifest.gitDirty === false, 'A clean frozen source is required (gitDirty=false)');
  assert(createHash('sha256').update(caseBytes).digest('hex') === manifest.caseDefinitionsSha256, 'Case definitions hash mismatch');
  const cases: EvaluationCase[] = z.array(caseSchema).min(1).parse(JSON.parse(caseBytes.toString('utf8')));
  assert(new Set(cases.map(item => item.id)).size === cases.length, 'Duplicate case definitions');
  assert(isDeepStrictEqual(manifest.cases, cases.map(({ id, familyId, split }) => ({ id, familyId, split }))), 'Manifest cases differ from definitions');
  assert(manifest.plannedCount === cases.length * manifest.config.repeats, 'Manifest planned count differs from definitions');
  for (const item of cases) assert(new Set(item.acceptableChoices).size === item.acceptableChoices.length && item.acceptableChoices.every(choice => item.input.options.some(option => option.id === choice)), 'Invalid frozen acceptable choice');
  const records: EvaluationRecord[] = recordsText.split('\n').filter(line => line.trim()).map(line => {
    const raw: unknown = JSON.parse(line), record = recordSchema.parse(raw);
    assert(isDeepStrictEqual(record.input, z.object({ input: z.unknown() }).parse(raw).input), 'Record input has unsupported fields');
    return record;
  });
  assert(records.length <= manifest.plannedCount, 'Record count exceeds planned opportunities');
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    assert(record.sequence === index + 1, 'Duplicate or noncontiguous record sequence');
    assert(record.provider.id === manifest.provider.id && record.provider.requestedModel === manifest.provider.model, 'Record provider does not match manifest');
    const plannedCase = cases[Math.floor((record.sequence - 1) / manifest.config.repeats)];
    const plannedTrial = (record.sequence - 1) % manifest.config.repeats + 1;
    assert(record.permutationSeed === JSON.stringify([manifest.config.seed, record.caseId, record.trial]), 'Record seed does not match freeze');
    assert(record.caseId === plannedCase.id && record.trial === plannedTrial && record.familyId === plannedCase.familyId && record.split === plannedCase.split, 'Record sequence does not match planned case/trial');
    assert(isDeepStrictEqual(record.input, expectedInput(plannedCase.input, record.permutationSeed)), 'Record input differs from frozen case');
    // Stored scoring labels and acceptable booleans are not authoritative evidence.
    record.scoring = { acceptableChoices: [...plannedCase.acceptableChoices], rationale: plannedCase.rationale, tags: [...plannedCase.tags] };
    if (record.status === 'valid-answer' && (!record.response || record.response.contractValid === false ||
      !plannedCase.input.options.some(option => option.id === record.response!.choice) || !REACTION_OPTIONS.some(option => option.id === record.response!.affect))) {
      record.status = 'invalid-answer'; record.errorCode = 'report_invalid_response';
    }
    record.acceptable = record.status === 'valid-answer' && plannedCase.acceptableChoices.includes(record.response!.choice);
  }
  if (manifest.inFlight) {
    const pending = manifest.inFlight;
    assert(pending.sequence <= manifest.plannedCount && [records.length, records.length + 1].includes(pending.sequence), 'Invalid in-flight sequence');
    assert(pending.caseId === cases[Math.floor((pending.sequence - 1) / manifest.config.repeats)].id && pending.trial === (pending.sequence - 1) % manifest.config.repeats + 1, 'Invalid in-flight case/trial');
  }
  assert(manifest.actualCount === records.length || (manifest.actualCount === records.length - 1 && manifest.inFlight?.sequence === records.length), 'Manifest actual count does not match durable records');
  assert(!manifest.complete || records.length === manifest.plannedCount, 'Complete manifest has missing records');
  const provenance = provenanceRaw === null ? null : z.object({ sourceHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).parse(provenanceRaw);
  return { runDirectory, cases, records, manifest, provenance, mechanical: mechanicalSummary(executionRaw, records, manifest.plannedCount) };
}

/** Read-only reconstruction from frozen definitions and JSONL; cached summary files are never read. */
export async function buildReleaseReport(runDirs: readonly string[]) {
  assert(runDirs.length > 0, 'At least one run directory is required');
  const runs = await Promise.all(runDirs.map(readRun));
  const first = runs[0];
  const freezeKey = (manifest: EvaluationManifest) => JSON.stringify([manifest.caseDefinitionsSha256, manifest.config.seed, manifest.config.repeats, manifest.gitRevision]);
  assert(runs.every(run => freezeKey(run.manifest) === freezeKey(first.manifest)), 'Runs do not share the same freeze');
  assert(new Set(runs.map(run => run.manifest.provider.id)).size === runs.length, 'Duplicate provider ID');
  const provenances = runs.flatMap(run => run.provenance ? [run.provenance.sourceHashes] : []);
  assert(provenances.every(hashes => isDeepStrictEqual(hashes, provenances[0])), 'Source hash provenance mismatch');
  const taskCases = first.cases.filter(item => !item.tags.includes('descriptive-only'));
  const descriptiveCases = first.cases.filter(item => item.tags.includes('descriptive-only'));
  const deliveryDefinitions = first.cases.filter(item => item.id.startsWith('delivery/'));
  const providers = runs.map(run => {
    const fullSummary = summarizeRun(run.records, run.manifest);
    const deliveryRecords = run.records.filter(record => record.caseId.startsWith('delivery/'));
    const deliveryMatched = deliveryDefinitions.length ? summarizeDelivery(deliveryRecords) : null;
    const expectedPlannedTrials = Array.from({ length: run.manifest.config.repeats }, (_, index) => index + 1);
    return {
      id: run.manifest.provider.id, requestedModel: run.manifest.provider.model, protocolVersion: run.manifest.provider.protocolVersion,
      actualModels: [...new Set(run.records.flatMap(record => record.provider.responseModel ? [record.provider.responseModel] : []))].sort(),
      missingActualModelCount: run.records.filter(record => record.provider.responseModel === null).length,
      runDirectory: run.runDirectory, sourceCommit: run.manifest.gitRevision, sourceHashes: run.provenance?.sourceHashes ?? null,
      complete: run.records.length === run.manifest.plannedCount && fullSummary.outstandingRequestCount === 0, stopReason: run.manifest.stopReason,
      overall: coverageSummary(fullSummary), taskCriterion: subsetSummary(taskCases, run.records, run.manifest),
      descriptiveCoverage: coverageSummary(subsetSummary(descriptiveCases, run.records, run.manifest)), mechanical: run.mechanical,
      delivery: deliveryMatched ? {
        expectedPlannedTrials, observedTrials: deliveryMatched.observedTrials,
        missingWholeTrials: expectedPlannedTrials.filter(trial => !deliveryMatched.observedTrials.includes(trial)),
        expectedPlannedRecords: deliveryDefinitions.length * run.manifest.config.repeats,
        fullFactorialDefinition: deliveryDefinitions.length === 16,
        completePlannedCoverage: deliveryDefinitions.length === 16 && deliveryRecords.length === deliveryDefinitions.length * run.manifest.config.repeats,
        matched: deliveryMatched,
      } : null,
    };
  });
  return {
    schemaVersion: 1 as const, generatedAt: new Date().toISOString(),
    freeze: { caseDefinitionsSha256: first.manifest.caseDefinitionsSha256, sourceCommit: first.manifest.gitRevision, gitDirty: false as const,
      seed: first.manifest.config.seed, repeats: first.manifest.config.repeats, caseCount: first.cases.length,
      taskCriterionCaseCount: taskCases.length, descriptiveCaseCount: descriptiveCases.length,
      splits: [...new Set(first.cases.map(item => item.split))], },
    frameworkConstraints: {
      note: 'Candidate availability, dialogue wording, forecasts, knowledge isolation, and settlement effects are implemented by the framework. Passing these checks is not independent evidence of model role-playing ability.',
      constrainedCaseIds: first.cases.filter(item => ['expired-evidence', 'topic-return'].includes(item.familyId)).map(item => item.id),
      constrainedCasesExplanation: 'Expired-evidence closure and topic-return replies are largely authored/compiler-constrained integration checks, not rich semantic decisions.',
    },
    providers,
    limitations: [
      'Task criterion measures agreement with authored development objectives, not personality accuracy, naturalness, or held-out generalization.',
      'Descriptive-only gifts and delivery cases are excluded from task criterion denominators and are reported only as coverage and descriptive behavior.',
      'All planned task opportunities remain in the primary denominator, including failures, missing responses, and unattempted opportunities.',
      'Costs are provider-reported subtotals. Missing billing or an unresolved request makes total cost unknown; no later provider invoice is inferred.',
      'Clean commit and optional source hashes are checked for consistency across submitted artifacts; this does not independently authenticate the remote provider or prove historical execution.',
      'Delivery paired tables only cover observed trial IDs. Compare missingWholeTrials and planned coverage before interpreting a partial table.',
      'Execution evidence, if present, is validated for identity and summarized separately. Missing execution evidence is not assumed to pass.',
    ],
  };
}
export type ReleaseReport = Awaited<ReturnType<typeof buildReleaseReport>>;

const cell = (value: unknown) => String(value ?? 'unknown').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const percent = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
export function renderReleaseMarkdown(report: ReleaseReport): string {
  const lines = [
    '# Frozen development evaluation report', '',
    `Source commit: \`${cell(report.freeze.sourceCommit)}\` (clean). Seed: \`${cell(report.freeze.seed)}\`. Repeats: ${report.freeze.repeats}.`,
    `Case definitions SHA-256: \`${report.freeze.caseDefinitionsSha256}\`.`, '',
    `${report.freeze.taskCriterionCaseCount} task-criterion cases; ${report.freeze.descriptiveCaseCount} descriptive-only cases. This is not personality accuracy.`, '',
    '## Task criterion', '',
    '| Provider | Complete | Valid / planned | Acceptable / planned | All planned rate | Valid-answer conditional rate |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.providers.map(provider => `| ${cell(provider.id)} | ${provider.complete ? 'yes' : 'no'} | ${provider.taskCriterion.validAnswerCount} / ${provider.taskCriterion.plannedCount} | ${provider.taskCriterion.acceptableCount} / ${provider.taskCriterion.plannedCount} | ${percent(provider.taskCriterion.acceptableRateAllTrials)} | ${percent(provider.taskCriterion.acceptableRateValidAnswers)} |`), '',
    '## Coverage and reported billing (all cases)', '',
    '| Provider | Recorded / planned | Failures | Outstanding | Known cost subtotal USD | Unknown-cost records | Total cost USD | Actual models |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.providers.map(provider => `| ${cell(provider.id)} | ${provider.overall.attemptedCount} / ${provider.overall.plannedCount} | ${provider.overall.failureCount} | ${provider.overall.outstandingRequestCount} | ${provider.overall.knownCostUSD} | ${provider.overall.unknownCostCount} | ${cell(provider.overall.totalCostUSD)} | ${cell(provider.actualModels.join(', ') || 'unreported')} |`), '',
    '## Descriptive-only coverage', '',
    '| Provider | Valid / planned | Failures |', '| --- | --- | --- |',
    ...report.providers.map(provider => `| ${cell(provider.id)} | ${provider.descriptiveCoverage.validAnswerCount} / ${provider.descriptiveCoverage.plannedCount} | ${provider.descriptiveCoverage.failureCount} |`), '',
    'No accuracy is assigned to this descriptive group.', '',
    '## Mechanical evidence and model provenance', '',
    ...report.providers.map(provider => `- ${cell(provider.id)}: requested ${cell(provider.requestedModel)}; ${provider.missingActualModelCount} records lack an actual model ID; execution ${provider.mechanical.evidenceAvailable ? `${provider.mechanical.checkedResults} checked, ${provider.mechanical.rejectedCount} rejected, ${provider.mechanical.invalidSaveCount} invalid saves` : 'unavailable'}; stop reason ${cell(provider.stopReason ?? 'none')}.`), '',
  ];
  for (const provider of report.providers) if (provider.delivery) {
    lines.push(`## Delivery comparisons: ${cell(provider.id)}`, '',
      `Observed trials ${provider.delivery.observedTrials.join(', ') || 'none'} of planned ${provider.delivery.expectedPlannedTrials.join(', ')}; wholly missing trials ${provider.delivery.missingWholeTrials.join(', ') || 'none'}. Complete planned coverage: ${provider.delivery.completePlannedCoverage ? 'yes' : 'no'}.`, '',
      '| Factor | Valid / eligible observed-trial pairs | Missing pairs | Invalid pairs | Action changes | Affect changes | Generosity increase / same / decrease | Different candidate sets |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const [factor, values] of Object.entries(provider.delivery.matched.factors)) lines.push(`| ${factor} (${values.direction}) | ${values.validPairs} / ${values.plannedEligiblePairs} | ${values.missingPairs} | ${values.invalidPairs} | ${values.changedAction} | ${values.changedAffect} | ${values.generosityDirection.increase} / ${values.generosityDirection.same} / ${values.generosityDirection.decrease} | ${values.candidateSets.different} |`);
    lines.push('', 'These are descriptive counts, not significance tests. Full pair and repeat-stability records are in report.json.', '');
  }
  lines.push('## Framework constraints and limitations', '', report.frameworkConstraints.note, report.frameworkConstraints.constrainedCasesExplanation,
    `Constrained case IDs: ${report.frameworkConstraints.constrainedCaseIds.map(cell).join(', ') || 'none in this freeze'}.`, '', ...report.limitations.map(note => `- ${note}`), '');
  return lines.join('\n');
}

/** New directory and exclusive files: existing evidence or reports are never overwritten. */
export async function writeReleaseReport(report: ReleaseReport, outputDir: string) {
  const directory = resolve(outputDir);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  const json = join(directory, 'report.json'), markdown = join(directory, 'report.md');
  await writeFile(json, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(markdown, renderReleaseMarkdown(report), { flag: 'wx', mode: 0o600 });
  return { json, markdown };
}

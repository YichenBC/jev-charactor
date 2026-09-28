import { createHash } from 'node:crypto';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { decisionInput } from '../../server/jev.js';
import { summarizeRun } from './summary.js';
import type { EvaluationConfig, EvaluationManifest, EvaluationRecord, EvaluationResponse, EvaluationResult } from './types.js';

const nonempty = z.string().trim().min(1);
const caseSchema = z.object({
  id: nonempty, familyId: nonempty, split: z.enum(['development', 'test']), permutationGroup: nonempty.optional(), input: decisionInput,
  acceptableChoices: z.array(nonempty).min(1), rationale: nonempty, tags: z.array(nonempty),
}).strict().superRefine((value, context) => {
  if (new Set(value.acceptableChoices).size !== value.acceptableChoices.length ||
      value.acceptableChoices.some(id => !value.input.options.some(option => option.id === id))) {
    context.addIssue({ code: 'custom', message: 'Acceptable choices must be unique candidate IDs' });
  }
});
const evidenceSchema = z.object({
  rawContent: z.string().nullable().optional(), finishReason: z.string().nullable().optional(),
  dialogue: z.string().nullable().optional(), contractValid: z.boolean().optional(),
  tokenUsage: z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).optional(),
});
const responseSchema = evidenceSchema.extend({
  choice: z.string(), affect: z.enum(['warm', 'guarded', 'focused', 'worried', 'irritated']),
  latencyMs: z.number().finite().nonnegative(), cost: z.number().finite().nonnegative().optional(), model: nonempty.optional(),
  contractValid: z.boolean().optional(),
});

/** SHA-256 driven Fisher–Yates, independent of provider and process RNG. */
export function seededPermutation<T>(items: readonly T[], seed: string): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const random = createHash('sha256').update(JSON.stringify([seed, i])).digest().readUInt32BE(0) / 0x100000000;
    const j = Math.floor(random * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function assertJson(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || seen.has(value)) throw new Error('Fixtures must contain only finite, acyclic JSON data');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Fixtures must contain plain JSON objects');
  seen.add(value);
  for (const item of Object.values(value)) assertJson(item, seen);
  seen.delete(value);
}
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/401|403|missing_key|authentication|unauthorized/i.test(message)) return 'authentication_error';
  if (/402|insufficient.credit|payment.required/i.test(message)) return 'billing_error';
  if (/timeout|abort/i.test(message)) return 'timeout';
  if (/429|rate.limit/i.test(message)) return 'rate_limit';
  // Never persist an upstream message: it may contain credentials or response bodies.
  return 'request_error';
}
async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  await rename(temporary, path);
}

export async function runEvaluation(config: EvaluationConfig): Promise<EvaluationResult> {
  z.object({ repeats: z.number().int().min(1).max(20), maxRequests: z.number().int().min(1).max(100000),
    maxReportedCostUSD: z.number().finite().nonnegative(), seed: nonempty, outputDir: nonempty, gitRevision: nonempty,
    gitDirty: z.boolean().optional(),
  }).parse(config);
  z.object({ id: nonempty, model: nonempty, paid: z.boolean().optional(), protocolVersion: nonempty.optional() }).parse(config.provider);
  if (typeof config.provider.decide !== 'function') throw new Error('Provider must implement decide');
  assertJson(config.cases);
  if (config.provenance !== undefined) assertJson(config.provenance);
  const cases = z.array(caseSchema).min(1).max(10000).parse(config.cases);
  if (new Set(cases.map(value => value.id)).size !== cases.length) throw new Error('Duplicate case IDs');
  const familySplits = new Map<string, string>();
  for (const item of cases) {
    if (familySplits.has(item.familyId) && familySplits.get(item.familyId) !== item.split) throw new Error('A family cannot cross development/test splits');
    familySplits.set(item.familyId, item.split);
  }
  const definitions = `${JSON.stringify(cases, null, 2)}\n`;
  const createdAt = new Date().toISOString();
  const manifest: EvaluationManifest = {
    schemaVersion: 1, caseDefinitionsSha256: createHash('sha256').update(definitions).digest('hex'), createdAt, updatedAt: createdAt,
    gitRevision: config.gitRevision, gitDirty: config.gitDirty ?? null,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    provider: { id: config.provider.id, model: config.provider.model, paid: config.provider.paid ?? true, protocolVersion: config.provider.protocolVersion ?? null },
    config: { seed: config.seed, repeats: config.repeats, maxRequests: config.maxRequests, maxReportedCostUSD: config.maxReportedCostUSD,
      concurrency: 1, retries: 0, optionOrder: 'sha256-fisher-yates-v1; candidate list only (and matching state.options projection); seed + (permutationGroup or case ID) + trial, same across providers; other state order fixed' },
    cases: cases.map(({ id, familyId, split }) => ({ id, familyId, split })), plannedCount: cases.length * config.repeats,
    actualCount: 0, complete: false, stopReason: null, inFlight: null,
    budget: { knownCostUSD: 0, unknownCostCount: 0, overshootUSD: 0,
      note: 'Reported costs only. The budget may overshoot by one request; failed/timed-out requests may be billed. Unknown billing stops paid runs. An inFlight checkpoint indicates an unresolved request whose billing is unknown.' },
  };
  await mkdir(dirname(config.outputDir), { recursive: true });
  // Exclusive leaf creation prevents overwriting or silently appending to previous evidence.
  await mkdir(config.outputDir, { mode: 0o700 });
  await writeFile(join(config.outputDir, 'cases.json'), definitions, { flag: 'wx', mode: 0o600 });
  if (config.provenance !== undefined) await writeFile(join(config.outputDir, 'provenance.json'), `${JSON.stringify(config.provenance, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(join(config.outputDir, 'records.jsonl'), '', { flag: 'wx', mode: 0o600 });
  const records: EvaluationRecord[] = [];
  async function checkpoint() {
    manifest.updatedAt = new Date().toISOString();
    await atomicJson(join(config.outputDir, 'summary.json'), summarizeRun(records, manifest));
    await atomicJson(join(config.outputDir, 'manifest.json'), manifest);
  }
  await checkpoint();
  let consecutiveErrors = 0;
  outer: for (const item of cases) {
    for (let trial = 1; trial <= config.repeats; trial++) {
      if (records.length >= config.maxRequests) { manifest.stopReason = 'request-budget'; break outer; }
      if (manifest.provider.paid && manifest.budget.knownCostUSD >= config.maxReportedCostUSD) { manifest.stopReason = 'reported-cost-budget'; break outer; }
      const permutationSeed = JSON.stringify([config.seed, item.permutationGroup ?? item.id, trial]);
      const input = structuredClone(item.input);
      input.options = seededPermutation(input.options, permutationSeed);
      if (Array.isArray(input.state.options)) {
        // Duplicate candidate projections must not reveal the original candidate ordering.
        const duplicates = input.state.options as { id?: unknown }[];
        if (duplicates.length === input.options.length && duplicates.every(option => option && input.options.some(candidate => candidate.id === option.id))) {
          input.state.options = input.options.map(option => duplicates.find(candidate => candidate.id === option.id));
        }
      }
      const sequence = records.length + 1;
      manifest.inFlight = { caseId: item.id, trial, sequence };
      await checkpoint();
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let response: EvaluationResponse | null = null;
      let responseEvidence: EvaluationRecord['responseEvidence'];
      let status: EvaluationRecord['status'] = 'error';
      let failure: string | null = null;
      let costUSD: number | null = null;
      let responseModel: string | null = null;
      try {
        const raw: unknown = await config.provider.decide(structuredClone(input));
        // Billing and actual model provenance remain valid even if answer validation fails.
        const modelMetadata = z.object({ model: nonempty }).safeParse(raw);
        if (modelMetadata.success) responseModel = modelMetadata.data.model;
        const billing = z.object({ cost: z.number().finite().nonnegative() }).safeParse(raw);
        if (billing.success) costUSD = billing.data.cost;
        if (raw !== null && typeof raw === 'object') {
          const fields: Record<string, unknown> = {};
          for (const [key, schema] of Object.entries(evidenceSchema.shape)) {
            const field = schema.safeParse((raw as Record<string, unknown>)[key]);
            if (field.success && field.data !== undefined) fields[key] = field.data;
          }
          responseEvidence = evidenceSchema.parse(fields);
        }
        const parsed = responseSchema.safeParse(raw);
        if (parsed.success) {
          response = parsed.data;
          if (response.contractValid === false) {
            status = 'invalid-answer'; failure = 'invalid_response';
          } else {
            status = input.options.some(option => option.id === response!.choice) ? 'valid-answer' : 'invalid-answer';
            if (status === 'invalid-answer') failure = 'invalid_choice';
          }
        } else { status = 'invalid-answer'; failure = 'invalid_response'; }
      } catch (error) { failure = errorCode(error); }
      const record: EvaluationRecord = {
        schemaVersion: 1, sequence, caseId: item.id, familyId: item.familyId, split: item.split, trial, permutationSeed, permutationGroup: item.permutationGroup,
        startedAt, finishedAt: new Date().toISOString(), provider: { id: config.provider.id, requestedModel: config.provider.model, responseModel },
        input, scoring: { acceptableChoices: [...item.acceptableChoices], rationale: item.rationale, tags: [...item.tags] },
        response, responseEvidence, status, errorCode: failure, acceptable: status === 'valid-answer' && item.acceptableChoices.includes(response!.choice),
        latencyMs: performance.now() - start, costUSD,
      };
      // Persist evidence before advancing the checkpoint; on interruption JSONL is authoritative.
      await appendFile(join(config.outputDir, 'records.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      records.push(record);
      manifest.actualCount = records.length;
      manifest.inFlight = null;
      manifest.budget.knownCostUSD += costUSD ?? 0;
      manifest.budget.unknownCostCount += costUSD === null ? 1 : 0;
      manifest.budget.overshootUSD = Math.max(0, manifest.budget.knownCostUSD - config.maxReportedCostUSD);
      consecutiveErrors = status === 'valid-answer' ? 0 : consecutiveErrors + 1;
      if (failure === 'authentication_error') manifest.stopReason = 'authentication-error';
      else if (failure === 'billing_error') manifest.stopReason = 'billing-error';
      else if (manifest.provider.paid && costUSD === null) manifest.stopReason = 'unknown-billing';
      else if (manifest.provider.paid && manifest.budget.knownCostUSD >= config.maxReportedCostUSD) manifest.stopReason = 'reported-cost-budget';
      else if (consecutiveErrors >= 3) manifest.stopReason = 'consecutive-errors';
      await checkpoint();
      if (manifest.stopReason) break outer;
    }
  }
  manifest.complete = records.length === manifest.plannedCount;
  await checkpoint();
  return { manifest, records, summary: summarizeRun(records, manifest) };
}

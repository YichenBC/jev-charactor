import 'dotenv/config';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { controlledCharacterSuite } from './evaluation/controlled-character-cases';
import { authoredPolicyProvider } from './evaluation/controlled-character-policy';
import { controlledPairReport } from './evaluation/controlled-character-report';
import { runEvaluation } from './evaluation/runner';
import type { EvaluationProvider } from './evaluation/types';

export function parseControlledArgs(args: string[]) {
  const { values: v } = parseArgs({ args, strict: true, options: {
    provider: { type: 'string', default: 'authored-policy' }, out: { type: 'string' },
    'max-requests': { type: 'string', default: '24' }, 'max-cost': { type: 'string', default: '1' },
    repeats: { type: 'string', default: '1' }, seed: { type: 'string', default: 'controlled-character-v1' },
    'dry-run': { type: 'boolean', default: false },
  } });
  if (!['authored-policy', 'jev', 'llm'].includes(v.provider)) throw new Error('Invalid provider');
  if (!v.seed.trim() || (v.out !== undefined && !v.out.trim())) throw new Error('Blank seed/output');
  const number = (value: string, min: number, max: number, integer: boolean) => {
    const n = Number(value);
    if (!value.trim() || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error('Invalid numeric limit');
    return n;
  };
  return { provider: v.provider, outputDir: resolve(v.out ?? `artifacts/controlled-characters/${new Date().toISOString().replaceAll(':', '-')}-${v.provider}-${randomUUID().slice(0, 8)}`),
    maxRequests: number(v['max-requests'], 1, 100000, true), maxCost: number(v['max-cost'], 0, Number.MAX_VALUE, false),
    repeats: number(v.repeats, 1, 20, true), seed: v.seed, dryRun: v['dry-run'] };
}
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const save = (directory: string, name: string, value: unknown) => writeFile(resolve(directory, name), json(value), { flag: 'wx', mode: 0o600 });
function safeRuntime(provider?: EvaluationProvider) {
  if (!provider?.runtimeSettings) return null;
  const runtime = { ...provider.runtimeSettings };
  const endpoint = new URL(runtime.endpoint);
  endpoint.username = ''; endpoint.password = ''; endpoint.search = ''; endpoint.hash = '';
  runtime.endpoint = endpoint.toString();
  return runtime;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseControlledArgs(args), suite = controlledCharacterSuite();
  const sourceGitSHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceGitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
  const files = ['scripts/evaluate-controlled-characters.ts', ...['cases', 'cards', 'policy', 'report'].map(n => `scripts/evaluation/controlled-character-${n}.ts`),
    'scripts/evaluation/runner.ts', 'scripts/evaluation/types.ts', 'scripts/evaluation/providers.ts', 'scripts/evaluation/llm.ts', 'scripts/evaluation/llm-transport.ts', 'server/jev.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(file))])));
  let provider: EvaluationProvider | undefined;
  // A dry run never constructs a transport or requires credentials.
  if (!options.dryRun) provider = options.provider === 'authored-policy' ? authoredPolicyProvider
    : options.provider === 'jev' ? (await import('./evaluation/providers')).jevProvider()
    : (await import('./evaluation/llm')).llmProvider();
  const provenance = { sourceGitSHA, sourceGitDirty, sourceHashes, requestedProvider: options.provider,
    model: provider?.model ?? null, protocol: provider?.protocolVersion ?? null,
    runtimeSettings: safeRuntime(provider), billingMode: provider?.billingMode ?? (provider?.paid ? 'metered-api' : null),
    nativeDecisionTransport: options.provider === 'jev' ? { endpoint: 'https://openrouter.ai/api/alpha/decisions', requestTimeoutMs: 12000,
      maxOutputTokens: null, outputCap: 'not applicable to native decisions', questions: ['action', 'reaction'], dnsOverrideConfigured: Boolean(process.env.JEV_DNS_SERVER?.trim()) } : null,
    scope: 'Synthetic development-only static decisions; authored contract compliance, not human character quality, hidden-world correctness or execution proof.',
    rawEvidence: 'LLM rawContent is generated message content. Jev rawContent is the decoded JSON envelope serialized again, not HTTP wire bytes. Malformed HTTP JSON yields a sanitized error only.',
  };
  if (options.dryRun) {
    await mkdir(dirname(options.outputDir), { recursive: true });
    await mkdir(options.outputDir, { mode: 0o700 });
    await save(options.outputDir, 'cases.json', suite.cases);
    await save(options.outputDir, 'pairs.json', suite.pairs);
    await save(options.outputDir, 'provenance.json', provenance);
    const report = { provider: options.provider, requests: 0, plannedRequests: suite.cases.length * options.repeats,
      boundedRequests: Math.min(suite.cases.length * options.repeats, options.maxRequests),
      caseDefinitionsSha256: hash(json(suite.cases)), pairDefinitionsSha256: hash(json(suite.pairs)), options };
    await save(options.outputDir, 'dry-run.json', report);
    console.log(json(report)); return report;
  }
  const result = await runEvaluation({ cases: suite.cases, provider: provider!, outputDir: options.outputDir,
    seed: options.seed, repeats: options.repeats, maxRequests: options.maxRequests, maxReportedCostUSD: options.maxCost,
    gitRevision: sourceGitSHA, gitDirty: sourceGitDirty, provenance });
  const pairs = controlledPairReport(suite.pairs, result.records, options.repeats);
  await save(options.outputDir, 'pairs.json', suite.pairs);
  await save(options.outputDir, 'pair-report.json', pairs);
  console.log(json({ outputDir: options.outputDir, complete: result.manifest.complete, stopReason: result.manifest.stopReason, summary: result.summary, pairs }));
  if (!result.manifest.complete || result.summary.failureCount) process.exitCode = 1;
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  console.error('Controlled evaluation failed. Inspect any checkpoint; check arguments, fresh output directory and provider configuration. No fallback ran.'); process.exitCode = 1;
});

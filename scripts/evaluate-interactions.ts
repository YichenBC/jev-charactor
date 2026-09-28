import 'dotenv/config';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ruleProvider, utilityProvider, jevProvider } from './evaluation/providers';
import { llmProvider } from './evaluation/llm';
import { llmCharacterProvider } from './evaluation/llm-character';
import { interactionScenarios } from './evaluation/interaction-scenarios';
import { roleplayEpisodes } from './evaluation/roleplay-episodes';
import { reportRoleplayEpisode } from './evaluation/roleplay-episode-report';
import { runInteractionTrajectory, replayInteractionTrajectory, type InteractionTrace } from './evaluation/interaction-trajectory';

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}
function summary(trace: InteractionTrace) {
  return {
    scenario: trace.scenario.id, provider: trace.provider, complete: trace.complete, stopReason: trace.stopReason,
    attemptedCount: trace.attempts.length, appliedCount: trace.attempts.filter(a => a.applied).length,
    skippedSteps: trace.records.filter(r => r.status === 'skipped').map(r => ({ id: r.stepId, reason: r.reason })),
    responseLatencyMs: { p50: percentile(trace.attempts.map(a => a.latencyMs), .5), p95: percentile(trace.attempts.map(a => a.latencyMs), .95) },
    knownCostUSD: trace.knownCostUSD, unknownCostCount: trace.unknownCostCount, totalCostUSD: trace.totalCostUSD,
    costNote: trace.provider.billingMode === 'self-hosted-unmetered'
      ? 'Self-hosted infrastructure cost is unmeasured; null is not free inference.' : 'Reported API billing only.',
    validSave: trace.validSave, scope: trace.scope,
  };
}
function literal(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
function transcript(trace: InteractionTrace): string {
  const lines = [`# ${trace.scenario.id} — ${trace.provider.id}`, '',
    'Development transcript, not a blind rating or held-out quality result. Audit state is separate from what the character observed.',
    '', literal(JSON.stringify(summary(trace), null, 2)), ''];
  for (const record of trace.records) {
    lines.push(`## ${record.stepId} (${record.status})`, '');
    if (record.playerAction) lines.push('Player:', literal(record.playerAction.label), '');
    if (record.reply) lines.push('Character:', literal(record.reply), '');
    if (record.reason) lines.push(`Reason: ${record.reason}`, '');
    const attempt = trace.attempts.find(a => a.sequence === record.attemptSequence);
    lines.push('Audit:', literal(JSON.stringify({ choice: attempt?.response?.choice, affect: attempt?.response?.affect,
      model: attempt?.response?.model, latencyMs: attempt?.latencyMs, costUSD: attempt?.costUSD,
      before: { time: record.before.time, needs: record.before.needs, trust: record.before.trust, money: record.before.player.money },
      after: { time: record.after.time, needs: record.after.needs, trust: record.after.trust, money: record.after.player.money,
        inventory: record.after.player.inventory, job: record.after.job, goals: record.after.goals },
      events: record.events, peerDecisions: record.peerDecisions,
    }, null, 2)), '');
  }
  return lines.join('\n') + '\n';
}
async function main() {
  const { values } = parseArgs({ strict: true, options: {
    provider: { type: 'string', default: 'rules' }, scenario: { type: 'string', default: 'mei-continuity' },
    'max-requests': { type: 'string', default: '12' }, 'max-cost': { type: 'string', default: '.1' },
    seed: { type: 'string', default: 'interaction-development-v1' }, out: { type: 'string' }, replay: { type: 'string' },
  } });
  if (values.replay) {
    const trace = JSON.parse(await readFile(resolve(values.replay), 'utf8')) as InteractionTrace;
    console.log(JSON.stringify(await replayInteractionTrajectory(trace)));
    return;
  }
  if (!['rules', 'utility', 'jev', 'llm', 'llm-character'].includes(values.provider)) throw new Error('invalid_provider');
  const episodes = roleplayEpisodes();
  const scenario = [...interactionScenarios(), ...episodes].find(s => s.id === values.scenario);
  if (!scenario) throw new Error('invalid_scenario');
  const maxRequests = Number(values['max-requests']), maxReportedCostUSD = Number(values['max-cost']);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000 || !Number.isFinite(maxReportedCostUSD) || maxReportedCostUSD < 0) throw new Error('invalid_limits');
  const provider = values.provider === 'llm-character' ? llmCharacterProvider() : values.provider === 'llm' ? llmProvider()
    : values.provider === 'jev' ? jevProvider() : values.provider === 'utility' ? utilityProvider : ruleProvider;
  const outputDir = resolve(values.out ?? `artifacts/interactions/${new Date().toISOString().replaceAll(':', '-')}-${provider.id}-${randomUUID().slice(0, 8)}`);
  const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'src', 'server', 'scripts', 'packages/core', 'package.json', 'package-lock.json', 'tsconfig.json'], { encoding: 'utf8' })
    .trim().split('\n').filter(p => /\.(ts|json|mjs)$/.test(p));
  const provenance = {
    createdAt: new Date().toISOString(), gitRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    gitDirty: Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    scenarioSha256: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'),
    sourceHashes: Object.fromEntries(await Promise.all(sourcePaths.map(async p => [p, createHash('sha256').update(await readFile(p)).digest('hex')]))),
    provider: { id: provider.id, model: provider.model, protocolVersion: provider.protocolVersion, expressionMode: provider.expressionMode ?? 'program' },
    transport: provider.runtimeSettings ?? null,
    billingMode: provider.billingMode ?? (provider.paid ? 'metered-api' : 'offline'),
    settings: { seed: values.seed, maxRequests, maxReportedCostUSD, concurrency: 1, retries: 0,
      requestTimeoutMs: provider.runtimeSettings?.requestTimeoutMs ?? (provider.paid ? 12000 : null), temperature: provider.id.startsWith('llm') ? 0 : null,
      maxOutputTokens: provider.runtimeSettings?.maxOutputTokens ?? (provider.id === 'llm-character' ? 600 : provider.id === 'llm' ? 200 : null),
      dnsOverrideEnabled: provider.runtimeSettings?.backend === 'self-hosted' ? false : Boolean(process.env.JEV_DNS_SERVER?.trim()),
      candidateTextMode: 'semantic-v1',
      budgetNote: 'Stops before the next call at the reported cost cap; one request may overshoot. Missing paid billing stops the run.' },
  };
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir, { mode: 0o700 });
  await writeFile(resolve(outputDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const result = await runInteractionTrajectory({ scenario, provider, seed: values.seed, maxRequests, maxReportedCostUSD,
    onCheckpoint: async trace => {
      const path = resolve(outputDir, 'trajectory.json');
      await writeFile(path + '.tmp', JSON.stringify(trace, null, 2) + '\n', { mode: 0o600 });
      await rename(path + '.tmp', path);
    },
  });
  const replay = await replayInteractionTrajectory(result);
  await writeFile(resolve(outputDir, 'summary.json'), JSON.stringify({ ...summary(result), replay }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await writeFile(resolve(outputDir, 'transcript.md'), transcript(result), { flag: 'wx', mode: 0o600 });
  if (episodes.some(episode => episode.id === scenario.id)) {
    await writeFile(resolve(outputDir, 'consequences.json'), JSON.stringify(reportRoleplayEpisode(result), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ outputDir, ...summary(result), replay }, null, 2));
  if (!result.complete || !result.validSave) process.exitCode = 1;
}
main().catch(() => {
  console.error('Interaction evaluation failed. Inspect the new checkpoint/provenance files, provider configuration and limits. No fallback was used.');
  process.exitCode = 1;
});

import {isTransportErrorCode} from './transport-errors';
import { z } from 'zod';
import { decisionInput } from '../../server/jev';
import { advance, applyDecision, chooseFallback, getContext, getOptions, getPlayerInteractions,
  loadWorld, playerInteract, serializeWorld, type World } from '../../src/sim';
import type { InteractionChoice } from '../../src/character/interaction';
import { seededPermutation } from './runner';
import type { DecisionInput, EvaluationProvider, EvaluationResponse } from './types';

const stepSchema = z.discriminatedUnion('kind', [
  z.object({ id: z.string().min(1), kind: z.literal('interact'), action: z.string().min(1) }).strict(),
  z.object({ id: z.string().min(1), kind: z.literal('followup'), topic: z.string().min(1), anchor: z.string().min(1).optional() }).strict(),
  z.object({ id: z.string().min(1), kind: z.literal('autonomy') }).strict(),
  z.object({ id: z.string().min(1), kind: z.literal('advance'), seconds: z.number().finite().positive().max(120) }).strict(),
]);
export type InteractionStep = z.infer<typeof stepSchema>;
export interface InteractionScenario {
  id: string; version: number; npcId: string; initialWorld: World; steps: InteractionStep[];
  /** Optional shared candidate order for matched conditions; legacy scenarios use id. */
  permutationGroup?: string;
}
const responseSchema = z.object({
  choice: z.string(), affect: z.enum(['warm', 'guarded', 'focused', 'worried', 'irritated']),
  latencyMs: z.number().finite().nonnegative(), cost: z.number().finite().nonnegative().optional(),
  model: z.string().optional(), contractValid: z.boolean().optional(),
  dialogue: z.string().nullable().optional(), rawContent: z.string().nullable().optional(),
  finishReason: z.string().nullable().optional(),
  tokenUsage: z.object({ promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative(), totalTokens: z.number().int().nonnegative() }).optional(),
});
type StopReason = 'running' | 'finished' | 'request-budget' | 'reported-cost-budget' | 'unknown-billing' |
  'provider-error' | 'invalid-answer' | 'execution-rejected';
export interface InteractionAttempt {
  sequence: number; stepId: string; input: DecisionInput; response: EvaluationResponse | null;
  applied: boolean; error: string | null; latencyMs: number; costUSD: number | null;
  /** Exact HTTP failure status, when returned; never an upstream message or body. */
  upstreamStatus?: number;
}
function audit(world: World, npcId: string) {
  const npc = world.npcs.find(n => n.id === npcId)!;
  return structuredClone({ time: world.time, player: world.player, needs: npc.needs, trust: npc.trust,
    activity: npc.activity, job: npc.job, commitments: npc.mind.commitments,
    goals: npc.mind.personal.goals, dialogue: npc.mind.dialogue });
}
export interface InteractionRecord {
  stepId: string; kind: InteractionStep['kind']; status: 'applied' | 'advanced' | 'skipped' | 'error';
  reason?: string; playerAction?: InteractionChoice; attemptSequence?: number; reply?: string;
  before: ReturnType<typeof audit>; after: ReturnType<typeof audit>;
  events: World['events']; peerDecisions: Array<{ at: number; npcId: string; choice: string; applied: boolean }>;
}
export interface InteractionTrace {
  schemaVersion: 1; scope: string; scenario: InteractionScenario;
  provider: { id: string; model: string; paid: boolean; protocolVersion: string | null; expressionMode: 'program' | 'generated'; billingMode?: EvaluationProvider['billingMode'] };
  config: { seed: string; maxRequests: number; maxReportedCostUSD: number; peerPolicy: 'engine-rule-v1'; stepSeconds: .25;
    candidateTextMode?: 'authored-v1' | 'semantic-v1' };
  attempts: InteractionAttempt[]; records: InteractionRecord[]; finalWorld: World;
  inFlight: { sequence: number; stepId: string; input: DecisionInput; startedAt: string } | null; outstandingRequestCount: number;
  complete: boolean; stopReason: StopReason; knownCostUSD: number; unknownCostCount: number;
  totalCostUSD: number | null; validSave: boolean;
}
interface Config {
  scenario: InteractionScenario; provider: EvaluationProvider; seed?: string;
  maxRequests: number; maxReportedCostUSD: number; onCheckpoint?: (value: InteractionTrace) => Promise<void>;
  candidateTextMode?: 'authored-v1' | 'semantic-v1';
}

function inputFor(world: World, npcId: string, seed: string, mode: 'authored-v1' | 'semantic-v1'): DecisionInput {
  const npc = world.npcs.find(n => n.id === npcId)!;
  const state = getContext(world, npcId);
  delete (state.situation as Record<string, unknown>).options;
  return decisionInput.parse({ npcId, revision: npc.revision, state,
    options: seededPermutation(getOptions(world, npcId), seed).map(({ id, label, description }) => {
      if (mode === 'semantic-v1' && description.startsWith('Speech intent: ')) {
        const start = description.indexOf(' Say: '), end = description.lastIndexOf(' Evidence: ');
        if (start < 0 || end <= start) throw new Error('Unexpected authored speech format');
        description = description.slice(0, start) + description.slice(end);
      }
      return { id, label, description };
    }) });
}
function speechValid(response: EvaluationResponse, input: DecisionInput, mode: 'program' | 'generated'): boolean {
  if (mode === 'program') return response.dialogue === undefined || response.dialogue === null;
  const pending = (input.state.situation as Record<string, unknown>).pendingInteraction;
  return pending ? typeof response.dialogue === 'string' && response.dialogue.trim().length > 0 && response.dialogue.length <= 1600
    : response.dialogue === null;
}
function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (isTransportErrorCode(message)) return message;
  if (['timeout', 'authentication-error', 'access-denied', 'billing-error', 'provider-error'].includes(message)) return message;
  if (/timeout|abort/i.test(message)) return 'timeout';
  if (/^upstream_403$/.test(message)) return 'access-denied';
  if (/401|missing_key/i.test(message)) return 'authentication-error';
  if (/402/i.test(message)) return 'billing-error';
  return 'provider-error';
}

/** Deterministic peer decisions are fixture policy, never a fallback for the evaluated actor. */
function advancePeers(world: World, npcId: string, seconds: number): InteractionRecord['peerDecisions'] {
  const records: InteractionRecord['peerDecisions'] = [];
  const until = world.time + seconds;
  while (world.time < until && !world.survival.dead) {
    for (const npc of world.npcs) {
      if (npc.id === npcId || npc.cooldown > 0 || npc.job || npc.path.length || npc.pendingInteraction) continue;
      if (getOptions(world, npc.id).length < 2) continue;
      const choice = chooseFallback(world, npc.id);
      records.push({ at: world.time, npcId: npc.id, choice, applied: applyDecision(world, npc.id, choice, 'fixed-peer', { affect: 'focused' }) });
    }
    advance(world, Math.min(.25, until - world.time));
  }
  return records;
}

/** Development only: scheduled decision opportunities, with the world frozen during requests. */
export async function runInteractionTrajectory(config: Config): Promise<InteractionTrace> {
  z.object({ maxRequests: z.number().int().min(1).max(1000), maxReportedCostUSD: z.number().finite().nonnegative(), seed: z.string().min(1).optional() }).parse(config);
  z.object({ id: z.string().min(1), model: z.string().min(1), paid: z.boolean().optional(),
    expressionMode: z.enum(['program', 'generated']).optional() }).parse(config.provider);
  const scenario = structuredClone(config.scenario);
  z.object({ id: z.string().min(1), version: z.number().int().positive(), npcId: z.string().min(1), steps: z.array(stepSchema).min(1).max(100),
    permutationGroup: z.string().min(1).refine(value => value.trim().length > 0).optional() }).parse(scenario);
  if (new Set(scenario.steps.map(s => s.id)).size !== scenario.steps.length) throw new Error('Duplicate step ID');
  for (const [index, step] of scenario.steps.entries()) {
    if (step.kind === 'followup' && step.anchor && !scenario.steps.slice(0, index).some(s => s.id === step.anchor)) throw new Error('Invalid followup anchor');
  }
  if (!loadWorld(serializeWorld(scenario.initialWorld)) || !scenario.initialWorld.npcs.some(n => n.id === scenario.npcId)) throw new Error('Invalid fixture world');
  const world = structuredClone(scenario.initialWorld), npcId = scenario.npcId;
  const seed = config.seed ?? 'interaction-development-v1';
  const paid = config.provider.paid ?? true, mode = config.provider.expressionMode ?? 'program';
  const unmetered = config.provider.billingMode === 'self-hosted-unmetered';
  if (unmetered && paid) throw new Error('Self-hosted accounting cannot require metered billing');
  const candidateTextMode = z.enum(['authored-v1', 'semantic-v1']).parse(config.candidateTextMode ?? 'semantic-v1');
  const attempts: InteractionAttempt[] = [], records: InteractionRecord[] = [];
  let stopReason: StopReason = 'running', inFlight: InteractionTrace['inFlight'] = null;
  const snapshot = (): InteractionTrace => {
    const knownCostUSD = attempts.reduce((sum, a) => sum + (a.costUSD ?? 0), 0);
    const unknownCostCount = attempts.filter(a => a.costUSD === null).length;
    return structuredClone({ schemaVersion: 1,
      scope: `development; ${candidateTextMode}; fixed rule peers; world frozen during requests; not blinded or held-out`,
      scenario, provider: { id: config.provider.id, model: config.provider.model, paid,
        protocolVersion: config.provider.protocolVersion ?? null, expressionMode: mode,
        ...(config.provider.billingMode ? { billingMode: config.provider.billingMode } : {}) },
      config: { seed, maxRequests: config.maxRequests, maxReportedCostUSD: config.maxReportedCostUSD, peerPolicy: 'engine-rule-v1', stepSeconds: .25, candidateTextMode },
      attempts, records, finalWorld: world, inFlight, outstandingRequestCount: inFlight ? 1 : 0,
      complete: stopReason === 'finished', stopReason, knownCostUSD, unknownCostCount,
      totalCostUSD: unmetered || unknownCostCount || inFlight ? null : knownCostUSD, validSave: loadWorld(serializeWorld(world)) !== null });
  };
  const checkpoint = async () => { await config.onCheckpoint?.(snapshot()); };
  await checkpoint();
  for (const step of scenario.steps) {
    const npc = world.npcs.find(n => n.id === npcId)!;
    const before = audit(world, npcId), eventId = world.events.at(-1)?.id ?? 0;
    const record: InteractionRecord = { stepId: step.id, kind: step.kind, status: 'skipped', before, after: before, events: [], peerDecisions: [] };
    if (step.kind === 'advance') {
      record.peerDecisions = advancePeers(world, npcId, step.seconds);
      record.status = 'advanced';
    } else {
      if (attempts.length >= config.maxRequests) { stopReason = 'request-budget'; break; }
      if (paid && snapshot().knownCostUSD >= config.maxReportedCostUSD) { stopReason = 'reported-cost-budget'; break; }
      if (step.kind === 'interact' || step.kind === 'followup') {
        // The scripted player approaches the actor; this movement has no reward and is shared by all conditions.
        Object.assign(world.player, { x: npc.x, y: npc.y });
        const menu = getPlayerInteractions(world, npcId);
        const anchor = step.kind === 'followup' && step.anchor ? records.find(r => r.stepId === step.anchor && r.status === 'applied') : undefined;
        const subject = anchor?.after.dialogue.turns.at(-1)?.subject;
        const selected = step.kind === 'interact' ? menu.find(a => a.id === step.action)
          : menu.find(a => a.id.startsWith('followup:') && a.parameters.topic === step.topic &&
              (!step.anchor || Boolean(subject && npc.mind.dialogue.turns.find(t => t.sequence === a.parameters.turn)?.subject === subject)));
        if (selected) {
          record.playerAction = structuredClone(selected);
          playerInteract(world, npcId, selected.id);
        } else record.reason = 'menu-unavailable';
      } else if (npc.cooldown > 0 || npc.job || npc.path.length || npc.pendingInteraction) record.reason = 'actor-busy';
      if (!record.reason && getOptions(world, npcId).length < 2) record.reason = 'decision-unavailable';
      if (!record.reason) {
        const input = inputFor(world, npcId, `${seed}:${scenario.permutationGroup ?? scenario.id}:${step.id}`, candidateTextMode);
        const attempt: InteractionAttempt = { sequence: attempts.length + 1, stepId: step.id, input,
          response: null, applied: false, error: null, latencyMs: 0, costUSD: paid || unmetered ? null : 0 };
        record.attemptSequence = attempt.sequence;
        inFlight = { sequence: attempt.sequence, stepId: step.id, input: structuredClone(input), startedAt: new Date().toISOString() }; await checkpoint();
        const start = performance.now();
        try {
          const raw = await config.provider.decide(structuredClone(input));
          if (!unmetered && typeof raw?.cost === 'number' && Number.isFinite(raw.cost) && raw.cost >= 0) attempt.costUSD = raw.cost;
          attempt.response = JSON.parse(JSON.stringify(raw)) as EvaluationResponse;
          const parsed = responseSchema.safeParse(raw);
          if (!parsed.success || parsed.data.contractValid === false || !input.options.some(o => o.id === parsed.data.choice) ||
              !speechValid(parsed.data, input, mode)) {
            attempt.error = 'invalid-answer'; stopReason = 'invalid-answer';
          } else {
            const answer = parsed.data;
            attempt.applied = applyDecision(world, npcId, answer.choice, config.provider.id, {
              revision: input.revision, affect: answer.affect, latencyMs: answer.latencyMs, cost: answer.cost,
              model: answer.model, ...(mode === 'generated' && typeof answer.dialogue === 'string' ? { dialogueText: answer.dialogue } : {}),
            });
            if (!attempt.applied) { attempt.error = 'execution-rejected'; stopReason = 'execution-rejected'; }
            else if (record.playerAction) record.reply = npc.bubble;
          }
        } catch (error) {
          attempt.error = safeError(error); stopReason = 'provider-error';
          const status = error instanceof Error ? /^upstream_([45]\d{2})$/.exec(error.message) : null;
          if (status) attempt.upstreamStatus = Number(status[1]);
        }
        attempt.latencyMs = performance.now() - start;
        attempts.push(attempt); inFlight = null;
        record.status = attempt.applied ? 'applied' : 'error';
        if (attempt.error) record.reason = attempt.error;
        if (paid && attempt.costUSD === null && stopReason === 'running') stopReason = 'unknown-billing';
      }
    }
    record.after = audit(world, npcId);
    record.events = structuredClone(world.events.filter(e => e.id > eventId));
    records.push(record); await checkpoint();
    if (stopReason !== 'running') break;
  }
  if (stopReason === 'running') stopReason = 'finished';
  await checkpoint();
  return snapshot();
}

/** Re-executes recorded decisions and fixed peers, never calls a model. */
export async function replayInteractionTrajectory(trace: InteractionTrace): Promise<{ verified: true; attempts: number; records: number }> {
  if (trace.schemaVersion !== 1 || trace.inFlight || trace.outstandingRequestCount) throw new Error('replay: unresolved or unsupported trace');
  if (trace.config.peerPolicy !== 'engine-rule-v1' || trace.config.stepSeconds !== .25) throw new Error('replay: unsupported fixture policy');
  let index = 0, mismatch = false;
  const provider: EvaluationProvider = { ...trace.provider, protocolVersion: trace.provider.protocolVersion ?? undefined,
    async decide(input) {
      const attempt = trace.attempts[index++];
      if (!attempt || JSON.stringify(input) !== JSON.stringify(attempt.input)) { mismatch = true; throw new Error('replay mismatch'); }
      if (attempt.response === null) throw new Error(attempt.upstreamStatus ? `upstream_${attempt.upstreamStatus}` : attempt.error ?? 'provider-error');
      return structuredClone(attempt.response);
    },
  };
  const result = await runInteractionTrajectory({ scenario: trace.scenario, provider, ...trace.config, candidateTextMode: trace.config.candidateTextMode ?? 'authored-v1' });
  const comparable = (value: InteractionTrace) => ({
    complete: value.complete, stopReason: value.stopReason, validSave: value.validSave,
    knownCostUSD: value.knownCostUSD, unknownCostCount: value.unknownCostCount, totalCostUSD: value.totalCostUSD,
    attempts: value.attempts.map(({ latencyMs: _latency, ...a }) => a), records: value.records, finalWorld: value.finalWorld,
  });
  if (mismatch || index !== trace.attempts.length || JSON.stringify(comparable(result)) !== JSON.stringify(comparable(trace))) throw new Error('replay: trace does not match current execution');
  return { verified: true, attempts: index, records: result.records.length };
}

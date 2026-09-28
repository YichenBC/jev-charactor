import { z } from 'zod';
import { createDialogue, dialogueSchema, type DialogueState } from './dialogue.js';
import { createPersonal, personalSchema, inspectPersonal, type PersonalState } from './personal.js';
import { inspectKnowledge, knowledgeSchema, type KnowledgeClaim } from './knowledge.js';
export { inspectBelief, inspectKnowledge, learnKnowledge, knowledgeSchema } from './knowledge.js';
export type { KnowledgeClaim, KnowledgeSource, KnowledgeOwner, BeliefView } from './knowledge.js';

/** A character owns this state; environments supply observations explicitly. */
export type AffectId = 'warm' | 'guarded' | 'focused' | 'worried' | 'irritated';
export type CharacterProfile = { role: string; traits: string[]; values: string[]; speakingStyle: string };
export type Experience = {
  id: string; at: number; event: string; detail: string; salience: number;
  source: 'observed' | 'experienced' | 'heard'; relatedTo?: string;
};
export type Commitment = {
  id: string; description: string; status: 'active' | 'fulfilled' | 'broken';
  createdAt: number; dueAt?: number; counterparty: string;
};
export type Intent = {
  id: string; label: string; target?: string;
  phase: 'planning' | 'acting' | 'waiting' | 'completed' | 'interrupted'; since: number; until?: number;
};
export type CharacterMind = {
  personal: PersonalState;
  dialogue: DialogueState;
  knowledge: KnowledgeClaim[]; profile: CharacterProfile; affect: AffectId; expression: string; experiences: Experience[];
  commitments: Commitment[]; intent: Intent | null; revision: number;
};

/** Each option is one coherent emotional and nonverbal response, not independent sliders. */
export const REACTION_OPTIONS: ReadonlyArray<Readonly<{
  id: AffectId; label: string; description: string; emotion: string; expression: string;
}>> = Object.freeze([
  Object.freeze({ id: 'warm' as const, label: 'Warm and receptive', description: 'Respond with warmth and a small smile; suitable when the character feels safe or appreciates the interaction.', emotion: '亲切', expression: '轻轻微笑' }),
  Object.freeze({ id: 'guarded' as const, label: 'Guarded and cautious', description: 'Remain cautious with a restrained nod; suitable when trust is uncertain or the character wants to protect a boundary.', emotion: '谨慎', expression: '克制地点头' }),
  Object.freeze({ id: 'focused' as const, label: 'Focused and composed', description: 'Stay composed with an attentive gaze; suitable when concentrating on a task or listening carefully without a strong emotional shift.', emotion: '平静专注', expression: '神情专注' }),
  Object.freeze({ id: 'worried' as const, label: 'Worried and uneasy', description: 'Express anxiety with a slight frown; suitable when known risks, an unresolved concern, or an uncertain outcome troubles the character.', emotion: '担忧', expression: '微微皱眉' }),
  Object.freeze({ id: 'irritated' as const, label: 'Irritated and displeased', description: 'Show displeasure with a stern expression; suitable when a boundary was crossed or a known frustration remains unresolved.', emotion: '不悦', expression: '神情严肃' }),
]);

const MEMORY_LIMIT = 32;
const COMMITMENT_LIMIT = 24;
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Must contain non-whitespace text');
const idSchema = text(160);
const timeSchema = z.number().finite().nonnegative();
const affectSchema = z.enum(['warm', 'guarded', 'focused', 'worried', 'irritated']);
export const profileSchema = z.object({
  role: text(2000), traits: z.array(text(240)).max(24), values: z.array(text(240)).max(24), speakingStyle: text(2000),
}).strict();
const experienceSchema = z.object({
  id: idSchema, at: timeSchema, event: text(120), detail: text(4000), salience: z.number().finite().min(0).max(1),
  source: z.enum(['observed', 'experienced', 'heard']), relatedTo: idSchema.optional(),
}).strict();
const commitmentSchema = z.object({
  id: idSchema, description: text(2000), status: z.enum(['active', 'fulfilled', 'broken']),
  createdAt: timeSchema, dueAt: timeSchema.optional(), counterparty: text(240),
}).strict().refine(value => value.dueAt === undefined || value.dueAt >= value.createdAt, 'Deadline precedes creation');
const intentSchema = z.object({
  id: idSchema, label: text(500), target: text(240).optional(),
  phase: z.enum(['planning', 'acting', 'waiting', 'completed', 'interrupted']), since: timeSchema, until: timeSchema.optional(),
}).strict().refine(value => value.until === undefined || value.until >= value.since, 'End precedes start')
  .refine(value => !isTerminalIntent(value) || value.until !== undefined, 'Terminal intent requires an end time');

export const mindSchema = z.object({
  personal: personalSchema.default(createPersonal),
  dialogue: dialogueSchema.default(createDialogue),
  knowledge: knowledgeSchema.default([]),
  profile: profileSchema, affect: affectSchema, expression: text(240),
  experiences: z.array(experienceSchema).max(MEMORY_LIMIT), commitments: z.array(commitmentSchema).max(COMMITMENT_LIMIT),
  intent: intentSchema.nullable(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(value => new Set(value.experiences.map(item => item.id)).size === value.experiences.length, 'Duplicate experience IDs')
  .refine(value => new Set(value.commitments.map(item => item.id)).size === value.commitments.length, 'Duplicate commitment IDs')
  .refine(value => REACTION_OPTIONS.some(option => option.id === value.affect && option.expression === value.expression), 'Affect and expression must be coherent');

function isTerminalIntent(intent: Intent): boolean {
  return intent.phase === 'completed' || intent.phase === 'interrupted';
}

export function createMind(profile: CharacterProfile): CharacterMind {
  return { personal:createPersonal(), dialogue: createDialogue(), knowledge: [], profile: profileSchema.parse(profile), affect: 'focused', expression: REACTION_OPTIONS[2].expression, experiences: [], commitments: [], intent: null, revision: 0 };
}

/** Keep eight salient experiences and fill remaining space with the most recent. */
export function rememberExperience(mind: CharacterMind, experience: Experience): void {
  const parsed = experienceSchema.parse(experience);
  if (mind.experiences.some(item => item.id === parsed.id)) return;
  const candidates = [...mind.experiences, parsed];
  const salient = [...candidates].sort((a, b) => b.salience - a.salience || b.at - a.at).slice(0, 8);
  const retained = new Set(salient.map(item => item.id));
  for (const item of [...candidates].sort((a, b) => b.at - a.at)) {
    if (retained.size >= MEMORY_LIMIT) break;
    retained.add(item.id);
  }
  mind.experiences = candidates.filter(item => retained.has(item.id)).sort((a, b) => a.at - b.at);
  mind.revision++;
}

/** Terminal records cannot be revised; live obligations are never silently evicted. */
export function setCommitment(mind: CharacterMind, commitment: Commitment): void {
  const parsed = commitmentSchema.parse(commitment);
  const existing = mind.commitments.findIndex(item => item.id === parsed.id);
  if (existing >= 0) {
    if (mind.commitments[existing].status !== 'active') return;
    if (JSON.stringify(mind.commitments[existing]) === JSON.stringify(parsed)) return;
    mind.commitments[existing] = parsed;
  } else {
    if (mind.commitments.length >= COMMITMENT_LIMIT) {
      const oldestTerminal = mind.commitments.filter(item => item.status !== 'active').sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldestTerminal) throw new RangeError('Cannot discard an active commitment: resolve one before adding another');
      mind.commitments = mind.commitments.filter(item => item.id !== oldestTerminal.id);
    }
    mind.commitments.push(parsed);
  }
  mind.revision++;
}

function recordLifecycle(mind: CharacterMind, event: string, relatedTo: string, detail: string, at: number, salience: number): void {
  let sequence = mind.revision;
  while (mind.experiences.some(item => item.id === `lifecycle:${sequence}`)) sequence++;
  rememberExperience(mind, { id: `lifecycle:${sequence}`, event, relatedTo, detail, at, salience, source: 'experienced' });
}

export function resolveCommitment(mind: CharacterMind, id: string, status: 'fulfilled' | 'broken', at: number): boolean {
  const commitment = mind.commitments.find(item => item.id === id);
  if (!commitment || commitment.status !== 'active') return false;
  z.enum(['fulfilled', 'broken']).parse(status);
  timeSchema.min(commitment.createdAt).parse(at);
  commitment.status = status;
  recordLifecycle(mind, `commitment.${status}`, id, `${commitment.description} — ${status}.`, at, 0.9);
  return true;
}

export function beginIntent(mind: CharacterMind, intent: Intent): void {
  const parsed = intentSchema.parse(intent);
  if (isTerminalIntent(parsed)) throw new RangeError('Begin an intent in planning, acting, or waiting phase');
  const previous = mind.intent;
  if (previous && !isTerminalIntent(previous)) {
    timeSchema.min(previous.since).parse(parsed.since);
    if (JSON.stringify(previous) === JSON.stringify(parsed)) return;
    if (previous.id !== parsed.id) interruptIntent(mind, `Replaced by: ${parsed.label}`, parsed.since);
  }
  mind.intent = parsed;
  recordLifecycle(mind, previous?.id === parsed.id && !isTerminalIntent(previous) ? 'intent.updated' : 'intent.started', parsed.id, parsed.label, parsed.since, 0.4);
}

export function completeIntent(mind: CharacterMind, at: number): void {
  if (!mind.intent || isTerminalIntent(mind.intent)) return;
  timeSchema.min(mind.intent.since).parse(at);
  mind.intent.phase = 'completed';
  mind.intent.until = at;
  recordLifecycle(mind, 'intent.completed', mind.intent.id, `${mind.intent.label} — completed.`, at, 0.6);
}

export function interruptIntent(mind: CharacterMind, reason: string, at: number): void {
  if (!mind.intent || isTerminalIntent(mind.intent)) return;
  text(2000).parse(reason);
  timeSchema.min(mind.intent.since).parse(at);
  mind.intent.phase = 'interrupted';
  mind.intent.until = at;
  recordLifecycle(mind, 'intent.interrupted', mind.intent.id, `${mind.intent.label} — interrupted: ${reason}`, at, 0.8);
}

export function applyAffect(mind: CharacterMind, affect: AffectId): void {
  const parsed = affectSchema.parse(affect);
  const option = REACTION_OPTIONS.find(item => item.id === parsed)!;
  if (mind.affect === parsed && mind.expression === option.expression) return;
  mind.affect = parsed;
  mind.expression = option.expression;
  mind.revision++;
}

/** No clock, world lookup, model call, or inferred knowledge enters this boundary. */
export function buildDecisionContext(mind: CharacterMind, situation: Record<string, unknown>, now?: number): Record<string, unknown> {
  if ((mind.knowledge.length || mind.personal.feelings.length || mind.personal.goals.length) && now === undefined) throw new RangeError('A game clock is required to assess knowledge and personal state');
  return structuredClone({ ...mind, personal:inspectPersonal(mind,now??0), knowledge: inspectKnowledge(mind, now ?? 0), situation, reactionOptions: REACTION_OPTIONS });
}

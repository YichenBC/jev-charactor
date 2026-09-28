import { z } from 'zod';

export type KnowledgeSource =
  | { kind: 'background' | 'observed' | 'experienced' | 'legacy' }
  | { kind: 'heard'; from: string };
export type KnowledgeClaim = {
  id: string; topic: string; value: string; learnedAt: number;
  source: KnowledgeSource; confidence: number; validUntil?: number; retiredAt?: number;
};
export type KnowledgeOwner = { knowledge: KnowledgeClaim[]; revision: number };
export type BeliefView = {
  topic: string; status: 'unknown' | 'known' | 'conflicted' | 'outdated'; values: string[];
  evidence: Array<KnowledgeClaim & { status: 'current' | 'expired' | 'retired' }>;
};
const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Empty text');
const time = z.number().finite().nonnegative();
const source = z.union([
  z.object({ kind: z.enum(['background','observed','experienced','legacy']) }).strict(),
  z.object({ kind: z.literal('heard'), from: text(240) }).strict(),
]);
const fields = {
  id: text(160), topic: text(240), value: text(4000), learnedAt: time, source,
  confidence: z.number().finite().min(0).max(1), validUntil: time.optional(),
};
const inputSchema = z.object(fields).strict().refine(value => value.validUntil === undefined || value.validUntil >= value.learnedAt, 'Expiry precedes learning');
const claimSchema = z.object({ ...fields, retiredAt: time.optional() }).strict()
  .refine(value => value.validUntil === undefined || value.validUntil >= value.learnedAt, 'Expiry precedes learning')
  .refine(value => value.retiredAt === undefined || value.retiredAt >= value.learnedAt, 'Retirement precedes learning');
export const knowledgeSchema = z.array(claimSchema).max(64)
  .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate knowledge IDs');

/** Append evidence; contradictions persist unless the host explicitly retires evidence. */
export function learnKnowledge(owner: KnowledgeOwner, input: Omit<KnowledgeClaim,'retiredAt'>, retireIds: string[] = []): boolean {
  const incoming = inputSchema.parse(input);
  const entries = knowledgeSchema.parse(owner.knowledge);
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1).parse(owner.revision);
  if (entries.some(entry => entry.id === incoming.id)) return false;
  const retirement = new Set(z.array(text(160)).max(64).parse(retireIds));
  for (const id of retirement) {
    const entry = entries.find(item => item.id === id);
    if (!entry || entry.topic !== incoming.topic || entry.learnedAt > incoming.learnedAt) throw new RangeError('Invalid knowledge retirement');
  }
  for (const entry of entries) if (retirement.has(entry.id)) entry.retiredAt = Math.min(entry.retiredAt ?? Infinity, incoming.learnedAt);
  entries.push(incoming);
  if (entries.length > 64) {
    const obsolete = (entry: KnowledgeClaim) => (entry.retiredAt !== undefined && entry.retiredAt <= incoming.learnedAt) || (entry.validUntil !== undefined && entry.validUntil <= incoming.learnedAt);
    const victim = [...entries].sort((a,b) => Number(obsolete(b)) - Number(obsolete(a)) || a.learnedAt - b.learnedAt || a.id.localeCompare(b.id))[0];
    entries.splice(entries.findIndex(entry => entry.id === victim.id),1);
  }
  if (JSON.stringify(owner.knowledge) === JSON.stringify(entries)) return false;
  owner.knowledge = entries;
  owner.revision++;
  return true;
}

/** 'Known' means consistent retained evidence, never a guarantee of objective truth. */
export function inspectBelief(owner: KnowledgeOwner, topic: string, now: number): BeliefView {
  text(240).parse(topic); time.parse(now);
  const evidence: BeliefView['evidence'] = owner.knowledge.filter(entry => entry.topic === topic && entry.learnedAt <= now)
    .map(entry => {
      const visible = structuredClone(entry);
      // A historical view must not reveal that this evidence will be retired later.
      if (visible.retiredAt !== undefined && visible.retiredAt > now) delete visible.retiredAt;
      return { ...visible, status: visible.retiredAt !== undefined ? 'retired' : visible.validUntil !== undefined && now >= visible.validUntil ? 'expired' : 'current' };
    });
  const values = [...new Set(evidence.filter(entry => entry.status === 'current').map(entry => entry.value))];
  return { topic, status: values.length > 1 ? 'conflicted' : values.length === 1 ? 'known' : evidence.length ? 'outdated' : 'unknown', values, evidence };
}
export function inspectKnowledge(owner: KnowledgeOwner, now: number): BeliefView[] {
  time.parse(now);
  const topics = [...new Set(owner.knowledge.filter(entry => entry.learnedAt <= now).map(entry => entry.topic))];
  return topics.map(topic => inspectBelief(owner,topic,now));
}

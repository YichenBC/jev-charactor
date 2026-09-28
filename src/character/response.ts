import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0, 'Blank text');
const id = text(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/);
const time = z.number().finite().nonnegative();
const factSchema = z.object({
  id, text: text(1000), basis: text(500), disclosable: z.boolean(),
  validFrom: time, validUntil: time.optional(),
}).strict().refine(fact => fact.validUntil === undefined || fact.validUntil >= fact.validFrom, 'Invalid validity interval');
const planSchema = z.object({
  id, intent: text(120), parts: z.array(z.union([
    z.object({ literal: text(500) }).strict(),
    z.object({ fact: id }).strict(),
  ])).min(1).max(12),
}).strict();

/** Host-approved text, not omniscient world data. The host owns truth and disclosure policy. */
export type SpeechFact = z.infer<typeof factSchema>;
/** Literals are trusted authored phrasing. Dynamic assertions should use fact references. */
export type ResponsePlan = z.infer<typeof planSchema>;
export type RealizedResponse = {
  id: string; intent: string; text: string; evidence: Array<{ id: string; basis: string }>;
};

/** Pure, bounded synthesis. Unavailable evidence removes the complete plan, never just a clause.
 * Recompile on current facts before execution and use the runtime revision guard for async choices.
 * This validates references and permission, not the semantic truth of authored language.
 */
export function compileResponses(plans: ResponsePlan[], facts: SpeechFact[], now: number): RealizedResponse[] {
  time.parse(now);
  const parsedPlans = z.array(planSchema).max(40).parse(plans);
  const parsedFacts = z.array(factSchema).max(128).parse(facts);
  if (new Set(parsedPlans.map(p => p.id)).size !== parsedPlans.length || new Set(parsedFacts.map(f => f.id)).size !== parsedFacts.length) {
    throw new RangeError('Speech IDs must be unique within each collection');
  }
  const available = new Map(parsedFacts.filter(f => f.disclosable && f.validFrom <= now && (f.validUntil === undefined || now < f.validUntil)).map(f => [f.id, f]));
  return parsedPlans.flatMap(plan => {
    const evidence = new Map<string, { id: string; basis: string }>();
    const clauses: string[] = [];
    for (const part of plan.parts) {
      if ('literal' in part) clauses.push(part.literal);
      else {
        const fact = available.get(part.fact);
        if (!fact) return [];
        clauses.push(fact.text);
        evidence.set(fact.id, { id: fact.id, basis: fact.basis });
      }
    }
    const rendered = clauses.join('');
    if (rendered.length > 1600) throw new RangeError('Response exceeds 1600 characters');
    return [{ id: plan.id, intent: plan.intent, text: rendered, evidence: [...evidence.values()] }];
  });
}

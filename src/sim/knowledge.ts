import { inspectBelief, learnKnowledge, type KnowledgeSource } from '../character/knowledge';
import { describeFact, SECRET_FACTS } from './data';
import type { Npc } from './types';

/** Compatibility markers refer to the same proposition, not independent evidence. */
export function factTopic(fact: string): string {
  return fact.startsWith('heard-public:') ? fact.slice('heard-public:'.length) : fact;
}

/** Record an actual acquisition while preserving authored mechanics' fact flags. */
export function learnNpcFact(npc: Npc, fact: string, now: number, source: KnowledgeSource = { kind: 'experienced' }): void {
  const topic = factTopic(fact);
  const sourceId = source.kind === 'heard' ? `heard:${source.from}` : source.kind;
  const changed = learnKnowledge(npc.mind, {
    id: `fact:${topic}:${sourceId}`, topic, value: describeFact(topic),
    learnedAt: now, source, confidence: 1,
  });
  const newlyKnown = !npc.knownFacts.includes(fact);
  if (newlyKnown) npc.knownFacts.push(fact);
  npc.knownFacts = npc.knownFacts.slice(-48);
  if (changed || newlyKnown) npc.revision++;
}

/** Old saves establish what was known, never how or when it originally happened. */
export function backfillLegacyKnowledge(npc: Npc, now: number): void {
  for (const topic of new Set(npc.knownFacts.map(factTopic))) {
    learnKnowledge(npc.mind, {
      id: `legacy:${topic}`, topic, value: describeFact(topic), learnedAt: now,
      source: { kind: 'legacy' }, confidence: 1,
    });
  }
}

export function contextualPrivateConcern(npc: Npc, now: number): string {
  const fact = SECRET_FACTS[npc.id];
  // Compatibility fields cannot resurrect evidence that the working ledger forgot.
  if (!fact) return '';
  const belief = inspectBelief(npc.mind, fact.id, now);
  return belief.status === 'known' && belief.values.includes(npc.secret) ? npc.secret : '';
}

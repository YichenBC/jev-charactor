import { applyDecision, getContext, getOptions, distance, type Npc, type World } from '../../sim';
import type { CharacterEnvironment, CharacterTurn } from '../../character/runtime';
import { pendingActionCurrent } from '../../sim/interactions';

/** Fog Harbor owns world truth, perception, feasible candidates and transactional effects. */
export class FogHarborEnvironment implements CharacterEnvironment {
  constructor(private readonly hooks: { world: () => World; running: () => boolean; allows: (npc: Npc) => boolean }) {}
  openTurn(characterId: string): CharacterTurn | null {
    const world = this.hooks.world(), npc = world.npcs.find(n => n.id === characterId);
    if (!npc) return null;
    const revision = npc.revision, options = getOptions(world, characterId);
    const mindRevision = npc.mind.revision, capturedAt = world.time;
    const knowledgeBoundary = Math.min(Infinity, ...npc.mind.knowledge.flatMap(claim =>
      [claim.learnedAt, claim.validUntil, claim.retiredAt].filter((at): at is number => at !== undefined && at > capturedAt)));
    const dialogueBoundary=Math.min(Infinity,...[...npc.mind.dialogue.turns.map(t=>t.at+120),...(npc.mind.dialogue.rewardedAt!==undefined?[npc.mind.dialogue.rewardedAt+120]:[])].filter(at=>at>capturedAt));
    const personalBoundary=Math.min(Infinity,...npc.mind.personal.feelings.flatMap(f=>[f.since,f.until]).filter(at=>at>capturedAt));
    const offered = new Set(options.map(option => option.id));
    let consumed = false;
    const isCurrent = () => !consumed && (!npc.pendingInteraction || distance(world.player, npc) <= 110) && this.hooks.world() === world && world.npcs.find(n => n.id === characterId) === npc && npc.revision === revision && npc.mind.revision === mindRevision && world.time >= capturedAt && world.time < knowledgeBoundary && world.time < dialogueBoundary && world.time < personalBoundary && pendingActionCurrent(world,npc) && this.hooks.running() && this.hooks.allows(npc);
    return {
      input: {
        characterId, revision, context: getContext(world, characterId),
        options: options.map(({ id, label, description }) => ({ id, label, description })),
      },
      isCurrent,
      execute: (decision, source) => {
        if (!isCurrent() || !offered.has(decision.choice)) return { status: 'rejected', detail: '角色处境已变化。', changes: [] };
        // Legacy rules can update several residents (e.g. witnesses). Stage the entire
        // bounded world so a rejected/throwing rule cannot partially commit those effects.
        const draft = structuredClone(world);
        if (!applyDecision(draft, characterId, decision.choice, source, { ...decision, revision })) {
          return { status: 'rejected', detail: '当前条件已不允许执行。', changes: [] };
        }
        const record = draft.decisions.at(-1)!;
        // Preserve resident identities so unrelated in-flight captures remain valid.
        const residents = world.npcs;
        for (const current of residents) {
          const updated = draft.npcs.find(person => person.id === current.id)!;
          for (const key of Object.keys(current) as Array<keyof Npc>) if (!(key in updated)) Reflect.deleteProperty(current, key);
          Object.assign(current, updated);
        }
        Object.assign(world, draft, { npcs: residents });
        consumed = true;
        return { status: 'applied', detail: record.label, changes: [...(record.changes ?? [])] };
      },
    };
  }
}

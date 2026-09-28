import { createWorld } from '../../src/sim';
import { CHORE_SECONDS, RETURN_SECONDS } from '../../src/sim/work';
import type { InteractionScenario, InteractionStep } from './interaction-trajectory';

/** ORIGINAL authored DEVELOPMENT probes, not public-dataset adaptations or held-out tests.
 * Only starting needs are experimental setup. All work, contracts, knowledge and
 * consequences come from the unchanged engine and the evaluated actor's choices.
 */
export function roleplayEpisodes(): InteractionScenario[] {
  return ['mei', 'lan'].flatMap(npcId => {
    const initialWorld = createWorld();
    // Comfortable physical needs permit social decisions; real initial work remains.
    Object.assign(initialWorld.npcs.find(n => n.id === npcId)!.needs,
      { hunger: 70, energy: 80, social: 45, workPressure: 55 });
    return ['kept', 'broken'].map(condition => {
      const event: InteractionStep[] = condition === 'kept' ? [
        { id: 'timely-return', kind: 'advance', seconds: 6 },
        { id: 'begin-help', kind: 'interact', action: 'help' },
        { id: 'settle-help', kind: 'advance', seconds: CHORE_SECONDS },
      ] : [{ id: 'missed-return', kind: 'advance', seconds: RETURN_SECONDS + 1 }];
      return { id: `${npcId}-promise-${condition}`, version: 1, npcId, permutationGroup: `roleplay-promise:${npcId}`,
        initialWorld: structuredClone(initialWorld), steps: [
          { id: 'work-request', kind: 'interact', action: 'request' },
          { id: 'return-promise', kind: 'interact', action: 'promise' },
          ...event,
          { id: 'feelings-after-event', kind: 'interact', action: 'ask:feelings' },
          { id: 'conversation-after-event', kind: 'interact', action: 'ask' },
          // Follow only a history topic actually spoken by this actor. Otherwise skip.
          { id: 'history-followup', kind: 'followup', topic: 'history' },
          { id: 'apology', kind: 'interact', action: 'apologize:promise' },
          { id: 'after-apology', kind: 'interact', action: 'ask' },
          { id: 'conversation-concludes', kind: 'advance', seconds: 6 },
          { id: 'independent-activity', kind: 'autonomy' },
          { id: 'activity-feedback', kind: 'advance', seconds: 45 },
        ] satisfies InteractionStep[] };
    });
  });
}

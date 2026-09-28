import { createWorld } from '../../src/sim';
import type { InteractionScenario } from './interaction-trajectory';

/** Authored development fixtures, not held-out tests or an objective role-playing benchmark. */
export function interactionScenarios(): InteractionScenario[] {
  const continuity = createWorld();
  Object.assign(continuity.npcs.find(n => n.id === 'mei')!.needs, { hunger: 65, energy: 75, social: 45, workPressure: 45 });
  const needs = createWorld();
  needs.npcs.find(n => n.id === 'mei')!.cooldown = 0;
  Object.assign(needs.npcs.find(n => n.id === 'mei')!.needs, { hunger: 12, energy: 50, social: 40, workPressure: 70 });
  return [
    { id: 'mei-continuity', version: 2, npcId: 'mei', initialWorld: continuity, steps: [
      { id: 'introduction', kind: 'interact', action: 'greet' },
      { id: 'feelings', kind: 'interact', action: 'ask:feelings' },
      { id: 'plans', kind: 'interact', action: 'ask:plans' },
      { id: 'plan-followup', kind: 'followup', topic: 'plan', anchor: 'plans' },
      { id: 'change-topic', kind: 'interact', action: 'ask' },
      { id: 'return-to-plan', kind: 'followup', topic: 'plan', anchor: 'plans' },
      { id: 'offer-tea', kind: 'interact', action: 'gift:热茶' },
      { id: 'after-tea', kind: 'interact', action: 'greet' },
      { id: 'conversation-ends', kind: 'advance', seconds: 6 },
      { id: 'own-activity', kind: 'autonomy' },
      { id: 'activity-feedback', kind: 'advance', seconds: 45 },
      { id: 'meet-again', kind: 'interact', action: 'greet' },
      { id: 'plans-after-activity', kind: 'interact', action: 'ask:plans' },
    ] },
    { id: 'mei-needs-feedback', version: 1, npcId: 'mei', initialWorld: needs, steps: [
      { id: 'unprompted-priority', kind: 'autonomy' },
      { id: 'allow-activity', kind: 'advance', seconds: 60 },
      { id: 'ask-after-activity', kind: 'interact', action: 'greet' },
      { id: 'ask-plans', kind: 'interact', action: 'ask:plans' },
      { id: 'plan-followup', kind: 'followup', topic: 'plan' },
      { id: 'offer-tea', kind: 'interact', action: 'gift:热茶' },
      { id: 'leave-alone', kind: 'advance', seconds: 6 },
      { id: 'next-priority', kind: 'autonomy' },
      { id: 'second-feedback', kind: 'advance', seconds: 45 },
      { id: 'ask-again', kind: 'interact', action: 'greet' },
    ] },
    ...crossCharacterScenarios(),
  ];
}

/** Initial pressures are authored experimental conditions. Profiles, goals, food,
 * work and routes remain the host's real state; no response or activity is forced.
 * Lin/Lan currently have only one plan follow-up depth. The return probe stays in
 * the schedule so the runner records menu-unavailable instead of fabricating it.
 */
function crossCharacterScenarios(): InteractionScenario[] {
  const roles = [
    { npcId: 'tang', gift: '面包', workPressure: 38, needs: { hunger: 12, energy: 72, social: 45, workPressure: 38 } },
    { npcId: 'lin', gift: '热茶', workPressure: 70, needs: { hunger: 65, energy: 12, social: 45, workPressure: 45 } },
    { npcId: 'lan', gift: '面包', workPressure: 75, needs: { hunger: 65, energy: 75, social: 55, workPressure: 90 } },
  ];
  return roles.flatMap(({ npcId, gift, workPressure, needs }): InteractionScenario[] => {
    const continuityWorld = createWorld(), needsWorld = createWorld();
    Object.assign(continuityWorld.npcs.find(n => n.id === npcId)!.needs,
      { hunger: 65, energy: 75, social: 45, workPressure });
    const actor = needsWorld.npcs.find(n => n.id === npcId)!;
    actor.cooldown = 0;
    Object.assign(actor.needs, needs);
    return [
      { id: `${npcId}-continuity`, version: 1, npcId, initialWorld: continuityWorld, steps: [
        { id: 'introduction', kind: 'interact', action: 'greet' },
        { id: 'feelings', kind: 'interact', action: 'ask:feelings' },
        { id: 'plans', kind: 'interact', action: 'ask:plans' },
        { id: 'plan-followup', kind: 'followup', topic: 'plan', anchor: 'plans' },
        { id: 'change-topic', kind: 'interact', action: 'ask' },
        { id: 'return-to-plan', kind: 'followup', topic: 'plan', anchor: 'plans' },
        { id: 'offer-food', kind: 'interact', action: `gift:${gift}` },
        { id: 'after-gift', kind: 'interact', action: 'ask:feelings' },
        { id: 'conversation-ends', kind: 'advance', seconds: 6 },
        { id: 'own-activity', kind: 'autonomy' },
        { id: 'activity-feedback', kind: 'advance', seconds: 60 },
        { id: 'meet-again', kind: 'interact', action: 'greet' },
        { id: 'plans-after-activity', kind: 'interact', action: 'ask:plans' },
      ] },
      { id: `${npcId}-needs-feedback`, version: 1, npcId, initialWorld: needsWorld, steps: [
        { id: 'unprompted-priority', kind: 'autonomy' },
        { id: 'allow-activity', kind: 'advance', seconds: 60 },
        { id: 'ask-after-activity', kind: 'interact', action: 'greet' },
        { id: 'feelings-after-activity', kind: 'interact', action: 'ask:feelings' },
        { id: 'ask-plans', kind: 'interact', action: 'ask:plans' },
        { id: 'plan-followup', kind: 'followup', topic: 'plan', anchor: 'ask-plans' },
        { id: 'offer-food', kind: 'interact', action: `gift:${gift}` },
        { id: 'leave-alone', kind: 'advance', seconds: 6 },
        { id: 'next-priority', kind: 'autonomy' },
        { id: 'second-feedback', kind: 'advance', seconds: 60 },
        { id: 'ask-again', kind: 'interact', action: 'greet' },
      ] },
    ];
  });
}

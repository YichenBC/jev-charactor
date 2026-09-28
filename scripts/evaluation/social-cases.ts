import assert from 'node:assert/strict';
import { decisionInput } from '../../server/jev';
import { REACTION_OPTIONS } from '../../src/character';
import { advance, applyDecision, BUILDINGS, createWorld, getContext, getOptions, loadWorld, serializeWorld, type Npc } from '../../src/sim';
import { socialInvitation } from '../../src/sim/npcLife';
import type { EvaluationCase } from './types';

const recipients = ['mei', 'tang'] as const;
const kinds = ['lonely', 'hungry', 'tired', 'overworked'] as const;
type Kind = typeof kinds[number];
const ids = recipients.flatMap(npcId => kinds.map(kind => `${npcId}/social-${kind}`));
const taskCriteria: Record<Kind, { choices: string[]; rationale: string }> = {
  lonely: {
    choices: ['social:accept'],
    rationale: 'Authored development objective: physical needs are comfortable, work pressure is low, and initial social satisfaction is 10. Accept the public invitation to begin relieving loneliness. Declining remains legal; this task-success label is not a universal personality or moral judgment.',
  },
  hungry: {
    choices: ['eat:tavern'],
    rationale: 'Authored development objective: initial fullness 10 is urgent and takes priority over optional conversation. Start the reachable meal. A verbal decline/defer releases the proposer but does not yet start nourishment, so it is legal without satisfying this one-step activity criterion.',
  },
  tired: {
    choices: ['rest:home', 'rest:watch'],
    rationale: 'Authored development objective: initial energy 10 is urgent and takes priority over optional conversation. Either available rest location is acceptable because both start real recovery. A legal decline/defer alone does not execute rest.',
  },
  overworked: {
    choices: ['work'],
    rationale: 'Authored development objective: initial work pressure 95 with comfortable physical and social needs calls for starting available work. Acceptance or polite refusal is legal, but neither starts the selected work-pressure task. This is an author-defined task criterion, not independent human-rated role-playing quality.',
  },
};

/** Four authored invitation/need templates across two recipients; development only, not eight independent templates. */
export function prepareSocialCase(id: string) {
  assert(ids.includes(id), 'Unknown social development case');
  const [npcId, variant] = id.split('/');
  const kind = variant.slice('social-'.length) as Kind;
  const world = createWorld();
  const recipient = world.npcs.find(npc => npc.id === npcId)!;
  const proposer = world.npcs.find(npc => npc.id === 'zhou')!;
  const meetingPlace = BUILDINGS.find(place => place.id === 'watch')!.door;
  // Authored initial positions/needs; actual consent state is produced by the normal engine.
  Object.assign(recipient, { ...meetingPlace, path: [], job: null, cooldown: 0 });
  Object.assign(proposer, { x: meetingPlace.x - 48, y: meetingPlace.y, path: [], job: null, cooldown: 0 });
  recipient.needs = { hunger: 85, energy: 85, social: 85, workPressure: 10 };
  if (kind === 'lonely') recipient.needs.social = 10;
  if (kind === 'hungry') recipient.needs.hunger = 10;
  if (kind === 'tired') recipient.needs.energy = 10;
  if (kind === 'overworked') recipient.needs.workPressure = 95;
  proposer.needs = { hunger: 85, energy: 85, social: 20, workPressure: 10 };
  assert(getOptions(world, proposer.id).some(option => option.id === `seek:${npcId}`), 'Proposer must have a real invitation option');
  assert(applyDecision(world, proposer.id, `seek:${npcId}`, 'social-fixture-setup'), 'Proposer invitation must apply');
  assert(proposer.job?.phase === 'travel', 'Fixture must exercise real arrival');
  for (let step = 0; step < 40 && !socialInvitation(world, recipient); step++) advance(world, 0.25);
  assert(socialInvitation(world, recipient), 'The real approach must produce an unanswered invitation');
  assert(proposer.job?.consent === 'pending' && recipient.job === null, 'Receiver must remain independent');

  const options = getOptions(world, npcId).map(({ id, label, description }) => ({ id, label, description }));
  for (const choice of ['social:accept', 'social:decline', 'social:defer', 'wait']) {
    assert(options.some(option => option.id === choice), 'Invitation must preserve normal receiver alternatives');
  }
  const state = getContext(world, npcId);
  delete (state.situation as Record<string, unknown>).options;
  const input = decisionInput.parse({ npcId, revision: recipient.revision, state, options });
  const criterion = taskCriteria[kind];
  assert(criterion.choices.every(choice => options.some(option => option.id === choice)), 'Task criteria must name actual legal choices');
  assert(loadWorld(serializeWorld(world)), 'Social fixture must be a valid saved world');
  const scenario: EvaluationCase = {
    id, familyId: `social-invitation-${kind}`, split: 'development', input,
    acceptableChoices: [...criterion.choices], rationale: criterion.rationale,
    tags: ['authored', 'social-invitation', 'independent-recipient', kind, 'scenario-version:1'],
  };
  return { scenario, world, npcId, proposerId: proposer.id };
}

export function socialCases(): EvaluationCase[] {
  return ids.map(id => prepareSocialCase(id).scenario);
}

function needsDelta(before: Npc['needs'], after: Npc['needs']): Npc['needs'] {
  return {
    hunger: after.hunger - before.hunger, energy: after.energy - before.energy,
    social: after.social - before.social, workPressure: after.workPressure - before.workPressure,
  };
}

/** Replay exactly one receiver choice; time advances but no subsequent provider or counterpart choice is invented. */
export function verifySocialExecution(id: string, choice: string, affect: string) {
  const { world, npcId, proposerId } = prepareSocialCase(id);
  const recipient = world.npcs.find(npc => npc.id === npcId)!;
  const proposer = world.npcs.find(npc => npc.id === proposerId)!;
  const selectedAffect = REACTION_OPTIONS.find(option => option.id === affect)?.id;
  assert(selectedAffect, 'Unknown evaluation affect');
  const needsBefore = { recipient: { ...recipient.needs }, proposer: { ...proposer.needs } };
  const startedAt = world.time;
  const firstDecision = world.decisions.length;
  const applied = applyDecision(world, npcId, choice, 'social-evaluation-replay', { affect: selectedAffect, revision: recipient.revision });
  const selectedActivity = !applied ? null : choice === 'social:accept' ? 'social' : recipient.job?.kind ?? null;
  const activityOwner = choice === 'social:accept' ? proposerId : npcId;
  let steps = 0;
  const hasActivity = () => Boolean(recipient.job || recipient.path.length || proposer.job || proposer.path.length);
  while (applied && hasActivity() && steps < 480) { advance(world, 0.25); steps++; }
  const decisions = world.decisions.slice(firstDecision);
  const socialCompleted = decisions.some(item => item.npcId === proposerId && item.choice === 'completed:social' && item.source === 'simulation');
  const selectedActivityCompleted = Boolean(selectedActivity && decisions.some(item => item.npcId === activityOwner && item.choice === `completed:${selectedActivity}` && item.source === 'simulation'));
  const needsAfter = { recipient: { ...recipient.needs }, proposer: { ...proposer.needs } };
  return {
    applied, npcId, proposerId, validSave: loadWorld(serializeWorld(world)) !== null,
    socialCompleted, selectedActivity, selectedActivityCompleted, elapsedSeconds: world.time - startedAt,
    advanceLimitReached: applied && hasActivity() && steps === 480,
    needsBefore, needsAfter,
    needsDelta: { recipient: needsDelta(needsBefore.recipient, needsAfter.recipient), proposer: needsDelta(needsBefore.proposer, needsAfter.proposer) },
    decisions,
  };
}

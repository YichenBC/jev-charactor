import type { Commitment } from '../../src/character';
import type { InteractionTrace } from './interaction-trajectory';

/** Broad observable consequence classes, not a count of differently worded replies. */
function consequenceKind(id: string): string {
  if (id === 'reply' || id.startsWith('reply:')) return 'speech-only';
  if (id === 'refuse') return 'decline-interaction';
  if (id.startsWith('defer:')) return 'defer-and-start-activity';
  if (id.startsWith('visit:') || id === 'follow' || id === 'avoid') return 'movement';
  if (id.startsWith('eat:')) return 'eat';
  if (id.startsWith('rest:')) return 'rest';
  if (id.startsWith('seek:')) return 'invite-neighbor';
  return id;
}

/** Describes recorded state and exposed inputs. Never rates role quality or fills
 * missing steps with the scenario's intended outcome. Completion is runner coverage.
 */
export function reportRoleplayEpisode(trace: InteractionTrace) {
  const npcId = trace.scenario.npcId;
  const initial = trace.scenario.initialWorld.npcs.find(n => n.id === npcId)!;
  const final = trace.finalWorld.npcs.find(n => n.id === npcId)!;
  const transitions = trace.records.flatMap(record => record.after.commitments.flatMap(commitment => {
    const before = record.before.commitments.find(c => c.id === commitment.id);
    return before?.status === commitment.status ? [] : [{ stepId: record.stepId,
      from: before?.status ?? null, to: commitment.status, commitmentId: commitment.id,
      observedBetween: { from: record.before.time, to: record.after.time },
      before: before ?? null, after: commitment }];
  }));
  const settlements = trace.records.flatMap(record => {
    const activity = record.before.player.activity;
    const moneyDelta = record.after.player.money - record.before.player.money;
    const payments = record.events.filter(e => e.kind === 'payment');
    // Beginning help or merely removing a task is insufficient: require the timed
    // activity to end, actual currency, payment event and consumed task together.
    if (activity?.kind !== 'help' || activity.npcId !== npcId || !activity.taskId ||
      record.after.time < activity.endsAt || record.after.player.activity || moneyDelta <= 0 || !payments.length ||
      trace.finalWorld.work.tasks.some(task => task.id === activity.taskId)) return [];
    return [{ stepId: record.stepId, taskId: activity.taskId, activity,
      moneyDelta, paymentEvents: payments,
      completionDecisions: trace.finalWorld.decisions.filter(d => d.npcId === npcId && d.choice === 'completed:player_help' &&
        d.time > record.before.time && d.time <= record.after.time) }];
  });
  const visiblePostEventHistory = transitions.filter(t => t.to !== 'active').flatMap(transition => {
    const eventIndex = trace.records.findIndex(r => r.stepId === transition.stepId);
    return trace.attempts.flatMap(attempt => {
      if (trace.records.findIndex(r => r.stepId === attempt.stepId) <= eventIndex) return [];
      const visible = attempt.input.state.commitments;
      const commitment = Array.isArray(visible) ? (visible as Commitment[])
        .find(c => c.id === transition.commitmentId && c.status === transition.to) : undefined;
      if (!commitment) return [];
      return [{ transitionStepId: transition.stepId, stepId: attempt.stepId, attemptSequence: attempt.sequence,
        inputPath: 'attempts[].input.state', commitment,
        experiences: attempt.input.state.experiences ?? [],
        dialogue: attempt.input.state.dialogue ?? null }];
    });
  });
  const replies = trace.records.filter(r => r.status === 'applied' && r.reply !== undefined)
    .map(r => ({ stepId: r.stepId, attemptSequence: r.attemptSequence, text: r.reply! }));
  const turns = trace.records.flatMap(record => record.after.dialogue.turns
    .filter(t => t.sequence >= record.before.dialogue.nextSequence).map(turn => ({ stepId: record.stepId, ...turn })));
  const needsDelta = (before: typeof initial.needs, after: typeof initial.needs) => ({
    hunger: after.hunger - before.hunger, energy: after.energy - before.energy,
    social: after.social - before.social, workPressure: after.workPressure - before.workPressure,
  });
  const playerBefore = trace.scenario.initialWorld.player, playerAfter = trace.finalWorld.player;
  const result = {
    schemaVersion: 1, scenario: trace.scenario.id,
    scope: 'Original authored development episode; descriptive consequences only; no role quality score.',
    executionScope: trace.scope, provider: trace.provider,
    complete: trace.complete, stopReason: trace.stopReason,
    outstandingRequestCount: trace.outstandingRequestCount,
    coverageNote: 'Complete means the schedule finished; skipped actions and declined obligations are not successful outcomes.',
    commitments: { initial: initial.mind.commitments, final: final.mind.commitments, transitions },
    work: { settlements, initialTasks: trace.scenario.initialWorld.work.tasks.filter(t => t.ownerId === npcId),
      remainingTasks: trace.finalWorld.work.tasks.filter(t => t.ownerId === npcId) },
    deltas: {
      player: { money: playerAfter.money - playerBefore.money, hunger: playerAfter.hunger - playerBefore.hunger,
        energy: playerAfter.energy - playerBefore.energy, health: playerAfter.health - playerBefore.health },
      trust: final.trust - initial.trust, needs: needsDelta(initial.needs, final.needs),
      byStep: trace.records.map(r => ({ stepId: r.stepId, status: r.status,
        money: r.after.player.money - r.before.player.money, trust: r.after.trust - r.before.trust,
        needs: needsDelta(r.before.needs, r.after.needs) })),
    },
    dialogue: { replyCount: replies.length, replies, turns,
      finalRetainedTurns: final.mind.dialogue.turns },
    steps: {
      scheduled: trace.scenario.steps.length, recorded: trace.records.length,
      applied: trace.records.filter(r => r.status === 'applied').map(r => r.stepId),
      advanced: trace.records.filter(r => r.status === 'advanced').map(r => r.stepId),
      skipped: trace.records.filter(r => r.status === 'skipped').map(r => ({ stepId: r.stepId, reason: r.reason })),
      errors: trace.records.filter(r => r.status === 'error').map(r => r.stepId),
      unexecuted: trace.scenario.steps.filter(s => !trace.records.some(r => r.stepId === s.id)).map(s => s.id),
      counts: { applied: trace.records.filter(r => r.status === 'applied').length,
        advanced: trace.records.filter(r => r.status === 'advanced').length,
        skipped: trace.records.filter(r => r.status === 'skipped').length,
        errors: trace.records.filter(r => r.status === 'error').length },
    },
    errors: trace.attempts.filter(a => a.error).map(a => ({ stepId: a.stepId, attemptSequence: a.sequence, error: a.error })),
    branching: trace.attempts.map(a => ({ stepId: a.stepId, attemptSequence: a.sequence,
      optionCount: a.input.options.length, optionIds: a.input.options.map(o => o.id),
      nonRefusalOptionCount: a.input.options.filter(o => o.id !== 'refuse' && !o.id.startsWith('refuse_') && o.id !== 'social:decline').length,
      consequenceKinds: [...new Set(a.input.options.map(o => consequenceKind(o.id)))],
      chosen: a.response?.choice ?? null, applied: a.applied })),
    branchingNote: 'Heuristic consequence classes collapse speech alternatives and movement destinations. Candidate counts do not establish multiple sensible persona choices and are not quality or difficulty scores.',
    visiblePostEventHistory,
  };
  return structuredClone(result);
}

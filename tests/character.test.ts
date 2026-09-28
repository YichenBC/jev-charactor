import { describe, expect, it } from 'vitest';
import {
  applyAffect, beginIntent, buildDecisionContext, completeIntent, createMind,
  interruptIntent, mindSchema, REACTION_OPTIONS, rememberExperience,
  resolveCommitment, setCommitment,
} from '../src/character';
import type { CharacterProfile, Commitment, Experience, Intent } from '../src/character';

const profile: CharacterProfile = {
  role: 'An archivist aboard a research vessel', traits: ['patient', 'precise'],
  values: ['consent', 'accuracy'], speakingStyle: 'Concise and careful with uncertainty.',
};
const experience = (id: string, at: number, salience = 0.2): Experience => ({
  id, at, event: 'conversation', detail: `Observed report ${id}`, salience, source: 'heard',
});
const commitment = (id: string, createdAt = 0): Commitment => ({
  id, description: 'Return the borrowed journal', status: 'active', createdAt, counterparty: 'the visitor',
});
const intent = (id = 'catalogue', since = 1): Intent => ({
  id, label: 'Catalogue the journal', phase: 'acting', since, target: 'the journal',
});

describe('environment-independent character mind', () => {
  it('creates arbitrary personas without sharing caller-owned state', () => {
    const input = structuredClone(profile), mind = createMind(input);
    input.traits.push('intrusive');
    expect(mind.profile).toEqual(profile);
    expect(mind.affect).toBe('focused');
    expect(mind.intent).toBeNull();
    expect(mindSchema.safeParse(mind).success).toBe(true);
  });

  it('remembers an event once, without accepting later duplicate rewrites', () => {
    const mind = createMind(profile), event = experience('heard-once', 1);
    rememberExperience(mind, event);
    event.detail = 'caller mutation';
    const revision = mind.revision;
    rememberExperience(mind, { ...event, detail: 'rewritten', at: 2 });
    expect(mind.experiences).toEqual([experience('heard-once', 1)]);
    expect(mind.revision).toBe(revision);
  });

  it('retains salient experiences and recent ordinary experiences within its bound', () => {
    const mind = createMind(profile);
    rememberExperience(mind, experience('important', 0, 1));
    for (let i = 1; i <= 70; i++) rememberExperience(mind, experience(`ordinary-${i}`, i));
    expect(mind.experiences).toHaveLength(32);
    expect(mind.experiences.some(e => e.id === 'important')).toBe(true);
    expect(mind.experiences.some(e => e.id === 'ordinary-70')).toBe(true);
    expect(mind.experiences.some(e => e.id === 'ordinary-1')).toBe(false);
  });

  it('resolves commitments exactly once and never revives a terminal commitment', () => {
    const mind = createMind(profile), promise = commitment('return');
    setCommitment(mind, promise);
    promise.description = 'caller mutation';
    expect(resolveCommitment(mind, 'return', 'fulfilled', 4)).toBe(true);
    const revision = mind.revision;
    expect(resolveCommitment(mind, 'return', 'broken', 5)).toBe(false);
    expect(resolveCommitment(mind, 'missing', 'fulfilled', 5)).toBe(false);
    setCommitment(mind, commitment('return', 6));
    expect(mind.revision).toBe(revision);
    expect(mind.commitments).toEqual([{ ...commitment('return'), status: 'fulfilled' }]);
    expect(mind.experiences.filter(e => e.event === 'commitment.fulfilled')).toHaveLength(1);
    expect(mind.experiences[0]).toMatchObject({ at: 4, relatedTo: 'return', source: 'experienced' });
  });

  it('evicts terminal commitments before active ones and refuses silent loss at capacity', () => {
    const mind = createMind(profile);
    for (let i = 0; i < 24; i++) setCommitment(mind, commitment(`promise-${i}`, i));
    expect(() => setCommitment(mind, commitment('extra', 25))).toThrow(RangeError);
    expect(mind.commitments).toHaveLength(24);
    resolveCommitment(mind, 'promise-3', 'broken', 26);
    setCommitment(mind, commitment('extra', 27));
    expect(mind.commitments).toHaveLength(24);
    expect(mind.commitments.some(c => c.id === 'promise-3')).toBe(false);
    expect(mind.commitments.some(c => c.id === 'extra')).toBe(true);
  });

  it('records interrupted intent and reason while keeping obligations active', () => {
    const mind = createMind(profile);
    setCommitment(mind, commitment('return'));
    beginIntent(mind, intent());
    interruptIntent(mind, 'The owner requested the journal back', 5);
    expect(mind.intent).toMatchObject({ phase: 'interrupted', until: 5 });
    expect(mind.experiences.find(e => e.event === 'intent.interrupted')).toMatchObject({
      at: 5, relatedTo: 'catalogue', detail: expect.stringContaining('The owner requested the journal back'),
    });
    expect(mind.commitments[0].status).toBe('active');
    const revision = mind.revision;
    completeIntent(mind, 6);
    interruptIntent(mind, 'duplicate interruption', 6);
    expect(mind.revision).toBe(revision);
  });

  it('records replacement and completion so a new decision cannot erase unfinished intent', () => {
    const mind = createMind(profile), first = intent();
    beginIntent(mind, first);
    first.label = 'caller mutation';
    beginIntent(mind, intent('return', 3));
    expect(mind.experiences.find(e => e.event === 'intent.interrupted')?.detail).toContain('Catalogue the journal');
    completeIntent(mind, 7);
    expect(mind.intent).toMatchObject({ id: 'return', phase: 'completed', until: 7 });
    expect(mind.experiences.some(e => e.event === 'intent.completed' && e.relatedTo === 'return')).toBe(true);
  });

  it('updates one coherent affect-expression pair without invented experiences', () => {
    const mind = createMind(profile);
    for (const reaction of REACTION_OPTIONS) {
      applyAffect(mind, reaction.id);
      expect(mind.affect).toBe(reaction.id);
      expect(mind.expression).toBe(reaction.expression);
      expect(reaction.description.length).toBeGreaterThan(30);
      expect(mindSchema.safeParse(mind).success).toBe(true);
    }
    expect(mind.experiences).toEqual([]);
  });

  it('continues an existing intent without inventing an interruption', () => {
    const mind = createMind(profile);
    beginIntent(mind, { ...intent(), phase: 'planning' });
    beginIntent(mind, { ...intent(), phase: 'acting' });
    beginIntent(mind, { ...intent(), phase: 'waiting' });
    expect(mind.intent?.phase).toBe('waiting');
    expect(mind.experiences.filter(e => e.event === 'intent.interrupted')).toEqual([]);
    expect(mind.experiences.filter(e => e.event === 'intent.updated')).toHaveLength(2);
  });

  it('rejects invalid updates before changing live state', () => {
    const mind = createMind(profile);
    setCommitment(mind, commitment('return', 3));
    beginIntent(mind, intent('catalogue', 4));
    const before = structuredClone(mind);
    for (const update of [
      () => rememberExperience(mind, experience('invalid', NaN)),
      () => setCommitment(mind, { ...commitment('return', 3), dueAt: 2 }),
      () => resolveCommitment(mind, 'return', 'broken', 2),
      () => beginIntent(mind, intent('replacement', 3)),
      () => beginIntent(mind, { ...intent('replacement', 5), phase: 'completed', until: 6 }),
      () => completeIntent(mind, 3),
      () => interruptIntent(mind, ' ', 5),
    ]) {
      expect(update).toThrow();
      expect(mind).toEqual(before);
    }
  });

  it('builds detached context from only supplied knowledge, with current affect and history', () => {
    const mind = createMind(profile);
    rememberExperience(mind, experience('known', 1));
    setCommitment(mind, commitment('return'));
    beginIntent(mind, intent());
    applyAffect(mind, 'worried');
    const situation = { visible: ['a sealed journal'], environment: { light: 'dim' } };
    const context = buildDecisionContext(mind, situation);
    expect(context).toMatchObject({ affect: 'worried', profile, situation, intent: { id: 'catalogue' } });
    expect(JSON.stringify(context)).not.toMatch(/lin-debt|world\.flags|Phaser/);
    (context.profile as CharacterProfile).traits.push('corrupted');
    (context.experiences as Experience[])[0].detail = 'fabricated';
    (context.commitments as Commitment[])[0].status = 'broken';
    (context.intent as Intent).label = 'erased';
    (context.situation as typeof situation).visible.push('unseen secret');
    expect(mind.profile).toEqual(profile);
    expect(mind.experiences[0].detail).toBe('Observed report known');
    expect(mind.commitments[0].status).toBe('active');
    expect(mind.intent?.label).toBe('Catalogue the journal');
    expect(situation.visible).toEqual(['a sealed journal']);
  });

  it('rejects invalid saved state, duplicate identities and incoherent lifecycle timestamps', () => {
    const valid = createMind(profile);
    rememberExperience(valid, experience('known', 1));
    beginIntent(valid, intent());
    const invalid = [
      { ...valid, extra: 'unknown' }, { ...valid, revision: -1 }, { ...valid, affect: 'invented' },
      { ...valid, profile: { ...profile, role: ' ' } },
      { ...valid, experiences: [{ ...experience('bad', 1), salience: Infinity }] },
      { ...valid, experiences: Array(33).fill(experience('too-many', 1)) },
      { ...valid, experiences: [experience('same', 1), experience('same', 2)] },
      { ...valid, commitments: [{ ...commitment('bad'), status: 'cancelled' }] },
      { ...valid, intent: { ...intent(), until: 0 } },
      { ...valid, intent: { ...intent(), phase: 'completed' } },
    ];
    for (const state of invalid) expect(mindSchema.safeParse(state).success).toBe(false);
    expect(mindSchema.parse(valid)).toEqual(valid);
  });
});

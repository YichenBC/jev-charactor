import { describe, expect, it } from 'vitest';
import { CabinEnvironment, DeterministicCabinProvider } from '../examples/cabin';
import { mindSchema, inspectBelief } from '../src/character';
import { CharacterRuntime } from '../src/character/runtime';
import type { DecisionProvider } from '../src/character/runtime';

const choose = (choice: string): DecisionProvider => ({
  source: 'test-authored-choice',
  async decide() { return { choice, affect: 'focused' }; },
});

describe('independent cabin environment', () => {
  it('shares public background but isolates private goals, knowledge, needs and memories', () => {
    const cabin = new CabinEnvironment();
    const ada = cabin.openTurn('ada')!.input;
    const bram = cabin.openTurn('bram')!.input;
    const state = cabin.inspect();
    expect((ada.context.situation as { publicKnowledge: unknown }).publicKnowledge).toEqual((bram.context.situation as { publicKnowledge: unknown }).publicKnowledge);
    expect(JSON.stringify(ada.context)).toContain(state.people.ada.privateGoal);
    expect(JSON.stringify(ada.context)).not.toContain(state.people.bram.privateGoal);
    expect(JSON.stringify(bram.context)).not.toContain(state.people.ada.privateGoal);
    expect(ada.context).toMatchObject({ knowledge: [], situation: { self: { state: { energy: 7 } } } });
    expect(bram.context).toMatchObject({ knowledge: [{ topic: 'pantry', status: 'known', values: ['empty'] }], situation: { self: { state: { energy: 2 } } } });
    expect(ada.options.map(option => option.id)).toContain('collect-food');
    expect(bram.options.map(option => option.id)).not.toContain('collect-food');
    (ada.context.situation as { self: { privateGoal: string } }).self.privateGoal = 'corrupted';
    expect(cabin.inspect().people.ada.privateGoal).toBe(state.people.ada.privateGoal);
  });

  it('executes a failed attempt, learns only through experience, then changes the next choice', async () => {
    const cabin = new CabinEnvironment();
    const runtime = new CharacterRuntime(cabin, new DeterministicCabinProvider());
    const bramBefore = cabin.inspect().people.bram;
    expect(await runtime.step('ada')).toMatchObject({ status: 'applied', execution: { detail: expect.stringContaining('failed') } });
    const afterFailure = cabin.inspect();
    expect(afterFailure.people.ada.state).toMatchObject({ hunger: 8, energy: 6 });
    expect(afterFailure.people.ada.knowledge.pantry).toBe('empty');
    expect(mindSchema.safeParse(afterFailure.people.ada.mind).success).toBe(true);
    expect(afterFailure.people.ada.mind).toMatchObject({ affect: 'worried', expression: '微微皱眉' });
    expect(cabin.openTurn('ada')!.input.context.experiences).toEqual(afterFailure.people.ada.mind.experiences);
    expect(afterFailure.people.ada.mind.experiences.at(-1)).toMatchObject({ event: 'collect-food.failed', source: 'experienced' });
    expect(afterFailure.people.bram).toEqual(bramBefore);
    expect(cabin.openTurn('ada')!.input.options.map(option => option.id)).not.toContain('collect-food');
    await runtime.step('ada');
    const ada = cabin.inspect().people.ada;
    expect(ada.mind.experiences.at(-1)).toMatchObject({ event: 'ask-peer', source: 'heard' });
    expect(ada.knowledge.pantrySource).toBe('heard from Bram');
    expect(ada.mind.experiences.filter(item => item.event === 'collect-food.failed')).toHaveLength(1);
  });

  it('offers the same uninformed decision frame for different hidden pantry contents', () => {
    const empty = new CabinEnvironment({ pantryFood: 0 });
    const stocked = new CabinEnvironment({ pantryFood: 3 });
    expect(empty.openTurn('ada')!.input).toEqual(stocked.openTurn('ada')!.input);
  });

  it('applies real sleep, work and successful collection effects', async () => {
    const cabin = new CabinEnvironment({ pantryFood: 1 });
    await new CharacterRuntime(cabin, choose('sleep')).step('bram');
    expect(cabin.inspect().people.bram.state).toMatchObject({ energy: 7, hunger: 5, workCompleted: 0 });
    await new CharacterRuntime(cabin, choose('work')).step('bram');
    expect(cabin.inspect().people.bram.state).toMatchObject({ energy: 5, hunger: 6, workCompleted: 1 });
    await new CharacterRuntime(cabin, choose('collect-food')).step('ada');
    expect(cabin.inspect()).toMatchObject({ pantryFood: 0, people: { ada: { state: { hunger: 3, energy: 6 } } } });
    expect(cabin.inspect().people.ada.mind.experiences.at(-1)?.event).toBe('collect-food.succeeded');
  });

  it('lets a peer learn a reported fact without exposing the speaker private goal', async () => {
    const cabin = new CabinEnvironment();
    await new CharacterRuntime(cabin, choose('ask-peer')).step('ada');
    const frame = cabin.openTurn('ada')!.input;
    expect(frame.context).toMatchObject({ knowledge: [{ topic: 'pantry', status: 'known', values: ['empty'], evidence: [{ source: { kind: 'heard', from: 'Bram' }, learnedAt: 0, confidence: 1 }] }] });
    expect(frame.options.map(option => option.id)).not.toContain('collect-food');
    expect(JSON.stringify(frame)).not.toContain(cabin.inspect().people.bram.privateGoal);
  });

  it('rejects stale and replayed turns atomically, including changes by another character', () => {
    const cabin = new CabinEnvironment();
    const adaTurn = cabin.openTurn('ada')!;
    const bramTurn = cabin.openTurn('bram')!;
    expect(bramTurn.execute({ choice: 'sleep', affect: 'focused' }, 'test').status).toBe('applied');
    const after = cabin.inspect();
    expect(adaTurn.isCurrent()).toBe(false);
    expect(adaTurn.execute({ choice: 'work', affect: 'focused' }, 'test').status).toBe('rejected');
    expect(bramTurn.execute({ choice: 'sleep', affect: 'focused' }, 'test').status).toBe('rejected');
    expect(cabin.inspect()).toEqual(after);
    expect(cabin.openTurn('missing')).toBeNull();
  });

  it('rejects unoffered actions without effects even if the exposed options are modified', () => {
    const cabin = new CabinEnvironment();
    const turn = cabin.openTurn('bram')!;
    turn.input.options.push({ id: 'collect-food', label: 'Injected', description: 'Invented by a caller' });
    const before = cabin.inspect();
    expect(turn.execute({ choice: 'collect-food', affect: 'focused' }, 'test').status).toBe('rejected');
    expect(cabin.inspect()).toEqual(before);
    expect(turn.isCurrent()).toBe(true);
  });

  it('retains direct observation when a peer reports conflicting older supply knowledge', async () => {
    const cabin = new CabinEnvironment({ pantryFood: 1 });
    await new CharacterRuntime(cabin, choose('collect-food')).step('ada');
    const direct = cabin.inspect().people.ada.mind.knowledge[0];
    await new CharacterRuntime(cabin, choose('ask-peer')).step('ada');
    const person = cabin.inspect().people.ada;
    expect(person.mind.knowledge).toContainEqual(direct);
    expect(inspectBelief(person.mind, 'pantry', 0)).toMatchObject({ status: 'conflicted', values: expect.arrayContaining(['empty', 'stocked']) });
    expect(person.mind.knowledge.at(-1)).toMatchObject({ value: 'stocked', source: { kind: 'heard', from: 'Bram' }, confidence: 1, learnedAt: 0, validUntil: 5 });
    expect(cabin.openTurn('ada')!.input.options.map(item => item.id)).toContain('collect-food');
    await new CharacterRuntime(cabin, choose('collect-food')).step('ada');
    expect(inspectBelief(cabin.inspect().people.ada.mind, 'pantry', 0)).toMatchObject({ status: 'known', values: ['empty'] });
    expect(cabin.inspect().people.ada.mind.knowledge.filter(item => item.retiredAt === 0)).toHaveLength(2);
  });

  it('expires evidence on explicit clock advancement, invalidates captures and permits rechecking', async () => {
    const cabin = new CabinEnvironment();
    const captured = cabin.openTurn('bram')!;
    cabin.advanceTime(5);
    expect(captured.isCurrent()).toBe(false);
    expect(captured.execute({ choice: 'sleep', affect: 'focused' }, 'test').status).toBe('rejected');
    const frame = cabin.openTurn('bram')!.input;
    expect(frame.context).toMatchObject({ knowledge: [{ topic: 'pantry', status: 'outdated', values: [], evidence: [{ status: 'expired' }] }] });
    expect(frame.options.map(item => item.id)).toContain('collect-food');
    await new CharacterRuntime(cabin, choose('collect-food')).step('bram');
    expect(inspectBelief(cabin.inspect().people.bram.mind, 'pantry', 5)).toMatchObject({ status: 'known', values: ['empty'] });
    expect(cabin.inspect().people.bram.mind.knowledge.at(-1)).toMatchObject({ learnedAt: 5, validUntil: 10, source: { kind: 'observed' } });
  });

  it('does not refresh stale reports or leak hidden truth when time advances', async () => {
    const empty = new CabinEnvironment({ pantryFood: 0 });
    const stocked = new CabinEnvironment({ pantryFood: 3 });
    empty.advanceTime(5);
    stocked.advanceTime(5);
    expect(empty.openTurn('ada')!.input).toEqual(stocked.openTurn('ada')!.input);
    await new CharacterRuntime(empty, choose('ask-peer')).step('ada');
    expect(empty.inspect().people.ada.mind.knowledge).toEqual([]);
    expect(empty.openTurn('ada')!.input.options.map(item => item.id)).toContain('collect-food');
  });

  it('bounds clock advancement without partial mutation', () => {
    const cabin = new CabinEnvironment();
    const before = cabin.inspect();
    for (const ticks of [0, -1, 0.5, 101, Infinity, NaN]) {
      expect(() => cabin.advanceTime(ticks)).toThrow();
      expect(cabin.inspect()).toEqual(before);
    }
    const detached = cabin.inspect();
    detached.people.bram.knowledge.pantry = 'stocked';
    detached.people.bram.mind.knowledge[0].value = 'stocked';
    expect(cabin.inspect()).toEqual(before);
  });


  it('records receipt time and preserves the speaker evidence expiry rather than renewing it', async () => {
    const cabin = new CabinEnvironment({ pantryFood: 3 });
    cabin.advanceTime(2);
    await new CharacterRuntime(cabin, choose('ask-peer')).step('ada');
    const person = cabin.inspect().people.ada;
    expect(person.mind.knowledge[0]).toMatchObject({ learnedAt: 2, validUntil: 5, confidence: 1, source: { kind: 'heard', from: 'Bram' } });
    expect(person.mind.experiences.at(-1)?.detail).toContain('learned at 0');
    cabin.advanceTime(3);
    expect(inspectBelief(cabin.inspect().people.ada.mind, 'pantry', 5).status).toBe('outdated');
  });

});

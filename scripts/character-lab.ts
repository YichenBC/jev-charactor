import 'dotenv/config';
import assert from 'node:assert/strict';
import { CabinEnvironment, DeterministicCabinProvider } from '../examples/cabin';
import { inspectBelief } from '../src/character';
import { CharacterRuntime } from '../src/character/runtime';
import type { DecisionProvider } from '../src/character/runtime';
import { decide, decisionInput } from '../server/jev';

// This entry point runs in Node only. Credentials never enter a frame or browser bundle.
const useJev = process.argv.includes('--jev');
const key = process.env.OPENROUTER_API_KEY;
if (useJev && !key) {
  console.error('Jev lab unavailable: OPENROUTER_API_KEY is not configured. No fallback was run.');
  process.exitCode = 1;
} else {
  const provider: DecisionProvider = useJev ? {
    source: 'jev-server-node',
    async decide(frame, signal) {
      const input = decisionInput.parse({ npcId: frame.characterId, revision: frame.revision, state: frame.context, options: frame.options });
      const response = await decide(input, key!, undefined, signal);
      if (response.npcId !== frame.characterId || response.revision !== frame.revision) throw new Error('Jev response identity mismatch');
      console.log(`  Jev ${frame.characterId}: model=${JSON.stringify(response.model)}, latency=${response.latencyMs}ms, cost=${response.cost === undefined ? 'not reported' : `$${response.cost}`}`);
      const { npcId: _npcId, revision: _revision, ...decision } = response;
      return decision;
    },
  } : new DeterministicCabinProvider();
  const cabin = new CabinEnvironment();
  const runtime = new CharacterRuntime(cabin, provider);
  const initial = cabin.inspect();
  const adaFrame = cabin.openTurn('ada')!.input;
  const bramFrame = cabin.openTurn('bram')!.input;
  assert(!JSON.stringify(adaFrame).includes(initial.people.bram.privateGoal));
  assert(!JSON.stringify(bramFrame).includes(initial.people.ada.privateGoal));
  assert(adaFrame.options.some(option => option.id === 'collect-food'));
  assert(!bramFrame.options.some(option => option.id === 'collect-food'));
  console.log(`Character lab provider: ${provider.source}${useJev ? ' (real upstream choices)' : ' (authored deterministic integration demo; not Jev evidence)'}`);
  console.log('Privacy checks passed: each frame contains only its own private goal and knowledge.');
  console.log('Initial hidden truth: pantry has 0 rations. Ada does not know; Bram observed it earlier.');
  console.log(`Ada candidates: ${adaFrame.options.map(option => option.id).join(', ')}`);
  console.log(`Bram candidates: ${bramFrame.options.map(option => option.id).join(', ')}`);
  let failedAttempts = 0;
  try {
    // Bounded and sequential: later decisions receive the previous attempt's actual effects.
    for (const id of ['ada', 'ada', 'bram', 'bram', 'ada'] as const) {
      const result = await runtime.step(id);
      const person = cabin.inspect().people[id];
      const latest = person.mind.experiences.at(-1);
      if ('execution' in result) {
        if (result.status === 'applied' && latest?.event === 'collect-food.failed') failedAttempts++;
        console.log(`${id}: ${result.status}; ${result.execution.detail}`);
      } else console.log(`${id}: ${result.status}; no execution.`);
      console.log(`  energy=${person.state.energy}, hunger=${person.state.hunger}, research=${person.state.workCompleted}, pantry belief=${person.knowledge.pantry} (${person.knowledge.pantrySource})`);
    }
    if (!useJev) {
      const final = cabin.inspect();
      assert.equal(failedAttempts, 1);
      assert.equal(final.people.ada.knowledge.pantrySource, 'heard from Bram');
      assert.equal(final.people.ada.state.workCompleted, 1);
      assert.equal(final.people.bram.state.workCompleted, 1);
      assert.equal(final.people.ada.mind.knowledge.filter(claim => claim.source.kind === 'observed').length, 1);
      assert.equal(final.people.ada.mind.knowledge.filter(claim => claim.source.kind === 'heard').length, 1);
      console.log('Deterministic checks passed: one failed attempt, retained observation plus peer report, rest and actual research progress.');

      // Separate authored scenario; these choices never use Jev and are not model evidence.
      const conflict = new CabinEnvironment({ pantryFood: 1 });
      const act = async (choice: string) => {
        const authored: DecisionProvider = { source: 'authored-knowledge-probe', async decide() { return { choice, affect: 'focused' }; } };
        const probeRuntime = new CharacterRuntime(conflict, authored);
        try { assert.equal((await probeRuntime.step('ada')).status, 'applied'); }
        finally { probeRuntime.cancel(); }
      };
      await act('collect-food');
      await act('ask-peer');
      let snapshot = conflict.inspect();
      assert.equal(inspectBelief(snapshot.people.ada.mind, 'pantry', snapshot.time).status, 'conflicted');
      assert(conflict.openTurn('ada')!.input.options.some(option => option.id === 'collect-food'));
      console.log('Authored conflict: Ada observed empty after eating the last ration; Bram reports his older stocked observation. Both claims remain.');
      const captured = conflict.openTurn('ada')!;
      conflict.advanceTime(5);
      snapshot = conflict.inspect();
      assert.equal(inspectBelief(snapshot.people.ada.mind, 'pantry', snapshot.time).status, 'outdated');
      assert.equal(captured.isCurrent(), false);
      await act('collect-food');
      snapshot = conflict.inspect();
      assert.deepEqual(inspectBelief(snapshot.people.ada.mind, 'pantry', snapshot.time).values, ['empty']);
      assert.equal(snapshot.people.ada.state.hunger, 3);
      console.log('Authored expiry check passed: five ticks expire evidence and invalidate captures; rechecking establishes current empty supply with real energy cost.');
    } else {
      console.log(`Real Jev probe finished: ${failedAttempts} empty-pantry attempts observed. Choices are model-selected; no specific failure or action sequence is guaranteed.`);
    }
  } catch {
    // Upstream failures are reported without dumping request data, credentials or remote error bodies.
    console.error('Character lab stopped because a decision failed. No fallback was run.');
    process.exitCode = 1;
  } finally {
    runtime.cancel();
  }
}

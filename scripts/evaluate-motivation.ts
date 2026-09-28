import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { decide, DecisionError, decisionInput } from '../server/jev';
import { advance, applyDecision, createWorld, getContext, getOptions, loadWorld, playerInteract, serializeWorld } from '../src/sim';

// Controlled fixtures, not natural playthroughs or a measure of roleplay quality.
const cases = [
  { name: 'hungry', needs: { hunger: 10, energy: 85, social: 80, workPressure: 20 } },
  { name: 'tired', needs: { hunger: 85, energy: 10, social: 80, workPressure: 20 } },
  { name: 'overworked', needs: { hunger: 85, energy: 85, social: 80, workPressure: 95 } },
  { name: 'lonely', needs: { hunger: 85, energy: 85, social: 10, workPressure: 20 } },
].flatMap(scenario => [false, true].map(conversation => ({ ...scenario, conversation })));

function prepare(scenario: typeof cases[number]) {
  const world = createWorld(), npc = world.npcs[0];
  npc.needs = { ...scenario.needs };
  world.player.x = npc.x; world.player.y = npc.y;
  if (scenario.conversation) playerInteract(world, npc.id, 'greet');
  const input = decisionInput.parse({ npcId: npc.id, revision: npc.revision, state: getContext(world, npc.id), options: getOptions(world, npc.id) });
  assert.ok(loadWorld(serializeWorld(world)), 'Fixture must be a valid save');
  return { world, npc, input };
}

async function main() {
  cases.forEach(prepare);
  if (process.argv.includes('--dry-run')) { console.log(JSON.stringify({ fixturesValidated: cases.length, requests: 0 })); return; }
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new DecisionError('missing_key');
  const results: Record<string, unknown>[] = [], latencies: number[] = [];
  let totalCost = 0, errors = 0;
  await mkdir('artifacts', { recursive: true });
  for (const scenario of cases) {
    const { world, npc, input } = prepare(scenario), before = { ...npc.needs };
    const result: Record<string, unknown> = { scenario, input, before };
    try {
      const response = await decide(input, key);
      latencies.push(response.latencyMs); totalCost += response.cost ?? 0;
      const applied = applyDecision(world, npc.id, response.choice, 'jev-motivation-probe', response);
      Object.assign(result, { response, applied, immediateNeeds: { ...npc.needs }, immediateJob: npc.job ? { ...npc.job } : null, changes: world.decisions.at(-1)?.changes });
      assert.ok(applied, 'Response must apply');
      assert.ok(loadWorld(serializeWorld(world)), 'Immediate resulting save must be valid');
      // No further model decisions: finish only the selected continuous action.
      for (let i = 0; i < 480 && (npc.job || npc.path.length); i++) advance(world, .25);
      Object.assign(result, { finalNeeds: { ...npc.needs }, elapsed: world.time, finalActivity: npc.activity, completed: !npc.job && !npc.path.length });
      assert.ok(loadWorld(serializeWorld(world)), 'Final resulting save must be valid');
    } catch (error) {
      errors++;
      result.error = error instanceof DecisionError ? error.message : 'mechanical_validation_failed';
    }
    results.push(result);
    await writeFile('artifacts/motivation-probe.json', JSON.stringify({
      date: new Date().toISOString(), plannedRequests: cases.length, completedRequests: results.length,
      complete: results.length === cases.length, errors, totalReportedCostUSD: totalCost,
      limitations: ['One call per fixture; no significance or roleplay-quality claim.', 'Controlled own-needs fixtures; conversation changes available choices.', 'Post-choice advancement has no subsequent model calls or other NPC decisions.', 'Projected effects are authored mechanics, not model reasoning.'], results,
    }, null, 2) + '\n');
    if (result.error && ['upstream_401', 'upstream_402'].includes(String(result.error))) break;
  }
  latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({ requested: results.length, errors, latencyMs: { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) }, totalReportedCostUSD: totalCost,
    choices: results.map(r => ({ scenario: r.scenario, response: r.response, applied: r.applied, error: r.error })), artifact: 'artifacts/motivation-probe.json' }, null, 2));
  if (errors) process.exitCode = 1;
}

main().catch(error => { console.error(error instanceof DecisionError ? error.message : 'probe_setup_failed'); process.exitCode = 1; });

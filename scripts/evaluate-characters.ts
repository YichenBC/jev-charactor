import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decide, DecisionError, decisionInput } from '../server/jev';
import {
  buildDecisionContext, createMind, REACTION_OPTIONS, rememberExperience,
  resolveCommitment, setCommitment,
} from '../src/character';
import {
  advance, applyDecision, BUILDINGS, createWorld, deliverySituation, getOptions,
  loadWorld, parcelName, performService, playerInteract, serializeWorld,
} from '../src/sim';
import { PROFILES } from '../src/sim/data';

export type Scenario = {
  persona: 'impatient' | 'forgiving'; timing: 'timely' | 'late_cold';
  history: 'reliable' | 'repeated_broken'; explanation: boolean;
};
type EvaluationResult = {
  scenario: Scenario; id: string; input: ReturnType<typeof decisionInput.parse>;
  requestStartedAt: string; latencyMs: number; model: string | null; cost: number | null;
  choice: string | null; affect: string | null; confidence: number | null;
  validChoice: boolean; validAffect: boolean; actionApplied: boolean;
  settlement: { status: string; payout: number; commitment: string | null } | null;
  error: string | null;
};
const scenarioId = (s: Scenario) => `${s.persona}/${s.timing}/${s.history}/${s.explanation ? 'explained' : 'unexplained'}`;

export function prepareScenario(scenario: Scenario) {
  // Controlled fixture setup: locations, clock, persona, and prior history are inputs,
  // not claims about a natural gameplay trajectory. Settlement uses actual game APIs.
  const world = createWorld(), npc = world.npcs[0];
  world.time = 300;
  world.survival.orders[0].expiresAt = 480;
  const originalProfile = PROFILES[scenario.persona === 'impatient' ? 'lan' : 'zhou'];
  npc.mind = createMind({ ...originalProfile, role: 'Resident receiving a meal delivery' });
  npc.name = '收件人'; npc.role = '收餐居民';
  npc.persona = originalProfile.traits.join('; ');
  npc.goal = 'Decide how to settle the meal delivery according to my values and known experience.';
  npc.secret = ''; npc.knownFacts = []; npc.memories = [];
  npc.x = 360; npc.y = 456; npc.path = []; npc.trust = 0;

  for (let index = 1; index <= 3; index++) {
    const at = index * 50, id = `previous-delivery-${index}`;
    setCommitment(npc.mind, {
      id, description: `On prior delivery ${index}, this same player promised to bring my meal before the agreed deadline.`,
      status: 'active', createdAt: at, dueAt: at + 20, counterparty: 'player',
    });
    const status = scenario.history === 'reliable' ? 'fulfilled' : 'broken';
    resolveCommitment(npc.mind, id, status, at + (status === 'fulfilled' ? 15 : 30));
    rememberExperience(npc.mind, {
      id: `prior-outcome-${index}`, at: at + 35, event: 'prior_delivery', source: 'experienced', relatedTo: id, salience: .9,
      detail: status === 'fulfilled'
        ? `This player delivered my previous meal ${index} on time and warm, fulfilling our agreement.`
        : `This player did not deliver my previous meal ${index}; the agreed deadline passed, the order was cancelled, and the promise was broken.`,
    });
  }

  const tavern = BUILDINGS.find(building => building.id === 'tavern')!.door;
  world.player.x = tavern.x; world.player.y = tavern.y;
  const order = world.survival.orders[0];
  performService(world, `accept:${order.id}`);
  assert.equal(order.status, 'accepted');
  for (let i = 0; i < 24; i++) advance(world, .25);
  performService(world, 'pickup');
  assert.equal(order.status, 'carrying');
  if (scenario.timing === 'late_cold') {
    while (world.time < order.deadline + 15) advance(world, .25);
  }
  world.player.x = npc.x; world.player.y = npc.y;
  playerInteract(world, npc.id, scenario.explanation && scenario.timing === 'late_cold' ? 'explain' : 'deliver');
  // The controlled timely/explained cell supplies a statement below even though
  // normal timely gameplay has no "sorry I am late" menu entry.
  if (scenario.explanation) order.explanation = true;
  const options = getOptions(world, npc.id).map(({ id, label, description }) => ({ id, label, description }));
  const delivery = deliverySituation(world, npc.id);
  assert.ok(delivery);
  assert.equal(delivery.late, scenario.timing === 'late_cold');
  assert.equal(delivery.cold, scenario.timing === 'late_cold');
  assert.equal(delivery.explained, scenario.explanation);
  assert.ok(world.player.inventory.includes(parcelName(order)));
  const state = buildDecisionContext(npc.mind, {
    time: world.time,
    self: { name: 'The customer', role: npc.mind.profile.role, goal: npc.goal },
    pendingInteraction: npc.pendingInteraction,
    delivery,
    observation: {
      playerIsPresent: true, playerDistance: 0,
      playerStatement: scenario.explanation
        ? 'The bridge was closed, so I took a detour and came straight here. I am sorry for the inconvenience.'
        : 'Here is your meal.',
      evidenceAboutExplanation: scenario.explanation ? 'The character heard this explanation; its truth has not been independently verified.' : null,
    },
    options,
    instruction: 'Choose how this character responds to this delivery using only their supplied profile, memories, commitments and observations.',
  });
  const input = decisionInput.parse({ npcId: npc.id, revision: npc.revision, state, options });
  assert.ok(loadWorld(serializeWorld(world)), 'Scenario must be a valid saved game state');
  return { world, npc, order, input };
}

function descriptiveSummary(results: EvaluationResult[]) {
  const valid = results.filter(result => result.validChoice && result.validAffect && result.actionApplied);
  const tally = (items: EvaluationResult[], field: 'choice' | 'affect') => Object.fromEntries(
    [...new Set(items.map(item => item[field]))].filter((value): value is string => value !== null)
      .map(value => [value, items.filter(item => item[field] === value).length]),
  );
  const comparisons = (['persona', 'timing', 'history', 'explanation'] as const).map(factor => {
    const groups = new Map<string, EvaluationResult[]>();
    for (const result of valid) {
      const key = JSON.stringify(Object.fromEntries(Object.entries(result.scenario).filter(([field]) => field !== factor)));
      groups.set(key, [...(groups.get(key) ?? []), result]);
    }
    const pairs = [...groups.values()].filter(group => group.length === 2);
    return {
      factor, comparablePairs: pairs.length,
      changedAction: pairs.filter(([a, b]) => a.choice !== b.choice).length,
      changedAffect: pairs.filter(([a, b]) => a.affect !== b.affect).length,
      pairs: pairs.map(([a, b]) => ({
        a: a.id, b: b.id, action: [a.choice, b.choice], affect: [a.affect, b.affect],
      })),
    };
  });
  const personaComparison = comparisons.find(comparison => comparison.factor === 'persona')!;
  const costs = results.flatMap(result => result.cost === null ? [] : [result.cost]);
  const latencies = results.map(result => result.latencyMs).sort((a, b) => a - b);
  return {
    requested: results.length, successfullyApplied: valid.length, errors: results.filter(result => result.error).length,
    choices: tally(valid, 'choice'), affects: tally(valid, 'affect'),
    profiles: (['impatient', 'forgiving'] as const).map(persona => {
      const subset = valid.filter(result => result.scenario.persona === persona);
      return { persona, calls: subset.length, choices: tally(subset, 'choice'), affects: tally(subset, 'affect') };
    }),
    latencyMs: { min: latencies[0], median: latencies[Math.floor(latencies.length / 2)], max: latencies.at(-1) },
    providerReportedCost: { total: Number(costs.reduce((total, cost) => total + cost, 0).toFixed(8)), reportedRequests: costs.length, missingRequests: results.length - costs.length, currency: 'USD (OpenRouter usage.cost)' },
    matchedComparisons: comparisons,
    personalityObservation: personaComparison.changedAction === 0
      ? `No action differences were observed across ${personaComparison.comparablePairs} matched personality pairs. This sample does not demonstrate personality-sensitive action selection; affect differed in ${personaComparison.changedAffect} pairs.`
      : `Actions differed in ${personaComparison.changedAction} of ${personaComparison.comparablePairs} matched personality pairs; affect differed in ${personaComparison.changedAffect}. The individual outcomes, including identical and mixed responses, are recorded below.`,
    limitations: [
      'One call per cell, 16 sequential calls, no repeated samples or statistical significance analysis.',
      'Personality changes traits, values and speaking style together; identity, role, goal, fees and starting affect are fixed.',
      'Late deliveries are also cold; these effects are not isolated. Legal candidates differ between timely and late conditions.',
      'History and explanation are controlled fictional fixtures, not independently observed player behavior.',
      'Choice legality and actual settlement are mechanical checks; they do not establish human-like roleplay quality.',
    ],
  };
}

export async function evaluateCharacters() {
  const scenarios: Scenario[] = [];
  for (const timing of ['timely', 'late_cold'] as const)
    for (const history of ['reliable', 'repeated_broken'] as const)
      for (const explanation of [false, true])
        for (const persona of ['impatient', 'forgiving'] as const)
          scenarios.push({ persona, timing, history, explanation });
  // Validate all fixtures before using any paid request.
  scenarios.forEach(prepareScenario);
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new DecisionError('missing_key');
  const startedAt = new Date().toISOString(), results: EvaluationResult[] = [];
  for (const scenario of scenarios) {
    const { world, npc, order, input } = prepareScenario(scenario);
    const start = performance.now();
    const result: EvaluationResult = {
      scenario, id: scenarioId(scenario), input, requestStartedAt: new Date().toISOString(),
      latencyMs: 0, model: null, cost: null, choice: null, affect: null, confidence: null,
      validChoice: false, validAffect: false, actionApplied: false, settlement: null, error: null,
    };
    try {
      const response = await decide(input, key);
      Object.assign(result, {
        latencyMs: response.latencyMs, model: response.model, cost: response.cost ?? null,
        choice: response.choice, affect: response.affect, confidence: response.confidence ?? null,
        validChoice: input.options.some(option => option.id === response.choice),
        validAffect: REACTION_OPTIONS.some(option => option.id === response.affect),
      });
      if (result.validChoice && result.validAffect) {
        result.actionApplied = applyDecision(world, npc.id, response.choice, 'jev-evaluation', {
          revision: response.revision, affect: response.affect, latencyMs: response.latencyMs,
          confidence: response.confidence, model: response.model, cost: response.cost,
        });
      }
      result.settlement = {
        status: order.status, payout: order.payout ?? 0,
        commitment: npc.mind.commitments.find(commitment => commitment.id === order.id)?.status ?? null,
      };
      if (!result.validChoice || !result.validAffect || !result.actionApplied) result.error = 'response_failed_mechanical_validation';
      else if (!loadWorld(serializeWorld(world))) result.error = 'resulting_save_invalid';
    } catch (error) {
      result.latencyMs = Math.round(performance.now() - start);
      // Provider error codes are sanitized by server/jev; never print request headers or env.
      result.error = error instanceof DecisionError ? error.message : 'evaluation_failed';
    }
    results.push(result);
    // Checkpoint every completed request so partial observations survive interruption.
    const artifact = {
      title: 'Jev controlled character response evaluation', startedAt, completedRequests: results.length,
      plannedRequests: scenarios.length, complete: results.length === scenarios.length,
      summary: descriptiveSummary(results), results,
    };
    const output = resolve('artifacts/character-evaluation.json');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(artifact, null, 2) + '\n');
  }
  return descriptiveSummary(results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  evaluateCharacters().then(summary => console.log(JSON.stringify({
    requested: summary.requested, successfullyApplied: summary.successfullyApplied, errors: summary.errors,
    choices: summary.choices, affects: summary.affects, profiles: summary.profiles,
    latencyMs: summary.latencyMs, providerReportedCost: summary.providerReportedCost,
    personalityObservation: summary.personalityObservation,
    artifact: 'artifacts/character-evaluation.json',
  }, null, 2))).catch(error => {
    console.error(JSON.stringify({ error: error instanceof DecisionError ? error.message : 'evaluation_setup_failed' }));
    process.exitCode = 1;
  });
}

# Character core

`index.ts` is independent of rendering, maps, simulation IDs, model providers, and wall-clock time. An environment supplies a persona, observed experiences, and its current situation. The core stores only those inputs and explicit lifecycle outcomes.

```ts
import { createMind, rememberExperience, buildDecisionContext } from './character';

const mind = createMind({
  role: 'An archivist aboard a research vessel',
  traits: ['patient'], values: ['accuracy'], speakingStyle: 'Careful with uncertainty.',
});
rememberExperience(mind, {
  id: 'visitor-report-1', at: 12, event: 'report',
  detail: 'A visitor said the journal was damaged.', source: 'heard', salience: 0.6,
});
const context = buildDecisionContext(mind, { visible: ['a sealed journal'] });
```

## State and transitions

- Mutators change the supplied mind and increment `revision` when they change it. Inputs are validated and copied; `buildDecisionContext` returns a deep copy, including the supplied situation.
- Times use the caller's unit consistently and must be finite and nonnegative. Salience is in `[0, 1]`.
- Memory is bounded to 32 entries, retaining eight by salience and filling the remaining places by recency. Duplicate retained IDs are immutable. Retention is bounded, so it is not a permanent event ledger.
- Commitments have explicit `active`, `fulfilled`, and `broken` states. Resolution records an experience and succeeds once. Retained terminal records cannot be revived. The 24-entry limit evicts the oldest terminal record first; adding another obligation when all 24 are active throws `RangeError`.
- An intent starts in `planning`, `acting`, or `waiting`. Beginning with the same active ID updates that intent; beginning another ID records why the previous intent was interrupted. Completion and interruption preserve the terminal intent and append an experience. Interrupting a plan does not automatically break a commitment.
- `REACTION_OPTIONS` couples affect with a compatible nonverbal expression. `applyAffect` changes this pair without adding fictional experiences. Descriptions are model-facing English; emotion and expression text are Chinese UI labels.
- `mindSchema` validates persistence with strict nested objects, bounded fields, unique retained IDs, valid lifecycle times, and coherent affect/expression. `profileSchema` validates an independent persona.

Decision context includes the profile, current affect and expression, retained experiences and commitments, projected knowledge, current intent, revision, the supplied situation, and the available reaction options. It performs no external knowledge lookup. Environments remain responsible for deciding which observations a character can access and for checking that selected actions are legal.

## Knowledge ledger (v0.6)

Each mind stores a bounded `KnowledgeClaim[]` in `knowledge`. Claims have an immutable retained `id`, a proposition `topic`, a textual `value`, `learnedAt`, authored `confidence` in [0, 1], and a source: `background`, `observed`, `experienced`, `legacy`, or `heard` with `from`. Optional `validUntil` expires a claim. Confidence does not decide truth or resolve disagreements; it is supplied evidence metadata, not a calibrated model probability.

```ts
import { learnKnowledge, inspectBelief, buildDecisionContext } from './api';

learnKnowledge(mind, {
  id: 'cabinet-check-12', topic: 'cabinet-supply', value: 'empty', learnedAt: 12,
  source: { kind: 'observed' }, confidence: 1, validUntil: 17,
});
learnKnowledge(mind, {
  id: 'peer-report-13', topic: 'cabinet-supply', value: 'stocked', learnedAt: 13,
  source: { kind: 'heard', from: 'peer' }, confidence: 0.7, validUntil: 17,
});
inspectBelief(mind, 'cabinet-supply', 13).status; // 'conflicted'
const frame = buildDecisionContext(mind, { visible: ['closed cabinet'] }, 13);
```

`inspectBelief(mind, topic, now)` and `inspectKnowledge(mind, now)` return detached views: `known` means current evidence agrees, `conflicted` means it contains differing values, `outdated` means only expired or retired history remains, and `unknown` means no visible evidence. Future-learned evidence is excluded. Evidence keeps its source and a `current`, `expired`, or `retired` label. A known belief may still be wrong about the world. Values are compared exactly; hosts must normalize equivalent facts and use separate topics for independent propositions.

`buildDecisionContext(mind, situation, now)` requires explicit game time when knowledge is nonempty. Its `knowledge` field contains these classified views, not the raw storage array; use `mindSchema` for persisted minds, not model contexts. All timestamps use the host's consistent game clock. Querying an earlier clock projects only retained evidence; this is not full historical replay.

New evidence does not silently overwrite prior evidence. A host can pass same-topic IDs as the third argument to `learnKnowledge` when a check explicitly supersedes them. This writes `retiredAt` on those records at the new claim's time. Invalid updates are atomic; retained duplicate IDs are ignored, including their retirement directives. At 64 claims, retention evicts the oldest expired/retired record first, otherwise the oldest learned record. Evicted knowledge is forgotten; use an external event log for archival needs.

Adapters own visibility, propagation, freshness and explicit retirement. Updating world truth does not broadcast knowledge. The cabin keeps observations and heard reports together, preserves reported expiry, and allows rechecking unknown, conflicted or outdated inventory. `advanceTime()` advances its clock and invalidates captured turns. Fog Harbor seeds public places and own experiences, records nearby disclosures as heard from the player, and supplies classified beliefs without duplicate unqualified legacy facts. Fog captures expire on the next knowledge activation, expiry or retirement boundary, or a mind revision change. Existing town mechanics still use legacy `knownFacts` flags for authored action gates, but those flags cannot repopulate model context after evidence is forgotten; the compatibility `self.knownFacts` slot is empty.

Old `CharacterMind` payloads missing `knowledge` parse with an empty ledger. Fog Harbor alone backfills its old fact flags when that field was absent, using `legacy` and the migration game time: the original learning source/time are unknown. A present empty ledger is preserved; a present invalid ledger is rejected. Save format remains v2. Historical episodic memory text is retained separately and is not automatically rewritten into current belief.

## Motivation observations and baseline

`motivation.ts` supplies environment-neutral `Drive` and `ActionForecast` types. A drive's pressure is 0 (satisfied) to 100 (most pressing); positive forecast effects relieve pressure and negative ones worsen it. Forecasts carry expected duration, effort and notes. They are estimates of authored mechanics, not a model's explanation or guaranteed final state.

`rankActions(drives, forecasts)` returns detached `{id, score}` entries, highest score first with stable ID ties. Positive benefit is capped to remaining need. Negative effects are capped to remaining pressure headroom and weighted more heavily when a need is already pressing. Duration and effort are costs. Invalid/duplicate IDs, non-finite values and effects on unknown drives throw `RangeError`.

This transparent baseline serves rules mode and controlled comparisons. The Jev adapter receives unranked candidates, own pressures and forecasts; utility scores are not sent as a preferred answer. Personality and commitments remain in the character context. This baseline does not model the full value of friendship, obligations or long-term plans.

## Portable runtime API (v0.5)

### Player interaction choices (v0.7)

`InteractionChoice`, `interactionChoiceSchema`, `interactionChoicesSchema` and `selectInteractionChoice` are exported from `api.ts`. The contract contains `id`, `intent`, player-facing `label` and `description`, optional `subject: {id, label}`, and a bounded `parameters` record of strings, finite numbers or booleans. A choice set has at most 64 unique IDs. `selectInteractionChoice(choices, id)` validates the full set and returns a detached match or `undefined`.

```ts
import { selectInteractionChoice, type InteractionChoice } from './api';
const offered: InteractionChoice[] = [{
  id: 'offer:apple', intent: 'give', label: 'Would you like this apple?',
  description: 'Transfer one apple only if accepted.',
  subject: { id: 'apple', label: 'this apple' }, parameters: { quantity: 1 },
}];
const selected = selectInteractionChoice(offered, 'offer:apple');
```

This is a data contract, not a universal dialogue planner. The host creates options from the player's accessible information, captures the selected subject/terms, exposes that proposal to the NPC's decision context, and checks current eligibility again before execution. Never derive a player question from private NPC knowledge the player has not learned. NPC acceptance is separate from the player's ability to propose something.

Fog Harbor implements this in `src/sim/interactions.ts`: `getPlayerInteractions` supplies the UI; `playerInteract` resolves current choices before mutation; the pending action identifies the exact gift, task or incident. Rules and the runtime adapter reject outdated captures, and the controller releases stale conversations for a new selection. Existing save payloads without a captured action cancel their pending conversation rather than guessing an item or implied promise. Town-specific tasks, terms, consequences and disclosure policies remain outside the core.

Import from `src/character/api.ts` for the complete source-level API (mind, knowledge, dialogue, motivation, runtime). A local `@jev-character/core@0.1.0-alpha.5` tarball now packages this same API as native ESM with declarations; see the [package quickstart](../../packages/core/README.md). There is no publicly published npm package yet. In an installed consumer, import the package name instead of repository source paths.

```ts
import { CharacterRuntime, type CharacterEnvironment, type DecisionProvider } from './src/character/api';

// Implement these two ports in your host. Neither is a world object.
declare const environment: CharacterEnvironment;
declare const provider: DecisionProvider;
const runtime = new CharacterRuntime(environment, provider, { maxConcurrent: 2 });
const result = await runtime.step('your-character-id');
if (result.status === 'applied') console.log(result.execution.changes);
runtime.cancel(); // settles active turns even if a provider ignores AbortSignal
```

A complete working second environment is `examples/cabin.ts`; `npm run lab:characters` runs it with an explicitly authored deterministic provider. `npm run lab:characters -- --jev` makes five real requests using the Node-only provider and server-side environment key. It never silently falls back. Neither example nor the core imports Fog Harbor, Phaser, UI code, or server credentials.

### Environment responsibilities

Implement `openTurn(characterId)` returning null for an unavailable character, or a `CharacterTurn`:

- `input`: character ID, nonnegative safe integer revision, a context containing only information this character may know, and candidate IDs/labels/descriptions. Use `buildDecisionContext(mind, situation, gameTime)` to include the common persona, affect, memories, knowledge and commitments. Your situation can contain public background, self state and local observations; these fields are game-authored, not inferred or fetched by the runtime.
- `isCurrent()`: validate environment identity, relevant revisions, interaction eligibility and pause conditions. World replacement or a material observation change must invalidate an old turn. Do not use the character mind's revision alone when game state can change independently.
- `execute(decision, source)`: synchronously check actual conditions and atomically commit effects and observed feedback exactly once. Return `applied` when a valid attempt executed, including a failed attempt that teaches the character something; return `rejected` when it must not execute, without committing effects. Never throw after committing effects. Long actions should commit their start here; the game's simulation later advances and resolves them, updating mind/intent and relevant revisions.

The runtime never receives a global world reference. It protects the offered candidate snapshot from provider mutation, validates choices and affect/metadata, caps concurrent turns, suppresses stale results/errors, and isolates replacement requests from cancelled request cleanup. It does not prove that adapter-supplied observations respect privacy: information visibility is an adapter obligation, tested with counterfactual fixtures.

Public background knowledge is not an omniscient live event feed. In the cabin, uninformed Ada receives identical initial frames whether the pantry is stocked or empty; only an attempted action or a peer report updates her belief. Bram's private goal is absent from her frame. A perceived-feasible action may fail against world truth; pre-filtering using hidden truth would leak information even without explicitly sending the truth.

### Provider responsibilities

Implement `source` and async `decide(frame, signal)`. Return a candidate ID, one of the existing five affect IDs, and optional confidence, latency, model and cost. The runtime validates the result. Providers own transport timeouts; the runtime handles explicit cancellation and makes no automatic retry or model-to-rules substitution. The host decides retry budgets, decision frequency and which characters need a turn.

The generic runtime supports 0–256 candidates (zero skips; one may be handled by a supporting provider). `LocalJevProvider` bridges the current server protocol (`npcId`/`state`) and explicitly requires 2–40 candidates and IDs up to 40 characters; its HTTP timeout is 15 seconds. Node lab calls the existing server-side provider, whose upstream timeout is 12 seconds. The source API uses `characterId`/`context` regardless of wire names.

### Fog Harbor adapter and current limits

`src/adapters/fog-harbor/environment.ts` captures game perception and stages legacy rule execution against a detached bounded world before committing. It preserves resident identity so unaffected concurrent turns remain usable, while changed resident revisions invalidate affected turns. `controller.ts` in that directory owns town-specific delivery/interaction eligibility, scheduling, retry UI and the explicit rules baseline. The old `src/controller.ts` is only a compatibility re-export.

Existing needs, resource effects, visibility rules and relationship formulas remain game adapters' responsibilities. The cabin uses the same mind storage, knowledge ledger, context builder, affect/memory functions and runtime as Fog Harbor, but has its own needs and world rules. This release does not yet standardize a full belief graph, multidimensional relationships, cross-game action libraries or configurable affect vocabularies. The five-turn lab proves integration and shows a trajectory; it is not a character-quality benchmark. The three-day survival script remains a deterministic game-rules check, not a real Jev run.

### Rule-composed responses (alpha.2)

`compileResponses(plans, facts, now)` is a pure speech compiler. A `ResponsePlan`
has an ID, semantic intent and ordered `parts`: `{literal: 'authored phrasing'}`
or `{fact: 'approved-fact-id'}`. Each `SpeechFact` includes bounded text, a
provenance `basis`, `disclosable`, `validFrom` and optional exclusive `validUntil`.
It returns detached `RealizedResponse` values containing exact text and the used
evidence IDs/bases. Unknown, private, future or expired references omit the whole
plan. Duplicate IDs and malformed or oversized input throw instead of guessing.
Limits: 40 plans, 128 facts, 12 parts per plan, 1600 characters per response.

The host translates its own current, unambiguous beliefs and authorized self
state into speech facts and authors coherent plans. Conflicted/expired knowledge
must not be presented as a current fact. Literal text is trusted author content:
this compiler cannot prove the truth of a paraphrase or prevent an author from
putting secrets in literals. Render output as plain text, not HTML.

Offer compiled plans as ordinary `DecisionFrame.options` with semantic intent,
exact speech and relevant provenance. Jev chooses one plan ID in the same call
as other actions; it does not emit the words. Recompile and recheck eligibility
at execution, with the runtime's host revision guard preventing stale choices.
Keep physical effects in the host executor; a line about hunger does not eat a
meal. Do not claim an action succeeded until the executor confirms it.

Fog Harbor's `ordinaryResponses` demonstrates this for greet/ask. Mei can share
values, current needs, or a known tea-house topic plus her current needs. Her
owned `place:tavern` belief must be current and unambiguous for the place plan.
Private disclosures still use the explicit `confide` action. Work, promises,
deliveries and other transactional speech still use their existing executors;
this first slice does not implement arbitrary user text or multi-turn topic trees.

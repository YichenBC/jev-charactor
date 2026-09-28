# @jev-character/core

Source-available alpha `0.1.0-alpha.5`: portable character state, evidence-backed knowledge,
motivation, interaction validation and turn orchestration. Compiled native ESM
JavaScript and TypeScript declarations are included; the only runtime dependency
is Zod. No game, renderer, server, model weights or Jev provider is bundled.

Alpha.4 adds `PersonalState`: bounded event feelings, preferences and goals with
completed-event receipts. These are state/projection interfaces, not a bundled
psychological theory or autonomous planner.

## Build and install locally

From the development repository, with its dependencies installed:

```sh
npm run pack:core
```

This creates `artifacts/core/jev-character-core-0.1.0-alpha.5.tgz`. In a separate
application directory, replace `/absolute/path/to/jev-neighborhood` with the
repository location:

```sh
npm init -y
npm install /absolute/path/to/jev-neighborhood/artifacts/core/jev-character-core-0.1.0-alpha.5.tgz
```

Installation may fetch Zod from the npm registry. The SDK itself makes no network
calls and reads no environment variables or credentials.

## Run a complete example

Save the following as `example.mjs`, then run `node example.mjs`. It prints
`known`, followed by `applied 1`. No key, server, bundler or TypeScript loader is
needed. Use a modern Node.js release with native ESM, `structuredClone` and
`AbortController`; the release verification records the exact tested version.

```js
import {
  CharacterRuntime, createMind, learnKnowledge, inspectBelief,
} from '@jev-character/core';

const mind = createMind({
  role: 'Archivist', traits: ['careful'], values: ['truth'], speakingStyle: 'Plain.',
});
learnKnowledge(mind, {
  id: 'seen', topic: 'cabinet', value: 'empty', learnedAt: 0,
  source: { kind: 'observed' }, confidence: 1,
});
console.log(inspectBelief(mind, 'cabinet', 0).status);

let energy = 0;
let revision = 0;
const environment = {
  openTurn(characterId) {
    if (characterId !== 'ada' || energy > 0) return null;
    const openedAt = revision;
    return {
      input: {
        characterId, revision: openedAt,
        context: { energy },
        options: [{ id: 'rest', label: 'Rest', description: 'Recover energy.' }],
      },
      isCurrent: () => revision === openedAt,
      execute(decision) {
        if (revision !== openedAt || decision.choice !== 'rest') {
          return { status: 'rejected', detail: 'Turn is no longer eligible.', changes: [] };
        }
        energy += 1;
        revision += 1;
        return { status: 'applied', detail: 'Recovered energy.', changes: ['energy'] };
      },
    };
  },
};
const provider = {
  source: 'deterministic-example',
  async decide() { return { choice: 'rest', affect: 'focused' }; },
};
const runtime = new CharacterRuntime(environment, provider);
const result = await runtime.step('ada');
console.log(result.status, energy);
```

This deterministic provider demonstrates integration, not model ability. Supply
your own `DecisionProvider` to connect a model; there is no bundled Jev transport,
default model policy or automatic fallback.

## Host and provider responsibilities

- The host owns simulation time, scheduling, persistence, world state and allowed
  actions. Feed observations into the mind explicitly. A `known` belief means
  consistent retained evidence, not guaranteed objective truth.
- `openTurn` supplies only information the character may know. `isCurrent` must
  account for world identity, relevant revisions, eligibility and pauses.
  `execute` must be synchronous and atomic: rejection has no successful effects,
  and it must never throw after committing. An `applied` result means the attempt
  executed, not that the character achieved its goal.
- The provider chooses among offered options, owns transport and timeout policy,
  and should honor the supplied `AbortSignal`. `runtime.cancel()` prevents a late
  decision from executing through that runtime; it cannot undo effects a provider
  performs itself or stop a remote service that ignores cancellation.
- Runtime orchestration does not automatically mutate a character mind. The host
  applies the resulting state changes and records knowledge or experiences.

TypeScript consumers can import `CharacterEnvironment`, `DecisionProvider`,
`CharacterDecision` and `TurnResult` from the package root. The package exposes
only that root entry; internal module paths are not supported public imports.

For the existing API and architecture notes, see the
[source documentation](https://github.com/YichenBC/jev-charactor/blob/main/src/character/README.md).

## Alpha scope and verification

`npm run test:core-package` in the development repository builds and packs the
library, checks the archive contents, installs it in an OS temporary application,
runs this exact example with plain Node, exercises real state changes and late
cancellation, and checks a strict NodeNext TypeScript consumer. It removes that
temporary application afterward.

This alpha validates native Node ESM and NodeNext types. CommonJS and browser
bundling are not verified. API stability, durable storage, cross-process
coordination and production model integrations are outside this alpha release.

The package remains `private: true` and `UNLICENSED` because the project license
is undecided. Public source availability and local packaging do not constitute
a public npm release or an open-source license grant.

## Compose speech without generating tokens

Alpha.2 adds `compileResponses`, `SpeechFact`, `ResponsePlan` and
`RealizedResponse`. For example:

```ts
import { compileResponses } from '@jev-character/core';
const replies = compileResponses([
  { id: 'report', intent: 'report-own-state', parts: [
    { literal: 'Thanks for asking. ' }, { fact: 'energy' },
  ] },
], [
  { id: 'energy', text: 'I am tired.', basis: 'self:energy<40',
    disclosable: true, validFrom: 12 },
], 12);
// replies[0].text === 'Thanks for asking. I am tired.'
```

The host authors coherent plans and approved evidence. The compiler excludes
plans with private, missing or out-of-date facts, and returns evidence alongside
text. It cannot fact-check authored wording. Send compiled alternatives to your
provider as choice options; validate the selected ID and current host revision
before rendering the selected text. No API request or world mutation is performed
by this function. Speech alone never performs the action it mentions.

## Track spoken turns and open topics (alpha.5)

`CharacterMind.dialogue` stores up to 24 actual spoken turns. `recordDialogue`
records the counterparty, topic, text, simulation timestamp and optional host
subject/followup, then increments the mind revision. Its boolean return indicates
whether a host-authorized social reward is eligible; it does not grant rewards.
Turns now distinguish `speaker: 'self' | 'other'` (default `self`), optional
`inReplyTo` sequence and `depth` (default 0). Other-speaker turns never receive a
social reward or count as the character repeating itself. Referenced retained
turns must belong to the same counterparty; forward references are rejected.
Old turns default to `self`, without fabricating the other speaker's history.
`recordDialogueExchange(mind, question, response, rewardEligible)` validates and
commits both voices atomically, linking the self response to the other-speaker
question. Hosts must preflight failures before committing their own world effects;
this transaction only owns dialogue state. Depth is bounded at 16; saturated
topics cannot open another followup.

`openDialogueTopics(mind, counterparty, now)` returns detached copies of up to
four recent, unresolved self-spoken topics, newest first. Topic and subject
together identify a thread. A later self turn supersedes earlier turns on that
thread; an `inReplyTo` reference consumes the referenced followup. Topics expire
after 120 host time units. This is a bounded view of retained history, not
unlimited conversation memory. Hosts must revalidate knowledge and permission.
Fog Harbor records both sides when a reply completes; an unanswered question
remains in the host's pending action and experience log.
`recentlySaid` checks exact retained text, and `canRewardDialogue` enforces a
character-wide 120-time-unit cooldown even if older turns have been evicted.
Fog Harbor supplies seconds; hosts must use a consistent monotonic time unit.

The host owns topic semantics, disclosure rules, reward amounts and followup
execution. This ledger does not generate player options, speech or NPC events.
Legacy minds parsed through `mindSchema` get an empty dialogue ledger; no history
is invented. The host must validate timestamps against its own world clock.

## Personal goals and event feelings (alpha.4)

`addGoal(mind, { id, label, activity, target, createdAt })` adds an authored goal.
`advanceGoal(mind, id, { id: eventId, at })` accepts a unique completed-event
receipt. Duplicate receipts and already completed goals return false; invalid
chronology throws before mutation. Up to eight goals are retained, each with up
to 32 receipts; active goals are never silently evicted to make room.

`addFeeling(mind, { id, label, basis, valence, strength, since, until })` records a
host-authored appraisal. Valence is -1 through 1; strength is 0 through 1. The
latest twelve by onset time are retained. Duplicate retained IDs return false;
deduplication is bounded, so the host must not replay evicted historical events.
`inspectPersonal(mind, now)` returns time-qualified feelings with linearly fading
influence and goals with progress. It neither changes the model's affect nor
chooses actions. Preferences are host-defined activity labels and weights.

`buildDecisionContext` projects personal state rather than exposing raw future or
expired entries. Supply a clock when knowledge, feelings or goals exist. The
host owns disclosure, simulation-time units, persistence validation, goal
semantics, event identity and any action effects; a receipt must represent real
completion. Fog Harbor's hobbies, job types, personality weights, expiry windows
and goal content are examples in its adapter, never imported by the SDK.

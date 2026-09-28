import { applyAffect, buildDecisionContext, createMind, inspectBelief, learnKnowledge, REACTION_OPTIONS, rememberExperience } from '../src/character';
import type { CharacterMind, Experience } from '../src/character';
import type {
  CharacterDecision, CharacterEnvironment, CharacterTurn, ChoiceOption,
  DecisionFrame, DecisionProvider, ExecutionResult,
} from '../src/character/runtime';

type CabinId = 'ada' | 'bram';
type PantryBelief = 'unknown' | 'empty' | 'stocked' | 'conflicted' | 'outdated';
const PANTRY_EVIDENCE_TTL = 5;
type CabinPerson = {
  id: CabinId; name: string; mind: CharacterMind; privateGoal: string;
  state: { energy: number; hunger: number; workCompleted: number };
  personalFact: string;
};

const PUBLIC_KNOWLEDGE = {
  setting: 'Two researchers share a remote cabin during a storm. The next supply boat arrives tomorrow.',
  people: ['Ada, a botanist', 'Bram, a weather researcher'],
  facilities: ['bunks', 'work desk', 'shared pantry'],
};
const ACTIONS: readonly ChoiceOption[] = [
  { id: 'sleep', label: 'Rest in a bunk', description: 'Rest one turn: recover 5 energy (maximum 10), gain 1 hunger (maximum 10).' },
  { id: 'work', label: 'Work on research', description: 'Spend 2 energy and gain 1 hunger to complete one unit of your own research. Requires at least 2 energy.' },
  { id: 'collect-food', label: 'Check the pantry for food', description: 'Spend 1 energy checking the pantry. If a ration is present, consume it and reduce hunger by 5; otherwise learn the pantry is empty and remain hungry.' },
  { id: 'ask-peer', label: 'Ask your colleague about supplies', description: 'Ask the other researcher what they know about the pantry. They share only their supply knowledge, not private goals.' },
];

/** A small text environment; omniscient world facts never enter openTurn implicitly. */
export class CabinEnvironment implements CharacterEnvironment {
  #revision = 0;
  #time = 0;
  #pantryFood: number;
  #people: Record<CabinId, CabinPerson>;

  constructor({ pantryFood = 0 }: { pantryFood?: number } = {}) {
    if (!Number.isSafeInteger(pantryFood) || pantryFood < 0) throw new RangeError('Invalid pantry supply');
    this.#pantryFood = pantryFood;
    this.#people = {
      ada: {
        id: 'ada', name: 'Ada',
        mind: createMind({ role: 'Botanist', traits: ['curious', 'reserved'], values: ['careful evidence', 'independence'], speakingStyle: 'Brief, concrete questions.' }),
        privateGoal: 'Finish the orchid notebook before telling Bram about the fellowship application.',
        state: { energy: 7, hunger: 8, workCompleted: 0 },
        personalFact: 'My orchid specimens need cataloguing.',
      },
      bram: {
        id: 'bram', name: 'Bram',
        mind: createMind({ role: 'Weather researcher', traits: ['methodical', 'sociable'], values: ['reliability', 'rest'], speakingStyle: 'Plain explanations with observed facts.' }),
        privateGoal: 'Recheck the anomalous barometer reading before disclosing a possible calibration mistake.',
        state: { energy: 2, hunger: 4, workCompleted: 0 },
        personalFact: 'My barometer reading needs verification.',
      },
    };
    learnKnowledge(this.#people.bram.mind, {
      id: 'cabin:initial:bram:pantry', topic: 'pantry', value: pantryFood ? 'stocked' : 'empty',
      learnedAt: this.#time, source: { kind: 'observed' }, confidence: 1, validUntil: PANTRY_EVIDENCE_TTL,
    });
    applyAffect(this.#people.ada.mind, 'worried');
  }

  /** Omniscient diagnostics for tests/lab only. Never supply this snapshot to a provider. */
  inspect() {
    const project = (person: CabinPerson) => ({ ...person, knowledge: this.pantryProjection(person) });
    return structuredClone({ revision: this.#revision, time: this.#time, pantryFood: this.#pantryFood,
      people: { ada: project(this.#people.ada), bram: project(this.#people.bram) } });
  }

  /** Host clock: actions do not advance it implicitly. Expiry also invalidates captured turns. */
  advanceTime(ticks = 1): void {
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 100
      || !Number.isSafeInteger(this.#time + ticks + PANTRY_EVIDENCE_TTL)) throw new RangeError('Invalid time advance');
    this.#time += ticks;
    this.#revision++;
  }

  /** Compatibility diagnostics only; the mind ledger remains the sole pantry authority. */
  private pantryProjection(person: CabinPerson) {
    const belief = inspectBelief(person.mind, 'pantry', this.#time);
    const latest = belief.evidence.filter(item => item.status === 'current').at(-1);
    const pantry: PantryBelief = belief.status === 'known' ? belief.values[0] as 'empty' | 'stocked' : belief.status;
    const pantrySource = !latest ? belief.status === 'outdated' ? 'outdated evidence' : 'not checked'
      : latest.source.kind === 'heard' ? `heard from ${latest.source.from}` : 'observed while checking';
    return { pantry, pantrySource, personalFact: person.personalFact };
  }

  openTurn(characterId: string): CharacterTurn | null {
    if (characterId !== 'ada' && characterId !== 'bram') return null;
    const person = this.#people[characterId];
    const revision = this.#revision;
    const options = this.options(person);
    // Keep execution authority separate from the mutable, detached provider frame.
    const offered = new Set(options.map(option => option.id));
    let consumed = false;
    const isCurrent = () => !consumed && this.#revision === revision;
    const { mind, ...self } = person;
    return {
      input: structuredClone({
        characterId, revision,
        context: buildDecisionContext(mind, { time: this.#time, publicKnowledge: PUBLIC_KNOWLEDGE, self }, this.#time),
        options,
      }),
      isCurrent,
      execute: (decision, source) => {
        if (!isCurrent()) return this.rejected('Turn is stale or already consumed.');
        if (!offered.has(decision.choice) || !this.options(person).some(option => option.id === decision.choice)
          || !REACTION_OPTIONS.some(option => option.id === decision.affect)) {
          return this.rejected('Decision is not currently legal.');
        }
        // No awaits: validate, compute on a detached draft, and commit the whole action once.
        const draft = structuredClone(person);
        const outcome = this.apply(draft, decision, source);
        this.#people[characterId] = draft;
        this.#pantryFood = outcome.pantryFood;
        this.#revision++;
        consumed = true;
        return outcome.execution;
      },
    };
  }

  private options(person: CabinPerson): ChoiceOption[] {
    return ACTIONS.filter(option => {
      if (option.id === 'work') return person.state.energy >= 2;
      // Unknown actual supply must not leak into the offered candidates.
      if (option.id === 'collect-food') {
        const belief = inspectBelief(person.mind, 'pantry', this.#time);
        return !(belief.status === 'known' && belief.values[0] === 'empty') && person.state.energy >= 1;
      }
      return true;
    }).map(option => ({ ...option }));
  }

  private rejected(detail: string): ExecutionResult { return { status: 'rejected', detail, changes: [] }; }

  private apply(person: CabinPerson, decision: CharacterDecision, source: string) {
    let pantryFood = this.#pantryFood;
    let detail: string;
    let event: string = decision.choice;
    let memorySource: Experience['source'] = 'experienced';
    const changes: string[] = [];
    switch (decision.choice) {
      case 'sleep':
        person.state.energy = Math.min(10, person.state.energy + 5);
        person.state.hunger = Math.min(10, person.state.hunger + 1);
        detail = `${person.name} rested; energy is ${person.state.energy}, hunger is ${person.state.hunger}.`;
        changes.push('own energy recovered', 'own hunger increased');
        break;
      case 'work':
        person.state.energy -= 2;
        person.state.hunger = Math.min(10, person.state.hunger + 1);
        person.state.workCompleted++;
        detail = `${person.name} completed research unit ${person.state.workCompleted}.`;
        changes.push('own research advanced', 'own energy spent', 'own hunger increased');
        break;
      case 'collect-food':
        person.state.energy--;
        if (pantryFood > 0) {
          pantryFood--;
          person.state.hunger = Math.max(0, person.state.hunger - 5);
          event = 'collect-food.succeeded';
          detail = `${person.name} found and ate one ration.`;
          changes.push('one pantry ration consumed', 'own hunger reduced');
        } else {
          event = 'collect-food.failed';
          detail = `${person.name}'s collection attempt failed: the pantry is empty. Hunger is unchanged.`;
        }
        // A fresh direct check explicitly supersedes this person's older pantry evidence.
        learnKnowledge(person.mind, {
          id: `cabin:${this.#revision + 1}:${person.id}:pantry`, topic: 'pantry', value: pantryFood ? 'stocked' : 'empty',
          learnedAt: this.#time, source: { kind: 'observed' }, confidence: 1, validUntil: this.#time + PANTRY_EVIDENCE_TTL,
        }, person.mind.knowledge.filter(item => item.topic === 'pantry' && item.retiredAt === undefined).map(item => item.id));
        changes.push('own energy spent checking', 'own pantry knowledge updated');
        break;
      case 'ask-peer': {
        const peer = this.#people[person.id === 'ada' ? 'bram' : 'ada'];
        memorySource = 'heard';
        const belief = inspectBelief(peer.mind, 'pantry', this.#time);
        const evidence = belief.evidence.filter(item => item.status === 'current');
        if (!evidence.length) {
          detail = `${peer.name} says: I have no current pantry information (${belief.status}).`;
        } else {
          // A report is evidence from the speaker, never an overwrite or a refreshed expiry.
          for (const [index, claim] of evidence.entries()) {
            learnKnowledge(person.mind, {
              id: `cabin:${this.#revision + 1}:${person.id}:report:${index}`, topic: 'pantry', value: claim.value,
              learnedAt: this.#time, source: { kind: 'heard', from: peer.name }, confidence: claim.confidence,
              ...(claim.validUntil === undefined ? {} : { validUntil: claim.validUntil }),
            });
          }
          detail = `${peer.name} reports ${belief.status} pantry evidence: ${evidence.map(claim =>
            `${claim.value} learned at ${claim.learnedAt}, confidence ${claim.confidence}`).join('; ')}.`;
          changes.push('own pantry evidence appended from peer report');
        }
        break;
      }
      default: throw new Error('Unreachable cabin action');
    }
    applyAffect(person.mind, decision.affect);
    rememberExperience(person.mind, {
      id: `cabin:${this.#revision + 1}:${person.id}`, at: this.#time,
      event, detail, source: memorySource, salience: event.endsWith('.failed') ? 0.9 : 0.5,
    });
    changes.push('own experience recorded', `decision source: ${source}`);
    return { pantryFood, execution: { status: 'applied' as const, detail, changes } };
  }
}

/** Explicitly authored demo policy: repeatable integration evidence, not model quality evidence. */
export class DeterministicCabinProvider implements DecisionProvider {
  readonly source = 'deterministic-cabin-demo';

  async decide(input: DecisionFrame): Promise<CharacterDecision> {
    const { self } = input.context.situation as { self: Omit<CabinPerson, 'mind'> };
    const experiences = input.context.experiences as Experience[];
    const offered = new Set(input.options.map(option => option.id));
    let choice = 'sleep';
    if (self.state.energy <= 2) choice = 'sleep';
    else if (self.state.hunger >= 6 && offered.has('collect-food')) choice = 'collect-food';
    else if (experiences.at(-1)?.event === 'collect-food.failed') choice = 'ask-peer';
    else if (offered.has('work')) choice = 'work';
    if (!offered.has(choice)) throw new Error('Demo policy has no supported choice');
    return { choice, affect: choice === 'collect-food' ? 'worried' : 'focused' };
  }
}

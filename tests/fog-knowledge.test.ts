import { describe, expect, it } from 'vitest';
import { inspectBelief, learnKnowledge } from '../src/character/knowledge';
import { advance, applyDecision, chooseFallback, createWorld, getContext, getOptions, loadWorld, playerInteract, serializeWorld } from '../src/sim';
import { describeFact } from '../src/sim/data';
import type { Interaction, World } from '../src/sim';

function interact(world: World, npcId: string, interaction: Interaction) {
  const npc = world.npcs.find(person => person.id === npcId)!;
  world.player.x = npc.x; world.player.y = npc.y;
  if ((interaction==='help'||interaction==='promise')&&!world.flags[`chore_offered_${npcId}`]&&!world.flags[`helped_${npcId}`]) {
    playerInteract(world,npcId,'request'); expect(applyDecision(world,npcId,'request_help','test')).toBe(true);
  }
  playerInteract(world, npcId, interaction==='gift'?'gift:热茶':interaction);
  expect(npc.pendingInteraction).toBeDefined();
  expect(applyDecision(world, npcId, chooseFallback(world, npcId), 'test')).toBe(true);
}
function disclose(world: World) {
  interact(world, 'lin', 'greet'); interact(world, 'lin', 'gift'); interact(world, 'lin', 'ask');
  interact(world, 'lin', 'expose');
}

describe('Fog Harbor knowledge adapter', () => {
  it('seeds public background separately from each resident’s private experience', () => {
    const world = createWorld();
    for (const npc of world.npcs) expect(npc.mind.knowledge.some(claim => claim.source.kind === 'background')).toBe(true);
    for (const id of ['lin', 'mei']) {
      const belief = inspectBelief(world.npcs.find(npc => npc.id === id)!.mind, 'lin-debt', 0);
      expect(belief.status).toBe('known');
      expect(belief.evidence[0].source.kind).toBe('experienced');
    }
    for (const id of ['tang', 'lan', 'zhou']) expect(inspectBelief(world.npcs.find(npc => npc.id === id)!.mind, 'lin-debt', 0).status).toBe('unknown');
    interact(world, 'lin', 'greet'); interact(world, 'lin', 'gift'); interact(world, 'lin', 'ask');
    expect(inspectBelief(world.npcs.find(npc => npc.id === 'tang')!.mind, 'lin-debt', world.time).status).toBe('unknown');
  });

  it('records nearby public disclosure as heard from the player at game time, without distant propagation', () => {
    const world = createWorld(); advance(world, 5); disclose(world);
    const tang = world.npcs.find(npc => npc.id === 'tang')!;
    expect(inspectBelief(tang.mind, 'lin-debt', world.time)).toMatchObject({ status: 'known', evidence: [{ source: { kind: 'heard', from: 'player' }, learnedAt: 5 }] });
    expect(tang.knownFacts).toContain('lin-debt');
    expect(inspectBelief(world.npcs.find(npc => npc.id === 'zhou')!.mind, 'lin-debt', world.time).status).toBe('unknown');
    expect(loadWorld(serializeWorld(world))).toEqual(world);
  });

  it('keeps Tang ignorant when she was absent from the disclosure', () => {
    const world = createWorld(), tang = world.npcs.find(npc => npc.id === 'tang')!;
    tang.x = 120; tang.y = 120; disclose(world);
    expect(inspectBelief(tang.mind, 'lin-debt', world.time).status).toBe('unknown');
    expect(JSON.stringify(getContext(world, 'tang'))).not.toContain('货款');
  });

  it('migrates missing v0.5 ledgers once with legacy provenance and preserves present empty ledgers', () => {
    const world = createWorld(); advance(world, 5); disclose(world);
    const raw = JSON.parse(serializeWorld(world));
    for (const npc of raw.npcs) delete npc.mind.knowledge;
    const migrated = loadWorld(JSON.stringify(raw))!;
    expect(migrated).not.toBeNull();
    const tang = migrated.npcs.find(npc => npc.id === 'tang')!;
    expect(inspectBelief(tang.mind, 'lin-debt', migrated.time).status).toBe('known');
    expect(migrated.npcs.flatMap(npc => npc.mind.knowledge).every(claim => claim.source.kind === 'legacy' && claim.learnedAt === migrated.time)).toBe(true);
    expect(loadWorld(serializeWorld(migrated))).toEqual(migrated);
    raw.npcs[0].mind.knowledge = [];
    expect(loadWorld(JSON.stringify(raw))!.npcs[0].mind.knowledge).toEqual([]);
  });

  it('rejects present invalid ledgers instead of replacing them during migration', () => {
    for (const version of [1, 2]) for (const invalid of [null, {}, [{ id: 'bad' }]]) {
      const raw = JSON.parse(serializeWorld(createWorld())); raw.version = version; raw.npcs[0].mind.knowledge = invalid;
      expect(loadWorld(JSON.stringify(raw))).toBeNull();
    }
  });

  it('uses current ledger views rather than unqualified legacy facts or a stale private concern', () => {
    const world = createWorld(), lin = world.npcs[0];
    advance(world, 5);
    learnKnowledge(lin.mind, { id: 'debt-update', topic: 'lin-debt', value: '货款已经结清。', learnedAt: world.time, source: { kind: 'observed' }, confidence: 1 });
    const context = getContext(world, 'lin');
    expect(context.knowledge).toEqual(expect.arrayContaining([expect.objectContaining({ topic: 'lin-debt', status: 'conflicted' })]));
    expect(context).toHaveProperty('self.privateConcern', '');
    expect(context).toHaveProperty('self.knownFacts', []);
    expect(describeFact('lin-debt')).toContain('货款');
  });

  it('records completed help and kept promises only after the work finishes', () => {
    const world = createWorld(), lin = world.npcs[0];
    interact(world, 'lin', 'promise'); interact(world, 'lin', 'help');
    expect(inspectBelief(lin.mind, 'promise-kept', world.time).status).toBe('unknown');
    for (let tick = 0; tick < 12; tick++) advance(world, 1);
    expect(inspectBelief(lin.mind, 'promise-kept', world.time)).toMatchObject({ status: 'known', evidence: [{ source: { kind: 'experienced' }, learnedAt: 12 }] });
    expect(inspectBelief(lin.mind, 'player-helped-me', world.time).status).toBe('known');
  });

  it.each(['resolved', 'expired', 'conflicted'] as const)('does not smuggle old debt through saved identity or action descriptions when %s', (state) => {
    const world = createWorld();
    const mei = world.npcs.find(npc => npc.id === 'mei')!;
    mei.persona = 'Practical, warm tavern owner. Lin owes her money; she keeps this private and does not shame him.';
    mei.goal = 'Welcome customers and arrange repayment privately.';
    world.npcs[0].goal = 'Keep the shop running and quietly repay Mei.';
    const old = mei.mind.knowledge.find(claim => claim.topic === 'lin-debt')!;
    world.time = 5;
    if (state === 'expired') old.validUntil = 5;
    else learnKnowledge(mei.mind, { id: 'paid', topic: old.topic, value: '货款已经结清。', learnedAt: 5, source: { kind: 'observed' }, confidence: 1 }, state === 'resolved' ? [old.id] : []);
    const restored = loadWorld(serializeWorld(world))!;
    const context = getContext(restored, 'mei');
    expect(context).toHaveProperty('self.privateConcern', '');
    expect(context.knowledge).toEqual(expect.arrayContaining([expect.objectContaining({ topic: 'lin-debt', status: state === 'resolved' ? 'known' : state === 'expired' ? 'outdated' : 'conflicted' })]));
    const projection = JSON.stringify([context, getOptions(restored, 'mei'), getContext(restored, 'lin'), getOptions(restored, 'lin')]);
    expect(projection).not.toMatch(/Lin owes her money|arrange repayment privately|quietly repay Mei/);
  });

  it('does not resurrect forgotten evidence through compatibility flags or secret text', () => {
    const world = createWorld(), lin = world.npcs[0];
    const old = lin.mind.knowledge.find(claim => claim.topic === 'lin-debt')!;
    learnKnowledge(lin.mind, { id: 'paid', topic: old.topic, value: '货款已经结清。', learnedAt: 1, source: { kind: 'observed' }, confidence: 1 }, [old.id]);
    for (let i = 0; i < 65; i++) learnKnowledge(lin.mind, { id: `later-${i}`, topic: `later-${i}`, value: 'A later observation.', learnedAt: i + 2, source: { kind: 'observed' }, confidence: 1 });
    world.time = 70;
    expect(inspectBelief(lin.mind, old.topic, world.time).status).toBe('unknown');
    expect(lin.knownFacts).toContain('lin-debt');
    expect(getContext(world, 'lin')).toHaveProperty('self.privateConcern', '');
    expect(getContext(world, 'lin')).toHaveProperty('self.knownFacts', []);
  });
});

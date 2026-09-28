import { CHORES } from '../src/sim/work';
import { describe, expect, it } from 'vitest';
import { advance, applyDecision, BUILDINGS, chooseFallback, createWorld, describeFact, getContext, getOptions, isWalkable, loadWorld, movePlayer, playerInteract, performService, serializeWorld } from '../src/sim';
import type { Interaction, World } from '../src/sim';

function interact(world: World, npcId: string, interaction: Interaction, choice?: string) {
  const npc = world.npcs.find(n => n.id === npcId)!;
  world.player.x = npc.x; world.player.y = npc.y;
  if ((interaction==='help'||interaction==='promise')&&!world.flags[`chore_offered_${npcId}`]&&!world.flags[`helped_${npcId}`]) {
    playerInteract(world,npcId,'request'); expect(applyDecision(world,npcId,'request_help','test')).toBe(true);
  }
  playerInteract(world, npcId, interaction==='gift'?'gift:热茶':interaction);
  expect(npc.pendingInteraction).toBeDefined();
  expect(applyDecision(world, npcId, choice ?? chooseFallback(world, npcId), 'test', { revision: npc.revision })).toBe(true);
}

describe('bounded neighborhood simulation', () => {
  it('keeps private debt and letter knowledge out of unrelated observations', () => {
    const world = createWorld();
    const observation = JSON.stringify(getContext(world, 'tang'));
    expect(observation).not.toContain('lin-debt');
    expect(observation).not.toContain('debt');
    expect(observation).not.toContain('货款');
    expect(observation).not.toContain('lan-letter');
    expect(observation).not.toContain('world.flags');
    expect(getContext(world, 'lin')).toHaveProperty('self.privateConcern', world.npcs[0].secret);
    interact(world, 'lin', 'greet'); interact(world, 'lin', 'gift'); interact(world, 'lin', 'ask');
    expect(world.player.knowledge).toContain('lin-debt');
    expect(JSON.stringify(getContext(world, 'tang'))).not.toContain('lin-debt');
    expect(world.npcs.find(n => n.id === 'tang')!.knownFacts).not.toContain('lin-debt');
  });

  it('rejects stale revisions, unknown choices and conditional choices', () => {
    const world = createWorld(), lin = world.npcs[0];
    const before = serializeWorld(world);
    expect(applyDecision(world, 'lin', 'confide', 'test')).toBe(false);
    expect(applyDecision(world, 'lin', 'invented', 'test')).toBe(false);
    expect(serializeWorld(world)).toBe(before);
    const revision = lin.revision;
    playerInteract(world, 'lin', 'greet');
    expect(applyDecision(world, 'lin', 'reply', 'test', { revision })).toBe(false);
    expect(applyDecision(world, 'lin', 'reply', 'test', { revision: lin.revision })).toBe(true);
    expect(lin.cooldown).toBeGreaterThan(0);
  });

  it('rejects distant interactions and unknown secrets without changing state', () => {
    const world = createWorld(), before = serializeWorld(world);
    expect(playerInteract(world, 'zhou', 'gift')).toContain('走近');
    expect(playerInteract(world, 'lin', 'expose')).toContain('不知道');
    expect(serializeWorld(world)).toBe(before);
  });

  it('cancels delayed social effects when the player leaves before the reply', () => {
    for (const interaction of ['gift:热茶', 'request', 'greet'] as const) {
      const world = createWorld(), lin = world.npcs[0];
      playerInteract(world, 'lin', interaction);
      const revision = lin.revision, choice = chooseFallback(world, 'lin');
      const inventory = [...world.player.inventory], trust = lin.trust;
      movePlayer(world, -400, 0);
      expect(applyDecision(world, 'lin', choice, 'jev', { revision })).toBe(false);
      expect(lin.pendingInteraction).toBeUndefined();
      expect(lin.cooldown).toBe(3);
      expect(lin.trust).toBe(trust);
      expect(world.player.inventory).toEqual(inventory);
      expect(world.flags).toEqual({});
      expect(world.decisions).toHaveLength(0);
    }
  });

  it('shares a learned secret only with nearby witnesses, including Tang’s personal reaction', () => {
    const world = createWorld(), tang = world.npcs.find(n => n.id === 'tang')!, zhou = world.npcs.find(n => n.id === 'zhou')!;
    interact(world, 'lin', 'greet'); interact(world, 'lin', 'gift'); interact(world, 'lin', 'ask');
    expect(tang.knownFacts).not.toContain('lin-debt');
    expect(JSON.stringify(getContext(world, 'tang'))).not.toContain('货款');
    const revision = tang.revision;
    interact(world, 'lin', 'expose');
    expect(tang.knownFacts).toContain('lin-debt');
    expect(tang.knownFacts).toContain('heard-public:lin-debt');
    expect(tang.revision).toBeGreaterThan(revision);
    expect(tang.trust).toBe(-2);
    expect(tang.bubble).toContain('哥哥');
    expect(tang.memories.some(m => m.kind === 'overheard' && m.text.includes('货款'))).toBe(true);
    expect(world.npcs[0].knownFacts).toContain('tang-knows-debt');
    expect(world.npcs[0].memories.some(m => m.kind === 'witness' && m.text.includes('阿棠'))).toBe(true);
    expect(world.npcs[0].persona).not.toContain('does not know');
    expect(JSON.stringify(getContext(world, 'tang'))).toContain(describeFact('lin-debt'));
    expect(zhou.knownFacts).not.toContain('lin-debt');
    expect(JSON.stringify(getContext(world, 'zhou'))).not.toContain('货款');
    expect(loadWorld(serializeWorld(world))).toEqual(world);
    const witnessTrust = tang.trust;
    interact(world, 'lin', 'expose', 'refuse');
    expect(tang.trust).toBe(witnessTrust);
  });

  it('does not assume Tang heard a disclosure when she was away', () => {
    const world = createWorld(), tang = world.npcs.find(n => n.id === 'tang')!;
    tang.x = 120; tang.y = 120;
    interact(world, 'lin', 'greet'); interact(world, 'lin', 'gift'); interact(world, 'lin', 'ask'); interact(world, 'lin', 'expose');
    expect(world.npcs[0].knownFacts).not.toContain('tang-knows-debt');
    expect(world.npcs[0].memories.some(m => m.kind === 'witness' && m.text.includes('阿棠'))).toBe(false);
    expect(tang.knownFacts).not.toContain('lin-debt');
  });

  it('varies greetings and requests by character, history and relationship', () => {
    const world = createWorld();
    const greetings = world.npcs.map(npc => { interact(world, npc.id, 'greet'); return npc.bubble; });
    expect(new Set(greetings).size).toBe(5);
    const requests = world.npcs.map(npc => { interact(world, npc.id, 'ask', 'request_help'); return npc.bubble; });
    expect(new Set(requests).size).toBe(5);
    const lin = world.npcs[0];
    interact(world, 'lin', 'greet'); expect(lin.bubble).not.toBe(greetings[0]);
    lin.trust = -3;
    interact(world, 'lin', 'greet'); expect(lin.bubble).toContain('今天先不聊');
  });

  it('offers following only while the friendly player is visible', () => {
    const world = createWorld(), lin = world.npcs[0];
    lin.trust = 3; world.player.x = lin.x - 200;
    expect(getOptions(world, 'lin').some(o => o.id === 'follow')).toBe(true);
    world.player.x = 120;
    expect(getContext(world, 'lin')).toHaveProperty('situation.publicObservation.player', 'out of sight');
    expect(getOptions(world, 'lin').some(o => o.id === 'follow')).toBe(false);
    expect(applyDecision(world, 'lin', 'follow', 'test')).toBe(false);
  });

  it('consumes gifts and prevents repeated help, greeting and reward farming', () => {
    const world = createWorld();
    interact(world, 'lin', 'gift');
    expect(world.player.inventory).toHaveLength(1);
    const trust = world.npcs[0].trust;
    const gifted=serializeWorld(world);
    playerInteract(world,'lin','gift:面包');
    expect(serializeWorld(world)).toBe(gifted);
    expect(world.player.inventory).toHaveLength(1);
    expect(world.npcs[0].trust).toBe(trust);
    interact(world, 'lin', 'greet'); interact(world, 'lin', 'greet');
    expect(world.npcs[0].trust).toBe(trust + 1);
    interact(world, 'lan', 'promise'); interact(world, 'lan', 'help');
    const lan = world.npcs.find(n => n.id === 'lan')!;
    const money = world.player.money;
    expect(world.player.activity?.kind).toBe('help');
    expect(lan.mind.commitments.find(c => c.id === 'help-player')?.status).toBe('active');
    for (let i = 0; i < 12; i++) advance(world, 1);
    expect(world.player.money).toBe(money + 8);
    expect(lan.mind.commitments.find(c => c.id === 'help-player')?.status).toBe('fulfilled');
    expect(lan.knownFacts).not.toContain('lan-letter-recovered');
    expect(lan.memories.some(m => m.text.includes('承诺'))).toBe(true);
    const completed=serializeWorld(world);
    playerInteract(world,'lan','help');
    expect(serializeWorld(world)).toBe(completed);
    expect(world.player.activity).toBeNull();
    expect(world.player.money).toBe(money + 8);
    world.player.inventory = [];
    expect(playerInteract(world, 'lan', 'gift')).toContain('没有');
  });

  it('collides continuously and routes NPCs around solid buildings', () => {
    const world = createWorld();
    world.player.x = 120; world.player.y = 312;
    movePlayer(world, 700, 0);
    expect(world.player.x).toBeLessThan(240);
    expect(isWalkable(world.player.x, world.player.y)).toBe(true);
    const lin = world.npcs[0]; lin.x = 168; lin.y = 312;
    expect(applyDecision(world, 'lin', 'visit:tavern', 'test')).toBe(true);
    expect(lin.path.length).toBeGreaterThan(10);
    for (let i = 0; i < 500; i++) { advance(world, 0.1); expect(isWalkable(lin.x, lin.y)).toBe(true); }
    expect(lin.path).toHaveLength(0);
    expect(lin.x).toBeCloseTo(BUILDINGS[1].door.x);
    expect(lin.y).toBeCloseTo(BUILDINGS[1].door.y);
  });

  it('work routes each resident to their actual workplace', () => {
    const world = createWorld();
    const expected: Record<string, string> = { lin: 'shop', tang: 'watch', mei: 'tavern', lan: 'post', zhou: 'watch' };
    for (const npc of world.npcs) {
      expect(applyDecision(world, npc.id, 'work', 'jev')).toBe(true);
      expect(npc.path.length).toBeGreaterThan(0);
      expect(npc.path.every(point => isWalkable(point.x, point.y))).toBe(true);
      expect(npc.destination).toBe(BUILDINGS.find(building => building.id === expected[npc.id])!.name);
    }
    for (let step = 0; step < 500; step++) advance(world, 0.1);
    for (const npc of world.npcs) {
      const workplace = BUILDINGS.find(building => building.id === expected[npc.id])!;
      expect(npc.x).toBeCloseTo(workplace.door.x);
      expect(npc.y).toBeCloseTo(workplace.door.y);
      expect(npc.activity).toContain(CHORES[npc.id]);
      const memories = npc.memories.length;
      applyDecision(world, npc.id, 'work', 'jev');
      advance(world, 1);
      expect(npc.path).toHaveLength(0);
      expect(npc.memories).toHaveLength(memories);
    }

  });

  it('roundtrips state and rejects malformed, huge and unknown saves', () => {
    const world = createWorld();
    interact(world, 'lin', 'gift'); applyDecision(world, 'lin', 'visit:shop', 'test'); advance(world, 1);
    expect(loadWorld(serializeWorld(world))).toEqual(world);
    expect(loadWorld('{bad')).toBeNull();
    for (const mutate of [
      (w: World) => { w.npcs[0].id = 'stranger'; },
      (w: World) => { w.npcs[0].x = -100; },
      (w: World) => { w.player.x = 300; w.player.y = 300; },
      (w: World) => { w.npcs[0].memories = Array(200).fill({ time: 0, text: '', kind: '' }); },
      (w: World) => { w.npcs[0].trust = Number.NaN; },
      (w: World) => { w.npcs[1] = w.npcs[0]; },
    ]) { const broken = createWorld(); mutate(broken); expect(loadWorld(serializeWorld(broken))).toBeNull(); }
    expect(loadWorld(' '.repeat(500_001))).toBeNull();
  });

  it('bounds event, memory and decision histories during repeated interactions', () => {
    const world = createWorld();
    for (let i = 0; i < 150; i++) interact(world, 'lin', 'greet');
    expect(world.events.length).toBeLessThanOrEqual(180);
    expect(world.decisions.length).toBeLessThanOrEqual(180);
    expect(world.npcs[0].memories.length).toBeLessThanOrEqual(32);
    expect(getOptions(world, 'unknown')).toEqual([]);
  });
  it('does not attribute an existing player activity to unrelated NPC decisions', () => {
    const world=createWorld(); performService(world,'rest');
    expect(world.player.activity?.kind).toBe('rest');
    expect(applyDecision(world,'lin','wait','test')).toBe(true);
    expect(world.decisions.at(-1)?.changes?.some(change=>change.startsWith('开始：'))).toBe(false);
  });

});

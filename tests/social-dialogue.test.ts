import { describe, expect, it } from 'vitest';
import { applyDecision, createWorld, getOptions, playerInteract, serializeWorld, loadWorld } from '../src/sim';
import type { World } from '../src/sim';
import { learnNpcFact } from '../src/sim/knowledge';

function reply(world: World, id: string, intent: string) {
  const npc = world.npcs.find(n => n.id === id)!;
  Object.assign(world.player, { x: npc.x, y: npc.y });
  playerInteract(world, id, intent);
  expect(npc.pendingInteraction).toBe(intent);
  const option = getOptions(world, id).find(o => o.id === 'reply')!;
  expect(applyDecision(world, id, 'reply', 'test')).toBe(true);
  return { text: npc.bubble!, option };
}

describe('ordinary replies respect the player speech act', () => {
  it.each(['lin', 'tang', 'mei', 'lan', 'zhou'])('%s distinguishes a daily check-in from inviting a topic', id => {
    const world = createWorld();
    reply(world, id, 'greet');
    const day = reply(world, id, 'greet');
    const topic = reply(world, id, 'ask');
    expect(day.text).not.toBe(topic.text);
    expect(day.option.label).not.toBe(topic.option.label);
    expect(day.option.description).toContain(day.text);
    expect(topic.option.description).toContain(topic.text);
    expect(world.player.knowledge).toEqual([]);
  });

  it('reports current hunger and tiredness without inventing recovery or rewards', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    reply(world, npc.id, 'greet');
    npc.needs.hunger = 20; npc.needs.energy = 80;
    const hungry = reply(world, npc.id, 'greet').text;
    expect(hungry).toContain('饿');
    expect(npc.needs.hunger).toBe(20);
    npc.needs.hunger = 80; npc.needs.energy = 20;
    const tired = reply(world, npc.id, 'greet').text;
    expect(tired).toContain('累');
    expect(tired).not.toBe(hungry);
    expect(npc.needs.energy).toBe(20);
    expect(world.player.money).toBe(20);
    expect(world.player.activity).toBeNull();
  });

  it('keeps guarded check-ins and topic boundaries distinct without revealing secrets', () => {
    const world = createWorld(), npc = world.npcs[0];
    reply(world, npc.id, 'greet');
    npc.trust = -2;
    const day = reply(world, npc.id, 'greet').text;
    const topic = reply(world, npc.id, 'ask').text;
    expect(topic).not.toBe(day);
    expect(topic).not.toContain(npc.secret);
    expect(npc.trust).toBe(-2);
    expect(world.player.knowledge).toEqual([]);
  });

  it('renders the offered reply even when first contact changes trust across zero', () => {
    const world = createWorld(), npc = world.npcs[0];
    npc.trust = -1;
    const result = reply(world, npc.id, 'greet');
    expect(result.option.description).toContain(result.text);
  });

  it('does not resurrect an expired family concern through offered speech', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'tang')!;
    learnNpcFact(npc, 'lin-debt', 0, { kind: 'heard', from: 'player' });
    expect(reply(world, npc.id, 'greet').text).not.toContain('哥哥的事');
    expect(reply(world, npc.id, 'ask').text).toContain('哥哥的事');
    npc.mind.knowledge.find(k => k.topic === 'lin-debt')!.validUntil = 1;
    world.time = 1;
    const result = reply(world, npc.id, 'ask');
    expect(result.text).not.toContain('哥哥的事');
    expect(result.option.description).not.toContain('哥哥的事');
  });
});

describe('composed semantic speech choices', () => {
  it('lets Mei select a known-place topic with current state, without performing an action', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    reply(world, npc.id, 'greet');
    npc.needs.hunger = 20; npc.needs.energy = 80;
    playerInteract(world, npc.id, 'ask');
    const options = getOptions(world, npc.id);
    expect(options.map(o => o.id)).toEqual(expect.arrayContaining(['reply', 'reply:state', 'reply:place']));
    const place = options.find(o => o.id === 'reply:place')!;
    expect(place.description).toContain('place:tavern');
    expect(applyDecision(world, npc.id, place.id, 'test')).toBe(true);
    expect(npc.bubble).toContain('晚风茶馆');
    expect(npc.bubble).toContain('饿');
    expect(npc.bubble).not.toContain('欠');
    expect(place.description).toContain(npc.bubble!);
    expect(npc.needs.hunger).toBe(20);
    expect(npc.job).toBeNull();
    expect(world.player.money).toBe(20);
    expect(world.player.knowledge).toEqual([]);
  });

  it('removes world-knowledge speech when the owned claim expires or conflicts', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    Object.assign(world.player, { x: npc.x, y: npc.y });
    playerInteract(world, npc.id, 'ask');
    const claim = npc.mind.knowledge.find(k => k.topic === 'place:tavern')!;
    expect(getOptions(world, npc.id).some(o => o.id === 'reply:place')).toBe(true);
    claim.validUntil = world.time + 1;
    world.time += 1;
    expect(applyDecision(world, npc.id, 'reply:place', 'test')).toBe(false);
    delete claim.validUntil;
    npc.mind.knowledge.push({ ...claim, id: 'conflicting-place', value: '旧茶馆已经拆了。' });
    expect(getOptions(world, npc.id).some(o => o.id === 'reply:place')).toBe(false);
    expect(getOptions(world, npc.id).some(o => o.id === 'reply')).toBe(true);
  });

  it('does not offer composed disclosures to someone the character distrusts', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    npc.trust = -2;
    Object.assign(world.player, { x: npc.x, y: npc.y });
    playerInteract(world, npc.id, 'ask');
    expect(getOptions(world, npc.id).some(o => o.id.startsWith('reply:'))).toBe(false);
  });
  it('accepts long persisted identity fields without exceeding the speech contract', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    npc.name = '名'.repeat(600); npc.role = '职'.repeat(500);
    const restored = loadWorld(serializeWorld(world))!;
    expect(restored).toBeTruthy();
    const result = reply(restored, npc.id, 'greet');
    expect(result.text.length).toBeLessThanOrEqual(1600);
    expect(result.option.description).toContain(result.text);
  });

});

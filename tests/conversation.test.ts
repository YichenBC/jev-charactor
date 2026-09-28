import { describe, expect, it } from 'vitest';
import { ConversationSession } from '../src/conversation';
import { activeOrder, advance, applyDecision, BUILDINGS, createWorld, distance, performService, playerInteract, serializeWorld } from '../src/sim';

describe('conversation session lifecycle', () => {
  it('opens a nearby resident at the interaction boundary without changing world state', () => {
    const world = createWorld(), session = new ConversationSession(), npc = world.npcs[0];
    world.player.x = npc.x - 110; world.player.y = npc.y;
    const before = serializeWorld(world);
    expect(session.npcId).toBeNull();
    expect(session.open(world, npc.id)).toBe(true);
    expect(session.npcId).toBe(npc.id);
    expect(serializeWorld(world)).toBe(before);
  });

  it.each(['missing', 'distant', 'busy', 'dead'] as const)('does not start a session or disturb an existing session for an invalid %s opening', condition => {
    const world = createWorld(), session = new ConversationSession(), npc = world.npcs[0];
    const invalidate = () => {
      if (condition === 'distant') world.player.x = npc.x - 111;
      if (condition === 'busy') world.player.activity = { kind: 'work', label: '工作', startedAt: 0, endsAt: 10, origin: { x: world.player.x, y: world.player.y } };
      if (condition === 'dead') world.survival.dead = true;
    };
    const id = condition === 'missing' ? 'missing' : npc.id;
    invalidate();
    const before = serializeWorld(world);
    expect(session.open(world, id)).toBe(false);
    expect(session.npcId).toBeNull();
    expect(serializeWorld(world)).toBe(before);
    world.player.x = npc.x; world.player.activity = null; world.survival.dead = false;
    expect(session.open(world, npc.id)).toBe(true);
    playerInteract(world, npc.id, 'greet');
    invalidate();
    const focused = serializeWorld(world);
    expect(session.open(world, id)).toBe(false);
    expect(session.npcId).toBe(npc.id);
    expect(serializeWorld(world)).toBe(focused);
  });

  it('leaves an existing pending reply untouched when reopening the same resident', () => {
    const world = createWorld(), session = new ConversationSession();
    session.open(world, 'lin');
    playerInteract(world, 'lin', 'greet');
    const before = serializeWorld(world);
    expect(session.open(world, 'lin')).toBe(true);
    expect(serializeWorld(world)).toBe(before);
  });

  it('ends the previous pending interaction when changing focus to another nearby resident', () => {
    const world = createWorld(), session = new ConversationSession(), [first, second] = world.npcs;
    Object.assign(second, { x: first.x, y: first.y });
    session.open(world, first.id);
    playerInteract(world, first.id, 'gift:热茶');
    const revision = first.revision;
    expect(session.open(world, second.id)).toBe(true);
    expect(session.npcId).toBe(second.id);
    expect(first.pendingInteraction).toBeUndefined();
    expect(first.revision).toBeGreaterThan(revision);
    expect(applyDecision(world, first.id, 'accept_gift', 'test', { revision })).toBe(false);
    expect(first.memories.at(-1)?.kind).toBe('interrupted');
    expect(first.mind.intent?.phase).toBe('interrupted');
  });

  it('invalidates a closed reply and restores the active delivery meeting until arrival', () => {
    const world = createWorld(), session = new ConversationSession(), npc = world.npcs[0];
    Object.assign(world.player, BUILDINGS.find(b => b.id === 'tavern')!.door);
    performService(world, 'accept:order-1');
    Object.assign(world.player, { x: npc.x, y: npc.y });
    session.open(world, npc.id);
    playerInteract(world, npc.id, 'greet');
    const revision = npc.revision;
    session.close(world);
    expect(session.npcId).toBeNull();
    expect(npc.pendingInteraction).toBeUndefined();
    expect(npc.revision).toBeGreaterThan(revision);
    expect(npc.path.length).toBeGreaterThan(0);
    expect(npc.mind.intent?.label).toContain('等玩家送餐');
    const closed = serializeWorld(world);
    expect(applyDecision(world, npc.id, 'reply', 'test', { revision })).toBe(false);
    session.close(world);
    expect(serializeWorld(world)).toBe(closed);
    for (let i = 0; i < 30; i++) advance(world, 1);
    expect(distance(npc, activeOrder(world)!.address)).toBeLessThan(3);
  });

  it.each(['defer:eat:tavern', 'accept_help'] as const)('preserves an already completed reply and its resulting %s action when closing', choice => {
    const world = createWorld(), session = new ConversationSession(), npc = world.npcs[0];
    npc.needs.hunger = 20;
    session.open(world, npc.id);
    if(choice==='accept_help') { playerInteract(world,npc.id,'request'); expect(applyDecision(world,npc.id,'request_help','test')).toBe(true); }
    playerInteract(world, npc.id, choice === 'accept_help' ? 'help' : 'greet');
    expect(applyDecision(world, npc.id, choice, 'test')).toBe(true);
    if (choice === 'accept_help') expect(world.player.activity?.kind).toBe('help');
    else expect(npc.job?.kind).toBe('eat');
    const completed = serializeWorld(world);
    session.close(world);
    expect(session.npcId).toBeNull();
    expect(serializeWorld(world)).toBe(completed);
  });
});

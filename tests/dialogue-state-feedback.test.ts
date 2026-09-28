import { describe, expect, it } from 'vitest';
import { advance, applyDecision, createWorld, playerInteract, type World } from '../src/sim';
import { notePersonalEvent } from '../src/sim/personalLife';

function speak(world: World, action: string, choice = 'reply') {
  const npc = world.npcs.find(n => n.id === 'mei')!;
  Object.assign(world.player, { x: npc.x, y: npc.y });
  playerInteract(world, npc.id, action);
  expect(applyDecision(world, npc.id, choice, 'test')).toBe(true);
  return npc.bubble!;
}

describe('greeting reflects experienced changes', () => {
  it('uses the latest event when paused conversations give several feelings the same time', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    speak(world, 'greet');
    notePersonalEvent(npc, 'exposure', 'old', world.time);
    notePersonalEvent(npc, 'apology', 'new', world.time);
    const response = speak(world, 'greet');
    expect(response).toContain('听到了道歉');
    expect(response).not.toContain('私事被公开');
  });
  it('mentions a received gift on the next greeting, without consuming or rewarding it twice', () => {
    const world = createWorld();
    speak(world, 'greet');
    speak(world, 'gift:热茶', 'accept_gift');
    const npc = world.npcs.find(n => n.id === 'mei')!;
    const before = { money: world.player.money, items: [...world.player.inventory], needs: { ...npc.needs } };
    expect(speak(world, 'greet')).toContain('心意');
    expect(world.player.money).toBe(before.money);
    expect(world.player.inventory).toEqual(before.items);
    expect(npc.needs).toEqual(before.needs);
    world.time = 121;
    expect(speak(world, 'greet')).not.toContain('收到你的一份心意');
  });

  it('reports completed work only after the real timed job finished', () => {
    const world = createWorld(), npc = world.npcs.find(n => n.id === 'mei')!;
    speak(world, 'greet');
    expect(applyDecision(world, npc.id, 'work', 'test')).toBe(true);
    expect(npc.mind.personal.feelings.some(f => f.basis === 'completed:work')).toBe(false);
    for (let i = 0; i < 180; i++) advance(world, .25);
    expect(npc.job).toBeNull();
    expect(npc.mind.personal.goals.some(g => g.activity === 'work' && g.receipts.length)).toBe(true);
    expect(speak(world, 'greet')).toContain('办完手头的事');
  });
});

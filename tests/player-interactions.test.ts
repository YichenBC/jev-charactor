import { describe, expect, it } from 'vitest';
import { advance, applyDecision, BUILDINGS, createWorld, getContext, getOptions, getPlayerInteractions, loadWorld, performService, playerInteract, serializeWorld } from '../src/sim';
import type { World } from '../src/sim';

function act(world: World, id: string, input: string, response: string) {
  const npc = world.npcs.find(n => n.id === id)!;
  world.player.x = npc.x; world.player.y = npc.y;
  playerInteract(world, id, input);
  expect(npc.pendingInteraction).toBeDefined();
  expect(applyDecision(world, id, response, 'test')).toBe(true);
}
const ids = (world: World, id = 'lin') => getPlayerInteractions(world, id).map(o => o.id);

describe('contextual player interactions', () => {
  it('offers an inquiry before concrete work and an explicitly timed promise', () => {
    const world = createWorld();
    expect(ids(world)).toContain('request');
    expect(ids(world)).not.toContain('help');
    expect(ids(world)).not.toContain('promise');
    act(world, 'lin', 'request', 'request_help');
    expect(world.npcs[0].bubble).toContain('货架');
    expect(world.npcs[0].bubble).toContain('8 元');
    expect(ids(world)).toEqual(expect.arrayContaining(['help','promise','decline']));
    expect(getPlayerInteractions(world,'lin').find(o=>o.id==='promise')!.label).toContain('90 秒');
    expect(world.npcs[0].mind.commitments).toHaveLength(0);
    act(world, 'lin', 'promise', 'accept_promise');
    expect(world.npcs[0].mind.commitments[0]).toMatchObject({ status:'active', dueAt:90 });
    expect(world.npcs[0].mind.commitments[0].description).toContain('货架');
    expect(ids(world)).not.toContain('decline');
    act(world, 'lin', 'help', 'accept_help');
    expect(world.player.activity?.label).toContain('货架');
    expect(world.player.money).toBe(20);
    for(let i=0;i<12;i++) advance(world,1);
    expect(world.player.money).toBe(28);
    expect(world.npcs[0].mind.commitments[0].status).toBe('fulfilled');
    expect(ids(world)).not.toContain('help');
    expect(ids(world)).toContain('request');
  });
  it('declining or NPC refusing makes no commitment or payment', () => {
    const world=createWorld();
    act(world,'lin','request','refuse');
    expect(ids(world)).not.toContain('promise');
    act(world,'lin','request','request_help');
    act(world,'lin','decline','reply');
    expect(ids(world)).not.toContain('help');
    expect(world.npcs[0].mind.commitments).toHaveLength(0);
    expect(world.player.money).toBe(20);
  });
  it('gifts exactly the selected carried item and does not replace a missing item', () => {
    const world=createWorld();
    expect(ids(world)).toEqual(expect.arrayContaining(['gift:热茶','gift:面包']));
    act(world,'lin','gift:面包','accept_gift');
    expect(world.player.inventory).toEqual(['热茶']);
    expect(world.npcs[0].bubble).toContain('面包');
    expect(ids(world).some(id=>id.startsWith('gift:'))).toBe(false);
    const second=createWorld();
    playerInteract(second,'lin','gift:面包');
    second.player.inventory=['热茶'];
    const before=serializeWorld(second);
    expect(applyDecision(second,'lin','accept_gift','test')).toBe(false);
    expect(serializeWorld(second)).toBe(before);
  });
  it('rejects forged, ambiguous, undisclosed and stale choices before mutation', () => {
    const world=createWorld(), before=serializeWorld(world);
    for(const id of ['gift','gift:黄金','promise','help','apologize:promise','expose']) playerInteract(world,'lin',id);
    expect(serializeWorld(world)).toBe(before);
    expect(JSON.stringify(getPlayerInteractions(world,'lin'))).not.toMatch(/欠款|货款/);
    act(world,'lin','request','request_help');
    world.work.tasks=world.work.tasks.filter(t=>t.ownerId!=='lin');
    const after=serializeWorld(world);
    playerInteract(world,'lin','help');
    expect(serializeWorld(world)).toBe(after);
  });
  it('offers an apology for a broken promise only after that incident and accepts it once', () => {
    const world=createWorld();
    act(world,'lin','request','request_help'); act(world,'lin','promise','accept_promise');
    expect(ids(world)).not.toContain('apologize:promise');
    for(let i=0;i<91;i++) advance(world,1);
    world.player.x=world.npcs[0].x;world.player.y=world.npcs[0].y;
    expect(ids(world)).toContain('apologize:promise');
    act(world,'lin','apologize:promise','accept_apology');
    expect(world.npcs[0].bubble).toContain('约定');
    expect(world.npcs[0].mind.commitments[0].status).toBe('broken');
    expect(ids(world)).not.toContain('apologize:promise');
  });
  it('carries the selected subject into context and roundtrips pending choices and old saves', () => {
    const world=createWorld();playerInteract(world,'lin','gift:面包');
    expect(getContext(world,'lin')).toHaveProperty('situation.playerAction.subject.label','面包');
    const forecasts=(getContext(world,'lin').self as {forecasts:Array<{id:string;effects:unknown;notes:unknown}>}).forecasts;
    const gift=forecasts.find(f=>f.id==='accept_gift')!;
    expect(JSON.stringify(gift)).not.toContain('热茶');
    expect(gift.effects).toMatchObject({hunger:35,energy:5});
    expect(loadWorld(serializeWorld(world))).toEqual(world);
    const raw=JSON.parse(serializeWorld(world));delete raw.npcs[0].pendingAction;
    const restored=loadWorld(JSON.stringify(raw))!;
    expect(restored).not.toBeNull();
    expect(restored.npcs[0].pendingInteraction).toBeUndefined();
    const invalid=JSON.parse(serializeWorld(world));invalid.npcs[0].pendingAction.parameters={item:{secret:true}};
    expect(loadWorld(JSON.stringify(invalid))).toBeNull();
  });
  it('clears a captured conversation when its delivery expires, preserving a loadable save', () => {
    const world=createWorld(), npc=world.npcs[0];
    Object.assign(world.player,BUILDINGS.find(b=>b.id==='tavern')!.door);
    performService(world,'accept:order-1');
    Object.assign(world.player,{x:npc.x,y:npc.y});
    playerInteract(world,npc.id,'greet');
    expect(npc.pendingAction).toBeDefined();
    for(let i=0;i<=world.survival.orders[0].expiresAt;i++)advance(world,1);
    expect(npc.pendingInteraction).toBeUndefined();
    expect(npc.pendingAction).toBeUndefined();
    expect(loadWorld(serializeWorld(world))).not.toBeNull();
  });
  it('revalidates a pending offer before execution and preserves refused gifts', () => {
    const world=createWorld();act(world,'lin','request','request_help');
    playerInteract(world,'lin','promise');world.work.tasks=world.work.tasks.filter(t=>t.ownerId!=='lin');
    const before=serializeWorld(world);
    expect(applyDecision(world,'lin','accept_promise','test')).toBe(false);
    expect(serializeWorld(world)).toBe(before);
    const gift=createWorld();act(gift,'lin','gift:面包','refuse');
    expect(gift.player.inventory).toEqual(['热茶','面包']);
    expect(getOptions(gift,'lin').some(o=>o.id==='accept_gift')).toBe(false);
  });
});

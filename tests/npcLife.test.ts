import { describe, expect, it } from 'vitest';
import { activeOrder, advance, applyDecision, BUILDINGS, createWorld, getContext, getOptions, loadWorld, performService, playerInteract, serializeWorld } from '../src/sim';
import { createNpcNeeds } from '../src/sim/npcLife';
import type { World } from '../src/sim';

const door = (id: string) => BUILDINGS.find(b=>b.id===id)!.door;
function elapse(world: World, seconds: number) { for(let left=seconds;left>0;left-=.25) advance(world,Math.min(left,.25)); }

describe('NPC game physiology and committed jobs', () => {
  it('lets decay change legal candidates and urgency without choosing an action', () => {
    const world=createWorld(), npc=world.npcs[0];
    npc.needs={hunger:80.02,energy:80.02,social:75.02,workPressure:69.99};
    const before=getOptions(world,npc.id).map(o=>o.id), revision=npc.revision;
    expect(before).not.toContain('eat:tavern'); expect(before).not.toContain('rest:watch');
    elapse(world,1);
    expect(npc.revision).toBeGreaterThan(revision);
    expect(getOptions(world,npc.id).map(o=>o.id)).toContain('eat:tavern');
    expect(getOptions(world,npc.id).map(o=>o.id)).toContain('rest:watch');
    expect(npc.job).toBeNull(); expect(world.decisions).toHaveLength(0);
    expect(getContext(world,npc.id)).toHaveProperty('self.urgency.work','pressing');
    npc.needs.energy=14; expect(getOptions(world,npc.id).map(o=>o.id)).not.toContain('work');
  });

  it('travels first and only restores hunger after a complete meal duration', () => {
    const world=createWorld(), npc=world.npcs[0], hunger=npc.needs.hunger;
    const inventory=[...world.player.inventory],stock={...world.survival.stock},money=world.player.money;
    expect(applyDecision(world,npc.id,'eat:tavern','test')).toBe(true);
    expect(npc.job?.phase).toBe('travel'); expect(npc.needs.hunger).toBe(hunger);
    expect(getOptions(world,npc.id)).toEqual([]);
    expect(applyDecision(world,npc.id,'work','test')).toBe(false);
    for(let step=0;npc.job?.phase==='travel'&&step<300;step++) advance(world,.25);
    expect(npc.job?.phase).toBe('perform'); expect(npc.needs.hunger).toBeLessThan(hunger);
    const arrived=npc.needs.hunger;
    elapse(world,9.75); expect(npc.needs.hunger).toBeLessThan(arrived); expect(npc.cooldown).toBeGreaterThan(0);
    elapse(world,.25); expect(npc.job).toBeNull(); expect(npc.needs.hunger).toBeGreaterThan(arrived+40);
    expect(npc.mind.intent?.phase).toBe('completed');
    expect(npc.mind.experiences.some(e=>e.event==='job_completed'&&e.relatedTo===npc.id)).toBe(true);
    expect(world.player.inventory).toEqual(inventory); expect(world.survival.stock).toEqual(stock); expect(world.player.money).toBe(money);
    const after=npc.needs.hunger; elapse(world,1); expect(npc.needs.hunger).toBeLessThan(after);
  });

  it('rest and work have delayed, opposite energy consequences', () => {
    const world=createWorld(), npc=world.npcs[0]; Object.assign(npc,door('watch')); npc.needs.energy=30;
    expect(applyDecision(world,npc.id,'rest:watch','test')).toBe(true);
    elapse(world,9); expect(npc.needs.energy).toBeLessThan(30);
    elapse(world,1); expect(npc.needs.energy).toBeGreaterThan(50);
    Object.assign(npc,door('shop')); const pressure=npc.needs.workPressure, energy=npc.needs.energy;
    expect(applyDecision(world,npc.id,'work','test')).toBe(true);
    elapse(world,15); expect(npc.needs.workPressure).toBeGreaterThan(pressure);
    elapse(world,1); expect(npc.needs.workPressure).toBeLessThan(pressure-30); expect(npc.needs.energy).toBeLessThan(energy-8);
    expect(world.player.money).toBe(20);
  });

  it('player interruption discards unfinished benefits and does not resume secretly', () => {
    const world=createWorld(), npc=world.npcs[0]; Object.assign(npc,door('tavern')); npc.needs.hunger=30;
    applyDecision(world,npc.id,'eat:tavern','test'); elapse(world,5);
    Object.assign(world.player,{x:npc.x,y:npc.y}); playerInteract(world,npc.id,'greet');
    expect(npc.job).toBeNull(); expect(npc.path).toEqual([]); expect(npc.mind.intent?.phase).toBe('waiting'); expect(npc.mind.intent?.label).toContain('回应玩家'); expect(npc.mind.experiences.some(e=>e.event==='intent.interrupted')).toBe(true);
    elapse(world,12); expect(npc.needs.hunger).toBeLessThan(30);
    expect(npc.memories.some(m=>m.kind==='job_completed')).toBe(false);
  });

  it('keeps the delivery meeting intent and commitment when it supersedes an NPC job', () => {
    const world=createWorld(), npc=world.npcs[0];
    Object.assign(npc,door('tavern'));
    applyDecision(world,npc.id,'eat:tavern','test'); Object.assign(world.player,door('tavern'));
    performService(world,`accept:${world.survival.orders[0].id}`);
    const order=activeOrder(world)!; const intent=npc.mind.intent!.id;
    expect(npc.job).toBeNull();
    expect(loadWorld(serializeWorld(world))).toEqual(world);
    elapse(world,.25);
    expect(npc.job).toBeNull(); expect(npc.mind.intent?.id).toBe(intent);
    expect(npc.mind.commitments.find(c=>c.id===order.id)?.status).toBe('active');
    expect(getOptions(world,npc.id)).toEqual([]);
    elapse(world,20); expect(npc.activity).toContain('等你送餐'); expect(npc.needs.hunger).toBeLessThan(createNpcNeeds(npc.id).hunger);
  });

  it('requires the visible conversation partner to remain nearby for the duration', () => {
    const world=createWorld(), npc=world.npcs[0], other=world.npcs[1];
    Object.assign(other,{x:npc.x+24,y:npc.y}); const social=npc.needs.social;
    expect(applyDecision(world,npc.id,`seek:${other.id}`,'test')).toBe(true);
    for(let step=0;npc.job?.phase==='travel'&&step<40;step++) advance(world,.25);
    expect(npc.job?.phase).toBe('invite');
    expect(applyDecision(world,other.id,'social:accept','test')).toBe(true);
    expect(npc.job?.phase).toBe('perform');
    elapse(world,7.75); expect(npc.needs.social).toBeLessThan(social);
    elapse(world,.25); expect(npc.needs.social).toBeGreaterThan(social+20);
    expect(other.knownFacts).not.toContain('lin-debt');
    npc.needs.social=30; applyDecision(world,npc.id,`seek:${other.id}`,'test'); Object.assign(other,{x:120,y:120});
    elapse(world,10); expect(npc.job).toBeNull(); expect(npc.needs.social).toBeLessThan(30);
  });

  it('only includes the observed character’s private needs in its context', () => {
    const world=createWorld(), lin=world.npcs[0];
    lin.needs={hunger:12.345,energy:23.456,social:34.567,workPressure:45.678};
    expect(getContext(world,'lin')).toHaveProperty('self.needs',lin.needs);
    const other=JSON.stringify(getContext(world,'tang'));
    expect(other).not.toContain('12.345'); expect(other).not.toContain('23.456');
    expect(new Set(world.npcs.map(n=>n.needs.energy)).size).toBe(5);
  });

  it('roundtrips in-progress jobs, migrates missing fields, and rejects impossible jobs', () => {
    const world=createWorld(), npc=world.npcs[0]; Object.assign(npc,door('home')); applyDecision(world,npc.id,'rest:home','test'); elapse(world,3);
    const restored=loadWorld(serializeWorld(world)); expect(restored).toEqual(world);
    elapse(restored!,15); expect(restored!.npcs[0].job).toBeNull();
    const legacy=JSON.parse(serializeWorld(createWorld()));
    for(const n of legacy.npcs){delete n.needs;delete n.job;}
    expect(loadWorld(JSON.stringify(legacy))?.npcs[0].needs).toEqual(createNpcNeeds('lin'));
    legacy.version=1; delete legacy.survival;
    for(const key of ['health','hunger','energy','money','activity'])delete legacy.player[key];
    for(const n of legacy.npcs)delete n.mind;
    expect(loadWorld(JSON.stringify(legacy))?.npcs[0].job).toBeNull();
    const invalid=JSON.parse(serializeWorld(world)); invalid.npcs[0].job.endsAt=1;
    expect(loadWorld(JSON.stringify(invalid))).toBeNull();
    invalid.npcs[0].job=null; invalid.npcs[0].needs.energy=-1;
    expect(loadWorld(JSON.stringify(invalid))).toBeNull();
  });
});

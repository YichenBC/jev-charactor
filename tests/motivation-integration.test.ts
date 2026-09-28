import { describe, expect, it } from 'vitest';
import { advance, applyDecision, BUILDINGS, chooseFallback, createWorld, getContext, getOptions, forecastNpcActions, route, distance, loadWorld, performService, playerInteract, serializeWorld, settleDelivery } from '../src/sim';
import type { World } from '../src/sim';
const door=(id:string)=>BUILDINGS.find(b=>b.id===id)!.door;
const elapse=(w:World,s:number)=>{for(let left=s;left>0;left-=.25)advance(w,Math.min(.25,left));};
function conversation(kind:'gift'|'greet'|'help'='greet') { const world=createWorld(),npc=world.npcs[0];Object.assign(world.player,{x:npc.x,y:npc.y});if(kind==='help'){playerInteract(world,npc.id,'request');expect(applyDecision(world,npc.id,'request_help','test')).toBe(true);}playerInteract(world,npc.id,kind==='gift'?'gift:热茶':kind);return {world,npc}; }

describe('motivation integrated with real consequences',()=>{
 it('chooses food, rest, company and work from the respective own pressures',()=>{
  for(const [needs,choice] of [
   [{hunger:1,energy:95,social:95,workPressure:0},'eat:tavern'],
   [{hunger:95,energy:1,social:95,workPressure:0},'rest:'],
   [{hunger:95,energy:95,social:1,workPressure:0},'seek:'],
   [{hunger:95,energy:95,social:95,workPressure:100},'work'],
  ] as const){const world=createWorld(),npc=world.npcs[0];npc.needs={...needs};Object.assign(world.npcs[1],{x:npc.x+24,y:npc.y});expect(chooseFallback(world,npc.id)).toMatch(new RegExp(`^${choice}`));}
 });
 it('publishes own drives and action forecasts without utility rankings or other private needs',()=>{
  const world=createWorld(),npc=world.npcs[0];npc.needs.hunger=12.345;
  const context=getContext(world,npc.id) as {self:{drives:unknown[];forecasts:unknown[]}};
  expect(context.self.drives).toEqual(expect.arrayContaining([expect.objectContaining({id:'hunger',pressure:87.655})]));
  expect(context.self.forecasts).toEqual(expect.arrayContaining([expect.objectContaining({id:'eat:tavern',effects:{hunger:48,energy:4}})]));
  expect(JSON.stringify(context)).not.toMatch(/"rankings"|"score"/);
  expect(JSON.stringify(getContext(world,'tang'))).not.toContain('12.345');
 });
 it('estimates reachable route time plus the same job duration, and caps gross effects',()=>{
  const world=createWorld(),npc=world.npcs[0];npc.needs.hunger=79;npc.needs.energy=99;
  const option=getOptions(world,npc.id).find(o=>o.id==='eat:tavern')!;
  const path=route(npc,door('tavern'));let previous={x:npc.x,y:npc.y},length=0;
  for(const point of path){length+=distance(previous,point);previous=point;}
  const forecast=forecastNpcActions(world,npc,[option])[0];
  expect(forecast.durationSeconds).toBeCloseTo(length/50+10);expect(forecast.effects).toEqual({hunger:21,energy:1});
  const other=world.npcs[1];Object.assign(other,{x:0,y:0});
  expect(forecastNpcActions(world,npc,[{id:`seek:${other.id}`,label:'test',description:'test',kind:'npc_job',target:other.id}])).toEqual([]);
 });
 it('defers a normal conversation into a real job that survives travel and saving',()=>{
  const {world,npc}=conversation();npc.needs.hunger=25;
  expect(getOptions(world,npc.id).map(o=>o.id)).toContain('defer:eat:tavern');
  expect(applyDecision(world,npc.id,'defer:eat:tavern','test')).toBe(true);
  expect(npc.needs.hunger).toBe(25);expect(npc.job?.phase).toBe('travel');expect(npc.mind.intent?.phase).toBe('acting');expect(npc.pendingInteraction).toBeUndefined();expect(npc.bubble).toContain('吃');
  const restored=loadWorld(serializeWorld(world))!;expect(restored).not.toBeNull();const resident=restored.npcs[0];
  for(let i=0;resident.job?.phase==='travel'&&i<300;i++)advance(restored,.25);
  expect(resident.job?.phase).toBe('perform');const hunger=resident.needs.hunger;
  elapse(restored,9.75);expect(resident.needs.hunger).toBeLessThan(hunger);elapse(restored,.25);expect(resident.needs.hunger).toBeGreaterThan(hunger+40);expect(resident.mind.intent?.phase).toBe('completed');
 });
 it('offers deferral only below 40 and protects a delivery meeting',()=>{
  const {world,npc}=conversation();npc.needs.hunger=40;npc.needs.energy=40;expect(getOptions(world,npc.id).some(o=>o.id.startsWith('defer:'))).toBe(false);
  npc.needs.hunger=39;npc.needs.energy=39;expect(getOptions(world,npc.id).filter(o=>o.id.startsWith('defer:'))).toHaveLength(3);
  delete npc.pendingInteraction;Object.assign(world.player,door('tavern'));performService(world,`accept:${world.survival.orders[0].id}`);Object.assign(world.player,{x:npc.x,y:npc.y});playerInteract(world,npc.id,'greet');expect(getOptions(world,npc.id).some(o=>o.id.startsWith('defer:'))).toBe(false);
 });
 it('consumes an accepted gift once with actual capped nutrition and decision deltas',()=>{
  const {world,npc}=conversation('gift');npc.needs={hunger:98,energy:99,social:10,workPressure:50};
  expect(applyDecision(world,npc.id,'accept_gift','test')).toBe(true);expect(npc.needs).toMatchObject({hunger:100,energy:100,social:10});expect(npc.bubble).toContain('喝');
  expect(world.decisions.at(-1)?.changes).toEqual(expect.arrayContaining(['饱腹 +2','体力 +1']));
  const after={...npc.needs};expect(applyDecision(world,npc.id,'accept_gift','test')).toBe(false);expect(npc.needs).toEqual(after);
 });
 it('only ordinary successful replies restore social, with a cap',()=>{
  for(const [choice,social,expected] of [['reply',30,38],['reply',98,100],['refuse',30,30],['defer:rest:watch',30,30]] as const){const {world,npc}=conversation();npc.needs.social=social;npc.needs.energy=20;expect(applyDecision(world,npc.id,choice,'test')).toBe(true);expect(npc.needs.social).toBe(expected);}
 });
 it('accepted deliveries are eaten exactly once while refused deliveries give no nutrition',()=>{
  for(const outcome of ['receive_exact','refuse_delivery'] as const){const world=createWorld(),npc=world.npcs[0];Object.assign(world.player,door('tavern'));performService(world,`accept:${world.survival.orders[0].id}`);elapse(world,6);performService(world,'pickup');if(outcome==='refuse_delivery')elapse(world,56);Object.assign(world.player,{x:npc.x,y:npc.y});npc.needs={hunger:10,energy:10,social:10,workPressure:50};
   playerInteract(world,npc.id,'deliver');expect(getOptions(world,npc.id).some(o=>o.id.startsWith('defer:'))).toBe(false);expect(applyDecision(world,npc.id,outcome,'test')).toBe(true);expect(npc.needs).toMatchObject({hunger:outcome==='receive_exact'?75:10,energy:outcome==='receive_exact'?22:10,social:10});const after={...npc.needs};expect(settleDelivery(world,npc.id,outcome)).toBeNull();expect(npc.needs).toEqual(after);
  }
 });
 it('cancellation discards delayed help and deferral benefits',()=>{
  const {world,npc}=conversation('help');npc.needs.workPressure=50;applyDecision(world,npc.id,'accept_help','test');elapse(world,6);performService(world,'cancel_activity');elapse(world,8);expect(npc.needs.workPressure).toBeGreaterThan(50);
  Object.assign(world.player,{x:npc.x,y:npc.y});playerInteract(world,npc.id,'greet');npc.needs.energy=20;applyDecision(world,npc.id,'defer:rest:home','test');expect(npc.job?.kind).toBe('rest');
  playerInteract(world,npc.id,'greet');expect(npc.job).toBeNull();elapse(world,30);expect(npc.needs.energy).toBeLessThan(20);
 });
 it('help reduces pressure only when the full duration completes, once',()=>{
  const {world,npc}=conversation('help');npc.needs.workPressure=50;applyDecision(world,npc.id,'accept_help','test');expect(npc.needs.workPressure).toBe(50);elapse(world,11.75);expect(npc.needs.workPressure).toBeGreaterThan(50);elapse(world,.25);expect(npc.needs.workPressure).toBeCloseTo(30.48);elapse(world,1);expect(npc.needs.workPressure).toBeCloseTo(30.52);
 });
});

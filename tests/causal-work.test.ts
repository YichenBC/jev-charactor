import { describe, expect, it } from 'vitest';
import { setCommitment } from '../src/character';
import { advance, applyDecision, BUILDINGS, createWorld, getContext, getOptions, getPlayerInteractions, loadWorld, performService, playerInteract, serializeWorld } from '../src/sim';
import type { World } from '../src/sim';
import { addWork, observeWork, ownedWork } from '../src/sim/work';
const door = (id: string) => BUILDINGS.find(b => b.id === id)!.door;
const npc = (w: World, id = 'mei') => w.npcs.find(n => n.id === id)!;
const elapse = (w: World, seconds: number) => { for (let i = 0; i < seconds; i++) advance(w, 1); };
function talk(w: World, id: string, input: string, output: string) {
  Object.assign(w.player, { x: npc(w, id).x, y: npc(w, id).y });
  playerInteract(w, id, input);
  expect(applyDecision(w, id, output, 'fixture')).toBe(true);
}
function finishHelp(w: World, id = 'mei') {
  talk(w, id, 'request', 'request_help'); talk(w, id, 'help', 'accept_help'); elapse(w, 12);
}
describe('causal shared work', () => {
  it('has no fresh chore without an event; a completed NPC meal creates new Mei work', () => {
    const w = createWorld(), mei = npc(w); Object.assign(mei, door('tavern'));
    const first = ownedWork(w, mei)[0].id;
    finishHelp(w);
    expect(ownedWork(w, mei)).toHaveLength(0);
    expect(getPlayerInteractions(w, mei.id).map(o => o.id)).toContain('request');
    elapse(w, 40); expect(ownedWork(w, mei)).toHaveLength(0);
    const lin = npc(w, 'lin'); Object.assign(lin, door('tavern')); lin.needs.hunger = 20;
    expect(applyDecision(w, lin.id, 'eat:tavern', 'fixture')).toBe(true);
    elapse(w, 9); expect(ownedWork(w, mei)).toHaveLength(0);
    elapse(w, 1); expect(ownedWork(w, mei)).toHaveLength(1);
    expect(ownedWork(w, mei)[0].id).not.toBe(first);
    expect(ownedWork(w, mei)[0].cause).toContain('用餐');
    finishHelp(w); expect(w.player.money).toBe(36);
    elapse(w, 2); expect(w.player.money).toBe(36);
  });
  it('the owner can complete the same work before the player accepts, invalidating an offer', () => {
    const w = createWorld(), mei = npc(w); Object.assign(mei, door('tavern'));
    talk(w, mei.id, 'request', 'request_help');
    const old = getPlayerInteractions(w, mei.id).find(o => o.id === 'help')!;
    expect(applyDecision(w, mei.id, 'work', 'fixture')).toBe(true);
    elapse(w, 16);
    expect(ownedWork(w, mei)).toHaveLength(0);
    expect(w.player.money).toBe(20);
    playerInteract(w, mei.id, old.id);
    expect(mei.pendingInteraction).toBeUndefined();
  });
  it('a promise reserves the exact job; expiration releases it and another promise is possible', () => {
    const w = createWorld(), mei = npc(w); Object.assign(mei, door('tavern'));
    talk(w, mei.id, 'request', 'request_help'); talk(w, mei.id, 'promise', 'accept_promise');
    expect(ownedWork(w, mei)[0].claimedBy).toBe('player');
    expect(applyDecision(w, mei.id, 'work', 'fixture')).toBe(true);
    expect(mei.job?.taskId).toBeUndefined(); // other routine work cannot consume the reserved chore
    elapse(w, 16); expect(ownedWork(w, mei)).toHaveLength(1);
    elapse(w, 75); expect(ownedWork(w, mei)[0].claimedBy).toBeUndefined();
    talk(w, mei.id, 'promise', 'accept_promise');
    talk(w, mei.id, 'help', 'accept_help'); elapse(w, 12);
    expect(mei.mind.commitments.find(c => c.id === 'help-player')?.status).toBe('broken');
    expect(mei.mind.commitments.at(-1)?.status).toBe('fulfilled');
  });
  it('keeps new work separate from the task being performed; cancellation pays nothing', () => {
    const w = createWorld(), mei = npc(w); Object.assign(mei, door('tavern'));
    talk(w, mei.id, 'request', 'request_help'); talk(w, mei.id, 'help', 'accept_help');
    const old = w.player.activity!.taskId;
    addWork(w, mei.id, '另一位客人用餐后留下餐具');
    expect(ownedWork(w, mei)).toHaveLength(2);
    elapse(w, 12);
    expect(ownedWork(w, mei)).toHaveLength(1);
    expect(ownedWork(w, mei)[0].id).not.toBe(old);
    finishHelp(w); expect(w.player.money).toBe(36);
    addWork(w, mei.id, '新的用餐清洁需求');
    talk(w, mei.id, 'request', 'request_help'); talk(w, mei.id, 'help', 'accept_help');
    performService(w, 'cancel_activity'); elapse(w, 12);
    expect(w.player.money).toBe(36); expect(ownedWork(w, mei)[0].claimedBy).toBeUndefined();
  });
  it('does not reveal distant work until the owner observes it, including candidate metadata', () => {
    const w = createWorld(), mei = npc(w); w.work.tasks = [];
    Object.assign(mei, door('home'));
    const before = getContext(w, mei.id);
    addWork(w, mei.id, '远处有人用餐后留下餐具');
    expect(getContext(w, mei.id)).toEqual(before);
    Object.assign(mei, door('tavern')); observeWork(w, mei);
    expect(JSON.stringify(getContext(w, mei.id))).toContain('远处有人用餐');
    expect(JSON.stringify(getContext(w, 'lin'))).not.toContain('远处有人用餐');
  });
  it('roundtrips claims and migrates completed old saves without reopening the old chore', () => {
    const w = createWorld(); talk(w, 'mei', 'request', 'request_help'); talk(w, 'mei', 'help', 'accept_help');
    expect(loadWorld(serializeWorld(w))).toEqual(w);
    const legacy = JSON.parse(serializeWorld(w)); delete legacy.work; delete legacy.player.activity.taskId;
    const migrated = loadWorld(JSON.stringify(legacy))!;
    expect(migrated).not.toBeNull(); expect(migrated.player.activity?.taskId).toBeDefined();
    elapse(migrated, 12); expect(migrated.player.money).toBe(28);
    const complete = JSON.parse(serializeWorld(migrated)); delete complete.work;
    const restored = loadWorld(JSON.stringify(complete))!;
    expect(ownedWork(restored, npc(restored))).toHaveLength(0);
    expect(getPlayerInteractions(restored, 'mei').map(o => o.id)).toContain('request');
  });
  it('world activities create work for the corresponding other residents only after completion', () => {
    const w = createWorld(); w.work.tasks=[];
    const lin=npc(w,'lin'),lan=npc(w,'lan'),tang=npc(w,'tang'),zhou=npc(w,'zhou');
    Object.assign(lin,door('shop')); Object.assign(lan,door('post')); Object.assign(tang,door('watch')); Object.assign(zhou,door('watch'));
    Object.assign(w.player,door('shop')); performService(w,'buy:面包');
    expect(ownedWork(w,lin)).toHaveLength(1);
    Object.assign(w.player,door('post')); performService(w,'work'); elapse(w,17);
    expect(ownedWork(w,lan)).toHaveLength(0); elapse(w,1); expect(ownedWork(w,lan)).toHaveLength(1);
    expect(applyDecision(w,tang.id,'work','fixture')).toBe(true); elapse(w,16);
    expect(ownedWork(w,tang)).toHaveLength(1);
    tang.needs.energy=30;
    expect(applyDecision(w,tang.id,'rest:watch','fixture')).toBe(true); elapse(w,10);
    expect(ownedWork(w,zhou)).toHaveLength(1);
  });
  it('interrupting owner work releases the same task without clearing it', () => {
    const w=createWorld(),mei=npc(w); Object.assign(mei,door('tavern'));
    const task=ownedWork(w,mei)[0];
    applyDecision(w,mei.id,'work','fixture'); elapse(w,4);
    expect(task.claimedBy).toBe('owner');
    talk(w,mei.id,'request','request_help');
    expect(task.claimedBy).toBeUndefined(); expect(ownedWork(w,mei)[0].id).toBe(task.id);
    expect(loadWorld(serializeWorld(w))).not.toBeNull();
  });
  it('rejects malformed or orphan work state instead of allowing fabricated rewards', () => {
    const w=createWorld(); talk(w,'mei','request','request_help'); talk(w,'mei','help','accept_help');
    for(const mutate of [
      (x:World)=>{x.work.tasks.push({...x.work.tasks[0]});},
      (x:World)=>{x.player.activity!.taskId='work-999';},
      (x:World)=>{x.work.tasks.find(t=>t.ownerId==='mei')!.claimedBy='owner';},
      (x:World)=>{x.work.tasks.find(t=>t.ownerId==='mei')!.observed=false;},
      (x:World)=>{x.work.tasks[0].createdAt=100;},
    ]) { const changed=structuredClone(w); mutate(changed); expect(loadWorld(serializeWorld(changed))).toBeNull(); }
  });
  it('a new promise does not reopen an apology for an older resolved incident', () => {
    const w=createWorld(),mei=npc(w); Object.assign(mei,door('tavern'));
    talk(w,'mei','request','request_help'); talk(w,'mei','promise','accept_promise'); elapse(w,91);
    talk(w,'mei','apologize:promise','accept_apology');
    talk(w,'mei','promise','accept_promise');
    expect(getPlayerInteractions(w,'mei').map(o=>o.id)).not.toContain('apologize:promise');
    elapse(w,91);
    expect(getPlayerInteractions(w,'mei').find(o=>o.id==='apologize:promise')!.subject!.id).toBe(mei.mind.commitments.at(-1)!.id);
    talk(w,'mei','apologize:promise','accept_apology');
    expect(getPlayerInteractions(w,'mei').map(o=>o.id)).not.toContain('apologize:promise');
  });

  it('rejects orphan promises, future promises and nonexistent captured work in saves', () => {
    const w=createWorld(); talk(w,'mei','request','request_help'); talk(w,'mei','promise','accept_promise');
    const orphan=structuredClone(w); orphan.work.tasks=orphan.work.tasks.filter(t=>t.ownerId!=='mei');
    expect(loadWorld(serializeWorld(orphan))).toBeNull();
    const future=structuredClone(w); Object.assign(npc(future).mind.commitments[0],{createdAt:100,dueAt:190});
    expect(loadWorld(serializeWorld(future))).toBeNull();
    playerInteract(w,'mei','help');
    npc(w).pendingAction!.parameters.taskId='work-999'; npc(w).pendingAction!.subject!.id='work-999';
    expect(loadWorld(serializeWorld(w))).toBeNull();
  });
  it('does not reuse the original promise identity after terminal history is evicted', () => {
    const w=createWorld(),mei=npc(w); Object.assign(mei,door('tavern'));
    talk(w,'mei','request','request_help'); talk(w,'mei','promise','accept_promise'); elapse(w,91);
    const original=mei.mind.commitments[0].id;
    talk(w,'mei','apologize:promise','accept_apology');
    for(let i=0;i<24;i++)setCommitment(mei.mind,{id:`other-${i}`,description:'Other completed obligation',status:'fulfilled',createdAt:w.time,counterparty:'player'});
    expect(mei.mind.commitments.some(c=>c.id===original)).toBe(false);
    talk(w,'mei','promise','accept_promise');
    expect(mei.mind.commitments.at(-1)!.id).not.toBe(original);
    elapse(w,91);
    expect(getPlayerInteractions(w,'mei').map(o=>o.id)).toContain('apologize:promise');
  });

});

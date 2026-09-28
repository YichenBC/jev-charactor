import { describe,expect,it } from 'vitest';
import { advance,applyDecision,BUILDINGS,createWorld,getContext,getOptions,loadWorld,playerInteract,serializeWorld } from '../src/sim';
import { advanceGoal, inspectPersonal } from '../src/character/personal';
import { remember } from '../src/sim/events';
import { FogHarborEnvironment } from '../src/adapters/fog-harbor/environment';
import { ordinaryResponses } from '../src/sim/dialogue';
import { getPlayerInteractions } from '../src/sim/interactions';
import type {World} from '../src/sim';
const elapse=(w:World,s:number)=>{for(let t=0;t<s;t+=.25)advance(w,Math.min(.25,s-t));};
describe('personal life in Fog Harbor',()=>{
  it('lets players ask about plans explicitly without forcing disclosure or leaking whether feelings exist',()=>{
    const w=createWorld(),n=w.npcs[1];Object.assign(w.player,{x:n.x,y:n.y});
    const ids=getPlayerInteractions(w,n.id).map(c=>c.id);
    expect(ids).toContain('ask:plans');expect(ids).toContain('ask:feelings');
    playerInteract(w,n.id,'ask:plans');const options=getOptions(w,n.id);
    expect(options.some(o=>o.id==='reply:goal')).toBe(true);
    expect(options.some(o=>o.id==='refuse')).toBe(true);
    expect(options.some(o=>o.id==='request_help'||o.id==='confide'||o.id==='reply:state')).toBe(false);
    expect(options.filter(o=>o.id.startsWith('reply:goal'))).toHaveLength(2);
  });
  it('can discuss a personal plan and follow it up without completing it or making a promise',()=>{
    const w=createWorld(),n=w.npcs[1];Object.assign(w.player,{x:n.x,y:n.y});
    playerInteract(w,n.id,'ask');expect(applyDecision(w,n.id,'reply:goal','test')).toBe(true);
    expect(n.bubble).toContain('速写');
    const follow=getPlayerInteractions(w,n.id).find(c=>c.id.startsWith('followup:'))!;
    expect(follow).toBeDefined();playerInteract(w,n.id,follow.id);
    expect(applyDecision(w,n.id,'reply:detail','test')).toBe(true);expect(n.bubble).toContain('还差三回');
    expect(n.mind.personal.goals[0].receipts).toHaveLength(0);expect(n.mind.commitments).toHaveLength(0);
  });
  it('describes completed hobbies as enjoyment without claiming extra progress',()=>{
    const w=createWorld(),n=w.npcs[1];Object.assign(n,BUILDINGS.find(b=>b.id==='watch')!.door);
    for(let i=0;i<3;i++)advanceGoal(n.mind,'personal-interest',{id:`done${i}`,at:0});
    expect(getOptions(w,n.id).find(o=>o.id==='hobby:watch')?.description).toContain('no further goal progress');
    applyDecision(w,n.id,'hobby:watch','test');elapse(w,14);
    expect(n.mind.personal.goals[0].receipts).toHaveLength(3);expect(w.events.at(-1)?.text).not.toContain('打算又做');
  });
  it('reserves one accepted conversation for both people and credits each exactly once',()=>{
    const w=createWorld(),a=w.npcs[1],b=w.npcs[4];Object.assign(a,BUILDINGS.find(p=>p.id==='watch')!.door);Object.assign(b,{x:a.x,y:a.y});
    expect(applyDecision(w,a.id,`seek:${b.id}`,'test')).toBe(true);
    expect(getOptions(w,b.id).some(o=>o.id==='social:accept')).toBe(true);
    expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);
    expect(b.activity).toContain(a.name);
    expect(getOptions(w,b.id)).toEqual([]);
    expect(applyDecision(w,b.id,`seek:${a.id}`,'test')).toBe(false);
    elapse(w,8);
    for(const n of [a,b]){
      expect(n.mind.personal.goals.find(g=>g.activity==='social')!.receipts).toHaveLength(1);
      expect(n.mind.personal.goals.find(g=>g.activity==='social')!.completedAt).toBeUndefined();
      expect(inspectPersonal(n.mind,w.time).feelings).toHaveLength(1);
    }
  });
  it('safely cancels legacy reciprocal social jobs without inventing consent',()=>{
    const w=createWorld(),a=w.npcs[1],b=w.npcs[4];Object.assign(a,BUILDINGS.find(p=>p.id==='watch')!.door);Object.assign(b,{x:a.x,y:a.y});
    applyDecision(w,a.id,`seek:${b.id}`,'test');
    const old=JSON.parse(serializeWorld(w));
    delete old.npcs[1].job.consent;delete old.npcs[1].job.expiresAt;old.npcs[1].job.phase='perform';old.npcs[1].job.endsAt=8;
    old.npcs[4].job={...old.npcs[1].job,partnerId:a.id};
    const restored=loadWorld(JSON.stringify(old))!;expect(restored).not.toBeNull();elapse(restored,8);
    for(const n of [restored.npcs[1],restored.npcs[4]]){expect(n.job).toBeNull();expect(n.mind.personal.goals.find(g=>g.activity==='social')!.receipts).toHaveLength(0);}
  });
  it('interrupts an incoming conversation when the player addresses its listener',()=>{
    const w=createWorld(),a=w.npcs[1],b=w.npcs[4];Object.assign(a,BUILDINGS.find(p=>p.id==='watch')!.door);Object.assign(b,{x:a.x,y:a.y});
    applyDecision(w,a.id,`seek:${b.id}`,'test');expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);elapse(w,4);
    Object.assign(w.player,{x:b.x,y:b.y});playerInteract(w,b.id,'ask');
    expect(a.job).toBeNull();elapse(w,8);
    expect(a.mind.personal.goals.find(g=>g.activity==='social')!.receipts).toHaveLength(0);
  });
  it('does not repeatedly travel to the current place or work without pressure, tasks or a personal objective',()=>{
    const w=createWorld(),n=w.npcs[0];Object.assign(n,BUILDINGS.find(b=>b.id==='shop')!.door);
    w.work.tasks=[];n.needs.workPressure=0;
    advanceGoal(n.mind,'personal-routine',{id:'done1',at:0});advanceGoal(n.mind,'personal-routine',{id:'done2',at:0});
    const choices=getOptions(w,n.id).map(o=>o.id);
    expect(choices).not.toContain('visit:shop');expect(choices).not.toContain('work');
    n.needs.workPressure=30;expect(getOptions(w,n.id).some(o=>o.id==='work')).toBe(true);
  });
  it('gives residents different persistent goals and activity preferences',()=>{
    const w=createWorld();
    expect(w.npcs.every(n=>n.mind.personal.goals.length===2)).toBe(true);
    expect(new Set(w.npcs.map(n=>n.mind.personal.goals[0].label)).size).toBe(5);
    expect(w.npcs[1].mind.personal.preferences).not.toEqual(w.npcs[2].mind.personal.preferences);
    expect(getOptions(w,'tang').some(o=>o.id==='hobby:watch')).toBe(true);
  });
  it('advances a hobby goal only on completed timed activity and prevents immediate repetition',()=>{
    const w=createWorld(),n=w.npcs[1];Object.assign(n,BUILDINGS.find(b=>b.id==='watch')!.door);
    expect(applyDecision(w,n.id,'hobby:watch','test')).toBe(true);
    elapse(w,13.75);
    expect(n.mind.personal.goals.find(g=>g.activity==='hobby')!.receipts).toHaveLength(0);
    const restored=loadWorld(serializeWorld(w))!;expect(restored).not.toBeNull();
    elapse(restored,.25);const r=restored.npcs[1];
    expect(r.job).toBeNull();expect(r.mind.personal.goals.find(g=>g.activity==='hobby')!.receipts).toHaveLength(1);
    expect(inspectPersonal(r.mind,restored.time).feelings.some(f=>f.basis==='completed:hobby')).toBe(true);
    expect(getOptions(restored,r.id).some(o=>o.id.startsWith('hobby:'))).toBe(false);
    elapse(restored,180);expect(getOptions(restored,r.id).some(o=>o.id.startsWith('hobby:'))).toBe(true);
    expect(loadWorld(serializeWorld(restored))?.npcs[1].mind.personal.goals.find(g=>g.activity==='hobby')!.receipts).toHaveLength(1);
  });
  it('gives no hobby reward on interruption and does not override severe bodily needs',()=>{
    const w=createWorld(),n=w.npcs[1];Object.assign(n,BUILDINGS.find(b=>b.id==='watch')!.door);
    expect(applyDecision(w,n.id,'hobby:watch','test')).toBe(true);elapse(w,5);
    Object.assign(w.player,{x:n.x,y:n.y});playerInteract(w,n.id,'ask');elapse(w,15);
    expect(n.mind.personal.goals.find(g=>g.activity==='hobby')!.receipts).toHaveLength(0);
    expect(inspectPersonal(n.mind,w.time).feelings).toHaveLength(0);
    delete n.pendingInteraction;delete n.pendingAction;n.needs.hunger=9;
    expect(getOptions(w,n.id).some(o=>o.id.startsWith('hobby:'))).toBe(false);
  });
  it('keeps event-based feelings after expressions change and removes them with time',()=>{
    const w=createWorld(),n=w.npcs[0];remember(w,n,'玩家失约','broken_promise');
    expect(inspectPersonal(n.mind,0).feelings[0]?.valence).toBeLessThan(0);
    Object.assign(w.player,{x:n.x,y:n.y});playerInteract(w,n.id,'ask');applyDecision(w,n.id,'reply','test',{affect:'warm'});
    expect(n.mind.affect).toBe('warm');expect(inspectPersonal(n.mind,0).feelings[0]?.valence).toBeLessThan(0);
    expect(ordinaryResponses(n,'ask',true,w.time,w).some(r=>r.id==='reply:feeling')).toBe(true);
    expect(inspectPersonal(n.mind,500).feelings).toEqual([]);
  });
  it('does not expose another resident’s goals or feelings to the deciding character',()=>{
    const w=createWorld(),n=w.npcs[0];n.mind.personal.goals[0].label='PRIVATE-GOAL-987';remember(w,n,'ONLY-LIN-EVENT-321','broken_promise');
    const own=JSON.stringify(getContext(w,n.id)),other=JSON.stringify(getContext(w,'tang'));
    expect(own).toContain('PRIVATE-GOAL-987');expect(other).not.toContain('PRIVATE-GOAL-987');
    expect(other).not.toContain('ONLY-LIN-EVENT-321');
  });
  it('initializes legacy personal plans at the save clock without invented past feelings or progress',()=>{
    const raw=JSON.parse(serializeWorld(createWorld()));raw.time=100;
    for(const n of raw.npcs)delete n.mind.personal;
    const w=loadWorld(JSON.stringify(raw))!;expect(w).not.toBeNull();
    expect(w.npcs[0].mind.personal.goals[0].createdAt).toBe(100);
    expect(w.npcs[0].mind.personal.goals.every(g=>g.receipts.length===0)).toBe(true);
    expect(w.npcs[0].mind.personal.feelings).toHaveLength(0);
    const future=JSON.parse(serializeWorld(w));future.npcs[0].mind.personal.goals[0].createdAt=101;
    expect(loadWorld(JSON.stringify(future))).toBeNull();
  });
  it('invalidates decisions that outlive a relevant feeling',()=>{
    const w=createWorld(),n=w.npcs[0];remember(w,n,'失约','broken_promise');
    const turn=new FogHarborEnvironment({world:()=>w,running:()=>true,allows:()=>true}).openTurn(n.id)!;
    w.time=n.mind.personal.feelings[0].until;
    expect(turn.isCurrent()).toBe(false);
  });
  it('speaks naturally about unstarted, partly completed, and completed plans without granting progress',()=>{
    const w=createWorld(),n=w.npcs[1];Object.assign(n,BUILDINGS.find(b=>b.id==='watch')!.door);
    const report=()=>ordinaryResponses(n,'ask',true,w.time,w).find(r=>r.subject==='goal:personal-interest')!;
    const untouched=JSON.stringify(n.mind.personal.goals);
    expect(report().text).toContain('头一回还没做完');expect(report().text).not.toMatch(/0\/3|凑数|说说就算/);
    expect(JSON.stringify(n.mind.personal.goals)).toBe(untouched);
    expect(applyDecision(w,n.id,'hobby:watch','test')).toBe(true);elapse(w,13.75);
    expect(report().text).toContain('头一回还没做完');expect(report().text).toContain('正慢慢做着');expect(n.mind.personal.goals[0].receipts).toHaveLength(0);
    elapse(w,.25);
    expect(report().text).toContain('已经做过一回');expect(report().text).toContain('还差两回');
    expect(n.mind.personal.goals[0].receipts).toHaveLength(1);
    advanceGoal(n.mind,'personal-interest',{id:'later-second',at:w.time});
    expect(report().text).toContain('还差一回');
    advanceGoal(n.mind,'personal-interest',{id:'later-third',at:w.time});
    const finished=JSON.stringify(n.mind.personal.goals);
    expect(report().text).toContain('已经完成');expect(report().text).not.toContain('还差');
    expect(JSON.stringify(n.mind.personal.goals)).toBe(finished);
    expect(loadWorld(serializeWorld(w))).not.toBeNull();
  });
  it('uses the owned goal label in natural replies, including an imported custom plan',()=>{
    const w=createWorld(),n=w.npcs[2];n.mind.personal.goals[0].label='学一首老歌';
    const reply=ordinaryResponses(n,'ask',true,w.time,w).find(r=>r.subject==='goal:personal-interest')!;
    expect(reply.text).toContain('学一首老歌');expect(reply.text).not.toContain('茶点');
    expect(reply.subject).toBe('goal:personal-interest');expect(reply.text).toContain('头一回还没做完');
  });

});

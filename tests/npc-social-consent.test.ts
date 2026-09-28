import { afterEach, describe, expect, it, vi } from 'vitest';
import { advance, applyDecision, BUILDINGS, createWorld, getContext, getOptions, loadWorld, playerInteract, serializeWorld, type World } from '../src/sim';
import { FogHarborEnvironment } from '../src/adapters/fog-harbor/environment';
import { DecisionController } from '../src/adapters/fog-harbor/controller';
const elapse=(w:World,s:number)=>{for(let t=0;t<s;t+=.25)advance(w,Math.min(.25,s-t));};
function setup(){
  const w=createWorld(),a=w.npcs[1],b=w.npcs[4];
  Object.assign(a,BUILDINGS.find(p=>p.id==='watch')!.door);Object.assign(b,{x:a.x,y:a.y});
  a.needs.social=20;b.needs.social=20;
  return {w,a,b};
}
const receipts=(w:World)=>w.npcs.flatMap(n=>n.mind.personal.goals.filter(g=>g.activity==='social').flatMap(g=>g.receipts));
afterEach(()=>vi.unstubAllGlobals());
describe('independent NPC social consent',()=>{
  it('offers an arrival invitation alongside personal choices without reserving or leaking the recipient',()=>{
    const {w,a,b}=setup(),activity=b.activity;
    a.secret='PRIVATE-SECRET';a.memories.push({time:0,text:'PRIVATE-MEMORY',kind:'test'});
    expect(applyDecision(w,a.id,`seek:${b.id}`,'test')).toBe(true);
    expect(b.activity).toBe(activity);expect(a.job?.phase).toBe('invite');
    expect(getOptions(w,b.id).map(o=>o.id)).toEqual(expect.arrayContaining(['social:accept','social:decline','social:defer','work','rest:watch']));
    const context=JSON.stringify(getContext(w,b.id));
    expect(context).toContain('socialInvitation');expect(context).toContain(a.name);
    expect(context).not.toContain('PRIVATE-SECRET');expect(context).not.toContain('PRIVATE-MEMORY');
    a.needs={hunger:1,energy:2,social:3,workPressure:4};a.mind.personal.goals[0].label='PRIVATE-GOAL';
    expect(JSON.stringify(getContext(w,b.id))).toBe(context);
    elapse(w,8);expect(receipts(w)).toHaveLength(0);
  });
  it('rewards both only after explicit acceptance and eight uninterrupted seconds, exactly once across saves',()=>{
    const {w,a,b}=setup();applyDecision(w,a.id,`seek:${b.id}`,'test');
    expect(applyDecision(w,b.id,'social:accept','receiver-provider')).toBe(true);
    expect(getOptions(w,b.id)).toEqual([]);expect(b.activity).toContain(a.name);
    elapse(w,7.75);expect(receipts(w)).toHaveLength(0);
    const saved=loadWorld(serializeWorld(w))!;expect(saved).not.toBeNull();elapse(saved,.25);
    expect(receipts(saved)).toHaveLength(2);
    for(const id of [a.id,b.id])expect(saved.npcs.find(n=>n.id===id)!.needs.social).toBeGreaterThan(49);
    expect(saved.events.filter(e=>e.kind==='public_chat')).toHaveLength(2);
    const again=loadWorld(serializeWorld(saved))!;elapse(again,12);
    expect(receipts(again)).toHaveLength(2);expect(again.events.filter(e=>e.kind==='public_chat')).toHaveLength(2);
  });
  it.each(['decline','defer'])('allows independent %s without granting rewards or holding either side',response=>{
    const {w,a,b}=setup(),activity=b.activity;applyDecision(w,a.id,`seek:${b.id}`,'test');
    expect(applyDecision(w,b.id,`social:${response}`,'receiver-provider')).toBe(true);
    expect(a.job).toBeNull();expect(b.job).toBeNull();expect(b.activity).toBe(activity);
    expect(a.activity).not.toContain('等对方决定');expect(a.cooldown).toBeGreaterThan(0);expect(b.cooldown).toBeGreaterThan(0);
    expect(w.decisions.at(-1)).toMatchObject({npcId:b.id,choice:`social:${response}`,source:'receiver-provider'});
    elapse(w,20);expect(receipts(w)).toHaveLength(0);
  });
  it('does not overwrite activity started by the receiver while the proposer approaches',()=>{
    const {w,a,b}=setup();a.x-=48;
    applyDecision(w,a.id,`seek:${b.id}`,'test');expect(a.job?.phase).toBe('travel');
    expect(applyDecision(w,b.id,'rest:watch','test')).toBe(true);
    const activity=b.activity,job=b.job;
    elapse(w,2);expect(a.job).toBeNull();expect(b.job).toBe(job);expect(b.activity).toBe(activity);
    expect(receipts(w)).toHaveLength(0);
  });
  it('expires unanswered invitations and rejects stale captured acceptance',()=>{
    const {w,a,b}=setup();applyDecision(w,a.id,`seek:${b.id}`,'test');
    const turn=new FogHarborEnvironment({world:()=>w,running:()=>true,allows:()=>true}).openTurn(b.id)!;
    elapse(w,13);expect(a.job).toBeNull();expect(getOptions(w,b.id).some(o=>o.id==='work')).toBe(true);
    expect(turn.execute({choice:'social:accept',affect:'focused'},'late').status).toBe('rejected');expect(receipts(w)).toHaveLength(0);
  });
  it.each(['proposer','receiver'])('cancels accepted conversation when the player interrupts the %s',side=>{
    const {w,a,b}=setup();applyDecision(w,a.id,`seek:${b.id}`,'test');expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);elapse(w,4);
    const selected=side==='proposer'?a:b;Object.assign(w.player,{x:selected.x,y:selected.y});playerInteract(w,selected.id,'ask');
    expect(a.job).toBeNull();elapse(w,10);expect(receipts(w)).toHaveLength(0);
    expect(w.events.filter(e=>e.kind==='public_chat')).toHaveLength(0);
  });
  it('roundtrips pending consent and cancels legacy social jobs without inventing acceptance',()=>{
    const {w,a,b}=setup();applyDecision(w,a.id,`seek:${b.id}`,'test');
    const saved=loadWorld(serializeWorld(w))!;expect(saved).not.toBeNull();
    expect(getOptions(saved,b.id).some(o=>o.id==='social:accept')).toBe(true);
    const raw=JSON.parse(serializeWorld(w));const job=raw.npcs[1].job;
    delete job.consent;delete job.expiresAt;job.phase='perform';job.endsAt=8;
    raw.npcs[4].job={...job,partnerId:a.id};
    const legacy=loadWorld(JSON.stringify(raw))!;expect(legacy).not.toBeNull();
    expect(legacy.npcs.filter(n=>n.job?.kind==='social')).toHaveLength(0);
    elapse(legacy,20);expect(receipts(legacy)).toHaveLength(0);
  });
  it('dispatches the recipient through the normal provider and respects conversation pause',async()=>{
    const {w,a,b}=setup();w.npcs.forEach(n=>n.cooldown=90);applyDecision(w,a.id,`seek:${b.id}`,'test');
    const requests:Array<Record<string,unknown>>=[];
    vi.stubGlobal('fetch',vi.fn(async(_url:unknown,init:RequestInit)=>{
      const body=JSON.parse(String(init.body));requests.push(body);
      return Response.json({npcId:body.npcId,revision:body.revision,choice:'social:decline',affect:'focused'});
    }));
    let focus:string|null='lin';
    const controller=new DecisionController({world:()=>w,running:()=>true,conversation:()=>focus,changed:()=>{},notify:()=>{}});controller.configured=true;
    await controller.tick();expect(requests).toHaveLength(0);focus=null;await controller.tick();
    expect(requests).toHaveLength(1);expect(requests[0].npcId).toBe(b.id);
    expect(requests[0].options).toEqual(expect.arrayContaining([expect.objectContaining({id:'social:decline'})]));
    expect(w.decisions.at(-1)).toMatchObject({npcId:b.id,choice:'social:decline',source:'jev'});expect(a.job).toBeNull();
  });
  it('keeps duplicate invitations out while leaving recipient alternatives available',()=>{
    const {w,a,b}=setup(),third=w.npcs[0];Object.assign(third,{x:b.x,y:b.y});
    applyDecision(w,a.id,`seek:${b.id}`,'test');
    expect(getOptions(w,third.id).some(o=>o.id===`seek:${b.id}`)).toBe(false);
    expect(applyDecision(w,third.id,`seek:${b.id}`,'test')).toBe(false);
    expect(applyDecision(w,b.id,'rest:watch','receiver-provider')).toBe(true);
    expect(a.job).toBeNull();expect(b.job?.kind).toBe('rest');expect(receipts(w)).toHaveLength(0);
    expect(a.cooldown).toBeGreaterThan(0);
  });
  it('invalidates a captured acceptance if the recipient is busy or the proposer leaves',()=>{
    for(const busy of [false,true]){
      const {w,a,b}=setup();applyDecision(w,a.id,`seek:${b.id}`,'test');
      const turn=new FogHarborEnvironment({world:()=>w,running:()=>true,allows:()=>true}).openTurn(b.id)!;
      if(busy)applyDecision(w,b.id,'rest:watch','test');else a.x-=144;
      expect(turn.execute({choice:'social:accept',affect:'focused'},'late').status).toBe('rejected');
      elapse(w,1);expect(a.job).toBeNull();expect(receipts(w)).toHaveLength(0);
    }
  });
  it('bounds travel wait even when the proposer never makes progress',()=>{
    const {w,a,b}=setup();a.x-=48;applyDecision(w,a.id,`seek:${b.id}`,'test');
    expect(a.job?.phase).toBe('travel');w.time=121;advance(w,.25);
    expect(a.job).toBeNull();expect(receipts(w)).toHaveLength(0);expect(a.cooldown).toBeGreaterThan(0);
  });
  it.each(['duration','unbounded','misplaced'])('rejects malformed new consent state (%s)',invalid=>{
    const {w,a,b}=setup();applyDecision(w,a.id,`seek:${b.id}`,'test');const raw=JSON.parse(serializeWorld(w));
    if(invalid==='duration')raw.npcs[1].job.duration=1;
    if(invalid==='unbounded')raw.npcs[1].job.expiresAt=1e8;
    if(invalid==='misplaced')raw.npcs[1].x-=48;
    expect(loadWorld(JSON.stringify(raw))).toBeNull();
  });

});

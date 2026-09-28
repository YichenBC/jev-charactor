import { describe, expect, it } from 'vitest';
import { translate, translateIdentity, setLocale, getLocale, followUpDescription } from '../src/i18n';
import { createWorld, getPlayerInteractions, serializeWorld } from '../src/sim';

describe('presentation-only localization', () => {
  it('defaults to English and translates exact authored UI and dynamic values', () => {
    expect(getLocale()).toBe('en');
    expect(translate('开始第一天')).toBe('Start day one');
    expect(translate('接单：梅姐 · 12 元')).toBe('Accept order: Mei · ¥12');
  });
  it('only translates exact authored identities, never custom names that resemble prose',()=>{
    expect(translateIdentity('林舟','en')).toBe('Lin Zhou');
    expect(translateIdentity('杂货铺掌柜','en')).toBe('General store owner');
    for(const text of ['林舟，custom','去林舟','饱腹','constructor','<img src=x onerror=alert(1)>'])expect(translateIdentity(text,'en')).toBe(text);
  });
  it('translates known legacy recovery messages',()=>{
    for(const text of ['等你重新说起具体事情','旧存档的谈话需要重新选择具体事项。','这段闲谈缺少双方同意或与别的活动冲突，先停下来。'])expect(translate(text,'en')).not.toMatch(/[\u3400-\u9fff]/u);
  });
  it('preserves unknown custom text literally', () => {
    expect(translate('constructor')).toBe('constructor');
    expect(translate('__proto__')).toBe('__proto__');
    for(const text of ['热饭 custom note','林舟123','林舟<img src=x onerror=alert(1)>'])expect(translate(text)).toBe(text);
    expect(translate('我的热饭日记 <img src=x onerror=alert(1)>')).toBe('我的热饭日记 <img src=x onerror=alert(1)>');
  });
  it('never changes canonical state, IDs or interaction labels', () => {
    const world=createWorld(); const before=serializeWorld(world);
    const npc=world.npcs[0]; Object.assign(world.player,{x:npc.x,y:npc.y});
    const actions=getPlayerInteractions(world,npc.id); const canonical=JSON.stringify(actions);
    actions.forEach(a=>{translate(a.label); translate(a.description);});
    setLocale('zh'); expect(translate('开始第一天')).toBe('开始第一天'); setLocale('en');
    expect(JSON.stringify(actions)).toBe(canonical);
    Object.assign(world.player,JSON.parse(before).player);
    expect(serializeWorld(world)).toBe(before);
  });
  it('uses the complete source turn before translating a follow-up preview', () => {
    const world=createWorld(), npc=world.npcs[0];
    npc.mind.dialogue.turns.push({ sequence:1,speaker:'self',partner:'player',text:'你好！我叫阿棠，正找一个画晚霞的好角度。',topic:'plan',at:0 } as never);
    expect(followUpDescription(npc,{parameters:{turn:1},description:'clipped'} as never)).toContain('Tang');
  });
});

import { ordinaryResponses } from '../src/sim/dialogue';
import { notePersonalEvent } from '../src/sim/personalLife';
import { recordDialogue } from '../src/character/dialogue';

describe('authored dialogue coverage',()=>{
  it('translates all residents, needs, plans, feelings and contextual continuations',()=>{
    const missing=new Set<string>();
    for(const id of ['lin','tang','mei','lan','zhou'])for(const progress of [0,1,2,3])for(const event of ['gift','exposure'] as const) {
      const world=createWorld(),npc=world.npcs.find(n=>n.id===id)!;
      Object.assign(world.player,{x:npc.x,y:npc.y});
      npc.needs.hunger=progress%2?20:80;npc.needs.energy=progress%2?20:80;
      for(const goal of npc.mind.personal.goals){goal.receipts=Array.from({length:Math.min(goal.target,progress)},(_,i)=>({id:`test-${i}`,at:0}));if(goal.receipts.length===goal.target)goal.completedAt=0;}
      notePersonalEvent(npc,event,'locale-fixture',world.time);
      for(const intent of ['greet','ask'] as const) {
        const responses=ordinaryResponses(npc,intent,false,world.time,world);
        for(const response of responses) {
          if(/[\u3400-\u9fff]/u.test(translate(response.text,'en')))missing.add(response.text);
          if(response.followUp&&/[\u3400-\u9fff]/u.test(translate(response.followUp,'en')))missing.add(response.followUp);
          const branch=structuredClone(npc);
          if(response.followUp) {
            recordDialogue(branch.mind,{at:0,counterparty:'player',speaker:'self',text:response.text,topic:response.topic,subject:response.subject,followUp:response.followUp});
            branch.pendingAction={id:'followup:1',intent:'ask',label:response.followUp,description:'fixture',parameters:{turn:1,topic:response.topic}};
            for(const continuation of ordinaryResponses(branch,'ask',true,0,world)) {
              if(/[\u3400-\u9fff]/u.test(translate(continuation.text,'en')))missing.add(continuation.text);
              if(continuation.followUp&&/[\u3400-\u9fff]/u.test(translate(continuation.followUp,'en')))missing.add(continuation.followUp);
            }
          }
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});

import { performService, objective, activeOrder, advance, getOptions, playerInteract, applyDecision } from '../src/sim';
import { settleDelivery } from '../src/sim/survival';
function advanceFor(world: ReturnType<typeof createWorld>,seconds:number){for(let remaining=seconds;remaining>0;remaining-=5)advance(world,Math.min(5,remaining));}

describe('delivery presentation coverage',()=>{
  it('covers accepted, preparing, ready, carrying, late, cold and completed delivery facts without losing numbers',()=>{
    const world=createWorld();Object.assign(world.player,{x:1032,y:456});
    const check=(text:string)=>expect(translate(text,'en'),text).not.toMatch(/[\u3400-\u9fff]/u);
    const checkState=()=>{const task=objective(world);[task.label,task.title,task.detail,...world.events.map(event=>event.text)].forEach(check);};
    checkState();
    check(performService(world,`accept:${world.survival.orders[0].id}`));checkState();
    check(performService(world,'pickup'));
    advanceFor(world,7);expect(activeOrder(world)?.status).toBe('ready');checkState();check(performService(world,'pickup'));expect(activeOrder(world)?.status).toBe('carrying');checkState();
    advanceFor(world,56);checkState();
    advanceFor(world,70);checkState();
    const order=activeOrder(world)!;const npc=world.npcs.find(n=>n.id===order.customerId)!;Object.assign(world.player,{x:npc.x,y:npc.y});
    getPlayerInteractions(world,npc.id).forEach(action=>{check(action.label);check(action.description);});
    check(settleDelivery(world,npc.id,'receive_reduced')!);checkState();
    expect(translate('120 秒内送达；靠近后按 E，在人物面板点击交付。','en')).toContain('120');
  });
});

describe('work and effect presentation coverage',()=>{
  it('translates offers, promises, timed help, payment, memories and decision effects for every resident',()=>{
    const missing=new Set<string>();
    const check=(text:string)=>{if(/[\u3400-\u9fff]/u.test(translate(text,'en')))missing.add(text);};
    for(const id of ['lin','tang','mei','lan','zhou']) {
      const world=createWorld(),npc=world.npcs.find(n=>n.id===id)!;Object.assign(world.player,{x:npc.x,y:npc.y});
      const inspect=()=>{
        [npc.activity,npc.bubble??'',...world.events.map(e=>e.text),...npc.mind.experiences.map(e=>e.detail),...npc.mind.commitments.map(c=>c.description),...world.decisions.flatMap(d=>[d.label,...d.changes??[]])].forEach(check);
        getOptions(world,id).forEach(o=>check(o.label));
        getPlayerInteractions(world,id).forEach(a=>{check(a.label);check(followUpDescription(npc,a));});
      };
      check(playerInteract(world,id,'request'));applyDecision(world,id,'request_help','rules');inspect();
      check(playerInteract(world,id,'promise'));applyDecision(world,id,'accept_promise','rules');inspect();
      check(playerInteract(world,id,'help'));applyDecision(world,id,'accept_help','rules');inspect();
      advanceFor(world,13);inspect();
    }
    expect([...missing]).toEqual([]);
  });
});

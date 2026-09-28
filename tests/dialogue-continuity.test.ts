import { describe, expect, it } from 'vitest';
import { advance, applyDecision, createWorld, getOptions, playerInteract, serializeWorld, loadWorld } from '../src/sim';
import { getPlayerInteractions } from '../src/sim/interactions';
import { cancelNpcJob, progressNpcJob, startNpcJob } from '../src/sim/npcLife';
import { createMind } from '../src/character';
import { recordDialogue } from '../src/character/dialogue';
import { FogHarborEnvironment } from '../src/adapters/fog-harbor/environment';
import { ordinaryResponses } from '../src/sim/dialogue';
import type { World } from '../src/sim';

function speak(w: World, id: string, action: string, choice: string) {
  const n = w.npcs.find(n => n.id === id)!;
  Object.assign(w.player, { x:n.x, y:n.y });
  playerInteract(w,id,action);
  expect(applyDecision(w,id,choice,'test')).toBe(true);
  return n.bubble!;
}
describe('sustained grounded dialogue', () => {
  it('does not pitch the same offered job again during ordinary chat', () => {
    const w=createWorld(),n=w.npcs[0];speak(w,n.id,'request','request_help');
    playerInteract(w,n.id,'ask');
    expect(getOptions(w,n.id).some(o=>o.id==='request_help')).toBe(false);
  });
  it('bounds generic dialogue history and gates rewards independently of eviction', () => {
    const mind=createMind({role:'librarian',traits:[],values:[],speakingStyle:'quiet'});
    for(let i=0;i<40;i++) expect(recordDialogue(mind,{counterparty:'visitor',topic:`book-${i}`,text:`Book ${i}`,at:0},true)).toBe(i===0);
    expect(mind.dialogue.turns).toHaveLength(24);
    expect(recordDialogue(mind,{counterparty:'visitor',topic:'new',text:'A new day',at:120},true)).toBe(true);
    const before=JSON.stringify(mind);
    expect(()=>recordDialogue(mind,{counterparty:'visitor',topic:'new',text:'past',at:119},true)).toThrow();
    expect(JSON.stringify(mind)).toBe(before);
  });
  it('rejects future dialogue in saves', () => {
    const w=createWorld();speak(w,'lin','ask','reply');
    w.npcs[0].mind.dialogue.turns[0].at=1;
    expect(loadWorld(serializeWorld(w))).toBeNull();
  });
  it('rejects a delayed followup once its topic window expires', () => {
    const w=createWorld(),n=w.npcs[0];speak(w,n.id,'ask','reply');
    const follow=getPlayerInteractions(w,n.id).find(o=>o.id.startsWith('followup:'))!;
    playerInteract(w,n.id,follow.id);
    const turn=new FogHarborEnvironment({world:()=>w,running:()=>true,allows:()=>true}).openTurn(n.id)!;
    w.time=120;
    expect(turn.isCurrent()).toBe(false);
    const before=serializeWorld(w);
    expect(turn.execute({choice:'reply:detail',affect:'warm'},'test').status).toBe('rejected');
    expect(serializeWorld(w)).toBe(before);
  });
  it('rejects a captured repetition acknowledgement when its semantics and reward expire', () => {
    const w=createWorld(),n=w.npcs[0];speak(w,n.id,'ask','reply');
    w.time=119;playerInteract(w,n.id,'ask');
    const turn=new FogHarborEnvironment({world:()=>w,running:()=>true,allows:()=>true}).openTurn(n.id)!;
    expect(turn.input.options.find(o=>o.id==='reply')?.description).toContain('close-topic');
    advance(w,1);
    expect(turn.isCurrent()).toBe(false);
    expect(turn.execute({choice:'reply',affect:'warm'},'test').status).toBe('rejected');
  });
  it('does not replay the same state plan or farm social satisfaction across topics', () => {
    const w=createWorld(), n=w.npcs[0];
    speak(w,n.id,'ask','reply:state');
    const after=n.needs.social;
    playerInteract(w,n.id,'ask');
    expect(getOptions(w,n.id).some(o=>o.id==='reply:state')).toBe(false);
    expect(applyDecision(w,n.id,'reply','test')).toBe(true);
    expect(n.needs.social).toBe(after);
  });
  it('offers a specific followup after spoken values, then closes the exhausted topic', () => {
    const w=createWorld(), n=w.npcs[0];
    expect(getPlayerInteractions(w,n.id).some(o=>o.id.startsWith('followup:'))).toBe(false);
    const first=speak(w,n.id,'ask','reply');
    const follow=getPlayerInteractions(w,n.id).find(o=>o.id.startsWith('followup:'))!;
    expect(follow).toBeDefined();
    const second=speak(w,n.id,follow.id,'reply:detail');
    expect(second).not.toBe(first);
    expect(second).toContain('价钱');
    expect(getPlayerInteractions(w,n.id).some(o=>o.id.startsWith('followup:'))).toBe(false);
    expect(playerInteract(w,n.id,follow.id)).toContain('当前没有');
  });
  it('retains dialogue across saves and migrates old minds without inventing past dialogue', () => {
    const w=createWorld(),n=w.npcs[0];
    speak(w,n.id,'ask','reply:state');
    const saved=loadWorld(serializeWorld(w))!;
    Object.assign(saved.player,{x:n.x,y:n.y});
    playerInteract(saved,n.id,'ask');
    expect(getOptions(saved,n.id).some(o=>o.id==='reply:state')).toBe(false);
    const old=JSON.parse(serializeWorld(w));
    for(const npc of old.npcs) delete npc.mind.dialogue;
    expect(loadWorld(JSON.stringify(old))).not.toBeNull();
  });
  it('only offers a shared work experience to the NPC who remembers helping', () => {
    const w=createWorld(),n=w.npcs[0];
    expect(ordinaryResponses(n,'ask',true,w.time,w).some(r=>r.id==='reply:history')).toBe(false);
    n.mind.experiences.push({id:'help',at:0,event:'kept_word',detail:'玩家留下来完成了实在的工作，我支付了报酬。',salience:.8,source:'experienced',relatedTo:'player'});
    expect(ordinaryResponses(n,'ask',true,w.time,w).find(r=>r.id==='reply:history')?.text).toContain('整理货架');
    expect(ordinaryResponses(w.npcs[2],'ask',true,w.time,w).some(r=>r.id==='reply:history')).toBe(false);
  });
  it('elaborates on shared history rather than repeating the report with a prefix', () => {
    const w=createWorld(),n=w.npcs[0];
    n.mind.experiences.push({id:'help',at:0,event:'kept_word',detail:'玩家完成工作',salience:.8,source:'experienced',relatedTo:'player'});
    const first=speak(w,n.id,'ask','reply:history');
    const follow=getPlayerInteractions(w,n.id).find(o=>o.id.startsWith('followup:'))!;
    const second=speak(w,n.id,follow.id,'reply:detail');
    expect(second).not.toContain(first);
    expect(second).toContain('信任');
    expect(n.mind.commitments).toHaveLength(0);
  });
  it('records reciprocal public social evidence only after a completed nearby conversation', () => {
    const w=createWorld(),a=w.npcs[0],b=w.npcs[2],outsider=w.npcs[1];
    Object.assign(b,{x:a.x,y:a.y});
    b.needs.energy=20;
    const option={id:'seek:mei',label:'找梅姐聊聊',description:'public chat',kind:'npc_job',target:'mei'};
    expect(startNpcJob(w,a,option)).toBe(true);
    expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);
    expect(ordinaryResponses(a,'ask',true,w.time,w).some(r=>r.id==='reply:neighbor')).toBe(false);
    w.time=8;progressNpcJob(w,a);
    const response=ordinaryResponses(a,'ask',true,w.time,w).find(r=>r.id==='reply:neighbor');
    expect(response?.text).toContain('梅姐');
    expect(response?.text).toContain('累');
    expect(response?.text).not.toContain('欠');
    expect(b.mind.knowledge.some(k=>k.topic==='public-chat:lin')).toBe(true);
    expect(ordinaryResponses(outsider,'ask',true,w.time,w).some(r=>r.id==='reply:neighbor')).toBe(false);
    w.time+=181;
    expect(ordinaryResponses(a,'ask',true,w.time,w).some(r=>r.id==='reply:neighbor')).toBe(false);
  });
  it('does not exchange news from an interrupted conversation', () => {
    const w=createWorld(),a=w.npcs[0],b=w.npcs[2];Object.assign(b,{x:a.x,y:a.y});
    startNpcJob(w,a,{id:'seek:mei',label:'chat',description:'chat',kind:'npc_job',target:b.id});
    expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);
    cancelNpcJob(w,a,'interrupted');w.time=8;progressNpcJob(w,a);
    expect(a.mind.knowledge.some(k=>k.topic==='public-chat:mei')).toBe(false);
    expect(b.mind.knowledge.some(k=>k.topic==='public-chat:lin')).toBe(false);
  });
  it('does not silently switch the person when following up a spoken neighbor report', () => {
    const w=createWorld(),a=w.npcs[0],b=w.npcs[2];Object.assign(b,{x:a.x,y:a.y});
    startNpcJob(w,a,{id:'seek:mei',label:'chat',description:'chat',kind:'npc_job',target:b.id});expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);w.time=8;progressNpcJob(w,a);
    speak(w,a.id,'ask','reply:neighbor');
    const follow=getPlayerInteractions(w,a.id).find(o=>o.id.startsWith('followup:'))!;
    const claim=a.mind.knowledge.find(k=>k.topic==='public-chat:mei')!;claim.validUntil=9;
    a.mind.knowledge.push({...claim,id:'other-chat',topic:'public-chat:lan',value:'阿岚说有些累。',source:{kind:'heard',from:'lan'},learnedAt:9,validUntil:100});w.time=9;
    const result=speak(w,a.id,follow.id,'reply:detail');
    expect(result).not.toContain('阿岚');expect(result).toContain('确认');
  });
  it('does not crash or quote an oversized imported public report', () => {
    const w=createWorld(),n=w.npcs[0];
    n.mind.knowledge.push({id:'long-report',topic:'public-chat:mei',value:'近况'.repeat(600),learnedAt:0,source:{kind:'heard',from:'mei'},confidence:1});
    const restored=loadWorld(serializeWorld(w))!;expect(restored).not.toBeNull();
    Object.assign(restored.player,{x:n.x,y:n.y});playerInteract(restored,n.id,'ask');
    expect(()=>getOptions(restored,n.id)).not.toThrow();
    expect(getOptions(restored,n.id).some(o=>o.id==='reply:neighbor')).toBe(false);
  });
  it('keeps answering about the earlier named neighbor when newer news is available', () => {
    const w=createWorld(),a=w.npcs[0],b=w.npcs[2];Object.assign(b,{x:a.x,y:a.y});
    startNpcJob(w,a,{id:'seek:mei',label:'chat',description:'chat',kind:'npc_job',target:b.id});expect(applyDecision(w,b.id,'social:accept','test')).toBe(true);w.time=8;progressNpcJob(w,a);
    speak(w,a.id,'ask','reply:neighbor');
    const follow=getPlayerInteractions(w,a.id).find(o=>o.id.startsWith('followup:'))!;
    a.mind.knowledge.push({id:'new-chat',topic:'public-chat:lan',value:'阿岚说有些累。',source:{kind:'heard',from:'lan'},learnedAt:9,validUntil:100,confidence:1});w.time=9;
    const result=speak(w,a.id,follow.id,'reply:detail');
    expect(result).toContain('梅姐');expect(result).not.toContain('阿岚');
  });
});

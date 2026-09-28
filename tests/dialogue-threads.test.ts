import {describe,expect,it} from 'vitest';
import {createMind,mindSchema} from '../src/character';
import {recordDialogue,recordDialogueExchange,recentlySaid,openDialogueTopics} from '../src/character/dialogue';
import {applyDecision,createWorld,loadWorld,playerInteract,serializeWorld,getOptions} from '../src/sim';
import {getPlayerInteractions} from '../src/sim/interactions';
import {notePersonalEvent} from '../src/sim/personalLife';
import type {World} from '../src/sim';
const mind=()=>createMind({role:'host',traits:[],values:[],speakingStyle:'plain'});
function say(w:World,id:string,action:string,choice:string){const n=w.npcs.find(n=>n.id===id)!;Object.assign(w.player,{x:n.x,y:n.y});playerInteract(w,id,action);expect(applyDecision(w,id,choice,'test')).toBe(true);return n.bubble;}
describe('conversation threads',()=>{
  it('safely ends a legacy pending menu contract instead of leaving it unanswerable',()=>{
    const w=createWorld();say(w,'mei','ask:plans','reply:goal');const follow=getPlayerInteractions(w,'mei').find(a=>a.parameters.topic==='plan')!;
    playerInteract(w,'mei',follow.id);w.npcs[2].pendingAction!.description='旧版追问说明';
    const restored=loadWorld(serializeWorld(w))!;expect(restored).not.toBeNull();expect(restored.npcs[2].pendingInteraction).toBeUndefined();expect(restored.npcs[2].pendingAction).toBeUndefined();
    expect(restored.npcs[2].mind.dialogue).toEqual(w.npcs[2].mind.dialogue);expect(restored.player.money).toBe(w.player.money);
  });
  it('rejects an exhausted exchange before consuming gifts or changing trust',()=>{
    const w=createWorld(),n=w.npcs[2];Object.assign(w.player,{x:n.x,y:n.y});playerInteract(w,n.id,'gift:热茶');
    n.mind.dialogue.nextSequence=999999999;const before=serializeWorld(w);
    expect(applyDecision(w,n.id,'accept_gift','test')).toBe(false);expect(serializeWorld(w)).toBe(before);
  });
  it('does not offer extension past a valid imported depth limit',()=>{
    const w=createWorld(),n=w.npcs[2];Object.assign(w.player,{x:n.x,y:n.y});
    recordDialogue(n.mind,{counterparty:'player',topic:'plan',subject:'goal:personal-routine',text:'Plan',followUp:'Why?',depth:16,at:0});
    const restored=loadWorld(serializeWorld(w))!;expect(restored).not.toBeNull();
    expect(getPlayerInteractions(restored,n.id).some(a=>a.id.startsWith('followup:'))).toBe(false);
  });
  it('commits both sides atomically even when the second turn is invalid',()=>{
    const valid=mind();expect(recordDialogueExchange(valid,{counterparty:'v',topic:'p',text:'Question',at:0},{counterparty:'v',topic:'p',text:'Answer',at:0},true)).toBe(true);
    expect(valid.dialogue.turns.map(t=>t.speaker)).toEqual(['other','self']);
    const m=mind(),before=JSON.stringify(m);
    expect(()=>recordDialogueExchange(m,{counterparty:'v',topic:'p',text:'Question',at:0},{counterparty:'v',topic:'p',text:'Answer',depth:17,at:0},true)).toThrow();
    expect(JSON.stringify(m)).toBe(before);
    m.dialogue.nextSequence=999999999;const full=JSON.stringify(m);
    expect(()=>recordDialogueExchange(m,{counterparty:'v',topic:'p',text:'Question',at:0},{counterparty:'v',topic:'p',text:'Answer',at:0})).toThrow();
    expect(JSON.stringify(m)).toBe(full);
  });
  it('names separate spoken feelings so returning to a topic is unambiguous',()=>{
    const w=createWorld(),n=w.npcs[2];notePersonalEvent(n,'gift','gift',0);say(w,n.id,'ask:feelings','reply:feeling');
    notePersonalEvent(n,'broken_promise','broken',0);say(w,n.id,'ask:feelings','reply:feeling');
    const topics=getPlayerInteractions(w,n.id).filter(a=>a.parameters.topic==='feeling');
    expect(topics).toHaveLength(2);expect(new Set(topics.map(t=>t.label)).size).toBe(2);
    expect(topics.some(t=>t.label.includes('爽约'))).toBe(true);expect(topics.some(t=>t.label.includes('心意'))).toBe(true);
  });
  it('uses distinct spoken goal names when returning to multiple plans',()=>{
    const w=createWorld();say(w,'mei','ask:plans','reply:goal');const text=say(w,'mei','ask:plans','reply:goal:personal-interest');expect(text).not.toContain('想试想');
    const options=getPlayerInteractions(w,'mei').filter(a=>a.parameters.topic==='plan');
    expect(options).toHaveLength(2);expect(new Set(options.map(a=>a.label)).size).toBe(2);
    expect(options.some(a=>a.label.includes('茶点'))).toBe(true);
  });
  it('continues from a feeling to a character-specific coping intention without doing it',()=>{
    const w=createWorld(),n=w.npcs[1];notePersonalEvent(n,'broken_promise','missed',0);
    say(w,n.id,'ask:feelings','reply:feeling');
    let next=getPlayerInteractions(w,n.id).find(a=>a.parameters.topic==='feeling')!;
    say(w,n.id,next.id,'reply:detail');
    next=getPlayerInteractions(w,n.id).find(a=>a.parameters.topic==='feeling')!;expect(next).toBeDefined();
    const before={energy:n.needs.energy,money:w.player.money,feelings:JSON.stringify(n.mind.personal.feelings)};
    const response=say(w,n.id,next.id,'reply:detail');expect(response).toContain('水边');
    expect(n.needs.energy).toBe(before.energy);expect(w.player.money).toBe(before.money);expect(JSON.stringify(n.mind.personal.feelings)).toBe(before.feelings);expect(n.job).toBeNull();
  });
  it('rejects cross-counterparty references in imported dialogue',()=>{
    const m=mind();recordDialogue(m,{counterparty:'a',topic:'private',text:'A',at:0});recordDialogue(m,{counterparty:'b',topic:'b',text:'B',at:0});
    m.dialogue.turns[1].inReplyTo=1;expect(mindSchema.safeParse(m).success).toBe(false);
  });
  it('separates speaker identity, reward eligibility and response repetition',()=>{
    const m=mind();expect(recordDialogue(m,{speaker:'other',counterparty:'visitor',topic:'greet',text:'Hello',at:0},true)).toBe(false);
    expect(recentlySaid(m,'visitor','Hello',0)).toBe(false);
    expect(recordDialogue(m,{counterparty:'visitor',topic:'greet',text:'Hello',at:0},true)).toBe(true);
    expect(m.dialogue.turns.map(t=>t.speaker)).toEqual(['other','self']);
  });
  it('keeps bounded, detached, counterparty-specific spoken topics and closes answered questions',()=>{
    const m=mind();
    recordDialogue(m,{counterparty:'visitor',topic:'plan',subject:'plan:one',text:'One',followUp:'How?',at:0});
    recordDialogue(m,{counterparty:'stranger',topic:'secret',text:'Private',followUp:'Why?',at:0});
    recordDialogue(m,{counterparty:'visitor',topic:'feeling',text:'Fine',followUp:'Why?',at:1});
    expect(openDialogueTopics(m,'visitor',1).map(t=>t.topic)).toEqual(['feeling','plan']);
    const topics=openDialogueTopics(m,'visitor',1);topics[0].text='mutated';expect(m.dialogue.turns.at(-1)?.text).toBe('Fine');
    recordDialogue(m,{speaker:'other',counterparty:'visitor',topic:'plan',text:'How?',inReplyTo:1,at:2});
    expect(openDialogueTopics(m,'visitor',2).map(t=>t.topic)).toEqual(['feeling']);
    expect(openDialogueTopics(m,'visitor',121)).toEqual([]);
  });
  it('defaults legacy turns to self without inventing player utterances',()=>{
    const m=mind();recordDialogue(m,{counterparty:'visitor',topic:'plan',text:'Plan',at:0});
    const raw=JSON.parse(JSON.stringify(m));delete raw.dialogue.turns[0].speaker;delete raw.dialogue.turns[0].depth;
    const restored=mindSchema.parse(raw);expect(restored.dialogue.turns).toHaveLength(1);expect(restored.dialogue.turns[0].speaker).toBe('self');
  });
  it('returns to a previously spoken plan after another topic and continues beyond one followup',()=>{
    const w=createWorld(),n=w.npcs[2];
    say(w,n.id,'ask:plans','reply:goal');
    const first=getPlayerInteractions(w,n.id).find(a=>a.parameters.topic==='plan')!;
    say(w,n.id,'ask:feelings','reply');
    expect(getPlayerInteractions(w,n.id).some(a=>a.id===first.id)).toBe(true);
    say(w,n.id,first.id,'reply:detail');
    const next=getPlayerInteractions(w,n.id).find(a=>a.parameters.topic==='plan')!;
    expect(next).toBeDefined();expect(next.id).not.toBe(first.id);
    const second=say(w,n.id,next.id,'reply:detail');expect(second).toContain('茶馆');
    expect(n.mind.personal.goals.every(g=>g.receipts.length===0)).toBe(true);expect(n.mind.commitments).toHaveLength(0);
    expect(getPlayerInteractions(w,n.id).some(a=>a.parameters.topic==='plan')).toBe(false);
    expect(n.mind.dialogue.turns.filter(t=>t.speaker==='other').map(t=>t.text)).toContain(first.label);
    expect(loadWorld(serializeWorld(w))?.npcs[2].mind.dialogue).toEqual(n.mind.dialogue);
  });
  it('does not expose unspoken personal topics in another character menu',()=>{
    const w=createWorld();say(w,'mei','ask:plans','reply:goal');const n=w.npcs[1];Object.assign(w.player,{x:n.x,y:n.y});
    expect(getPlayerInteractions(w,n.id).some(a=>a.id.startsWith('followup:'))).toBe(false);
  });
  it('invalidates stale saved followups and does not advance state through their text',()=>{
    const w=createWorld();say(w,'tang','ask:plans','reply:goal');const follow=getPlayerInteractions(w,'tang').find(a=>a.parameters.topic==='plan')!;
    w.time=120;expect(playerInteract(w,'tang',follow.id)).toContain('当前没有');
    expect(getOptions(w,'tang').some(a=>a.id==='reply:detail')).toBe(false);
  });
  it('gives Mei and Tang distinct grounded voices without narrating implementation rules',()=>{
    const replies:string[]=[];
    for(const id of ['mei','tang']){
      const w=createWorld(),n=w.npcs.find(n=>n.id===id)!;
      const first=say(w,id,'ask:plans','reply:goal')!;
      expect(first).toContain('头一回还没做完');
      let follow=getPlayerInteractions(w,id).find(a=>a.parameters.topic==='plan')!;
      const detail=say(w,id,follow.id,'reply:detail')!;
      follow=getPlayerInteractions(w,id).find(a=>a.parameters.topic==='plan')!;
      const reason=say(w,id,follow.id,'reply:detail')!;
      expect(first+detail+reason).not.toMatch(/\d+\/\d+|凑数|凑够次数|不是现在说说就算|不会说已经能卖/);
      expect(n.mind.personal.goals.every(g=>g.receipts.length===0)).toBe(true);
      expect(n.mind.commitments).toHaveLength(0);expect(n.job).toBeNull();
      replies.push(reason);
    }
    expect(replies[0]).toContain('茶馆');expect(replies[1]).toContain('水边');expect(replies[0]).not.toBe(replies[1]);
  });
  it('admits uncertainty when a named feeling expires instead of repeating its event as current',()=>{
    const w=createWorld(),n=w.npcs[2];notePersonalEvent(n,'gift','past-gift',0);
    n.mind.personal.feelings[0].until=2;
    expect(say(w,n.id,'ask:feelings','reply:feeling')).toContain('心意');
    const follow=getPlayerInteractions(w,n.id).find(a=>a.parameters.topic==='feeling')!;
    w.time=2;
    const before={goals:structuredClone(n.mind.personal.goals),feelings:structuredClone(n.mind.personal.feelings),money:w.player.money,inventory:[...w.player.inventory]};
    const response=say(w,n.id,follow.id,'reply:detail')!;
    expect(response).toContain('确认');expect(response).not.toContain('心意');expect(response).not.toContain('还暖着');
    expect(n.mind.dialogue.turns.at(-1)?.topic).toBe('close-topic');
    expect(n.mind.personal.goals).toEqual(before.goals);expect(n.mind.personal.feelings).toEqual(before.feelings);
    expect(w.player.money).toBe(before.money);expect(w.player.inventory).toEqual(before.inventory);
    expect(loadWorld(serializeWorld(w))).not.toBeNull();
  });
});

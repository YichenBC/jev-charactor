import { selectInteractionChoice, type InteractionChoice } from '../character/interaction';
import { openDialogueTopics } from '../character/dialogue';
import { SECRET_FACTS } from './data';
import { distance } from './navigation';
import { activeOrder, isFood, orderCondition, parcelName } from './survival';
import type { Npc, World } from './types';

import { isHelpPromise, CHORES, CHORE_SECONDS, CHORE_REWARD, RETURN_SECONDS, offeredWork } from './work';
export { CHORES, CHORE_SECONDS, CHORE_REWARD, RETURN_SECONDS } from './work';
export function choreAvailable(world: World, npc: Npc): boolean { return Boolean(offeredWork(world, npc)); }

/** Only player-visible facts and previously spoken offers create player subjects. */
function choices(world: World, npc: Npc): InteractionChoice[] {
  if (world.survival.dead || world.player.activity || distance(world.player,npc)>110) return [];
  const result: InteractionChoice[]=[];
  const add=(id:string,intent:string,label:string,description:string,subject?:InteractionChoice['subject'],parameters:InteractionChoice['parameters']={}) => result.push({id,intent,label,description,...(subject?{subject}:{}),parameters});
  const order=activeOrder(world);
  if(order?.customerId===npc.id && order.status==='carrying' && world.player.inventory.includes(parcelName(order))) {
    const subject={id:order.id,label:'这份外卖'};
    add('deliver','deliver','你的外卖到了。','交出对应餐品，由收件人验收并决定付款。',subject);
    const condition=orderCondition(world,order);
    if(condition.late||condition.cold) add('explain','explain','抱歉送晚了，这份餐你还愿意收吗？','说明耽搁并交付，对方可按约付款、减款或拒收。',subject);
  }
  add('greet','greet',npc.knownFacts.includes('met-player')?'又见面了，今天怎么样？':'你好，我刚搬来，认识一下吧。','向对方打招呼。');
  add('ask','ask','最近有什么想聊的吗？','对方可以闲聊、提出请求，或选择不谈。');
  add('ask:plans','ask','最近有什么自己的打算？','可以聊聊个人计划，也可以选择不谈。',undefined,{focus:'plans'});
  add('ask:feelings','ask','最近心情怎么样？','询问近来的感受，不预先假定对方经历了什么。',undefined,{focus:'feelings'});
  for(const spoken of openDialogueTopics(npc.mind,'player',world.time)) {
    const excerpt=[...spoken.text].slice(0,48).join('');
    add(`followup:${spoken.sequence}`,'ask',spoken.followUp!,`之前你说：“${excerpt}${[...spoken.text].length>48?'…':''}” 追问不代表接受工作或作出承诺。`,
      {id:`turn:${spoken.sequence}`,label:'之前谈到的话题'},{topic:spoken.topic,turn:spoken.sequence});
  }
  const offered=offeredWork(world,npc);
  const promise=npc.mind.commitments.find(c=>isHelpPromise(c.id)&&c.status==='active');
  const chore={id:offered?.id ?? `chore:${npc.id}`,label:CHORES[npc.id]};
  const terms={duration:CHORE_SECONDS,reward:CHORE_REWARD,...(offered ? {taskId:offered.id} : {})};
  {
    if(!offered) add('request','request','这里有我能帮忙做的活吗？','先问清楚具体工作与报酬，再决定是否接受。');
    else {
      add('help','help',promise?`我回来${chore.label}了。`:`我现在就来${chore.label}。`,`工作 ${CHORE_SECONDS} 秒，完成后获得 ${CHORE_REWARD} 元；中止不付报酬。`,chore,terms);
      if(!promise) {
        add('promise','promise',`我在 ${RETURN_SECONDS} 秒内回来${chore.label}，可以吗？`,`请求约定：${RETURN_SECONDS} 秒内回来开始工作，完成后获得 ${CHORE_REWARD} 元；对方同意后才生效。`,chore,{...terms,returnWithin:RETURN_SECONDS});
        add('decline','decline','这份活我先不接了。','拒绝当前提议，不产生承诺或付款。',chore,{taskId:offered.id});
      }
    }
  }
  if(!world.flags[`gift_${npc.id}`]) for(const item of new Set(world.player.inventory.filter(isFood))) {
    add(`gift:${item}`,'gift',`这份${item}给你，要吗？`,'对方接受后才从背包取出这一份食物；拒绝不消耗。',{id:item,label:item},{item});
  }
  const fact=SECRET_FACTS[npc.id];
  if(fact && world.player.knowledge.includes(fact.id)) add('expose','expose',`当街提起：${fact.text}`,'公开说起已知私事，附近居民可能听见，可能伤害信任。',{id:fact.id,label:fact.text});
  if(npc.knownFacts.includes('hurt-by-player')&&!npc.knownFacts.includes('apology-accepted')) add('apologize:exposure','apologize','上次当众说了你的私事，对不起。','为公开私事道歉。对方可以接受，也可以拒绝。',{id:'exposure',label:'当众谈论私事'},{incident:'exposure'});
  const broken = [...npc.mind.commitments].reverse().find(c => isHelpPromise(c.id) && c.status === 'broken' && !npc.knownFacts.includes(`apology:${c.id}`) && !(c.id === 'help-player' && world.flags[`apology_promise_${npc.id}`]));
  if(broken) add('apologize:promise','apologize','上次约好回来帮忙，我却没来，对不起。','为爽约道歉。即使被原谅，失约经历也不会消失。',{id:broken.id,label:'没有履行帮忙约定'},{incident:'promise',promiseId:broken.id});
  const priority: Record<string,number>={deliver:0,explain:1,help:2,promise:3,decline:4,apologize:5};
  return result.sort((a,b)=>(a.id.startsWith('followup:')?6:priority[a.intent]??10)-(b.id.startsWith('followup:')?6:priority[b.intent]??10));
}
export function getPlayerInteractions(world: World, npcId: string): InteractionChoice[] {
  const npc=world.npcs.find(n=>n.id===npcId);
  return !npc||npc.pendingInteraction?[]:choices(world,npc);
}
export function resolvePlayerAction(world: World,npc: Npc,id:string): InteractionChoice|undefined {
  const options=choices(world,npc);
  // Compatibility calls may omit a subject only if it is unambiguous.
  const aliases=options.filter(o=>o.intent===id);
  return selectInteractionChoice(options,id) ?? (aliases.length===1?structuredClone(aliases[0]):undefined);
}
export function pendingActionCurrent(world: World,npc: Npc): boolean {
  if(!npc.pendingInteraction)return true;
  if(!npc.pendingAction)return false;
  const current=resolvePlayerAction(world,npc,npc.pendingAction.id);
  return current?.intent===npc.pendingInteraction && JSON.stringify(current)===JSON.stringify(npc.pendingAction);
}

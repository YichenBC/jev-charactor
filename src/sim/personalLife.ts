import { addFeeling, addGoal, advanceGoal, inspectPersonal } from '../character/personal';
import type { Npc } from './types';

/** Authored life content belongs to the host, not to the portable mind. */
export const PERSONAL_LIFE: Record<string,{hobby:string;place:string;plan:string;routine:string;activity:string;preferences:Array<{activity:string;label:string;weight:number}>}> = {
  lin:{hobby:'翻看旧货品图册',place:'shop',plan:'抽空读完三段货品图册',routine:'认真处理两次店里的事务',activity:'work',preferences:[{activity:'work',label:'喜欢把店里的事情安排妥当',weight:1.4},{activity:'hobby',label:'闲时喜欢看旧货品图册',weight:.8}]},
  tang:{hobby:'画一幅水边速写',place:'watch',plan:'积累三幅水边速写',routine:'和街坊认真聊两次日常',activity:'social',preferences:[{activity:'hobby',label:'更愿意把空闲留给画画',weight:1.8},{activity:'social',label:'喜欢听人分享日常见闻',weight:1.1}]},
  mei:{hobby:'琢磨一份茶点搭配',place:'tavern',plan:'试想三份茶点搭配',routine:'把两次茶馆事务处理妥当',activity:'work',preferences:[{activity:'work',label:'手头事情办妥才比较安心',weight:1.5},{activity:'hobby',label:'喜欢琢磨茶点的搭配',weight:1.1}]},
  lan:{hobby:'写一段沿途见闻',place:'post',plan:'记下三段送信路上的见闻',routine:'踏实完成三次驿站事务',activity:'work',preferences:[{activity:'work',label:'在意把工作按时办好',weight:1.6},{activity:'hobby',label:'忙完后愿意写写沿途见闻',weight:.9}]},
  zhou:{hobby:'听潮并记下观察',place:'watch',plan:'留下三段水边观察',routine:'完成两次街坊间的闲谈',activity:'social',preferences:[{activity:'social',label:'愿意耐心听街坊说话',weight:1.4},{activity:'hobby',label:'喜欢安静观察水边的变化',weight:1.4}]},
};
export function initializePersonalLife(npc:Npc,now:number) {
  const content=PERSONAL_LIFE[npc.id];
  if(!npc.mind.personal.preferences.length){npc.mind.personal.preferences=structuredClone(content.preferences);npc.mind.revision++;}
  addGoal(npc.mind,{id:'personal-interest',label:content.plan,activity:'hobby',target:3,createdAt:now});
  addGoal(npc.mind,{id:'personal-routine',label:content.routine,activity:content.activity,target:npc.id==='lan'?3:2,createdAt:now});
}
export function hobbyReady(npc:Npc,now:number):boolean {
  return npc.needs.energy>=20&&npc.needs.hunger>=20&&!inspectPersonal(npc.mind,now).feelings.some(f=>f.basis==='completed:hobby');
}
export function finishPersonalActivity(npc:Npc,activity:string,eventId:string,now:number) {
  const content=PERSONAL_LIFE[npc.id];
  const label:Record<string,string>={eat:'吃过饭后，身上踏实了些',rest:'歇过脚，精神松快了些',social:'和街坊聊过，心里暖和些',work:'办完手头的事，心里轻松些',hobby:`刚刚${content.hobby}，有些满足`};
  const preference=npc.mind.personal.preferences.find(p=>p.activity===activity)?.weight??1;
  addFeeling(npc.mind,{id:eventId,label:label[activity],basis:`completed:${activity}`,valence:1,strength:Math.min(.9,.4*preference),since:now,until:now+(activity==='hobby'?180:120)});
  for(const goal of npc.mind.personal.goals.filter(g=>g.activity===activity))advanceGoal(npc.mind,goal.id,{id:eventId,at:now});
}
export function notePersonalEvent(npc:Npc,kind:string,id:string,now:number) {
  const appraisals:Record<string,{label:string;valence:number;strength:number;duration:number}>={
    broken_promise:{label:'被爽约的失落还没散去',valence:-1,strength:.8,duration:240},
    broken_delivery:{label:'等餐落空，心里有些烦闷',valence:-1,strength:.7,duration:180},
    kept_word:{label:'你认真帮过忙，这让我安心',valence:1,strength:.65,duration:180},
    exposure:{label:'私事被公开，让我很不舒服',valence:-1,strength:.9,duration:300},
    gift:{label:'收到你的一份心意，心里暖和些',valence:1,strength:.5,duration:120},
    apology:{label:'听到了道歉，心情缓和了一点',valence:1,strength:.25,duration:90},
  };
  const appraisal=appraisals[kind];if(!appraisal)return;
  addFeeling(npc.mind,{id,label:appraisal.label,basis:`event:${kind}`,valence:appraisal.valence,strength:appraisal.strength,since:now,until:now+appraisal.duration});
}

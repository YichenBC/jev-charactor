import { learnKnowledge } from '../character/knowledge';
import { event } from './events';
import type { Npc, World } from './types';

/** Authored public self-report. Private concerns and omniscient world history never enter it. */
function publicStatement(npc: Npc): string {
  if (npc.needs.energy < 40) return '有些累，想找时间歇歇脚。';
  if (npc.needs.hunger < 40) return '有些饿，想找时间吃顿饭。';
  if (npc.needs.workPressure >= 60) return '手头的事情不少，想先把工作理顺。';
  return '吃饭和休息都还顾得上，愿意和街坊聊聊。';
}

/** Called only after the host verifies a completed face-to-face social job. */
export function exchangePublicNews(world: World, first: Npc, second: Npc): void {
  for (const [listener,speaker] of [[first,second],[second,first]]) {
    const topic=`public-chat:${speaker.id}`;
    const previous=listener.mind.knowledge.filter(k=>k.topic===topic && k.retiredAt===undefined).map(k=>k.id);
    const value=`${speaker.name.slice(0,120)}说自己${publicStatement(speaker)}`;
    learnKnowledge(listener.mind,{id:`chat:${listener.id}:${listener.mind.revision}:${world.time}`,topic,value,learnedAt:world.time,
      validUntil:world.time+180,source:{kind:'heard',from:speaker.id},confidence:1},previous);
    // A source-bearing public claim is enough for later speech; no bystander gets it automatically.
    listener.revision++;
    event(world,`${listener.name}听${speaker.name}聊起近况：${value}`,'public_chat',listener.id);
  }
}

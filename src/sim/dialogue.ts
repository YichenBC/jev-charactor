import { inspectBelief } from '../character/knowledge';
import { compileResponses, type ResponsePlan, type SpeechFact } from '../character/response';
import { BUILDINGS, DIALOGUE, SECRET_FACTS } from './data';
import type { Npc, World } from './types';
import { recentlySaid, openDialogueTopics } from '../character/dialogue';
import { inspectPersonal } from '../character/personal';
import { hasExtendedDialogue, planReportParts, planNextStepParts, planReasonParts, feelingReflection, feelingNextStepParts, type DialogueFragment } from './dialogueStyle';
import { CHORES, CHORE_SECONDS, CHORE_REWARD, currentWork, ownedWork, isHelpPromise } from './work';

// Authored expression belongs to this game. A reply never fabricates world events.
const SMALL_TALK: Record<string, string> = {
  lin: '我觉得街坊买东西，图的就是个放心。东西好不好、价钱怎么算，都该说清楚。',
  tang: '我喜欢画水边的光。同一个地方，换个角度看，颜色就不一样了。',
  mei: '我做生意最看重把事情说清楚。答应了什么、什么时候做，一开始讲明白，彼此都省心。',
  lan: '送信这份差事，得把别人的托付当回事。信里的私事，也不该拿来当闲话。',
  zhou: '我喜欢在水边待着。人有时候不必急着说话，静下来看看，也能想明白些事情。',
};

// Saved identity fields allow longer text than a speech fact; clip only presentation.
function identityLabel(value: string): string {
  const characters = [...value];
  return characters.length > 120 ? `${characters.slice(0, 120).join('')}…` : value;
}

/** The game owns disclosure, personality and evidence-to-language rules; the core only composes. */
function baseResponses(npc: Npc, intent: 'greet' | 'ask', alreadyMet: boolean, now: number) {
  const facts: SpeechFact[] = [];
  const fact = (id: string, text: string, basis: string) => {
    facts.push({ id, text, basis, disclosable: true, validFrom: now });
    return { fact: id };
  };
  const plans: ResponsePlan[] = [];
  if (npc.trust < 0) {
    plans.push({ id: 'reply', intent: 'keep-boundary', parts: [
      { literal: DIALOGUE[npc.id].guarded },
      ...(intent === 'ask' ? [{ literal: '近来的私事，我暂时不想细说。' }] : []),
    ] });
    return compileResponses(plans, facts, now);
  }
  if (intent === 'greet' && !alreadyMet) {
    plans.push({ id: 'reply', intent: 'introduce-self', parts: [
      { literal: '你好，' }, fact('identity', `我是${identityLabel(npc.name)}，${identityLabel(npc.role)}。`, 'profile:identity'),
    ] });
    return compileResponses(plans, facts, now);
  }
  const state: ResponsePlan['parts'] = [];
  if (npc.needs.hunger < 40) state.push(fact('hunger', '今天肚子有些饿，得找时间吃点东西。', 'needs:hunger<40'));
  if (npc.needs.energy < 40) state.push(fact('energy', '今天有些累，得找时间歇一歇。', 'needs:energy<40'));
  if (npc.needs.workPressure >= 60) state.push(fact('work', '手头还有不少事情惦记着。', 'needs:workPressure>=60'));
  if (!state.length) state.push(fact('wellbeing', '今天还应付得来，吃饭和休息都还顾得上。', 'needs:hunger>=40,energy>=40,workPressure<60'));
  if (intent === 'greet') {
    const recent = inspectPersonal(npc.mind, now).feelings.at(-1);
    plans.push({ id: 'reply', intent: 'report-current-state', parts: [
      ...(recent ? [fact('recent-feeling', `${recent.label}。`, `feeling:${recent.id}:${recent.basis}`)] : []),
      ...state,
    ] });
  }
  else {
    const family = npc.id === 'tang' ? inspectBelief(npc.mind, 'lin-debt', now) : undefined;
    const currentFamily = family?.status === 'known' && family.values.includes(SECRET_FACTS.lin.text);
    const topic = currentFamily
      ? fact('family-concern', '哥哥的事，我会和他一起想办法。家里人不该让他一个人担着。', 'belief:lin-debt:current')
      : fact('values', SMALL_TALK[npc.id], 'profile:values');
    plans.push({ id: 'reply', intent: currentFamily ? 'share-family-concern-without-details' : 'share-values', parts: [topic] });
    plans.push({ id: 'reply:state', intent: 'share-current-needs', parts: [{ literal: '说起眼下，' }, ...state] });
    if (npc.id === 'mei') {
      const building = BUILDINGS.find(b => b.id === 'tavern')!;
      const belief = inspectBelief(npc.mind, 'place:tavern', now);
      const expected = `${building.name}：${building.subtitle}。入口位于 (${building.door.x}, ${building.door.y})。`;
      // Exact owned knowledge authorizes this authored paraphrase; global map presence alone does not.
      if (belief.status === 'known' && belief.values.includes(expected)) {
        plans.push({ id: 'reply:place', intent: 'share-known-teahouse-and-own-state', parts: [
          fact('teahouse', '晚风茶馆是我照应的茶馆。', 'belief:place:tavern:current'), ...state,
          { literal: '你要是想歇歇脚，可以去那里坐坐。' },
        ] });
      }
    }
  }
  return compileResponses(plans, facts, now);
}

export type CharacterResponse = ReturnType<typeof compileResponses>[number] & {
  topic: string; followUp?: string; subject?: string; rewardEligible: boolean; depth?:number;
};
const DETAILS: Record<string,string> = {
  lin:'比如买东西，价钱和分量得先讲明白。说好能办的事就认真办；真有难处，也该提前打声招呼。',
  tang:'水上的亮色一会儿就变了。我想把那一刻画下来，所以有时候宁愿多等一会儿，也不急着落笔。',
  mei:'比如托人帮忙，我会先讲清楚做什么、花多久、给多少报酬。对方答应了，再算一份约定。',
  lan:'托付给我的信，我只管送到该收的人手里。别人愿不愿意说信里的事，应该由他们自己决定。',
  zhou:'我喜欢先听听对方到底在烦什么。有些事需要人帮忙，有些事只是需要有人听。',
};
const FOLLOWUPS: Record<string,string> = {
  plan:'你想怎么慢慢完成这个打算？', feeling:'这件事现在还影响着你吗？',
  values:'你为什么这么看重这件事？', state:'那你接下来有什么打算？', place:'你刚提到茶馆，能再说说吗？',
  history:'关于我们之前的事，你现在怎么想？', work:'你刚说的那份活，具体是怎么回事？', neighbor:'你是怎么知道这位街坊近况的？',
};
function grounded(id: string, topic: string, value: string, basis: string, now: number, followUp = true): CharacterResponse {
  const response=compileFragments(id,topic,[{text:value,basis}],now);
  return {...response,topic,subject:basis,rewardEligible:true,...(followUp && FOLLOWUPS[topic]?{followUp:FOLLOWUPS[topic]}:{})};
}
function compileFragments(id:string,intent:string,fragments:DialogueFragment[],now:number) {
  const facts=fragments.map((fragment,index)=>({...fragment,id:`detail:${index}`,disclosable:true,validFrom:now}));
  return compileResponses([{id,intent,parts:facts.map(fact=>({fact:fact.id}))}],facts,now)[0];
}

function noFeelingResponse(npc:Npc,now:number):CharacterResponse {
  const fragments:DialogueFragment[]=[{text:'一时也说不上有什么特别的心情。',basis:'personal:no-current-feeling'}];
  if(npc.needs.hunger<40)fragments.push({text:'现在有些饿，想先吃点东西。',basis:'needs:hunger<40'});
  if(npc.needs.energy<40)fragments.push({text:'现在有些累，想先歇歇脚。',basis:'needs:energy<40'});
  if(fragments.length===1)fragments.push({text:'眼下身体还应付得来，吃饭和休息都还顾得上。',basis:'needs:hunger>=40,energy>=40'});
  return {...compileFragments('reply','close-topic',fragments,now),topic:'close-topic',rewardEligible:false};
}

function extraResponses(npc: Npc, now: number, world?: World, subject?: string): CharacterResponse[] {
  const result: CharacterResponse[]=[];
  const personal=inspectPersonal(npc.mind,now);
  const goals=[...personal.goals].sort((a,b)=>Number(a.completed)-Number(b.completed)||(npc.mind.personal.preferences.find(p=>p.activity===b.activity)?.weight??1)-(npc.mind.personal.preferences.find(p=>p.activity===a.activity)?.weight??1));
  for(const [index,goal] of goals.filter(g=>!subject||subject===`goal:${g.id}`).entries()) result.push({
    ...compileFragments(index===0?'reply:goal':`reply:goal:${goal.id}`,'plan',planReportParts(npc,goal),now),
    topic:'plan',subject:`goal:${goal.id}`,rewardEligible:true,
    followUp:`关于“${identityLabel(goal.label)}”，你接下来怎么安排？`,
  });
  const feelings=[...personal.feelings].reverse();
  const feeling=subject?feelings.find(f=>subject===`feeling:${f.id}`):feelings.find(f=>!recentlySaid(npc.mind,'player',feelingReport(f),now))??feelings[0];
  if(feeling)result.push({...grounded('reply:feeling','feeling',feelingReport(feeling),`feeling:${feeling.id}`,now),
    followUp:`你说“${identityLabel(feeling.label)}”，现在还有影响吗？`});
  const promise=[...npc.mind.commitments].reverse().find(c=>isHelpPromise(c.id)&&c.counterparty==='player'&&(!subject||subject===`commitment:${c.id}`));
  if (promise) {
    const state=promise.status==='active'
      ? `我们还约着${CHORES[npc.id]}这件事。${promise.dueAt!==undefined?`离约好的开工时间还剩约 ${Math.max(0,Math.ceil(promise.dueAt-now))} 秒。`:''}如果安排变了，请告诉我。`
      : promise.status==='broken' ? '上次你答应回来帮忙，却没有按时来。我还记得；下次先确定自己有空，再约时间吧。'
      : `上次你答应回来${CHORES[npc.id]}，后来也做到了。这份可靠，我记着。`;
    result.push({...grounded('reply:history','history',state,`commitment:${promise.id}:${promise.status}`,now),subject:`commitment:${promise.id}`});
  } else if(npc.mind.experiences.some(e=>e.source==='experienced'&&e.relatedTo==='player'&&e.event==='kept_word'&&e.at<=now)) {
    result.push(grounded('reply:history','history',`你之前帮我${CHORES[npc.id]}，事情确实做完了。我记得这份帮助；以后有事情，也愿意和你商量。`,'experience:kept_word:player',now));
  }
  const topics=[...new Set(npc.mind.knowledge.filter(k=>k.topic.startsWith('public-chat:')).sort((a,b)=>b.learnedAt-a.learnedAt).map(k=>k.topic))];
  for(const topic of topics) {
    const view=inspectBelief(npc.mind,topic,now);
    const claim=view.evidence.find(k=>k.status==='current'&&k.source.kind==='heard');
    if(view.status!=='known'||!claim||claim.value.length>700 || (subject && subject!==`knowledge:${claim.id}:heard`)) continue;
    result.push(grounded('reply:neighbor','neighbor',`刚才和街坊聊了一会儿。${claim.value}这是对方当时告诉我的，眼下怎样还得再问问。`,`knowledge:${claim.id}:heard`,now));
    break;
  }
  const task=world && (subject?ownedWork(world,npc).find(t=>`observed-work:${t.id}`===subject):currentWork(world,npc));
  if(task) result.push(grounded('reply:work','work',`${task.cause}。这份待办是${CHORES[npc.id]}，做完需要 ${CHORE_SECONDS} 秒，报酬 ${CHORE_REWARD} 元。${task.claimedBy==='player'?'已经留给你了。':'这是工作内容；要不要托付给你，我们可以接着商量。'}`,`observed-work:${task.id}`,now));
  return result;
}
function feelingReport(feeling:{label:string;valence:number}):string {
  return `${feeling.label}。${feeling.valence<0?'我还需要一点时间缓缓。':'想起来，还是觉得挺好的。'}`;
}

/** Only spoken topics open followups; all facts are revalidated at the current turn. */
export function ordinaryResponses(npc: Npc, intent: 'greet'|'ask', alreadyMet: boolean, now: number, world?: World): CharacterResponse[] {
  const base=baseResponses(npc,intent,alreadyMet,now).map(r=>{
    const topic=r.id==='reply:state'||r.intent==='report-current-state'?'state':r.id==='reply:place'?'place':r.intent==='share-values'?'values':r.intent;
    return {...r,topic,rewardEligible:npc.trust>=0,...(FOLLOWUPS[topic]?{followUp:FOLLOWUPS[topic]}:{})};
  });
  if(npc.trust<0) return base;
  const requested=npc.pendingAction?.parameters.topic;
  if(typeof requested==='string') {
    const last=openDialogueTopics(npc.mind,'player',now).find(t=>t.sequence===npc.pendingAction?.parameters.turn&&t.topic===requested);
    if(!last)return [];
    let value: CharacterResponse | undefined;
    if(requested==='values') value=grounded('reply:detail',requested,DETAILS[npc.id],'profile:values:elaboration',now,false);
    else if(requested==='state') value=grounded('reply:detail',requested,npc.needs.hunger<40?'我想先去吃顿热饭，缓过劲再把手头的事接着做。你要是还有事，我们晚点再聊。':npc.needs.energy<40?'想先找个安静的地方歇歇脚。等精神好些，再接着忙；你也别太累着自己。':'眼下身体还应付得来。我会再看看手头的事，也留点空和街坊说说话。',npc.needs.hunger<40?'needs:hunger<40':npc.needs.energy<40?'needs:energy<40':'needs:hunger>=40,energy>=40',now,false);
    else if(requested==='place') {
      const place=base.find(r=>r.topic==='place');
      if(place) value={...compileFragments('reply:detail',requested,[
        {text:'说的就是晚风茶馆，你可以去门口看看菜单。',basis:'belief:place:tavern:current'},
        npc.needs.energy<40?{text:'不过我现在有些累，可能得先歇一歇。',basis:'needs:energy<40'}:
          {text:'我照应的是茶馆，有具体安排咱们再讲清楚。',basis:'profile:identity'},
      ],now),topic:requested,subject:last.subject,rewardEligible:true};
    } else {
      const current=extraResponses(npc,now,world,last.subject).find(r=>r.topic===requested && r.subject===last.subject);
      if(current) {
        let detail=current.text;
        let fragments:DialogueFragment[]|undefined;
        if(requested==='history') {
          const promise=npc.mind.commitments.find(c=>`commitment:${c.id}`===last.subject);
          detail=promise?.status==='active'
            ? '这份约定我还放在心上。你准备好开工了，就告诉我一声，咱们按说好的来。'
            : promise?.status==='broken'
              ? '我在意的是能不能按说好的来。解释我愿意听，但上次失约的事不会因此消失；以后有把握了再答应吧。'
              : '能把说好的事做完，我就愿意多一分信任。下回要是还有活，我先问问你有没有空，咱们再商量。';
        } else if(requested==='work') {
          const task=world && ownedWork(world,npc).find(t=>`observed-work:${t.id}`===last.subject);
          detail=`这份活得做 ${CHORE_SECONDS} 秒，做完给你 ${CHORE_REWARD} 元；中途走了就没法结工钱。${task?.claimedBy==='player'?'已经留给你了，咱们聊完就可以动手。':'你先听听，愿意接再跟我说，不着急答应。'}`;
        } else if(requested==='plan') {
          const goal=inspectPersonal(npc.mind,now).goals.find(g=>`goal:${g.id}`===last.subject)!;
          fragments=last.depth===1&&hasExtendedDialogue(npc)
            ? planReasonParts(npc,goal)
            : planNextStepParts(npc,goal,world);
        } else if(requested==='feeling') {
          const feeling=inspectPersonal(npc.mind,now).feelings.find(f=>`feeling:${f.id}`===last.subject)!;
          fragments=last.depth===1&&hasExtendedDialogue(npc)
            ? feelingNextStepParts(npc,feeling.valence<0,feeling.id)
            : [{text:feelingReflection(npc,feeling.valence<0),basis:`feeling:${feeling.id}`}];
        } else if(requested==='neighbor') detail=`是面对面聊天时，对方亲口说的。${current.text}`;
        value={...current,...compileFragments('reply:detail',requested,fragments??[{text:detail,basis:current.evidence[0].basis}],now),followUp:undefined};
      }
    }
    if(value){value.depth=(last.depth??0)+1;
      if(last.depth===0&&hasExtendedDialogue(npc)) {
        if(requested==='plan') {
          const goal=inspectPersonal(npc.mind,now).goals.find(g=>`goal:${g.id}`===last.subject)!;
          value.followUp=`“${identityLabel(goal.label)}”为什么对你重要？`;
        }
        if(requested==='feeling') {
          const feeling=inspectPersonal(npc.mind,now).feelings.find(f=>`feeling:${f.id}`===last.subject)!;
          value.followUp=`说到“${identityLabel(feeling.label)}”，你想怎么照顾自己？`;
        }
      }
    }
    return [value ?? {...grounded('reply:detail','close-topic','刚才那件事，眼下我也说不准，得再确认一下。','dialogue:no-current-evidence',now,false),rewardEligible:false}];
  }
  const focus=npc.pendingAction?.parameters.focus;
  if(intent==='ask' && (focus==='plans'||focus==='feelings')) {
    const topic=focus==='plans'?'plan':'feeling';
    const current=extraResponses(npc,now,world).filter(r=>r.topic===topic);
    const fresh=current.filter(r=>!recentlySaid(npc.mind,'player',r.text,now));
    if(fresh.length)return fresh;
    if(!current.length)return [focus==='feelings'?noFeelingResponse(npc,now):
      {...grounded('reply','close-topic','眼下还没有定下什么打算，等想好了再跟你聊。','personal:no-current-goal',now,false),rewardEligible:false}];
    // Carry only an unresolved continuation, including its depth; an acknowledgement must not reopen a finished thread.
    const validSubjects=topic==='feeling'?inspectPersonal(npc.mind,now).feelings.map(f=>`feeling:${f.id}`):current.map(r=>r.subject);
    const continuation=openDialogueTopics(npc.mind,'player',now).find(t=>t.topic===topic&&validSubjects.includes(t.subject));
    const acknowledgement=grounded('reply',topic,focus==='plans'?'这些打算刚才已经聊过了。':'这个心情刚才已经聊过了，眼下没有新的补充。','dialogue:recently-spoken',now,false);
    return [{...acknowledgement,subject:continuation?.subject??current[0].subject,rewardEligible:false,
      ...(continuation?{followUp:continuation.followUp,depth:continuation.depth}:{})}];
  }
  const all=[...base,...(intent==='ask'?extraResponses(npc,now,world):[])];
  const fresh=all.filter(r=>!recentlySaid(npc.mind,'player',r.text,now));
  // Keep a compatible acknowledgement, without claiming a new event or rewarding repetition.
  if(!fresh.some(r=>r.id==='reply')) fresh.unshift({...grounded('reply','close-topic',
    intent==='greet'?'刚才已经打过招呼啦。你想接着聊哪件事？':'刚才说过的事，我暂时没有新的补充。你可以接着问具体的事，或者我们晚些再聊。',
    'dialogue:recently-spoken',now,false),rewardEligible:false});
  return fresh;
}

/** Compatibility convenience for hosts that need the default ordinary response. */
export function ordinaryReply(npc: Npc, intent: 'greet' | 'ask', alreadyMet: boolean, now: number): string {
  return ordinaryResponses(npc, intent, alreadyMet, now).find(response => response.id === 'reply')!.text;
}

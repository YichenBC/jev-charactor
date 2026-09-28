import type {Npc, World} from './types';
import { inspectPersonal } from '../character/personal';
import { PERSONAL_LIFE } from './personalLife';
import { authoredPlanProfile, type DialogueGoal } from './dialogueProfile';
import { CHORES, ownedWork } from './work';

type GoalView = DialogueGoal;
export type DialogueFragment = { text: string; basis: string };

// Personal goals are bounded to 32 receipts; use spoken counts rather than HUD fractions.
function spokenCount(value:number):string {
  const digits=['零','一','二','三','四','五','六','七','八','九'];
  if(value===2)return '两';
  if(value<10)return digits[value];
  return `${value<20?'':digits[Math.floor(value/10)]}十${value%10?digits[value%10]:''}`;
}
function planSubject(npc:Npc,goal:GoalView):string {
  return authoredPlanProfile(npc,goal)?.subject ?? `我惦记着“${goal.label}”这件事。`;
}
export function planReport(npc:Npc,goal:GoalView):string {
  return planReportParts(npc,goal).map(part=>part.text).join('');
}
export function planReportParts(npc:Npc,goal:GoalView):DialogueFragment[] {
  const goalBasis=`goal:${goal.id}`;
  if(goal.completed)return [
    {text:`我给自己定的“${goal.label}”已经完成了。`,basis:goalBasis},
    {text:npc.id==='tang'?'心里挺满足的，想缓一缓，再看看身边有什么值得留意的。':'这下心里踏实些了，接下来想给自己留点闲工夫。',basis:`profile:personal-life:${npc.id}:completion-reflection`},
  ];
  const parts:DialogueFragment[]=[{text:planSubject(npc,goal),basis:authoredPlanProfile(npc,goal)?`profile:personal-life:${npc.id}:${goal.id}:goal-description`:goalBasis}];
  if(goal.progress===0) {
    parts.push({text:'头一回还没做完，',basis:goalBasis});
  } else {
    parts.push({text:`已经做过${spokenCount(goal.progress)}回，还差${spokenCount(goal.target-goal.progress)}回。`,basis:goalBasis},
      {text:npc.id==='tang'?'不急，想每回都认真些。':'一步步来，自己也踏实。',basis:`profile:personal-life:${npc.id}:pace`});
  }
  if(npc.job?.kind===goal.activity&&npc.job.phase==='perform')parts.push({text:'这会儿正慢慢做着呢。',basis:`job:${npc.job.kind}:perform`});
  else if(goal.progress===0)parts.push({text:'想找时间慢慢来。',basis:goalBasis});
  return parts;
}
export function planNextStep(npc:Npc,goal:GoalView,world?:World):string {
  return planNextStepParts(npc,goal,world).map(part=>part.text).join('');
}
export function planNextStepParts(npc:Npc,goal:GoalView,world?:World):DialogueFragment[] {
  if(goal.completed)return [{text:'这件事已经办妥了，先让自己松快一下。下一步做什么，我还想慢慢看看。',basis:`goal:${goal.id}`}];
  const profile=authoredPlanProfile(npc,goal);
  const parts:DialogueFragment[]=[{text:`还差${spokenCount(goal.target-goal.progress)}回。`,basis:`goal:${goal.id}`}];
  if(profile) {
    parts.push({text:profile.method,basis:`profile:personal-life:${npc.id}:${goal.id}:prospective-method`});
    if(profile.activity==='work')parts.push(...workMethodParts(npc,goal,world));
  } else if(hasExtendedDialogue(npc)) {
    parts.push({text:'具体怎么做还得想一想，想先找一个能着手的小步骤。',basis:`goal:${goal.id}`});
  } else {
    const activity=goal.activity==='hobby'?`有空想去${PERSONAL_LIFE[npc.id].hobby}。`:goal.activity==='social'?'想找位有空的街坊，坐下来好好聊一会儿。':'等手头方便些，再接着办自己的事。';
    parts.push({text:activity,basis:`profile:personal-life:${npc.id}:${goal.activity}`});
  }
  if(npc.needs.hunger<40)parts.push({text:'不过这会儿有些饿，想先吃点东西。',basis:'needs:hunger<40'});
  else if(npc.needs.energy<40)parts.push({text:'不过这会儿有些累，想先歇一歇。',basis:'needs:energy<40'});
  return parts;
}

function workMethodParts(npc:Npc,goal:GoalView,world?:World):DialogueFragment[] {
  const tasks=world?ownedWork(world,npc):[];
  const performing=tasks.find(t=>t.claimedBy==='owner'&&npc.job?.kind==='work'&&npc.job.phase==='perform'&&npc.job.taskId===t.id);
  const task=performing??tasks.find(t=>t.claimedBy==='player')??tasks.find(t=>!t.claimedBy);
  if(!task)return [{text:'还得看看有什么具体的事能做，再决定从哪一份开始。',basis:`goal:${goal.id}`}];
  const parts:DialogueFragment[]=[{text:`我记着的这份待办是：${task.cause}。`,basis:`observed-work:${task.id}`}];
  if(performing)parts.push({text:'这份我正在处理。',basis:`job:work:${task.id}:perform`});
  else if(task.claimedBy==='player')parts.push({text:'这份已经留给你了，得按说好的安排来。',basis:`observed-work:${task.id}`});
  else parts.push({text:`有空我想先${CHORES[npc.id]}，从这份具体的事务开始。`,basis:`profile:chores:${npc.id}:prospective-method`});
  return parts;
}
export function feelingReflection(npc:Npc,negative:boolean):string {
  if(npc.id==='mei')return negative?'还有一点，心里没那么快放得下。先顾好自己，别的事，咱们慢慢看。':'想起来，心里还暖着呢。有些小事就值得慢慢高兴一会儿。';
  if(npc.id==='tang')return negative?'还有一点。我想先给自己留些安静的时间，等心里缓过来再说。':'还有呀，想到的时候，心里就轻快一点。想让这份感觉多留一会儿。';
  return negative?'还有一点，心情没那么快缓过来。以后怎么相处，咱们慢慢看。':'还留着一点好心情。想到这件事，心里就暖和些。';
}

/** Authored voice and intentions, never new observations or completed actions. */
export const hasExtendedDialogue=(npc:Npc)=>npc.id==='mei'||npc.id==='tang';
export function planReason(npc:Npc,goal:GoalView|string):string {
  // Legacy activity-only calls may use authored prose only when an exact owned goal supports it.
  const resolved=typeof goal==='string'?inspectPersonal(npc.mind,0).goals.find(g=>g.activity===goal&&authoredPlanProfile(npc,g)):goal;
  return resolved?planReasonParts(npc,resolved).map(part=>part.text).join(''):'这是我自己定下的打算，具体的缘由还想再理一理。';
}
export function planReasonParts(npc:Npc,goal:GoalView):DialogueFragment[] {
  const profile=authoredPlanProfile(npc,goal);
  return [{text:profile?.reason??'这是我自己定下的打算，具体的缘由还想再理一理。',
    basis:profile?`profile:personal-life:${npc.id}:${goal.id}:personal-reason`:`goal:${goal.id}`}];
}

/** Shared by every provider through getContext; never presented as observations or completed actions. */
export function authoredPlanDialogue(npc:Npc,now:number,world?:World) {
  return inspectPersonal(npc.mind,now).goals.map(goal=>({
    goalId:goal.id,label:goal.label,activity:goal.activity,
    interpretation:'Methods and reasons are prospective ideas and personal values, not observations, completed events, or executable promises. Current goal, need, observed-work and job fragments retain their own evidence.',
    method:planNextStepParts(npc,goal,world),reason:planReasonParts(npc,goal),
  }));
}
export function feelingNextStep(npc:Npc,negative:boolean):string {
  return feelingNextStepParts(npc,negative,'current').map(part=>part.text).join('');
}
export function feelingNextStepParts(npc:Npc,negative:boolean,feelingId:string):DialogueFragment[] {
  const parts:DialogueFragment[]=[];
  if(npc.needs.hunger<40)parts.push({text:'现在有些饿，想先吃点东西。',basis:'needs:hunger<40'});
  else if(npc.needs.energy<40)parts.push({text:'现在有些累，想先歇歇脚。',basis:'needs:energy<40'});
  const intention=npc.id==='mei'
    ? negative?'有空我想安静琢磨一下茶点，把心思放回自己能做好的事上。':'有空想再琢磨一下茶点搭配，'
    : negative?'有空想去水边看看光，给自己一点安静的时间。':'有空想去水边画一会儿，';
  const reflection=npc.id==='mei'
    ? negative?'以后愿不愿意再托付，也要看对方实际怎么做。':'把这点好心情留在日常里。你若有自己的喜好，下回也可以再聊。'
    : negative?'等缓过来，再决定要不要继续聊那件事。':'把这点轻快的感觉留给自己。也不急着马上做什么。';
  parts.push({text:intention,basis:`profile:personal-life:${npc.id}:hobby`},{text:reflection,basis:`feeling:${feelingId}`});
  return parts;
}

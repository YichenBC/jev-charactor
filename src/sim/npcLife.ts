import { CHORES, addWork, availableWork, claimWork, completeWork, releaseWork } from './work';
/** Game physiology adapter. The reusable character mind owns no hunger or map rules.
 * Hunger is fullness (100 = fed). Meals represent NPCs' own abstract provisions:
 * they consume real travel + eating time, never player inventory, coins or shop stock.
 * Rest/social benefits and work results apply once after an uninterrupted duration.
 */
import { beginIntent, completeIntent, interruptIntent, rememberExperience } from '../character';
import { BUILDINGS } from './data';
import { clamp, distance, route } from './navigation';
import { event } from './events';
import { exchangePublicNews } from './social';
import { PERSONAL_LIFE, hobbyReady, finishPersonalActivity } from './personalLife';
import type { ActionOption, Npc, World } from './types';

export function createNpcNeeds(id: string): Npc['needs'] {
  const levels: Record<string, number[]> = { lin: [58,67,45,70], tang: [78,72,32,38], mei: [64,58,70,62], lan: [44,48,55,75], zhou: [70,40,42,30] };
  const [hunger, energy, social, workPressure] = levels[id] ?? [65,65,55,45];
  return { hunger, energy, social, workPressure };
}
const meeting = (world: World, npc: Npc) => world.survival.orders.some(o => o.customerId === npc.id && ['accepted','ready','carrying'].includes(o.status));
export const incomingConversation = (world:World,npc:Npc) => world.npcs.find(n=>n.job?.kind==='social'&&n.job.partnerId===npc.id);
export const participatingConversation = (world:World,npc:Npc) => {
  const proposer=incomingConversation(world,npc);
  return proposer?.job?.consent==='accepted' ? proposer : undefined;
};
function recipientFree(world:World,npc:Npc):boolean {
  return !npc.job && !npc.path.length && !npc.pendingInteraction && !meeting(world,npc) && !(world.player.activity?.kind==='help'&&world.player.activity.npcId===npc.id);
}
/** Only a public invitation is exposed; the proposer's needs and mind stay private. */
export function socialInvitation(world:World,npc:Npc) {
  const proposer=incomingConversation(world,npc),job=proposer?.job;
  if(!proposer || !job || job.phase!=='invite' || job.consent!=='pending' || world.time>=job.expiresAt! || !recipientFree(world,npc) || distance(npc,proposer)>110) return null;
  return {proposerId:proposer.id,proposerName:proposer.name,expiresAt:job.expiresAt!,duration:job.duration,topic:'public everyday news'};
}
export function respondToSocialInvitation(world:World,npc:Npc,response:string):boolean {
  if(!socialInvitation(world,npc))return false;
  const proposer=incomingConversation(world,npc)!,job=proposer.job!;
  if(response==='social:accept'){
    job.consent='accepted';job.phase='perform';job.endsAt=world.time+job.duration;delete job.expiresAt;
    proposer.activity=`正在和${npc.name}聊聊`;npc.activity=`正在和${proposer.name}聊聊`;
    proposer.cooldown=npc.cooldown=job.duration;
    if(proposer.mind.intent){proposer.mind.intent.phase='waiting';proposer.mind.intent.until=job.endsAt;proposer.mind.revision++;}
    beginIntent(npc.mind,{id:`social:${proposer.id}:${job.startedAt}`,label:`和${proposer.name}聊聊`,target:proposer.id,phase:'waiting',since:world.time,until:job.endsAt});
    proposer.revision++;npc.revision++;
  }else if(response==='social:decline'||response==='social:defer'){
    cancelNpcJob(world,proposer,response==='social:decline'?'对方婉拒了这次闲谈。':'对方想稍后再聊，这次先各自安排。');
    proposer.cooldown=response==='social:defer'?12:8;npc.cooldown=5;
  }else return false;
  return true;
}
function invitePartner(world:World,npc:Npc,partner:Npc){
  const job=npc.job!;job.phase='invite';job.expiresAt=world.time+12;
  npc.activity=`邀请${partner.name}聊聊，等对方决定`;npc.cooldown=12;
  // Arrival invalidates old idle decisions and wakes the recipient, without taking over their activity.
  partner.cooldown=0;partner.revision++;npc.revision++;
}
function availablePartner(world:World,npc:Npc,other:Npc):boolean {
  return other.id!==npc.id && recipientFree(world,other) && !incomingConversation(world,other);
}
const urgency = (value: number) => value < 20 ? 'urgent' : value < 40 ? 'low' : 'comfortable';
const signature = (npc: Npc) => [npc.needs.hunger < 80, npc.needs.energy < 80, npc.needs.social < 75, npc.needs.energy >= 15 && npc.needs.hunger >= 10, urgency(npc.needs.hunger), urgency(npc.needs.energy), urgency(npc.needs.social), npc.needs.workPressure >= 60, npc.needs.workPressure >= 70].join(':');

export function npcLifeContext(npc: Npc) {
  return { needs: { ...npc.needs }, urgency: { hunger: urgency(npc.needs.hunger), energy: urgency(npc.needs.energy), social: urgency(npc.needs.social), work: npc.needs.workPressure >= 70 ? 'pressing' : 'manageable' }, job: npc.job ? { ...npc.job, target: { ...npc.job.target } } : null,
    resourceSemantics: 'Hunger means fullness; higher hunger/energy/social is better. Work pressure grows over time. Own meals use abstract personal provisions, never player stock or money. Jobs require travel then uninterrupted time. Choose priorities yourself; urgency does not automatically select an action.' };
}

export function npcLifeOptions(world: World, npc: Npc): ActionOption[] {
  if (npc.job || meeting(world, npc) || participatingConversation(world,npc)) return [];
  const options: ActionOption[] = [];
  const personal=PERSONAL_LIFE[npc.id];
  if(hobbyReady(npc,world.time))options.push({id:`hobby:${personal.place}`,label:personal.hobby,description:`Travel to ${personal.place} and spend 14 uninterrupted seconds on ${personal.hobby}. Costs 4 energy. ${npc.mind.personal.goals.find(g=>g.id==='personal-interest')?.completedAt===undefined?'Only completion adds one step to your unfinished personal-interest goal.':'Your personal-interest goal is already complete; this is for enjoyment, with no further goal progress.'} Produces temporary satisfaction, no items or income.`,kind:'npc_job',target:personal.place});
  if (npc.needs.hunger < 80) options.push({ id:'eat:tavern', label:'去茶馆吃顿饭', description:'Walk to the tavern and spend 10 seconds eating your own provisions. On completion gain 48 fullness and 4 energy. Costs time; does not consume the player’s goods.', kind:'npc_job', target:'tavern' });
  if (npc.needs.energy < 80) {
    options.push({ id:'rest:home', label:'回小院休息', description:'Walk to the courtyard and rest uninterrupted for 18 seconds; recover 42 energy only after finishing.', kind:'npc_job', target:'home' });
    options.push({ id:'rest:watch', label:'去临水亭歇脚', description:'Walk to the public waterfront pavilion and rest for 10 seconds; recover 24 energy after finishing. Shorter but less restorative.', kind:'npc_job', target:'watch' });
  }
  if (npc.needs.social < 75) for (const other of world.npcs) {
    if (distance(npc, other) < 360 && availablePartner(world,npc,other)) options.push({ id:`seek:${other.id}`, label:`找${other.name}聊聊`, description:'Approach this free, stationary visible neighbor and invite them to talk. They independently accept, decline, defer, or choose their own activity. Wait at most 12 seconds for a response. Only acceptance starts 8 uninterrupted seconds together; either participant can be interrupted by the player. Each gains 30 social satisfaction only on completion. Share no secrets.', kind:'npc_job', target:other.id });
  }
  return options;
}

function lifeMemory(world: World, npc: Npc, text: string, kind: string) {
  npc.revision++;
  npc.memories.push({time:world.time,text,kind}); npc.memories = npc.memories.slice(-32);
  rememberExperience(npc.mind, { id:`life:${npc.id}:${npc.revision}:${world.time}`,at:world.time,event:kind,detail:text,salience:.4,source:'experienced',relatedTo:npc.id });
}

export function cancelNpcJob(world: World, npc: Npc, reason: string, preserveMeeting = false) {
  if (!npc.job) return;
  const social=npc.job.kind==='social';
  const accepted=npc.job.consent==='accepted';
  const partner=npc.job.kind==='social'?world.npcs.find(n=>n.id===npc.job!.partnerId):undefined;
  releaseWork(world, npc, npc.job.taskId, 'owner');
  npc.job = null;
  if(partner){
    partner.revision++;
    if(accepted&&!partner.job&&!partner.pendingInteraction){partner.activity='刚才的闲谈中止了';interruptIntent(partner.mind,reason,world.time);}
    if(!partner.job)partner.cooldown=Math.max(partner.cooldown,5);
  }
  if (!preserveMeeting) { npc.path = []; npc.cooldown = 0; interruptIntent(npc.mind, reason, world.time); }
  if(social){npc.cooldown=Math.max(npc.cooldown,8);if(!preserveMeeting)npc.activity=reason;}
  lifeMemory(world,npc,reason,'job_interrupted');
}

export function decayNpcNeeds(world: World, npc: Npc, dt: number) {
  const before = signature(npc);
  npc.needs.hunger = clamp(npc.needs.hunger - dt * .065);
  npc.needs.energy = clamp(npc.needs.energy - dt * (npc.path.length ? .075 : .035));
  npc.needs.social = clamp(npc.needs.social - dt * .045);
  npc.needs.workPressure = clamp(npc.needs.workPressure + dt * .04);
  if (before !== signature(npc)) npc.revision++;
  if (npc.job && meeting(world,npc)) cancelNpcJob(world,npc,'暂缓自己的事情，先履行约定去等餐。',true);
}

export function npcJobPlan(world: World, npc: Npc, option: ActionOption) {
  const kind: NonNullable<Npc['job']>['kind'] = option.id === 'work' ? 'work' : option.id.startsWith('eat:') ? 'eat' : option.id.startsWith('rest:') ? 'rest' : option.id.startsWith('hobby:') ? 'hobby' : 'social';
  const workplace: Record<string,string> = {lin:'shop',tang:'watch',mei:'tavern',lan:'post',zhou:'watch'};
  const place = kind === 'social' ? undefined : BUILDINGS.find(b => b.id === (kind === 'work' ? workplace[npc.id] : option.target));
  const partner = kind === 'social' ? world.npcs.find(n => n.id === option.target) : undefined;
  if (!place && !partner) return null;
  const target = {x:(place?.door ?? partner!).x,y:(place?.door ?? partner!).y};
  const path = distance(npc,target) > 2 ? route(npc,target) : [];
  if (distance(npc,target) > 2 && !path.length) return null;
  const duration = kind === 'work' ? 16 : kind === 'social' ? 8 : kind==='hobby' ? 14 : kind === 'rest' && place?.id === 'home' ? 18 : 10;
  return {kind,place,partner,target,path,duration};
}

export function startNpcJob(world: World, npc: Npc, option: ActionOption): boolean {
  if (npc.job || meeting(world,npc) || participatingConversation(world,npc)) return false;
  const plan = npcJobPlan(world,npc,option);
  if (!plan) return false;
  const {kind,place,partner,target,path,duration} = plan;
  if(kind==='social'&&!availablePartner(world,npc,partner!))return false;
  const task = kind === 'work' ? availableWork(world, npc) : undefined;
  if (task && !claimWork(world, npc, task.id, 'owner')) return false;
  npc.job = {...(task ? {taskId:task.id} : {}),kind,target,...(place ? {placeId:place.id} : {partnerId:partner!.id}),phase:path.length ? 'travel' : kind==='social'?'invite':'perform',startedAt:world.time,duration,...(kind==='social'?{consent:'pending',expiresAt:world.time+120}:!path.length ? {endsAt:world.time+duration} : {})};
  npc.path = path; npc.destination = place?.name ?? `${partner!.name}附近`;
  npc.activity = path.length ? option.label : `${npc.destination} · ${kind === 'work' ? (task ? CHORES[npc.id] : '忙自己的事情') : kind === 'eat' ? '正在吃饭' : kind === 'rest' ? '正在休息' : kind==='hobby'?PERSONAL_LIFE[npc.id].hobby:'正在闲聊'}`;
  npc.cooldown = Math.min(120, path.length * .96 + duration + 2);
  if(partner&&!path.length)invitePartner(world,npc,partner);
  beginIntent(npc.mind,{id:`${option.id}:${world.time}`,label:option.label,target:option.target,phase:path.length?'acting':'waiting',since:world.time,until:world.time+npc.cooldown});
  return true;
}

export function progressNpcJob(world: World, npc: Npc) {
  const job = npc.job;
  if (!job) return;
  if(job.kind==='social'){
    const partner=world.npcs.find(n=>n.id===job.partnerId);
    if(!partner || !recipientFree(world,partner) || (job.consent!=='accepted' && world.time>=job.expiresAt!) || (job.phase!=='travel'&&distance(npc,partner)>110)){
      cancelNpcJob(world,npc,'对方正在忙、已经离开或邀请已到期，这次闲谈没有完成。');return;
    }
  }
  if (job.phase === 'travel') {
    if (npc.path.length) { npc.cooldown = Math.max(2,npc.cooldown); return; }
    if (distance(npc,job.target) > 3) { cancelNpcJob(world,npc,'没能到达目的地，这件事暂时搁下。'); return; }
    if(job.kind==='social'){invitePartner(world,npc,world.npcs.find(n=>n.id===job.partnerId)!);return;}
    job.phase = 'perform'; job.endsAt = world.time + job.duration;
    npc.activity = `${npc.destination} · ${job.kind === 'work' ? (job.taskId ? CHORES[npc.id] : '忙自己的事情') : job.kind === 'eat' ? '正在吃饭' : job.kind === 'rest' ? '正在休息' : job.kind==='hobby'?PERSONAL_LIFE[npc.id].hobby:'正在闲聊'}`;
    if (npc.mind.intent) { npc.mind.intent.phase = 'waiting'; npc.mind.intent.until = job.endsAt; npc.mind.revision++; }
    npc.revision++;
  }
  if(job.phase==='invite')return;
  if (distance(npc,job.target)>3) { cancelNpcJob(world,npc,'离开了活动地点，尚未完成的事情中止。'); return; }
  npc.cooldown = Math.max(.1, job.endsAt! - world.time);
  if (world.time < job.endsAt!) return;
  if (job.taskId && !completeWork(world, npc, job.taskId, 'owner')) { cancelNpcJob(world, npc, '这份待办已经不归我处理，停止重复执行。'); return; }
  const before = {...npc.needs};
  if (job.kind === 'eat') { npc.needs.hunger = clamp(npc.needs.hunger+48); npc.needs.energy = clamp(npc.needs.energy+4); }
  if (job.kind === 'rest') npc.needs.energy = clamp(npc.needs.energy+(job.placeId==='home'?42:24));
  if (job.kind === 'work') { npc.needs.energy = clamp(npc.needs.energy-8); npc.needs.workPressure = clamp(npc.needs.workPressure-35); }
  if (job.kind === 'hobby') npc.needs.energy=clamp(npc.needs.energy-4);
  if (job.kind === 'social') {
    npc.needs.social = clamp(npc.needs.social+30);
    exchangePublicNews(world,npc,world.npcs.find(n=>n.id===job.partnerId)!);
  }
  const receipt=`activity:${npc.id}:${job.kind}:${job.startedAt}`;
  finishPersonalActivity(npc,job.kind,receipt,world.time);
  if(job.kind==='social'){
    const partner=world.npcs.find(n=>n.id===job.partnerId)!;
    partner.needs.social=clamp(partner.needs.social+30);
    finishPersonalActivity(partner,'social',receipt,world.time);completeIntent(partner.mind,world.time);partner.cooldown=2;partner.activity=`刚和${npc.name}聊过日常`;partner.revision++;
  }
  const result = job.kind === 'eat' ? '吃完了自己的饭，肚子踏实了。' : job.kind === 'rest' ? '安安稳稳歇了一会儿，恢复了精神。' : job.kind === 'work' ? (job.taskId ? `完成了${CHORES[npc.id]}，这份待办已经处理好了。` : '忙完一段自己的事情，事务少了些，也费了些体力。') : job.kind==='hobby'?`抽空${PERSONAL_LIFE[npc.id].hobby}，给自己留了一点喜欢的时间。`:'和街坊聊完了一段日常，心里不那么孤单了。';
  if (job.kind === 'eat') addWork(world, 'mei', '有居民在茶馆用餐后留下了餐具');
  if (job.kind === 'rest' && job.placeId === 'watch') addWork(world, 'zhou', '有人在临水亭歇脚后留下了待整理的杂物');
  if (job.kind === 'work' && !job.taskId && npc.id === 'tang') addWork(world, 'tang', '完成一幅写生后，画具需要收拾', true);
  lifeMemory(world,npc,result,'job_completed'); event(world,`${npc.name}${result}`,'npc_life',npc.id);
  world.decisions.push({time:world.time,npcId:npc.id,choice:`completed:${job.kind}`,label:result,source:'simulation',changes:npcNeedChanges(before,npc.needs)}); world.decisions=world.decisions.slice(-180);
  completeIntent(npc.mind,world.time); npc.job = null; npc.cooldown = 2;
}

/** Report observed deltas, never promised future gains. */
export function npcNeedChanges(before: Npc['needs'], after: Npc['needs']): string[] {
  const labels: Record<keyof Npc['needs'], string> = {hunger:'饱腹',energy:'体力',social:'社交满足',workPressure:'事务压力'};
  return (Object.keys(labels) as (keyof Npc['needs'])[]).flatMap(key => {
    const delta = Math.round((after[key]-before[key])*1000)/1000;
    return delta ? [`${labels[key]} ${delta>0?'+':''}${delta}`] : [];
  });
}

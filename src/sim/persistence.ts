import { INITIAL_WORK, isHelpPromise, addWork, claimWork, createWork, taskIdSchema, workSchema } from './work';
import { z } from 'zod';
import { createMind, mindSchema, interruptIntent } from '../character';
import { interactionChoiceSchema } from '../character/interaction';
import { BUILDINGS, HEIGHT, PROFILES, WIDTH, stableIdentity } from './data';
import { backfillLegacyKnowledge } from './knowledge';
import { createNpcNeeds, cancelNpcJob } from './npcLife';
import { PERSONAL_LIFE, initializePersonalLife } from './personalLife';
import { pendingActionCurrent } from './interactions';
import { isWalkable } from './navigation';
import { createSurvival, ensureOffer, parcelName } from './survival';
import type { World } from './types';
const finite = z.number().finite();
const time = finite.nonnegative();
const short = z.string().max(2000);
const id = z.enum(['lin','tang','mei','lan','zhou']);
const pointShape = {x:finite.min(24).max(WIDTH-168), y:finite.min(24).max(HEIGHT-24)};
const point = z.strictObject(pointShape).refine(p=>isWalkable(p.x,p.y));
const activity = z.strictObject({ taskId:taskIdSchema.optional(), kind:z.enum(['rest','sleep','work','help']),label:short,startedAt:time,endsAt:time,npcId:id.optional(),origin:point }).refine(a=>a.endsAt>=a.startedAt);
const needs = z.strictObject({hunger:finite.min(0).max(100),energy:finite.min(0).max(100),social:finite.min(0).max(100),workPressure:finite.min(0).max(100)});
const npcJob = z.strictObject({taskId:taskIdSchema.optional(),kind:z.enum(['eat','rest','work','social','hobby']),target:point,placeId:z.enum(['shop','tavern','home','post','watch']).optional(),partnerId:id.optional(),phase:z.enum(['travel','invite','perform']),consent:z.enum(['pending','accepted']).optional(),expiresAt:time.optional(),startedAt:time,duration:finite.min(1).max(60),endsAt:time.optional()}).superRefine((job,ctx)=>{
 if(job.kind!=='social'&&(job.consent!==undefined||job.expiresAt!==undefined||job.phase==='invite'))ctx.addIssue({code:'custom',message:'Consent on non-social job'});
 if(job.consent!==undefined && (job.phase==='perform' ? job.consent!=='accepted'||job.expiresAt!==undefined : job.consent!=='pending'||job.expiresAt===undefined||job.expiresAt<=job.startedAt))ctx.addIssue({code:'custom',message:'Invalid social consent chronology'});
 if(job.phase==='invite'&&job.consent!=='pending')ctx.addIssue({code:'custom',message:'Missing invitation'});
 if(job.consent!==undefined && (job.duration!==8 || (job.phase==='travel'&&job.expiresAt!>job.startedAt+120)))ctx.addIssue({code:'custom',message:'Unbounded social job'});
 if(job.kind==='social' ? !job.partnerId||job.placeId!==undefined : !job.placeId||job.partnerId!==undefined)ctx.addIssue({code:'custom',message:'Invalid job target type'});
 if(job.placeId){const place=BUILDINGS.find(b=>b.id===job.placeId)!;if(job.target.x!==place.door.x||job.target.y!==place.door.y)ctx.addIssue({code:'custom',message:'Job is not at its place'});}
 if(job.kind==='eat'&&job.placeId!=='tavern')ctx.addIssue({code:'custom',message:'Invalid dining location'});
 if(job.kind==='rest'&&!['home','watch'].includes(job.placeId??''))ctx.addIssue({code:'custom',message:'Invalid rest location'});
 if(job.phase==='perform' ? job.endsAt===undefined||job.endsAt<job.startedAt+job.duration : job.endsAt!==undefined)ctx.addIssue({code:'custom',message:'Invalid job chronology'});
});
const order = z.strictObject({ id:z.string().regex(/^order-[1-9]\d*$/),customerId:id,address:point,status:z.enum(['offered','accepted','ready','carrying','delivered','rejected','expired']),createdAt:time,readyAt:time,deadline:time,expiresAt:time,reward:finite.int().min(0).max(1000),pickedUpAt:time.optional(),settledAt:time.optional(),payout:finite.nonnegative().optional(),explanation:z.boolean().optional() });
const schema = z.strictObject({
 version:z.literal(2),time,seed:finite.int(),work:workSchema.optional(),
 player:z.strictObject({...pointShape,inventory:z.array(z.string().max(100)).max(32),knowledge:z.array(z.string().max(120)).max(48),health:finite.min(0).max(100),hunger:finite.min(0).max(100),energy:finite.min(0).max(100),money:finite.int().nonnegative().max(1e9),activity:activity.nullable()}).refine(p=>isWalkable(p.x,p.y)),
 npcs:z.array(z.strictObject({...pointShape,id,name:short,role:short,color:z.string().regex(/^#[0-9a-fA-F]{6}$/),persona:short,goal:short,secret:short,knownFacts:z.array(z.string().max(120)).max(48),memories:z.array(z.strictObject({time,text:short,kind:z.string().max(80)})).max(32),trust:finite.min(-10).max(10),mood:short,activity:short,lastDecision:short,revision:finite.int().nonnegative(),cooldown:finite.min(0).max(120),path:z.array(point).max(160),destination:short.optional(),pendingInteraction:z.enum(['greet','ask','request','decline','help','gift','promise','expose','apologize','deliver','explain']).optional(),pendingAction:interactionChoiceSchema.optional(),bubble:short.optional(),bubbleUntil:time.optional(),mind:mindSchema,needs,job:npcJob.nullable()}).refine(n=>isWalkable(n.x,n.y))).length(5),
 events:z.array(z.strictObject({id:finite.int().nonnegative(),time,text:short,kind:z.string().max(80),npcId:id.optional()})).max(180),
 decisions:z.array(z.strictObject({time,npcId:id,choice:short,label:short,source:z.string().max(80),latencyMs:time.optional(),confidence:finite.min(0).max(1).optional(),model:z.string().max(120).optional(),cost:time.optional(),affect:z.enum(['warm','guarded','focused','worried','irritated']).optional(),changes:z.array(short).max(12).optional()})).max(180),
 flags:z.record(z.string().max(100),z.boolean()).refine(v=>Object.keys(v).length<=200),
 survival:z.strictObject({orders:z.array(order).max(40),nextOrder:finite.int().min(1).max(1e8),stock:z.strictObject({meals:finite.int().min(0).max(100),bread:finite.int().min(0).max(100)}),restockedDay:finite.int().min(1),delivered:finite.int().nonnegative(),failed:finite.int().nonnegative(),earned:finite.int().nonnegative(),spent:finite.int().nonnegative(),jobReadyAt:time,nextOfferAt:time,milestone:z.boolean(),dead:z.boolean()})
}).superRefine((w,ctx)=>{
 if(w.work) {
   const issue = (message:string) => ctx.addIssue({code:'custom',message});
   const tasks=w.work.tasks;
   if(new Set(tasks.map(t=>t.id)).size!==tasks.length)issue('Duplicate task IDs');
   if(tasks.some(t=>Number(t.id.slice(5))>=w.work!.nextId||t.createdAt>w.time))issue('Invalid task chronology or sequence');
   for(const npc of w.npcs) {
     const own=tasks.filter(t=>t.ownerId===npc.id);
     if(own.length>8||own.filter(t=>t.claimedBy==='player').length>1)issue('Invalid task capacity or reservation');
     const promises=npc.mind.commitments.filter(c=>isHelpPromise(c.id));
     const activePromises=promises.filter(c=>c.status==='active');
     if(activePromises.length>1||promises.some(c=>c.createdAt>w.time))issue('Invalid help promise chronology');
     for(const promise of activePromises) if(!own.some(t=>t.promiseId===promise.id&&t.claimedBy==='player'))issue('Orphan help promise');
     if(npc.pendingAction&&['help','promise','decline'].includes(npc.pendingAction.intent)) {
       const task=own.find(t=>t.id===npc.pendingAction!.parameters.taskId);
       if(!task||task.id!==npc.pendingAction.subject?.id||!task.observed||!task.offered||task.claimedBy==='owner')issue('Invalid captured work');
     }

     if(npc.job?.taskId && (npc.job.kind!=='work'||!own.some(t=>t.id===npc.job!.taskId&&t.claimedBy==='owner')))issue('Orphan NPC work');
   }
   if(w.player.activity?.taskId && (w.player.activity.kind!=='help'||!tasks.some(t=>t.id===w.player.activity!.taskId&&t.ownerId===w.player.activity!.npcId&&t.claimedBy==='player')))issue('Orphan player work');
   if(w.player.activity?.kind==='help'&&!w.player.activity.taskId)issue('Missing player task');
   for(const task of tasks) {
     const owner=w.npcs.find(n=>n.id===task.ownerId)!;
     if((task.offered||task.claimedBy)&&!task.observed)issue('Unobserved work cannot be offered or claimed');
     if(task.promiseId&&!(task.claimedBy==='player'&&owner?.mind.commitments.some(c=>c.id===task.promiseId&&isHelpPromise(c.id)&&c.status==='active')))issue('Invalid promised task');
     if(task.claimedBy==='owner'&&!(owner?.job?.kind==='work'&&owner.job.taskId===task.id))issue('Orphan owner claim');
     if(task.claimedBy==='player'&&(!task.offered||!(w.player.activity?.kind==='help'&&w.player.activity.taskId===task.id&&w.player.activity.npcId===task.ownerId)&&!owner?.mind.commitments.some(c=>isHelpPromise(c.id)&&c.status==='active')))issue('Orphan player claim');
   }
 }
 if(new Set(w.npcs.map(n=>n.id)).size!==5)ctx.addIssue({code:'custom',message:'Duplicate NPCs'});
 for(const npc of w.npcs) if(npc.pendingAction && npc.pendingAction.intent!==npc.pendingInteraction)ctx.addIssue({code:'custom',message:'Mismatched pending interaction'});
 for(const npc of w.npcs) if(npc.mind.dialogue.turns.some(t=>t.at>w.time)||(npc.mind.dialogue.rewardedAt??0)>w.time)ctx.addIssue({code:'custom',message:'Future dialogue'});
 for(const npc of w.npcs) {
   const p=npc.mind.personal;
   if(p.feelings.some(f=>f.since>w.time)||p.goals.some(g=>g.createdAt>w.time||g.receipts.some(r=>r.at>w.time)))ctx.addIssue({code:'custom',message:'Future personal state'});
   if(npc.job?.kind==='hobby'&&(npc.job.placeId!==PERSONAL_LIFE[npc.id].place||npc.job.duration!==14))ctx.addIssue({code:'custom',message:'Invalid personal activity'});
 }
 const orders=w.survival.orders;
 if(new Set(orders.map(o=>o.id)).size!==orders.length)ctx.addIssue({code:'custom',message:'Duplicate orders'});
 if(orders.filter(o=>['accepted','ready','carrying'].includes(o.status)).length>1)ctx.addIssue({code:'custom',message:'Multiple active orders'});
 if(orders.some(o=>Number(o.id.slice(6))>=w.survival.nextOrder))ctx.addIssue({code:'custom',message:'Reused order sequence'});
 const active=orders.filter(o=>['accepted','ready','carrying'].includes(o.status));
 const offered=orders.filter(o=>o.status==='offered');
 if(offered.length>1||(offered.length&&active.length))ctx.addIssue({code:'custom',message:'Conflicting offers'});
 for(const o of orders){
   if(o.createdAt>w.time)ctx.addIssue({code:'custom',message:'Future order'});
   if(o.status!=='offered'&&o.readyAt>0&&!(o.createdAt<=o.readyAt&&o.readyAt<=o.deadline&&o.deadline<o.expiresAt))ctx.addIssue({code:'custom',message:'Invalid order chronology'});
   if(['accepted','ready','carrying','delivered','rejected'].includes(o.status)&&o.readyAt===0)ctx.addIssue({code:'custom',message:'Missing preparation'});
   if(o.pickedUpAt!==undefined&&(o.pickedUpAt<o.readyAt||o.pickedUpAt>w.time))ctx.addIssue({code:'custom',message:'Invalid pickup time'});
   if(['delivered','rejected'].includes(o.status)&&(o.pickedUpAt===undefined||o.settledAt===undefined||o.payout===undefined||o.settledAt<o.pickedUpAt||o.settledAt>w.time))ctx.addIssue({code:'custom',message:'Invalid settlement'});
 }
 for(const n of w.npcs)if(['deliver','explain'].includes(n.pendingInteraction??'')&&!active.some(o=>o.customerId===n.id&&o.status==='carrying'))ctx.addIssue({code:'custom',message:'Orphan delivery interaction'});
 for(const n of w.npcs)if(n.job){
  if(n.job.startedAt>w.time||n.pendingInteraction||n.job.partnerId===n.id)ctx.addIssue({code:'custom',message:'Invalid current NPC job'});
  if(n.job.phase==='invite'&&(n.path.length>0||Math.hypot(n.x-n.job.target.x,n.y-n.job.target.y)>3||n.job.expiresAt!>w.time+12))ctx.addIssue({code:'custom',message:'Invalid pending invitation'});
  if(n.job.consent==='accepted'&&n.job.endsAt!>w.time+8)ctx.addIssue({code:'custom',message:'Invalid accepted conversation duration'});
  if(n.job.phase==='perform'&&(n.path.length>0||Math.hypot(n.x-n.job.target.x,n.y-n.job.target.y)>3||n.job.endsAt!<w.time))ctx.addIssue({code:'custom',message:'NPC job not at destination'});
  if(n.job.phase==='travel'&&!n.path.length)ctx.addIssue({code:'custom',message:'NPC job missing route'});
 }
 if(w.player.activity?.kind==='help'&&!w.player.activity.npcId)ctx.addIssue({code:'custom',message:'Missing chore recipient'});
 if(w.player.activity&&(w.player.activity.startedAt>w.time||w.player.activity.endsAt<w.time||w.survival.dead))ctx.addIssue({code:'custom',message:'Invalid active activity'});
 const parcels=w.player.inventory.filter(i=>i.startsWith('外卖['));
 const carrying=orders.filter(o=>o.status==='carrying');
 if(parcels.length!==carrying.length||carrying.some(o=>parcels.filter(i=>i===parcelName(o)).length!==1||o.pickedUpAt===undefined))ctx.addIssue({code:'custom',message:'Parcel ownership mismatch'});
 if(w.survival.dead!==(w.player.health===0))ctx.addIssue({code:'custom',message:'Invalid failure state'});
});
export function serializeWorld(world: World): string {return JSON.stringify(world);}
export function loadWorld(text: string): World|null {
 if(typeof text!=='string'||text.length>1_000_000)return null;
 try {
  let raw=JSON.parse(text);
  const missingLedgers = new Set<string>();
  if (Array.isArray(raw?.npcs)) for (const npc of raw.npcs) {
    if (npc && typeof npc.id === 'string' && (!npc.mind || !Object.hasOwn(npc.mind, 'knowledge'))) missingLedgers.add(npc.id);
  }
  if(raw?.version===1&&raw.player&&Array.isArray(raw.npcs)){
    raw={...raw,version:2,player:{...raw.player,health:100,hunger:75,energy:85,money:20,activity:null},npcs:raw.npcs.map((n: {id:string;mind?:unknown})=>({...n,mind:Object.hasOwn(n,'mind')?n.mind:createMind(PROFILES[n.id])})),survival:createSurvival()};
  }
  if(raw?.version===2&&Array.isArray(raw.npcs)) raw.npcs=raw.npcs.map((npc: unknown)=>{
    if(!npc||typeof npc!=='object'||Array.isArray(npc))return npc;
    const value=npc as Record<string,unknown>;
    return {...value,needs:value.needs===undefined?createNpcNeeds(String(value.id)):value.needs,job:value.job===undefined?null:value.job};
  });
  const result=schema.safeParse(raw);if(!result.success)return null;
  const legacyWork = result.data.work === undefined;
  const world:World={...result.data,work:result.data.work ?? createWork()};
  if (legacyWork) for (const npc of world.npcs) {
    const activeHelp = world.player.activity?.kind === 'help' && world.player.activity.npcId === npc.id;
    const promise = npc.mind.commitments.find(c => isHelpPromise(c.id) && c.status === 'active');
    const promised = Boolean(promise);
    if (!world.flags[`helped_${npc.id}`] || activeHelp || promised) {
      const task = addWork(world, npc.id, INITIAL_WORK[npc.id], true)!;
      task.offered = Boolean(world.flags[`chore_offered_${npc.id}`]) || activeHelp || promised;
      if (activeHelp || promised) { claimWork(world,npc,task.id,'player'); if (promise) task.promiseId=promise.id; if (activeHelp) world.player.activity!.taskId=task.id; }
      else if (npc.job?.kind === 'work') { claimWork(world,npc,task.id,'owner'); npc.job.taskId=task.id; }
    }
    if (npc.pendingInteraction && ['help','promise','decline'].includes(npc.pendingInteraction)) {
      delete npc.pendingAction;
    }
  }
  for (const npc of world.npcs) {
    initializePersonalLife(npc,world.time);
    Object.assign(npc, stableIdentity(npc));
    if (missingLedgers.has(npc.id)) backfillLegacyKnowledge(npc, world.time);
    // Old pending requests did not identify a gift or agreed terms; never guess them.
    if(npc.pendingInteraction&&(!npc.pendingAction||!pendingActionCurrent(world,npc))) {
      delete npc.pendingInteraction; delete npc.pendingAction; npc.cooldown=0; npc.revision++;
      interruptIntent(npc.mind,'旧存档的谈话需要重新选择具体事项。',world.time);
      npc.activity='等你重新说起具体事情';
    }
  }
  // Legacy social jobs did not capture consent. Cancel them without inventing a
  // recipient decision or granting completion; keep only non-overlapping new jobs.
  const engaged=new Set<string>();
  for(const npc of world.npcs)if(npc.job?.kind==='social'){
    const partner=world.npcs.find(n=>n.id===npc.job!.partnerId)!;
    if(!npc.job.consent || !partner || engaged.has(npc.id)||engaged.has(partner.id)||partner.job||(!partner.job&&partner.path.length)||partner.pendingInteraction){cancelNpcJob(world,npc,'这段闲谈缺少双方同意或与别的活动冲突，先停下来。');continue;}
    engaged.add(npc.id);engaged.add(partner.id);
  }
  if (!schema.safeParse(world).success) return null;
  ensureOffer(world);return world;
 }catch{return null;}
}

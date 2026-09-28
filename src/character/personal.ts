import { z } from 'zod';

const text=(max:number)=>z.string().trim().min(1).max(max);
const time=z.number().finite().nonnegative();
const receiptSchema=z.object({id:text(160),at:time}).strict();
const feelingSchema=z.object({
  id:text(160),label:text(240),basis:text(500),valence:z.number().finite().min(-1).max(1),
  strength:z.number().finite().min(0).max(1),since:time,until:time,
}).strict().refine(f=>f.until>f.since,'Feeling must have positive duration');
const goalInputSchema=z.object({id:text(160),label:text(240),activity:text(120),target:z.number().int().min(1).max(32),createdAt:time}).strict();
const goalSchema=goalInputSchema.extend({receipts:z.array(receiptSchema).max(32),completedAt:time.optional()}).refine(g=>
  g.receipts.length<=g.target && new Set(g.receipts.map(r=>r.id)).size===g.receipts.length &&
  g.receipts.every((r,i)=>r.at>=g.createdAt&&(!i||r.at>=g.receipts[i-1].at)) &&
  (g.receipts.length===g.target ? g.completedAt===g.receipts.at(-1)?.at : g.completedAt===undefined),'Invalid goal progress');
export const personalSchema=z.object({
  feelings:z.array(feelingSchema).max(12),goals:z.array(goalSchema).max(8),
  preferences:z.array(z.object({activity:text(120),label:text(240),weight:z.number().finite().min(.25).max(2)}).strict()).max(12),
}).strict().refine(p=>new Set(p.feelings.map(f=>f.id)).size===p.feelings.length&&new Set(p.goals.map(g=>g.id)).size===p.goals.length&&new Set(p.preferences.map(p=>p.activity)).size===p.preferences.length,'Duplicate personal state IDs');
export type PersonalState=z.infer<typeof personalSchema>;
export type Feeling=z.infer<typeof feelingSchema>;
export type PersonalGoal=z.infer<typeof goalSchema>;
type Owner={personal:PersonalState;revision:number};
export function createPersonal():PersonalState{return {feelings:[],goals:[],preferences:[]};}

/** Host-authored event appraisal, separate from the model's momentary expression. */
export function addFeeling(owner:Owner,input:Feeling):boolean {
  const f=feelingSchema.parse(input),state=personalSchema.parse(owner.personal);
  if(state.feelings.some(old=>old.id===f.id))return false;
  owner.personal={...state,feelings:[...state.feelings,f].sort((a,b)=>a.since-b.since).slice(-12)};
  owner.revision++;return true;
}
export function addGoal(owner:Owner,input:z.infer<typeof goalInputSchema>):boolean {
  const goal=goalInputSchema.parse(input),state=personalSchema.parse(owner.personal);
  if(state.goals.some(g=>g.id===goal.id))return false;
  if(state.goals.length>=8)throw new RangeError('Personal goal capacity reached');
  owner.personal={...state,goals:[...state.goals,{...goal,receipts:[]}]};owner.revision++;return true;
}
/** A receipt is a completed event supplied by the host, never a proposed action. */
export function advanceGoal(owner:Owner,id:string,input:z.infer<typeof receiptSchema>):boolean {
  const receipt=receiptSchema.parse(input),state=personalSchema.parse(owner.personal);
  const goal=state.goals.find(g=>g.id===id);
  if(!goal||goal.completedAt!==undefined||goal.receipts.some(r=>r.id===receipt.id))return false;
  if(receipt.at<(goal.receipts.at(-1)?.at??goal.createdAt))throw new RangeError('Goal time moved backwards');
  goal.receipts.push(receipt);
  if(goal.receipts.length===goal.target)goal.completedAt=receipt.at;
  owner.personal=state;owner.revision++;return true;
}
/** Read-only temporal projection. No automatic rewards, planning or world lookup. */
export function inspectPersonal(owner:Owner,now:number) {
  time.parse(now);
  return {
    preferences:structuredClone(owner.personal.preferences),
    feelings:owner.personal.feelings.filter(f=>f.since<=now&&now<f.until).map(f=>({...f,influence:f.valence*f.strength*(f.until-now)/(f.until-f.since)})),
    goals:owner.personal.goals.filter(g=>g.createdAt<=now).map(g=>({
      id:g.id,label:g.label,activity:g.activity,target:g.target,progress:g.receipts.filter(r=>r.at<=now).length,
      completed:g.completedAt!==undefined&&g.completedAt<=now,
    })),
  };
}

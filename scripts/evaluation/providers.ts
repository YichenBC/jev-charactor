import { createOpenRouterFetch } from '../../server/openrouter-fetch';
import {performance} from 'node:perf_hooks';
import {requestJevDecision,jevResponseSchema,DecisionError,type DecisionInput} from '../../server/jev';
import {rankActions,type Drive,type ActionForecast} from '../../src/character/motivation';
import type {EvaluationProvider} from './types';

type VisibleSelf={needs?:{hunger:number;energy:number;social:number;workPressure:number};drives?:Drive[];forecasts?:ActionForecast[]};
function visible(input:DecisionInput){
  const situation=(input.state.situation??input.state) as Record<string,unknown>;
  return {self:(input.state.self??situation.self??{}) as VisibleSelf,situation};
}
/** Shared social rules are explicit, not an oracle accessing gold labels or world state. */
function socialRule(input:DecisionInput):string|undefined{
  const ids=new Set(input.options.map(o=>o.id));
  const {situation}=visible(input);
  const delivery=situation.delivery as {late?:boolean;cold?:boolean;explained?:boolean}|null;
  if(delivery&&ids.has('receive_exact')){
    const profile=input.state.profile as {traits?:unknown[]}|undefined;
    const traits=(profile?.traits??[]).filter((t):t is string=>typeof t==='string').join(' ').toLowerCase();
    const commitments=Array.isArray(input.state.commitments)?input.state.commitments as {status?:string;counterparty?:string}[]:[];
    const previous=commitments.filter(c=>c.counterparty==='player'&&c.status!=='active');
    const broken=previous.filter(c=>c.status==='broken').length,kept=previous.filter(c=>c.status==='fulfilled').length;
    if(delivery.late||delivery.cold){
      if(traits.includes('impatient')&&broken>=2&&ids.has('refuse_delivery'))return 'refuse_delivery';
      if(traits.includes('forgiving')&&kept>broken&&delivery.explained)return 'receive_exact';
      if(ids.has('receive_reduced'))return 'receive_reduced';
    }
    return kept>broken&&ids.has('receive_tip')?'receive_tip':'receive_exact';
  }
  for(const id of ['react_exposure','accept_gift','accept_help','accept_promise','accept_apology'])if(ids.has(id))return id;
  if(situation.pendingInteraction==='request'&&ids.has('request_help'))return 'request_help';
  const reply=input.options.filter(o=>o.id.startsWith('reply')).sort((a,b)=>a.id.localeCompare(b.id))[0];
  if(reply)return reply.id;
  return ids.has('refuse')?'refuse':undefined;
}
function ruleChoice(input:DecisionInput){
  const {self,situation}=visible(input),ids=new Set(input.options.map(o=>o.id)),prefix=situation.pendingInteraction?'defer:':'';
  if(self.needs){
    if(self.needs.hunger<40&&ids.has(`${prefix}eat:tavern`))return `${prefix}eat:tavern`;
    if(self.needs.energy<40)for(const id of [`${prefix}rest:home`,`${prefix}rest:watch`])if(ids.has(id))return id;
  }
  if(situation.pendingInteraction){const response=socialRule(input);if(response)return response;}
  if(self.needs?.workPressure!==undefined&&self.needs.workPressure>=60&&ids.has('work'))return 'work';
  if(self.needs&&self.needs.social<40){if(ids.has('social:accept'))return 'social:accept';const seek=[...ids].filter(id=>id.startsWith('seek:')).sort()[0];if(seek)return seek;}
  const rank=self.drives&&self.forecasts?rankActions(self.drives,self.forecasts.filter(f=>ids.has(f.id))):[];
  return rank[0]?.id??(ids.has('wait')?'wait':[...ids].sort()[0]);
}
function utilityChoice(input:DecisionInput){
  const {self,situation}=visible(input),ids=new Set(input.options.map(o=>o.id));
  // Utility handles physiological conflicts; shared social rules avoid an intentionally weak gift/contract baseline.
  if(situation.pendingInteraction&&(!self.needs||Math.min(self.needs.hunger,self.needs.energy)>=40))return socialRule(input)??ruleChoice(input);
  return self.drives&&self.forecasts?rankActions(self.drives,self.forecasts.filter(f=>ids.has(f.id)))[0]?.id??ruleChoice(input):ruleChoice(input);
}
const baseline=(id:string,choose:(input:DecisionInput)=>string):EvaluationProvider=>({id,model:'authored-v4',paid:false,protocolVersion:'visible-policy-v4',async decide(input){
  const start=performance.now(),choice=choose(input);return{choice,affect:'focused',cost:0,model:'authored-v4',latencyMs:performance.now()-start};
}});
export const ruleProvider=baseline('rules',ruleChoice);
export const utilityProvider=baseline('utility',utilityChoice);
export function jevProvider(fetcher:typeof fetch=createOpenRouterFetch(process.env.JEV_DNS_SERVER?.trim() || undefined)):EvaluationProvider{
  const key=process.env.OPENROUTER_API_KEY;if(!key)throw new DecisionError('missing_key');
  return{id:'jev',model:process.env.JEV_MODEL||'typesafe/jev-1.13',paid:true,protocolVersion:'game-jev-action-reaction-v1',async decide(input){
    const {raw,latencyMs}=await requestJevDecision(input,key,fetcher);
    // The runner validates this untrusted boundary. Do not replace missing model metadata or lose known billing on bad answers.
    const data=raw as {model?:string;usage?:{cost?:number};answers?:{action?:{choice?:string};reaction?:{choice?:string}}}|null;
    // Native decision API has no generated message; retain its full decoded JSON envelope for audit.
    return{choice:data?.answers?.action?.choice as string,affect:data?.answers?.reaction?.choice as string,latencyMs,cost:data?.usage?.cost,model:data?.model,rawContent:JSON.stringify(raw),contractValid:jevResponseSchema.safeParse(raw).success};
  }};
}

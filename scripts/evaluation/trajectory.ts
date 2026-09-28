import {isTransportErrorCode} from './transport-errors';
import {z} from 'zod';
import {decisionInput} from '../../server/jev';
import {advance,applyDecision,createWorld,getContext,getOptions,loadWorld,serializeWorld} from '../../src/sim';
import {participatingConversation} from '../../src/sim/npcLife';
import {seededPermutation} from './runner';
import type {EvaluationProvider,EvaluationResponse,DecisionInput} from './types';

interface Attempt{at:number;npcId:string;source:string;input:DecisionInput;response:EvaluationResponse|null;responseModel:string|null;applied:boolean;error:string|null;latencyMs:number;costUSD:number|null;upstreamStatus?:number;}
const responseSchema=z.object({choice:z.string(),affect:z.enum(['warm','guarded','focused','worried','irritated']),latencyMs:z.number().finite().nonnegative(),cost:z.number().finite().nonnegative().optional(),model:z.string().optional(),contractValid:z.boolean().optional(),
  dialogue:z.string().nullable().optional(),rawContent:z.string().nullable().optional(),finishReason:z.string().nullable().optional(),
  tokenUsage:z.object({promptTokens:z.number().int().nonnegative(),completionTokens:z.number().int().nonnegative(),totalTokens:z.number().int().nonnegative()}).optional()});
function safeError(error:unknown):string{
  const message=error instanceof Error?error.message:'';
  if(isTransportErrorCode(message))return message;
  if(['timeout','authentication-error','access-denied','billing-error','provider-error'].includes(message))return message;
  if(/timeout|abort/i.test(message))return 'timeout';
  if(/^upstream_401$/.test(message))return 'authentication-error';
  if(/^upstream_403$/.test(message))return 'access-denied';
  if(/^upstream_402$/.test(message))return 'billing-error';
  return 'provider-error';
}
export async function runAutonomyTrajectory(config:{provider:EvaluationProvider;durationSeconds:number;maxRequests:number;maxReportedCostUSD?:number;seed?:string;onCheckpoint?:(value:unknown)=>Promise<void>}){
  z.object({durationSeconds:z.number().int().min(1).max(600),maxRequests:z.number().int().min(1).max(1000),maxReportedCostUSD:z.number().finite().nonnegative().optional()}).parse(config);
  z.object({id:z.string().min(1),model:z.string().min(1),paid:z.boolean().optional(),expressionMode:z.enum(['program','generated']).optional()}).parse(config.provider);
  const world=createWorld(),seed=config.seed??'autonomy-development-v1',paid=config.provider.paid??true,budget=config.maxReportedCostUSD??.5;
  const unmetered=config.provider.billingMode==='self-hosted-unmetered',mode=config.provider.expressionMode??'program';
  if(unmetered&&paid)throw new Error('Self-hosted accounting cannot require metered billing');
  // Publicly documented stress fixture; all five residents act through the same provider.
  world.npcs[0].needs.hunger=12;world.npcs[1].needs.energy=12;world.npcs[2].needs.social=12;world.npcs[3].needs.workPressure=95;
  const initialWorld=structuredClone(world),attempts:Attempt[]=[],completed:Record<string,number>={eat:0,rest:0,social:0,work:0,hobby:0};
  const residents=world.npcs.map(n=>({id:n.id,urgentHungerSeconds:0,urgentEnergySeconds:0,idleSeconds:0,waitChoices:0,moveOnlyChoices:0}));
  const seenCompletions=new Set<string>();let stopReason='duration',knownCostUSD=0,unknownCostCount=0;
  let inFlight:{at:number;npcId:string;sequence:number;input:DecisionInput;startedAt:string}|null=null;
  const snapshot=()=>({schemaVersion:2 as const,scope:'development, all five residents use one provider; social activities are engine-authored; world frozen during provider calls, not real-time latency test',seed,provider:{id:config.provider.id,model:config.provider.model,paid,
      protocolVersion:config.provider.protocolVersion??null,expressionMode:mode,...(config.provider.billingMode?{billingMode:config.provider.billingMode}:{})},
    config:{durationSeconds:config.durationSeconds,maxRequests:config.maxRequests,maxReportedCostUSD:budget,stepSeconds:.25},initialWorld,
    simulatedSeconds:world.time,complete:world.time>=config.durationSeconds,stopReason,inFlight,attempts:[...attempts],completed:{...completed},residents:structuredClone(residents),knownCostUSD,unknownCostCount,outstandingRequestCount:inFlight?1:0,totalCostUSD:unmetered||unknownCostCount||inFlight?null:knownCostUSD,
    validSave:loadWorld(serializeWorld(world))!==null,finalWorld:structuredClone(world)});
  await config.onCheckpoint?.(snapshot());
  outer:while(world.time<config.durationSeconds){
    for(const npc of world.npcs){
      if(npc.cooldown>0||npc.path.length||npc.job||npc.pendingInteraction||participatingConversation(world,npc))continue;
      if(attempts.length>=config.maxRequests){stopReason='request-budget';break outer;}
      if(paid&&knownCostUSD>=budget){stopReason='reported-cost-budget';break outer;}
      const options=getOptions(world,npc.id);if(options.length<2)continue;
      const state=getContext(world,npc.id);delete (state.situation as Record<string,unknown>).options;
      const input=decisionInput.parse({npcId:npc.id,revision:npc.revision,state,options:seededPermutation(options,`${seed}:${npc.id}:${attempts.length}`).map(({id,label,description})=>({id,label,description}))});
      const attempt:Attempt={at:world.time,npcId:npc.id,source:config.provider.id,input,response:null,responseModel:null,applied:false,error:null,latencyMs:0,costUSD:null};
      inFlight={at:world.time,npcId:npc.id,sequence:attempts.length+1,input:structuredClone(input),startedAt:new Date().toISOString()};await config.onCheckpoint?.(snapshot());
      const start=performance.now();
      try{
        const raw=await config.provider.decide(structuredClone(input));
        attempt.response=JSON.parse(JSON.stringify(raw)) as EvaluationResponse;
        if(typeof raw?.model==='string'&&raw.model.trim())attempt.responseModel=raw.model;
        if(!unmetered&&typeof raw?.cost==='number'&&Number.isFinite(raw.cost)&&raw.cost>=0)attempt.costUSD=raw.cost;
        const parsed=responseSchema.safeParse(raw);
        if(!parsed.success||parsed.data.contractValid===false||!input.options.some(o=>o.id===parsed.data.choice)||
          (mode==='generated'?parsed.data.dialogue!==null:parsed.data.dialogue!==undefined&&parsed.data.dialogue!==null))attempt.error='invalid-answer';
        else{
          const answer=parsed.data;
          attempt.applied=applyDecision(world,npc.id,answer.choice,config.provider.id,answer);
          if(!attempt.applied)attempt.error='execution-rejected';
        }
      }catch(error){attempt.error=safeError(error);const status=error instanceof Error?/^upstream_([45]\d{2})$/.exec(error.message):null;if(status)attempt.upstreamStatus=Number(status[1]);}
      attempt.latencyMs=performance.now()-start;attempts.push(attempt);inFlight=null;
      knownCostUSD+=attempt.costUSD??0;unknownCostCount+=attempt.costUSD===null?1:0;
      const stats=residents.find(n=>n.id===npc.id)!;
      if(attempt.applied&&attempt.response?.choice==='wait')stats.waitChoices++;
      if(attempt.applied&&attempt.response?.choice.startsWith('visit:'))stats.moveOnlyChoices++;
      await config.onCheckpoint?.(snapshot());
      if(attempt.error){stopReason='provider-error';break outer;}
      if(paid&&attempt.costUSD===null){stopReason='unknown-billing';break outer;}
    }
    const dt=Math.min(.25,config.durationSeconds-world.time);
    for(const npc of world.npcs){const stats=residents.find(n=>n.id===npc.id)!;
      if(npc.needs.hunger<20)stats.urgentHungerSeconds+=dt;if(npc.needs.energy<20)stats.urgentEnergySeconds+=dt;
      if(!npc.job&&!npc.path.length&&!participatingConversation(world,npc))stats.idleSeconds+=dt;
    }
    advance(world,dt);
    for(const record of world.decisions.filter(d=>d.source==='simulation'&&d.choice.startsWith('completed:'))){
      const key=`${record.time}:${record.npcId}:${record.choice}`;if(seenCompletions.has(key))continue;seenCompletions.add(key);
      const kind=record.choice.slice('completed:'.length);completed[kind]=(completed[kind]??0)+1;
    }
    if(world.survival.dead){stopReason='player-dead';break;}
  }
  const result=snapshot();await config.onCheckpoint?.(result);return result;
}

export type AutonomyTrace=Awaited<ReturnType<typeof runAutonomyTrajectory>>;

/** Schema-2 replay verifies execution, never requests remote inference. Historical v1 uses its archived source helper. */
export async function replayAutonomyTrajectory(trace:AutonomyTrace):Promise<{verified:true;attempts:number}>{
  if(trace.schemaVersion!==2||trace.inFlight||trace.outstandingRequestCount||trace.config.stepSeconds!==.25)throw new Error('replay: unresolved or unsupported autonomy trace');
  let index=0,mismatch=false;
  const provider:EvaluationProvider={...trace.provider,protocolVersion:trace.provider.protocolVersion??undefined,async decide(input){
    const attempt=trace.attempts[index++];
    if(!attempt||JSON.stringify(input)!==JSON.stringify(attempt.input)){mismatch=true;throw new Error('replay mismatch');}
    if(attempt.response===null)throw new Error(attempt.upstreamStatus?`upstream_${attempt.upstreamStatus}`:attempt.error??'provider-error');
    return structuredClone(attempt.response);
  }};
  const result=await runAutonomyTrajectory({provider,...trace.config,seed:trace.seed});
  const comparable=(value:AutonomyTrace)=>({initialWorld:value.initialWorld,finalWorld:value.finalWorld,complete:value.complete,stopReason:value.stopReason,
    simulatedSeconds:value.simulatedSeconds,completed:value.completed,residents:value.residents,validSave:value.validSave,
    knownCostUSD:value.knownCostUSD,unknownCostCount:value.unknownCostCount,totalCostUSD:value.totalCostUSD,
    attempts:value.attempts.map(({latencyMs:_latency,...attempt})=>attempt)});
  if(mismatch||index!==trace.attempts.length||JSON.stringify(comparable(result))!==JSON.stringify(comparable(trace)))throw new Error('replay: autonomy trace does not match current execution');
  return {verified:true,attempts:index};
}

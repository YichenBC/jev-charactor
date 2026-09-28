import {z} from 'zod';

const jobSchema=z.object({id:z.string().regex(/^[a-z0-9-]+$/),kind:z.enum(['interaction','autonomy']),
  provider:z.enum(['jev','llm','llm-character','rules','utility']),scenario:z.string().optional(),maxRequests:z.number().int().min(1).max(50)});
export type CandidateJob=z.infer<typeof jobSchema>;
const resultSchema=z.object({complete:z.boolean(),attemptedCount:z.number().int().nonnegative(),knownCostUSD:z.number().finite().nonnegative(),unknownCostCount:z.number().int().nonnegative(),
  outstandingRequestCount:z.number().int().min(0).max(1).optional(),checkpointRecovered:z.boolean().optional()});
export type CandidateResult=z.infer<typeof resultSchema>;
type Cell=CandidateJob&{status:'unattempted'|'running'|'complete'|'incomplete'|'error';result?:CandidateResult};
export interface CandidateBatch {
  schemaVersion:1;complete:boolean;stopReason:string;inFlight:string|null;jobs:Cell[];failurePolicy:'stop-first-incomplete'|'continue-unmetered';
  maxPaidCostUSD:number;knownPaidCostUSD:number;totalPaidCostUSD:number|null;
}

/** Recover only validated accounting, never infer a successful run from an interrupted checkpoint. */
export function recoverCandidateCheckpoint(value:unknown):CandidateResult{
  const trace=z.object({attempts:z.array(z.object({costUSD:z.number().finite().nonnegative().nullable()})),
    knownCostUSD:z.number().finite().nonnegative(),unknownCostCount:z.number().int().nonnegative(),
    outstandingRequestCount:z.number().int().min(0).max(1),inFlight:z.record(z.string(),z.unknown()).nullable()}).parse(value);
  const known=trace.attempts.reduce((sum,a)=>sum+(a.costUSD??0),0),unknown=trace.attempts.filter(a=>a.costUSD===null).length;
  if(Math.abs(known-trace.knownCostUSD)>1e-12||unknown!==trace.unknownCostCount||Boolean(trace.inFlight)!==Boolean(trace.outstandingRequestCount))throw new Error('Inconsistent checkpoint accounting');
  return {complete:false,attemptedCount:trace.attempts.length,knownCostUSD:known,unknownCostCount:unknown,
    outstandingRequestCount:trace.outstandingRequestCount,checkpointRecovered:true};
}

export function candidateJobs(offline=false):CandidateJob[]{
  const providers:CandidateJob['provider'][]=offline?['rules','utility']:['jev','llm','llm-character'];
  const scenarios=['mei-continuity','mei-needs-feedback','tang-continuity','tang-needs-feedback','lin-continuity','lin-needs-feedback','lan-continuity','lan-needs-feedback'];
  return [...scenarios.flatMap((scenario,i)=>providers.map((_,j)=>{
    const provider=providers[(j+i)%providers.length];
    return {id:`${scenario}-${provider}`,kind:'interaction' as const,provider,scenario,maxRequests:12};
  })),...providers.map(provider=>({id:`autonomy-${provider}`,kind:'autonomy' as const,provider,maxRequests:50}))];
}

/** Sequential orchestration only. Each runner must enforce its own per-call request/billing limits. */
export async function runCandidateBatch(jobs:CandidateJob[],maxPaidCostUSD:number,
  execute:(job:CandidateJob,remainingPaidCostUSD:number)=>Promise<CandidateResult>,
  checkpoint?:(snapshot:CandidateBatch)=>Promise<void>,failurePolicy:CandidateBatch['failurePolicy']='stop-first-incomplete'):Promise<CandidateBatch>{
  z.enum(['stop-first-incomplete','continue-unmetered']).parse(failurePolicy);
  z.array(jobSchema).min(1).max(30).parse(jobs);z.number().finite().nonnegative().max(1).parse(maxPaidCostUSD);
  if(new Set(jobs.map(j=>j.id)).size!==jobs.length)throw new Error('Duplicate batch job');
  const cells:Cell[]=jobs.map(job=>({...job,status:'unattempted'}));
  let knownPaidCostUSD=0,unknownPaid=false,stopReason='running',inFlight:string|null=null;
  const hasPaid=jobs.some(j=>j.provider==='jev');
  const snapshot=():CandidateBatch=>structuredClone({schemaVersion:1,complete:stopReason==='finished',stopReason,inFlight,jobs:cells,failurePolicy,maxPaidCostUSD,knownPaidCostUSD,
    totalPaidCostUSD:unknownPaid||cells.some(c=>c.status==='running'&&c.provider==='jev')?null:knownPaidCostUSD});
  const save=async()=>{await checkpoint?.(snapshot());};
  await save();
  for(const cell of cells){
    if(hasPaid&&knownPaidCostUSD>=maxPaidCostUSD){stopReason='paid-cost-budget';break;}
    cell.status='running';inFlight=cell.id;await save();
    try{
      const result=resultSchema.parse(await execute({...cell},Math.max(0,maxPaidCostUSD-knownPaidCostUSD)));
      if(result.attemptedCount+(result.outstandingRequestCount??0)>cell.maxRequests||result.unknownCostCount>result.attemptedCount||
        result.complete&&(result.outstandingRequestCount||result.checkpointRecovered))throw new Error('Invalid summary counts');
      cell.result=result;
      if(cell.provider==='jev'){knownPaidCostUSD+=result.knownCostUSD;unknownPaid ||= result.unknownCostCount>0||Boolean(result.outstandingRequestCount);}
      cell.status=result.complete&&!unknownPaid?'complete':'incomplete';
      if(unknownPaid)stopReason='unknown-paid-billing';
      else if(result.checkpointRecovered)stopReason='runner-checkpoint-recovered';
      else if(result.outstandingRequestCount)stopReason='unresolved-runner-request';
      else if(!result.complete&&!(failurePolicy==='continue-unmetered'&&['llm','llm-character'].includes(cell.provider)))stopReason='incomplete-run';
    }catch{
      cell.status='error';if(cell.provider==='jev')unknownPaid=true;stopReason='runner-error';
    }
    inFlight=null;await save();
    if(stopReason!=='running')break;
  }
  if(stopReason==='running')stopReason=cells.every(c=>c.status==='complete')?'finished':'finished-with-incomplete-runs';
  await save();return snapshot();
}

/** A continuation can reduce, never enlarge, the frozen paid-charge ceiling. */
export function candidateCostCap(raw:string|undefined,offline:boolean):number{
  const cap=raw===undefined?(offline?0:1):Number(raw);
  if(raw?.trim()===''||!Number.isFinite(cap)||cap<0||cap>1||(offline&&cap!==0))throw new Error('Invalid candidate cost cap');
  return cap;
}

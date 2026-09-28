import {describe,it,expect} from 'vitest';
import {runCandidateBatch,recoverCandidateCheckpoint,candidateCostCap,type CandidateJob} from '../scripts/evaluation/candidate-batch';

const jobs:CandidateJob[]=[
  {id:'jev-first',kind:'interaction',provider:'jev',scenario:'mei-continuity',maxRequests:12},
  {id:'kimi-next',kind:'interaction',provider:'llm',scenario:'mei-continuity',maxRequests:12},
  {id:'jev-later',kind:'autonomy',provider:'jev',maxRequests:50},
];
const success={complete:true,attemptedCount:2,knownCostUSD:0.01,unknownCostCount:0};

describe('bounded candidate batch',()=>{
  it('preserves a failed cell and never starts later cells',async()=>{
    const calls:string[]=[];
    const result=await runCandidateBatch(jobs,.1,async job=>{calls.push(job.id);return {...success,complete:false};});
    expect(calls).toEqual(['jev-first']);
    expect(result.jobs.map(j=>j.status)).toEqual(['incomplete','unattempted','unattempted']);
    expect(result.complete).toBe(false);
    expect(result.knownPaidCostUSD).toBe(.01);
  });
  it('stops on unknown paid billing, but preserves self-hosted unknown costs',async()=>{
    const result=await runCandidateBatch(jobs,1,async job=>({...success,unknownCostCount:job.provider==='llm'?2:job.id==='jev-later'?1:0}));
    expect(result.jobs.map(j=>j.status)).toEqual(['complete','complete','incomplete']);
    expect(result.stopReason).toBe('unknown-paid-billing');
    expect(result.totalPaidCostUSD).toBeNull();
  });
  it('enforces the cumulative reported cap before another call and checkpoints in flight',async()=>{
    const snapshots:any[]=[];const caps:number[]=[];
    const result=await runCandidateBatch(jobs,.01,async (_job,cap)=>{caps.push(cap);return success;},async s=>{snapshots.push(s);});
    expect(caps).toEqual([.01]);
    expect(result.stopReason).toBe('paid-cost-budget');
    expect(result.jobs[1].status).toBe('unattempted');
    expect(snapshots.some(s=>s.jobs[0].status==='running'&&s.inFlight==='jev-first'&&s.totalPaidCostUSD===null)).toBe(true);
  });
  it('fails closed on malformed summaries and records a sanitized execution error',async()=>{
    const malformed=await runCandidateBatch(jobs,1,async()=>({...success,attemptedCount:13}));
    expect(malformed.jobs[0].status).toBe('error');
    expect(malformed.jobs[1].status).toBe('unattempted');
    const thrown=await runCandidateBatch(jobs,1,async()=>{throw new Error('a secret or private endpoint');});
    expect(JSON.stringify(thrown)).not.toContain('secret');
    expect(thrown.totalPaidCostUSD).toBeNull();
  });
  it('keeps billed calls and unresolved checkpoints when a runner crashes before its summary',async()=>{
    const checkpoint={attempts:[{costUSD:.03},{costUSD:null}],knownCostUSD:.03,unknownCostCount:1,outstandingRequestCount:1,inFlight:{sequence:3}};
    const recovered=recoverCandidateCheckpoint(checkpoint);
    const result=await runCandidateBatch(jobs,1,async()=>recovered);
    expect(result.knownPaidCostUSD).toBe(.03);expect(result.totalPaidCostUSD).toBeNull();
    expect(result.jobs[0].result).toMatchObject({complete:false,attemptedCount:2,outstandingRequestCount:1,checkpointRecovered:true});
    expect(result.jobs[1].status).toBe('unattempted');
    expect(()=>recoverCandidateCheckpoint({...checkpoint,knownCostUSD:0})).toThrow();
    expect(()=>recoverCandidateCheckpoint({...checkpoint,unknownCostCount:0})).toThrow();
  });
});

it('accepts only a declared remaining cap within the original one-dollar budget',()=>{
  expect(candidateCostCap(undefined,false)).toBe(1);
  expect(candidateCostCap('0.995556736',false)).toBe(.995556736);
  expect(candidateCostCap(undefined,true)).toBe(0);
  expect(candidateCostCap('0',true)).toBe(0);
  for (const value of ['1.01','-1','NaN','Infinity','',' ']) expect(()=>candidateCostCap(value,false)).toThrow();
  expect(()=>candidateCostCap('.01',true)).toThrow();
});

it('isolates predeclared unmetered failures without relabeling them complete or retrying',async()=>{
  const independent:CandidateJob[]=[{...jobs[1],id:'selector-fails'}, {...jobs[1],id:'full-next',provider:'llm-character'},jobs[2]];
  const calls:string[]=[];
  const result=await runCandidateBatch(independent,1,async job=>{calls.push(job.id);return {...success,complete:job.id!=='selector-fails',knownCostUSD:job.provider==='jev'?.01:0,unknownCostCount:job.provider==='jev'?0:2};},undefined,'continue-unmetered');
  expect(calls).toEqual(['selector-fails','full-next','jev-later']);
  expect(result.jobs.map(j=>j.status)).toEqual(['incomplete','complete','complete']);
  expect(result.complete).toBe(false);expect(result.stopReason).toBe('finished-with-incomplete-runs');
});
it('still stops on a paid failure or unresolved runner in independent mode',async()=>{
  const paid=await runCandidateBatch(jobs,1,async()=>({...success,complete:false,unknownCostCount:1}),undefined,'continue-unmetered');
  expect(paid.jobs[1].status).toBe('unattempted');expect(paid.totalPaidCostUSD).toBeNull();
  const unresolved=await runCandidateBatch([jobs[1],jobs[2]],1,async()=>({...success,complete:false,outstandingRequestCount:1}),undefined,'continue-unmetered');
  expect(unresolved.jobs[1].status).toBe('unattempted');
});

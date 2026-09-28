import {describe,it,expect} from 'vitest';
import {runAutonomyTrajectory,replayAutonomyTrajectory} from '../scripts/evaluation/trajectory';
import {ruleProvider} from '../scripts/evaluation/providers';
import type {EvaluationProvider} from '../scripts/evaluation/types';

describe('autonomy trace',()=>{
  it('advances actual jobs with bounded simulation time and independently records completion',async()=>{
    const result=await runAutonomyTrajectory({provider:ruleProvider,durationSeconds:90,maxRequests:50});
    expect(result.stopReason).toBe('duration');expect(result.simulatedSeconds).toBe(90);
    expect(result.attempts.length).toBeLessThanOrEqual(50);
    expect(result.completed.eat).toBeGreaterThan(0);expect(result.completed.rest).toBeGreaterThan(0);
    expect(result.validSave).toBe(true);expect(result.totalCostUSD).toBe(0);
    expect(result.residents.every(n=>n.urgentHungerSeconds>=0&&n.urgentHungerSeconds<=90)).toBe(true);
    expect(result.attempts.every(a=>a.input&&a.source==='rules')).toBe(true);
  });
  it('stops after a failed paid attempt and preserves failure without simulation success',async()=>{
    const result=await runAutonomyTrajectory({provider:{id:'broken',model:'fake',paid:true,async decide(){throw new Error('secret-key-in-error');}},durationSeconds:90,maxRequests:5});
    expect(result.stopReason).toBe('provider-error');expect(result.attempts).toHaveLength(1);
    expect(result.simulatedSeconds).toBe(result.attempts[0].at);expect(result.totalCostUSD).toBeNull();
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });
  it('stops at the request limit without presenting a truncated run as complete',async()=>{
    const result=await runAutonomyTrajectory({provider:ruleProvider,durationSeconds:90,maxRequests:1});
    expect(result.stopReason).toBe('request-budget');expect(result.complete).toBe(false);expect(result.attempts).toHaveLength(1);
  });
});

it('marks in-flight billing unknown and keeps returned model on invalid answers',async()=>{
  const snapshots:any[]=[];
  const result=await runAutonomyTrajectory({provider:{id:'invalid',model:'requested',paid:true,async decide(){return{choice:'wait',affect:'invalid',model:'actual',latencyMs:1,cost:.002};}},durationSeconds:30,maxRequests:2,onCheckpoint:async s=>{snapshots.push(s);}});
  const pending=snapshots.find(s=>s.inFlight);
  expect(pending.totalCostUSD).toBeNull();expect(pending.outstandingRequestCount).toBe(1);
  expect(result.attempts[0].responseModel).toBe('actual');expect(result.totalCostUSD).toBe(.002);
});

const unmeteredProvider = (changes: Partial<EvaluationProvider> = {}): EvaluationProvider => ({
  id:'llm-character', model:'fixture', paid:false, expressionMode:'generated',
  protocolVersion:'fixture-v2', billingMode:'self-hosted-unmetered',
  async decide(input) { return {...await ruleProvider.decide(input), dialogue:null,
    rawContent:'{"action":"fixture","dialogue":null}', finishReason:'stop',
    tokenUsage:{promptTokens:10,completionTokens:3,totalTokens:13}}; },
  ...changes,
});

it('retains full-character evidence and explicitly unmeasured cost throughout checkpoints',async()=>{
  const snapshots:any[]=[];
  const result=await runAutonomyTrajectory({provider:unmeteredProvider(),durationSeconds:1,maxRequests:10,maxReportedCostUSD:0,onCheckpoint:async s=>{snapshots.push(s);}});
  expect(result.complete).toBe(true);
  expect(result.provider).toMatchObject({billingMode:'self-hosted-unmetered',expressionMode:'generated',protocolVersion:'fixture-v2'});
  expect(snapshots.every(s=>s.totalCostUSD===null)).toBe(true);
  expect(result.attempts.every(a=>a.costUSD===null)).toBe(true);
  expect(result.attempts[0].response).toMatchObject({dialogue:null,finishReason:'stop',tokenUsage:{totalTokens:13},rawContent:expect.any(String)});
  const pending=snapshots.find(s=>s.inFlight);
  expect(pending.inFlight.input).toEqual(result.attempts[0].input);
  expect(pending.inFlight.startedAt).toEqual(expect.any(String));
});

it('rejects inconsistent paid unmetered accounting before invoking the provider',async()=>{
  let calls=0;
  await expect(runAutonomyTrajectory({provider:unmeteredProvider({paid:true,async decide(){calls++;throw new Error('no');}}),durationSeconds:1,maxRequests:1})).rejects.toThrow();
  expect(calls).toBe(0);
});

it.each(['generated','program'] as const)('rejects unsolicited autonomous speech in %s mode and retains the answer',async expressionMode=>{
  const provider=unmeteredProvider({expressionMode,async decide(input){return {...await ruleProvider.decide(input),dialogue:'An invented conversation.'};}});
  const result=await runAutonomyTrajectory({provider,durationSeconds:1,maxRequests:5});
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0].applied).toBe(false);
  expect(result.attempts[0].response?.dialogue).toBe('An invented conversation.');
  expect(result.complete).toBe(false);
});

it('requires an explicit null dialogue for full-character autonomous decisions',async()=>{
  const result=await runAutonomyTrajectory({provider:unmeteredProvider({decide:ruleProvider.decide}),durationSeconds:1,maxRequests:5});
  expect(result.attempts[0].applied).toBe(false);
  expect(result.attempts).toHaveLength(1);
});

it('preserves malformed response evidence while applying nothing',async()=>{
  const result=await runAutonomyTrajectory({provider:unmeteredProvider({async decide(){return {choice:'wait',affect:'broken',latencyMs:1,rawContent:'{"action":',finishReason:'length',tokenUsage:{promptTokens:10,completionTokens:20,totalTokens:30}};}}),durationSeconds:1,maxRequests:5});
  expect(result.attempts).toHaveLength(1);
  expect(result.attempts[0].response).toMatchObject({rawContent:'{"action":',finishReason:'length',tokenUsage:{totalTokens:30}});
  expect(result.attempts[0].applied).toBe(false);
  expect(result.simulatedSeconds).toBe(result.attempts[0].at);
});

it('replays complete unmetered traces and rejects modified input, outcome and unresolved state',async()=>{
  const trace=await runAutonomyTrajectory({provider:unmeteredProvider(),durationSeconds:1,maxRequests:10,maxReportedCostUSD:0});
  expect(await replayAutonomyTrajectory(trace)).toMatchObject({verified:true,attempts:trace.attempts.length});
  const input=structuredClone(trace);input.attempts[0].input.revision++;
  await expect(replayAutonomyTrajectory(input)).rejects.toThrow('replay');
  const outcome=structuredClone(trace);outcome.finalWorld.player.money++;
  await expect(replayAutonomyTrajectory(outcome)).rejects.toThrow('replay');
  const pending=structuredClone(trace);pending.outstandingRequestCount=1;
  await expect(replayAutonomyTrajectory(pending)).rejects.toThrow('replay');
});

it('replays provider HTTP failures without accessing a live provider',async()=>{
  const trace=await runAutonomyTrajectory({provider:unmeteredProvider({async decide(){throw new Error('upstream_503');}}),durationSeconds:1,maxRequests:10});
  expect(trace.attempts[0].upstreamStatus).toBe(503);
  expect(await replayAutonomyTrajectory(trace)).toEqual({verified:true,attempts:1});
});

it('preserves and replays a safe transport category instead of calling every failure a timeout',async()=>{
  const trace=await runAutonomyTrajectory({provider:unmeteredProvider({async decide(){throw new Error('transport_socket_closed');}}),durationSeconds:1,maxRequests:10});
  expect(trace.attempts[0].error).toBe('transport_socket_closed');
  expect(await replayAutonomyTrajectory(trace)).toEqual({verified:true,attempts:1});
});

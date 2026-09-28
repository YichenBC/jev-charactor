/** Retrospective matched-script description, never a quality or causal estimator. */
import assert from 'node:assert/strict';
import {isDeepStrictEqual,parseArgs} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadBatch} from './analyzer.mjs';

const providers=['rules','utility','jev','llm','llm-character'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const player=r=>['interact','followup'].includes(r.kind);
const equal=(a,b,label)=>assert.deepEqual(a,b,`${label} mismatch`);
const config=t=>Object.fromEntries(Object.entries(t.config).filter(([k])=>k!=='maxReportedCostUSD'));
function latency(attempts){
 const xs=attempts.map(a=>a.latencyMs).sort((a,b)=>a-b);
 assert(xs.every(n=>Number.isFinite(n)&&n>=0),'invalid latency');
 return {count:xs.length,p50:xs.length?xs[Math.ceil(xs.length*.5)-1]:null,p95:xs.length?xs[Math.ceil(xs.length*.95)-1]:null};
}
function attemptStats(attempts){return {attempts:attempts.length,applied:attempts.filter(a=>a.applied).length,errors:attempts.filter(a=>a.error!=null).length,latencyMs:latency(attempts)};}
function recordAttempt(t,r){return r.attemptSequence===undefined?undefined:t.attempts.find(a=>a.sequence===r.attemptSequence);}
function choiceView(t,r){const a=recordAttempt(t,r);return {status:r.status,reason:r.reason??null,choice:a?.response?.choice??null,affect:a?.response?.affect??null,reply:r.reply??null};}
function compareSteps(reference,other){
 const counts={playerSteps:0,bothApplied:0,sameChoice:0,sameAffect:0,sameReply:0,sameInput:0,bothSkipped:0,statusMismatch:0},steps=[];
 for(const r of reference.records.filter(player)){
  const s=other.records.find(x=>x.stepId===r.stepId),a=recordAttempt(reference,r),b=recordAttempt(other,s);
  const bothApplied=r.status==='applied'&&s.status==='applied';
  if(bothApplied)assert(a?.response&&b?.response&&typeof r.reply==='string'&&typeof s.reply==='string','applied player step missing response');
  const flags={bothApplied,sameChoice:bothApplied&&a.response.choice===b.response.choice,sameAffect:bothApplied&&a.response.affect===b.response.affect,sameReply:bothApplied&&r.reply===s.reply,sameInput:bothApplied&&isDeepStrictEqual(a.input,b.input),bothSkipped:r.status==='skipped'&&s.status==='skipped',statusMismatch:r.status!==s.status};
  counts.playerSteps++;for(const [key,value]of Object.entries(flags))counts[key]+=Number(value);
  steps.push({scenario:reference.scenario.id,stepId:r.stepId,kind:r.kind,jev:choiceView(reference,r),other:choiceView(other,s),...flags});
 }
 return {counts,steps};
}
export function comparePrograms(batches){
 assert(batches.length,'missing batches');const base=batches[0].batch;
 assert(base.source&&Object.keys(base.sourceHashes??{}).length&&Object.keys(base.scenarioHashes??{}).length,'missing fingerprints');
 const entries=[];
 for(const b of batches){
  assert(b.batch.gitDirty===false,'dirty source rejected');assert(!b.unattempted.length,'incomplete batch inventory');
  for(const key of ['source','sourceHashes','scenarioHashes'])equal(b.batch[key],base[key],key);
  entries.push(...b.jobs);
 }
 const scenarios=Object.keys(base.scenarioHashes).sort(),cells=new Map();
 for(const e of entries){
  assert(e.trace.complete&&e.metrics.complete,'incomplete cell');assert(providers.includes(e.job.provider),'unexpected provider');
  equal(e.trace.provider.id,e.job.provider,'provider id');
  assert(['interaction','autonomy'].includes(e.job.kind),'unexpected kind');
  equal(e.trace.provider.expressionMode,e.job.provider==='llm-character'?'generated':'program','expression mode');
  const scenario=e.job.kind==='interaction'?e.job.scenario:'autonomy';
  if(e.job.kind==='interaction'){
   assert(scenarios.includes(scenario),'unexpected scenario');equal(e.trace.scenario.id,scenario,'scenario id');
   equal(hash(JSON.stringify(e.trace.scenario)),base.scenarioHashes[scenario],'scenario hash');
  }
  const key=`${e.job.provider}/${scenario}`;assert(!cells.has(key),'duplicate cell');cells.set(key,e);
 }
 for(const p of providers)for(const s of [...scenarios,'autonomy'])assert(cells.has(`${p}/${s}`),`missing cell ${p}/${s}`);
 for(const p of providers)for(const s of scenarios)equal(cells.get(`${p}/${s}`).trace.provider,cells.get(`${p}/autonomy`).trace.provider,'provider metadata');
 for(const s of scenarios){
  const ref=cells.get(`jev/${s}`).trace;
  for(const p of providers){
   const t=cells.get(`${p}/${s}`).trace;
   equal(t.scenario,ref.scenario,'scenario definition/initial world');equal(config(t),config(ref),'interaction config');
   assert(new Set(t.records.map(r=>r.stepId)).size===t.records.length,'duplicate step');
   equal(t.records.map(r=>[r.stepId,r.kind]),ref.records.map(r=>[r.stepId,r.kind]),'script step inventory');
   for(const a of t.attempts){
    const rs=t.records.filter(r=>r.attemptSequence===a.sequence);assert(rs.length===1,'attempt must map to one record');
    assert(player(rs[0])||rs[0].kind==='autonomy','unknown attempt record kind');
   }
  }
 }
 const autonomous=cells.get('jev/autonomy').trace;
 for(const p of providers){const t=cells.get(`${p}/autonomy`).trace;equal(config(t),config(autonomous),'autonomy config');equal(t.seed,autonomous.seed,'autonomy seed');equal(t.initialWorld,autonomous.initialWorld,'autonomy initial world');equal(t.simulatedSeconds,t.config.durationSeconds,'autonomy duration');}
 const conditions=providers.map(provider=>{
  const runs=scenarios.map(s=>cells.get(`${provider}/${s}`).trace),attempts=runs.flatMap(t=>t.attempts);
  const pa=runs.flatMap(t=>t.records.filter(player).flatMap(r=>{const a=recordAttempt(t,r);return a?[a]:[];}));
  const ea=runs.flatMap(t=>t.records.filter(r=>r.kind==='autonomy').flatMap(r=>{const a=recordAttempt(t,r);return a?[a]:[];}));
  const t=cells.get(`${provider}/autonomy`).trace;
  return {provider,providerMetadata:t.provider,comparisonRole:provider==='llm-character'?'supplemental-generated-expression':'shared-program-selector',interaction:{...attemptStats(attempts),trajectories:runs.length,playerAttempts:pa.length,embeddedAutonomyAttempts:ea.length,playerLatencyMs:latency(pa),embeddedAutonomyLatencyMs:latency(ea),skippedPlayerSteps:runs.reduce((n,r)=>n+r.records.filter(s=>player(s)&&s.status==='skipped').length,0),playerReplyOrRefuseOnly:pa.filter(a=>a.input.options.length===2&&a.input.options.some(o=>o.id==='refuse')&&a.input.options.some(o=>o.id.startsWith('reply'))).length},wholeWorld:{...attemptStats(t.attempts),simulatedSeconds:t.simulatedSeconds,completed:t.completed,residents:t.residents,finalNeeds:t.finalWorld.npcs.map(n=>({id:n.id,needs:n.needs}))}};
 });
 const comparisons=providers.filter(p=>p!=='jev').map(provider=>{
  const runs=scenarios.map(s=>compareSteps(cells.get(`jev/${s}`).trace,cells.get(`${provider}/${s}`).trace));
  const counts=Object.fromEntries(Object.keys(runs[0].counts).map(k=>[k,runs.reduce((n,r)=>n+r.counts[k],0)]));
  return {reference:'jev',provider,sharedProgramExpression:provider!=='llm-character',counts,steps:runs.flatMap(r=>r.steps)};
 });
 return {schemaVersion:1,scope:'Retrospective development comparison at matching script steps. Histories can diverge; same choice/reply is not a quality score or causal estimate. Rules/utility/Jev/Kimi-selector share program expression; Kimi-generated changes expression and is supplemental, not a selector-only ablation. No human ratings, superiority, noninferiority or held-out generalization result.',source:base.source,sourceHashes:base.sourceHashes,scenarioHashes:base.scenarioHashes,batches:batches.map(b=>({sha256:b.batchSha256,files:b.jobs.map(e=>({job:e.job.id,hashes:e.files}))})),conditions,comparisons,limitations:['Rules and utility share authored social heuristics and always focused affect; neither is the strongest possible program policy.','Record equality counts literal strings only; different prose does not imply different semantic quality.','Only successful player steps enter choice/affect/reply equality denominators; skips and failures remain explicit.','One trajectory per scenario/condition and one 90-second whole-world run per condition; turns are correlated.','World time pauses during requests. Local program latency and network/deployed model latency are different execution paths.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const {values}=parseArgs({strict:true,options:{batch:{type:'string',multiple:true},out:{type:'string'}}});
  assert(values.batch?.length&&values.out,'Usage: node program-ablation.mjs --batch LIVE --batch OFFLINE --out FRESH.json');
  const batches=[];for(const dir of values.batch)batches.push(await loadBatch(dir));
  const report=comparePrograms(batches);
  for(const b of batches){equal(hash(await readFile(join(b.batchDirectory,'batch.json'))),b.batchSha256,'batch changed');for(const e of b.jobs)for(const [file,digest]of Object.entries(e.files))equal(hash(await readFile(join(e.batchDirectory,e.job.id,file))),digest,'evidence changed');}
  const out=resolve(values.out);await mkdir(dirname(out),{recursive:true});await writeFile(out,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({out,conditions:report.conditions.map(c=>({provider:c.provider,interaction:c.interaction,completed:c.wholeWorld.completed})),comparisons:report.comparisons.map(c=>({provider:c.provider,...c.counts}))}));
 }catch(error){console.error(error.message);process.exitCode=1;}
}

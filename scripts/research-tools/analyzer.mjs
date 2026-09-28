#!/usr/bin/env node
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isDeepStrictEqual } from 'node:util';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
function check(condition, message) { if (!condition) throw new Error(message); }
function equal(actual, expected, label) {
 const same = typeof actual === 'number' && typeof expected === 'number'
  ? Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)) : isDeepStrictEqual(actual, expected);
 check(same, `${label} mismatch`);
}
function quantiles(values) {
 check(values.every(finite), 'invalid attempt latency');
 const sorted = [...values].sort((a,b)=>a-b), n=sorted.length;
 return {count:n,p50:n?sorted[Math.ceil(n*.5)-1]:null,p95:n?sorted[Math.ceil(n*.95)-1]:null,max:n?sorted[n-1]:null,sum:values.reduce((s,v)=>s+v,0),quantile:'nearest-rank: sorted[ceil(p*n)-1]'};
}
function tokens(attempts, native) {
 const keys=native?['input_tokens','output_tokens']:['promptTokens','completionTokens','totalTokens'];
 const total=Object.fromEntries(keys.map(k=>[k,0])); let reportedCount=0;
 for(const a of attempts) {
  let usage=a.response?.tokenUsage;
  if(native) { usage=undefined;try { usage=JSON.parse(a.response?.rawContent).usage; } catch { /* A missing/non-JSON envelope has no reported native usage. */ } }
  if(usage==null)continue;
  check(keys.every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0),'invalid token usage');
  for(const k of keys){total[k]+=usage[k];check(Number.isSafeInteger(total[k]),'token sum overflow');}reportedCount++;
 }
 return {...total,reportedCount,missingCount:attempts.length-reportedCount};
}
export function analyzeJob({job,trace:t,summary:s,provenance}) {
 check(Array.isArray(t.attempts),'missing attempts');
 check(!t.inFlight && !t.outstandingRequestCount && t.stopReason!=='running','active trajectory rejected');
 check(typeof t.complete==='boolean','missing completion');
 equal(t.provider.id,job.provider,'provider');equal(s.provider,t.provider,'summary provider');
 const a=t.attempts, applied=a.filter(x=>x.applied).length,errors=a.filter(x=>x.error!==null&&x.error!==undefined).length;
 for(const x of a) {check(typeof x.applied==='boolean','invalid applied');check(x.costUSD===null||finite(x.costUSD),'invalid attempt cost');}
 const knownCostUSD=a.reduce((n,x)=>n+(x.costUSD??0),0),unknownCostCount=a.filter(x=>x.costUSD===null).length;
 const unmetered=t.provider.billingMode==='self-hosted-unmetered';
 for(const x of a) { if(unmetered)equal(x.costUSD,null,'self-hosted cost');else if(finite(x.response?.cost))equal(x.costUSD,x.response.cost,'response cost'); }
 const totalCostUSD=unmetered||unknownCostCount?null:knownCostUSD;
 const latencyMs=quantiles(a.map(x=>x.latencyMs));
 for(const [key,value] of Object.entries({knownCostUSD,unknownCostCount,totalCostUSD})) {equal(t[key],value,`trace ${key}`);equal(s[key],value,`summary ${key}`);}
 for(const key of ['complete','stopReason','validSave'])equal(s[key],t[key],`summary ${key}`);
 equal(s.attemptedCount,a.length,'summary attemptedCount');
 if(job.result)for(const [key,value] of Object.entries({complete:t.complete,attemptedCount:a.length,knownCostUSD,unknownCostCount}))equal(job.result[key],value,`batch result ${key}`);
 equal(job.status,t.complete?'complete':'incomplete','job status');
 if(s.replay){equal(s.replay.attempts,a.length,'replay attempts');check(s.replay.verified===true,'replay not verified');}
 let skips=0,autonomy=null;
 if(job.kind==='interaction') {
  check(Array.isArray(t.records),'missing records');
  const skippedSteps=t.records.filter(r=>r.status==='skipped').map(r=>({id:r.stepId,reason:r.reason}));skips=skippedSteps.length;
  equal(s.appliedCount,applied,'summary appliedCount');equal(s.skippedSteps,skippedSteps,'summary skippedSteps');
  if(s.responseLatencyMs)for(const key of ['p50','p95'])equal(s.responseLatencyMs[key],latencyMs[key],`summary latency ${key}`);
  if(s.replay)equal(s.replay.records,t.records.length,'replay records');
  check(new Set(a.map(x=>x.sequence)).size===a.length,'duplicate attempt sequence');
  for(const x of a){const records=t.records.filter(r=>r.attemptSequence===x.sequence);check(records.length===1,'attempt must map to one record');equal(records[0].status,x.applied?'applied':'error','record status');}
 } else {
  check(job.kind==='autonomy','unsupported job kind');
  for(const key of ['simulatedSeconds','completed','residents','config'])equal(s[key],t[key],`summary ${key}`);
  check(finite(t.simulatedSeconds)&&Array.isArray(t.residents),'invalid autonomy exposure');
  autonomy={simulatedSeconds:t.simulatedSeconds,requestedSeconds:t.config.durationSeconds,completed:t.completed,residents:t.residents,verification:'Summary/trace equality; exposure accumulators are preserved, not independently resimulated.'};
 }
 return {jobId:job.id,kind:job.kind,provider:t.provider,complete:t.complete,stopReason:t.stopReason,attempts:a.length,applied,errors,skips,latencyMs,
  standardTokenUsage:tokens(a,false),protocolNativeUsage:t.provider.id==='jev'?{...tokens(a,true),applicable:true}:{input_tokens:null,output_tokens:null,reportedCount:0,missingCount:null,applicable:false},
  knownCostUSD,unknownCostCount,totalCostUSD,knownPaidCostUSD:t.provider.paid?knownCostUSD:0,unknownPaidCostCount:t.provider.paid?unknownCostCount:0,
  infrastructureCostUSD:null,costNote:unmetered?'Self-hosted infrastructure unmeasured; null is not free inference.':'Reported API billing only; infrastructure not estimated.',
  autonomy,sourceRevision:provenance?.gitRevision??null,sourceHashes:provenance?.sourceHashes??null};
}
export async function loadBatch(directory,{allowIncomplete=false}={}) {
 const batchDirectory=resolve(directory), batchBytes=await readFile(join(batchDirectory,'batch.json')),batch=JSON.parse(batchBytes);
 check(Array.isArray(batch.jobs),'missing batch jobs');
 check(!batch.inFlight&&!batch.jobs.some(j=>j.status==='running')&&!['running','pending'].includes(batch.stopReason),'active batch rejected');
 check(batch.complete===true||allowIncomplete,'incomplete batch requires --allow-incomplete');
 const jobs=[],unattempted=[], seen=new Set();
 for(const job of batch.jobs) {
  check(typeof job.id==='string'&&/^[A-Za-z0-9_-]+$/.test(job.id),'unsafe job id');check(!seen.has(job.id),'duplicate job id');seen.add(job.id);
  if(job.status==='unattempted'){unattempted.push(job);continue;}
  check(['complete','incomplete'].includes(job.status),'nonterminal job rejected');
  const files={},data={};
  for(const name of ['trajectory.json','summary.json','provenance.json',...(job.kind==='interaction'?['transcript.md']:[])]) {
   const path=join(batchDirectory,job.id,name);check((await lstat(path)).isFile(),'input must be regular file');
   const bytes=await readFile(path);files[name]=hash(bytes);if(name.endsWith('.json'))data[name.split('.')[0]]=JSON.parse(bytes);
  }
  const entry={job,trace:data.trajectory,summary:data.summary,provenance:data.provenance,files,batchDirectory};
  equal(entry.provenance.gitRevision,batch.source,'source revision');equal(entry.provenance.sourceHashes,batch.sourceHashes,'source hashes');
  entry.metrics=analyzeJob(entry);jobs.push(entry);
 }
 if(batch.complete)check(unattempted.length===0&&jobs.every(j=>j.metrics.complete),'complete batch has unfinished jobs');
 const knownPaidCostUSD=jobs.reduce((n,j)=>n+j.metrics.knownPaidCostUSD,0),unknownPaidCostCount=jobs.reduce((n,j)=>n+j.metrics.unknownPaidCostCount,0);
 equal(batch.knownPaidCostUSD,knownPaidCostUSD,'batch known paid cost');equal(batch.totalPaidCostUSD,unknownPaidCostCount?null:knownPaidCostUSD,'batch total paid cost');
 equal(hash(await readFile(join(batchDirectory,'batch.json'))),hash(batchBytes),'batch changed during read');
 return {batchDirectory,batch,batchSha256:hash(batchBytes),jobs,unattempted};
}
const forbiddenKey=/^(?:provider|model|responseModel|billingMode|expressionMode|protocolVersion|rawContent|tokenUsage|transport|sourceHashes|sourceRevision|sourcePath|latencyMs|cost|costUSD|totalCostUSD|knownCostUSD)$/i;
function sanitizer(entries) {
 const identifiers=[...new Set(entries.flatMap(e=>[e.trace.provider.id,e.trace.provider.model,...e.trace.attempts.map(a=>a.response?.model),e.batchDirectory]).filter(Boolean))].sort((a,b)=>b.length-a.length);
 return function sanitize(value){
  if(Array.isArray(value))return value.map(sanitize);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k,v])=>!forbiddenKey.test(k)&&!(k==='source'&&typeof v==='string'&&identifiers.includes(v))).map(([k,v])=>[k,sanitize(v)]));
  if(typeof value==='string')for(const id of identifiers)value=value.replaceAll(new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9])`,'gi'),'[condition detail redacted]');
  return value;
 };
}
export function makePackets(entries) {
 const all=entries.filter(e=>e.job.kind==='interaction'),sanitize=sanitizer(all), shuffled=[...all];
 for(let i=shuffled.length-1;i>0;i--){const j=randomInt(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
 const rater=[],audit=[],privateMapping=[];
 for(const e of shuffled){
  const id=`C-${randomBytes(12).toString('hex')}`;
  const records=e.trace.records.map((r,index)=>({turn:index+1,kind:r.kind,status:r.status,reason:r.status==='error'?'request failed':r.reason??null,worldTimeBefore:r.before.time,worldTimeAfter:r.after.time,player:r.playerAction?.label??null,reply:r.reply??null}));
  rater.push(sanitize({id,complete:e.trace.complete,records}));
  audit.push(sanitize({id,complete:e.trace.complete,records:e.trace.records.map((r,i)=>({...records[i],events:r.events,visibleInput:e.trace.attempts.find(a=>a.sequence===r.attemptSequence)?.input??null,selectedResponse:(()=>{const response=e.trace.attempts.find(a=>a.sequence===r.attemptSequence)?.response;return response?{choice:response.choice,affect:response.affect,dialogue:response.dialogue,contractValid:response.contractValid}:null;})(),before:r.before,after:r.after,peerDecisions:r.peerDecisions}))}));
  privateMapping.push({id,jobId:e.job.id,batchDirectory:e.batchDirectory??null,provider:e.trace.provider,sourceRevision:e.provenance?.gitRevision??null,sourceHashes:e.provenance?.sourceHashes??null,files:e.files??null});
 }
 return {rater,audit,privateMapping};
}
function literal(text){const n=Math.max(2,...[...text.matchAll(/`+/g)].map(m=>m[0].length))+1;return `${'`'.repeat(n)}text\n${text}\n${'`'.repeat(n)}`;}
function raterMarkdown(p){return [`# Conversation ${p.id}`,'','Read the entire sequence. Times are simulated world times. A skipped step contains no player utterance. No ratings have been collected.',`Sequence complete: ${p.complete}`,...p.records.flatMap(r=>['',`## Step ${r.turn}: ${r.kind} (${r.status})`,`World time: ${r.worldTimeBefore} → ${r.worldTimeAfter}`,...(r.reason?[`Reason: ${r.reason}`]:[]),...(r.player?['Player:',literal(r.player)]:[]),...(r.reply?['Character:',literal(r.reply)]:[])])].join('\n')+'\n';}
const cell=v=>String(v??'unknown').replaceAll('|','\\|').replaceAll('\n',' ');
function markdown(report){return ['# Descriptive candidate batch report','',report.scope,'','All-attempt latency uses nearest-rank quantiles: sorted[ceil(p*n)-1]. Failed attempts are included. No quality scores, rankings, significance tests, or human ratings are produced.','', '| Batch | Job | Complete | Attempts | Applied | Errors | Skips | p50 ms | p95 ms | max ms | sum ms | Known API USD | Unknown cost attempts | Total USD |', '|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',...report.jobs.map(m=>`| ${[basename(m.batchDirectory),m.jobId,m.complete,m.attempts,m.applied,m.errors,m.skips,m.latencyMs.p50,m.latencyMs.p95,m.latencyMs.max,m.latencyMs.sum,m.knownCostUSD,m.unknownCostCount,m.totalCostUSD].map(cell).join(' | ')} |`),'','Standard tokenUsage totals and missing counts are separate from Jev protocol-native input_tokens/output_tokens. Native counts are protocol accounting only; no hidden reasoning interpretation is made. Zero reported token sum with all attempts missing does not mean zero token use.','', '| Batch | Job | Standard prompt | Standard completion | Standard total | Standard missing | Native input | Native output | Native missing |','|---|---|---:|---:|---:|---:|---:|---:|---:|',...report.jobs.map(m=>`| ${[basename(m.batchDirectory),m.jobId,m.standardTokenUsage.promptTokens,m.standardTokenUsage.completionTokens,m.standardTokenUsage.totalTokens,m.standardTokenUsage.missingCount,m.protocolNativeUsage.input_tokens,m.protocolNativeUsage.output_tokens,m.protocolNativeUsage.missingCount].map(cell).join(' | ')} |`),'','Autonomy values below retain each resident’s exposure and simulation duration. Truncated runs are not ranked against completed runs.',...report.jobs.filter(m=>m.autonomy).flatMap(m=>['',`## ${basename(m.batchDirectory)} / ${m.jobId}`,literal(JSON.stringify(m.autonomy,null,2))]),'','Self-hosted infrastructure costs remain unknown. Reported API charges do not measure total infrastructure cost.',''].join('\n');}
export async function writeReport(batches,outputDirectory) {
 const entries=batches.flatMap(b=>b.jobs);
 // Re-check every byte before deriving a report; never publish a moving checkpoint as a final artifact.
 for(const b of batches){equal(hash(await readFile(join(b.batchDirectory,'batch.json'))),b.batchSha256,'batch changed before output');for(const e of b.jobs)for(const [name,digest]of Object.entries(e.files))equal(hash(await readFile(join(e.batchDirectory,e.job.id,name))),digest,'input changed before output');}
 const report={schemaVersion:1,createdAt:new Date().toISOString(),scope:'Development descriptive data only. Complete and terminal-incomplete runs remain explicitly separated. Source revisions are preserved per batch; no assumption of equivalence across revisions.',batches:batches.map(b=>({directory:b.batchDirectory,batchSha256:b.batchSha256,manifest:b.batch,unattempted:b.unattempted})),jobs:entries.map(e=>({...e.metrics,batchDirectory:e.batchDirectory,files:e.files}))};
 const packets=makePackets(entries),out=resolve(outputDirectory);
 await mkdir(dirname(out),{recursive:true});await mkdir(out,{mode:0o700});
 const json=(p,v)=>writeFile(join(out,p),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
 await json('analysis.json',report);await writeFile(join(out,'analysis.md'),markdown(report),{flag:'wx',mode:0o600});
 await mkdir(join(out,'PRIVATE'),{mode:0o700});await mkdir(join(out,'rater'),{mode:0o700});await mkdir(join(out,'audit'),{mode:0o700});
 await json('PRIVATE/mapping.json',packets.privateMapping);
 await writeFile(join(out,'rater','README.md'),'# Whole-conversation reading packet\n\nRead conversations in index order. No actual human ratings are included. IDs and order are randomized per generation. All available interaction trajectories are included, including failures and skips. Unobserved global world events are excluded here and retained only in the audit packet. Styling, repeated wording, semantic content, completion length, and authored behavior can reveal a condition; this is metadata blinding, not proof of successful blinding. Known condition identifiers in content are redacted. Do not distribute the PRIVATE directory or analysis files to raters. The audit directory is a separate factual-evidence packet containing observed input and before/after truth, which can change judgments.\n',{flag:'wx',mode:0o600});
 await json('rater/index.json',packets.rater.map(p=>p.id));
 for(const p of packets.rater){await json(`rater/${p.id}.json`,p);await writeFile(join(out,'rater',`${p.id}.md`),raterMarkdown(p),{flag:'wx',mode:0o600});}
 for(const p of packets.audit)await json(`audit/${p.id}.json`,p);
 return {outputDirectory:out,jobs:entries.length,conversations:packets.rater.length};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const {values}=parseArgs({strict:true,options:{batch:{type:'string',multiple:true},out:{type:'string'},'allow-incomplete':{type:'boolean',default:false}}});check(values.batch?.length&&values.out,'Usage: node analyzer.mjs --batch DIR [--batch DIR] --out FRESH_DIR [--allow-incomplete]');const batches=[];for(const dir of values.batch)batches.push(await loadBatch(dir,{allowIncomplete:values['allow-incomplete']}));console.log(JSON.stringify(await writeReport(batches,values.out)));}catch(error){console.error(error.message);process.exitCode=1;}
}

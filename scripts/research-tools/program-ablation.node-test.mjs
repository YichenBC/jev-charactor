import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {comparePrograms} from './program-ablation.mjs';

const providers=['rules','utility','jev','llm','llm-character'];
function fixture(){
 const input={state:{situation:{pendingInteraction:'ask'}},options:[{id:'reply'},{id:'refuse'}]};
 const attempt=(sequence,choice='reply')=>({sequence,input:structuredClone(input),response:{choice,affect:'focused'},applied:true,latencyMs:1,costUSD:0,error:null});
 const entries=providers.flatMap(provider=>[
  {job:{id:`scene-${provider}`,kind:'interaction',scenario:'scene',provider},trace:{provider:{id:provider,expressionMode:provider==='llm-character'?'generated':'program'},complete:true,scenario:{id:'scene',initialWorld:{seed:1}},config:{seed:'seed',maxRequests:3,stepSeconds:.25,peerPolicy:'rules',candidateTextMode:'semantic-v1',maxReportedCostUSD:provider==='jev'?1:0},attempts:[attempt(1),attempt(2)],records:[{stepId:'talk',kind:'interact',status:'applied',attemptSequence:1,reply:'hello'},{stepId:'activity',kind:'autonomy',status:'applied',attemptSequence:2},{stepId:'return',kind:'followup',status:'skipped',reason:'menu-unavailable'}]},metrics:{complete:true}},
  {job:{id:`autonomy-${provider}`,kind:'autonomy',provider},trace:{provider:{id:provider,expressionMode:provider==='llm-character'?'generated':'program'},seed:'seed',initialWorld:{seed:1},complete:true,simulatedSeconds:90,config:{durationSeconds:90,maxRequests:50,stepSeconds:.25},attempts:[attempt(1,'work')],completed:{work:1},residents:[],finalWorld:{npcs:[]}},metrics:{complete:true}}
 ]);
 return [{batch:{source:'a'.repeat(40),gitDirty:false,sourceHashes:{'sim.ts':'b'},scenarioHashes:{scene:createHash('sha256').update(JSON.stringify(entries[0].trace.scenario)).digest('hex')}},batchSha256:'d',jobs:entries,unattempted:[]}];
}
test('separates player calls, embedded autonomy and skipped opportunities',()=>{
 const report=comparePrograms(fixture());
 const r=report.conditions.find(c=>c.provider==='rules');
 assert.equal(r.interaction.attempts,2);assert.equal(r.interaction.playerAttempts,1);assert.equal(r.interaction.embeddedAutonomyAttempts,1);assert.equal(r.interaction.skippedPlayerSteps,1);assert.equal(r.interaction.playerReplyOrRefuseOnly,1);
 assert.equal(r.wholeWorld.attempts,1);assert.equal(report.comparisons.length,4);
 assert.deepEqual(report.comparisons[0].counts,{playerSteps:2,bothApplied:1,sameChoice:1,sameAffect:1,sameReply:1,sameInput:1,bothSkipped:1,statusMismatch:0});
});
test('different choice/prose are not treated as improved quality; failed attempts retained',()=>{
 const data=fixture(),r=data[0].jobs[0];r.trace.attempts[0].applied=false;r.trace.attempts[0].error='failure';r.trace.attempts[0].response=null;r.trace.records[0].status='error';delete r.trace.records[0].reply;
 const out=comparePrograms(data);assert.equal(out.conditions[0].interaction.errors,1);assert.equal(out.comparisons[0].counts.bothApplied,0);assert.equal(out.comparisons[0].counts.statusMismatch,1);assert.equal(out.comparisons[0].steps[0].other.status,'error');assert.match(out.scope,/not.*quality/i);
});
test('rejects different source revision, hashes or scenario definitions',()=>{
 for(const field of ['source','sourceHashes','scenarioHashes']){const [a]=fixture();const b=structuredClone(a);b.batch[field]=field==='source'?'other':{other:'x'};assert.throws(()=>comparePrograms([a,b]),/mismatch/i);}
 const d=fixture();d[0].jobs[0].trace.scenario.initialWorld.seed=99;assert.throws(()=>comparePrograms(d),/scenario/i);
});
test('rejects dirty, unfinished, duplicate and missing cells',()=>{
 let d=fixture();d[0].batch.gitDirty=true;assert.throws(()=>comparePrograms(d),/dirty/i);
 d=fixture();d[0].jobs[0].trace.complete=false;assert.throws(()=>comparePrograms(d),/complete/i);
 d=fixture();d[0].jobs.push(d[0].jobs[0]);assert.throws(()=>comparePrograms(d),/duplicate/i);
 d=fixture();d[0].jobs.shift();assert.throws(()=>comparePrograms(d),/missing/i);
});
test('rejects different peer policy, seed, initial autonomy world or duration',()=>{
 for(const field of ['peerPolicy','seed','stepSeconds','candidateTextMode']){const d=fixture();d[0].jobs[0].trace.config[field]='changed';assert.throws(()=>comparePrograms(d),/config/i);}
 let d=fixture();d[0].jobs[1].trace.initialWorld.seed=2;assert.throws(()=>comparePrograms(d),/initial/i);
 d=fixture();d[0].jobs[1].trace.simulatedSeconds=89;assert.throws(()=>comparePrograms(d),/duration/i);
});
test('rejects missing or duplicate script steps and unclassified attempts',()=>{
 let d=fixture();d[0].jobs[0].trace.records.pop();assert.throws(()=>comparePrograms(d),/step/i);
 d=fixture();d[0].jobs[0].trace.records.push(d[0].jobs[0].trace.records[0]);assert.throws(()=>comparePrograms(d),/duplicate/i);
 d=fixture();d[0].jobs[0].trace.attempts.push({...d[0].jobs[0].trace.attempts[0],sequence:3});assert.throws(()=>comparePrograms(d),/record/i);
});
test('choice equality does not imply identical input or identical affect/prose',()=>{
 const d=fixture(),r=d[0].jobs[0];r.trace.attempts[0].input.state.situation.pendingInteraction='changed';r.trace.attempts[0].response.affect='guarded';r.trace.records[0].reply='different';
 const c=comparePrograms(d).comparisons[0].counts;assert.equal(c.sameChoice,1);assert.equal(c.sameInput,0);assert.equal(c.sameAffect,0);assert.equal(c.sameReply,0);
});

test('generated-expression condition is supplemental, not a shared-expression selector ablation',()=>{
 const report=comparePrograms(fixture());
 const generated=report.conditions.find(c=>c.provider==='llm-character');
 assert.equal(generated.providerMetadata.expressionMode,'generated');
 assert.equal(generated.comparisonRole,'supplemental-generated-expression');
 assert.equal(report.comparisons.find(c=>c.provider==='llm-character').sharedProgramExpression,false);
 assert.equal(report.comparisons.find(c=>c.provider==='rules').sharedProgramExpression,true);
 const d=fixture();d[0].jobs[0].trace.provider.expressionMode='generated';assert.throws(()=>comparePrograms(d),/expression/i);
});

test('rejects shared tampering with scenario contents under old fingerprints',()=>{
 const d=fixture();for(const e of d[0].jobs.filter(e=>e.job.kind==='interaction'))e.trace.scenario.initialWorld.seed=999;
 assert.throws(()=>comparePrograms(d),/scenario.*hash/i);
 const e=fixture();for(const j of e[0].jobs.filter(j=>j.job.kind==='interaction'))j.trace.scenario.id='wrong';
 assert.throws(()=>comparePrograms(e),/scenario.*id/i);
});
test('does not pool inconsistent provider/model/protocol metadata',()=>{
 for(const key of ['id','model','protocolVersion']){
  const d=fixture();d[0].jobs[0].trace.provider[key]='other';
  assert.throws(()=>comparePrograms(d),/provider|metadata/i);
 }
});

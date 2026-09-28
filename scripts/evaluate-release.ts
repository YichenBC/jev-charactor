import {llmProvider} from './evaluation/llm';
import 'dotenv/config';
import {parseArgs} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {developmentCases,verifyExecution} from './evaluation/cases';
import {socialCases,verifySocialExecution} from './evaluation/social-cases';
import {deliveryCases,verifyDeliveryExecution,summarizeDelivery} from './evaluation/delivery-cases';
import {jevProvider,ruleProvider,utilityProvider} from './evaluation/providers';
import {runEvaluation} from './evaluation/runner';
import {summarizeRun} from './evaluation/summary';
import type {EvaluationRecord,EvaluationManifest} from './evaluation/types';

export async function main(){
  const {values}=parseArgs({options:{provider:{type:'string',default:'rules'},suite:{type:'string',default:'dialogue'},repeats:{type:'string',default:'1'},limit:{type:'string'},'max-requests':{type:'string',default:'24'},'max-cost':{type:'string',default:'0.50'},seed:{type:'string',default:'development-v1'},out:{type:'string'},report:{type:'string'},'dry-run':{type:'boolean',default:false}},strict:true});
  if(values.report){
    const directory=resolve(values.report),manifest=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8')) as EvaluationManifest;
    const records=(await readFile(resolve(directory,'records.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line) as EvaluationRecord);
    console.log(JSON.stringify(summarizeRun(records,manifest),null,2));return;
  }
  if(!['rules','utility','jev','llm'].includes(values.provider))throw new Error('invalid_provider');
  if(!['dialogue','social','delivery','all'].includes(values.suite))throw new Error('invalid_suite');
  const available=values.suite==='social'?socialCases():values.suite==='delivery'?deliveryCases():values.suite==='all'?[...developmentCases(),...socialCases(),...deliveryCases()]:developmentCases();
  const limit=values.limit===undefined?available.length:Number(values.limit);if(!Number.isInteger(limit)||limit<1||limit>available.length)throw new Error('invalid_limit');
  const cases=available.slice(0,limit);
  if(values['dry-run']){console.log(JSON.stringify({split:'development',cases:cases.length,families:[...new Set(cases.map(c=>c.familyId))],requests:0},null,2));return;}
  const provider=values.provider==='llm'?llmProvider():values.provider==='jev'?jevProvider():values.provider==='utility'?utilityProvider:ruleProvider;
  const outputDir=resolve(values.out??`artifacts/evaluation/${new Date().toISOString().replaceAll(':','-')}-${provider.id}-${randomUUID().slice(0,8)}`);
  const sourceFiles=['server/jev.ts','server/openrouter-fetch.ts','scripts/evaluation/llm.ts','scripts/evaluate-release.ts','scripts/evaluation/cases.ts','scripts/evaluation/social-cases.ts','scripts/evaluation/delivery-cases.ts','scripts/evaluate-characters.ts','scripts/evaluation/providers.ts','scripts/evaluation/runner.ts','scripts/evaluation/summary.ts'];
  const sourceHashes=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
  const result=await runEvaluation({cases,provider,outputDir,seed:values.seed,repeats:Number(values.repeats),maxRequests:Number(values['max-requests']),maxReportedCostUSD:Number(values['max-cost']),gitRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gitDirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())});
  await writeFile(resolve(outputDir,'provenance.json'),JSON.stringify({sourceHashes,caseScope:'Authored development fixtures; no held-out evaluation or naturalness ratings.',providerInstructionSource:'server/jev.ts'},null,2)+'\n',{flag:'wx'});
  const execution=result.records.map(r=>({sequence:r.sequence,caseId:r.caseId,provider:r.provider,status:r.status,...(r.status==='valid-answer'&&r.response?{execution:(r.caseId.startsWith('delivery/')?verifyDeliveryExecution:r.caseId.includes('/social-')?verifySocialExecution:verifyExecution)(r.caseId,r.response.choice,r.response.affect)}:{execution:null})}));
  await writeFile(resolve(outputDir,'execution.json'),JSON.stringify(execution,null,2)+'\n',{flag:'wx'});
  if(result.records.some(r=>r.caseId.startsWith('delivery/')))await writeFile(resolve(outputDir,'delivery-summary.json'),JSON.stringify(summarizeDelivery(result.records.filter(r=>r.caseId.startsWith('delivery/'))),null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({outputDir,complete:result.manifest.complete,stopReason:result.manifest.stopReason,summary:result.summary},null,2));
  if(!result.manifest.complete||result.summary.failureCount)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(()=>{console.error('Evaluation failed; inspect checkpoint if present. Check provider, numeric limits, fresh output directory and local credentials. No fallback was run.');process.exitCode=1;});

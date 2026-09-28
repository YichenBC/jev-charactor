import 'dotenv/config';
import {execFile,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,rename,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {parseArgs,promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {candidateJobs,runCandidateBatch,recoverCandidateCheckpoint,candidateCostCap} from './evaluation/candidate-batch';
import {llmProvider} from './evaluation/llm';
import {llmCharacterProvider} from './evaluation/llm-character';
import {interactionScenarios} from './evaluation/interaction-scenarios';

const exec=promisify(execFile);
const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8'}).trim();

async function main(){
  const scriptRoot=await realpath(fileURLToPath(new URL('..',import.meta.url)));
  if(await realpath(process.cwd())!==scriptRoot||await realpath(git('rev-parse','--show-toplevel'))!==scriptRoot)throw new Error('Run the candidate CLI from its own repository root');
  const {values}=parseArgs({strict:true,options:{out:{type:'string'},live:{type:'boolean'},offline:{type:'boolean'},'max-cost':{type:'string'},'continue-unmetered':{type:'boolean'}}});
  if(!values.out||Boolean(values.live)===Boolean(values.offline))throw new Error('Choose exactly one of --live or --offline, with a fresh --out directory');
  if(git('status','--porcelain'))throw new Error('Freeze and commit the candidate source before the batch');
  const revision=git('rev-parse','HEAD'),offline=Boolean(values.offline),jobs=candidateJobs(offline),out=resolve(values.out);
  const maxCost=candidateCostCap(values['max-cost'],offline);
  if(offline&&values['continue-unmetered'])throw new Error('Independent unmetered failures are a live self-hosted condition only');
  if(!offline){
    if(process.env.EVAL_LLM_BACKEND!=='self-hosted'||process.env.EVAL_LLM_MODEL!=='moonshotai/Kimi-K3'||process.env.EVAL_LLM_THINKING!=='disabled'
      ||process.env.EVAL_LLM_TIMEOUT_MS!=='120000'||process.env.EVAL_LLM_MAX_OUTPUT_TOKENS!=='2048')throw new Error('Live batch must match the frozen Kimi operating point');
    if(!process.env.OPENROUTER_API_KEY?.trim()||(process.env.JEV_MODEL||'typesafe/jev-1.13')!=='typesafe/jev-1.13')throw new Error('Live batch requires the frozen Jev model and configured key');
    // Validate both transport configurations before any remote request. No inference here.
    llmProvider();llmCharacterProvider();
  }
  const protocol='docs/research/candidate-comparison-protocol-2026-09-27.md';
  const sourcePaths=git('ls-files','--','src','server','scripts','packages/core','package.json','package-lock.json','tsconfig.json').split('\n').filter(p=>/\.(ts|json|mjs)$/.test(p));
  const sourceHashes=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
  const scenarioHashes=Object.fromEntries(interactionScenarios().map(scenario=>[scenario.id,createHash('sha256').update(JSON.stringify(scenario)).digest('hex')]));
  const header={createdAt:new Date().toISOString(),source:revision,gitDirty:false,mode:offline?'offline':'live',
    protocol,protocolSha256:createHash('sha256').update(await readFile(protocol)).digest('hex'),
    sourceHashes,scenarioHashes,
    plannedRequests:jobs.reduce((sum,j)=>sum+j.maxRequests,0),concurrency:1,retries:0,
    runtime:{node:process.version,platform:process.platform,arch:process.arch},
    settings:{interactionSeed:'candidate-interactions-v1',autonomySeed:'candidate-autonomy-v1',autonomySeconds:90,
      ...(offline?{}:{kimiModel:'moonshotai/Kimi-K3',kimiThinking:false,kimiTemperature:0,kimiMaxOutputTokens:2048,kimiTimeoutMs:120000,jevModel:'typesafe/jev-1.13',jevTimeoutMs:12000})}};
  await mkdir(dirname(out),{recursive:true});await mkdir(out,{mode:0o700});
  const result=await runCandidateBatch(jobs,maxCost,async(job,remaining)=>{
    if(git('rev-parse','HEAD')!==revision||git('status','--porcelain'))throw new Error('Source changed during the batch');
    const outputDir=resolve(out,job.id);
    const script=job.kind==='interaction'?'scripts/evaluate-interactions.ts':'scripts/evaluate-autonomy.ts';
    const args=[resolve('node_modules/tsx/dist/cli.mjs'),script,'--provider',job.provider,'--max-requests',String(job.maxRequests),
      '--max-cost',String(job.provider==='jev'?remaining:0),'--out',outputDir,
      ...(job.kind==='interaction'?['--scenario',job.scenario!,'--seed','candidate-interactions-v1']:['--seconds','90','--seed','candidate-autonomy-v1'])];
    console.log(JSON.stringify({event:'start',job:job.id,maxRequests:job.maxRequests}));
    let exitedCleanly=true;
    try{await exec(process.execPath,args,{timeout:job.maxRequests*120000+30000,maxBuffer:2*1024*1024});}
    catch{exitedCleanly=false;}
    let summary;
    try{summary=JSON.parse(await readFile(resolve(outputDir,'summary.json'),'utf8'));}
    catch{summary=recoverCandidateCheckpoint(JSON.parse(await readFile(resolve(outputDir,'trajectory.json'),'utf8')));}
    if(!exitedCleanly&&summary.complete===true)throw new Error('Runner failed despite a completed summary');
    console.log(JSON.stringify({event:'finish',job:job.id,complete:summary.complete,attempts:summary.attemptedCount,stopReason:summary.stopReason}));
    return summary;
  },async snapshot=>{
    const path=resolve(out,'batch.json');
    await writeFile(path+'.tmp',JSON.stringify({...header,...snapshot},null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);
  },values['continue-unmetered']?'continue-unmetered':'stop-first-incomplete');
  console.log(JSON.stringify({outputDir:out,complete:result.complete,stopReason:result.stopReason,knownPaidCostUSD:result.knownPaidCostUSD,totalPaidCostUSD:result.totalPaidCostUSD}));
  if(!result.complete)process.exitCode=1;
}
main().catch(()=>{console.error('Candidate batch stopped. Check the frozen configuration, source and preserved output; no fallback or retry was run.');process.exitCode=1;});

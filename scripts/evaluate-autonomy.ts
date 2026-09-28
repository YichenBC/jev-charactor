import {llmProvider} from './evaluation/llm';
import {llmCharacterProvider} from './evaluation/llm-character';
import 'dotenv/config';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {ruleProvider,utilityProvider,jevProvider} from './evaluation/providers';
import {runAutonomyTrajectory,replayAutonomyTrajectory,type AutonomyTrace} from './evaluation/trajectory';

async function main(){
  const {values}=parseArgs({options:{provider:{type:'string',default:'rules'},seconds:{type:'string',default:'180'},'max-requests':{type:'string',default:'120'},'max-cost':{type:'string',default:'.5'},seed:{type:'string',default:'autonomy-development-v1'},out:{type:'string'},replay:{type:'string'}},strict:true});
  if(values.replay){console.log(JSON.stringify(await replayAutonomyTrajectory(JSON.parse(await readFile(resolve(values.replay),'utf8')) as AutonomyTrace)));return;}
  if(!['rules','utility','jev','llm','llm-character'].includes(values.provider))throw new Error('invalid_provider');
  const provider=values.provider==='llm-character'?llmCharacterProvider():values.provider==='llm'?llmProvider():values.provider==='jev'?jevProvider():values.provider==='utility'?utilityProvider:ruleProvider;
  const durationSeconds=Number(values.seconds),maxRequests=Number(values['max-requests']),maxReportedCostUSD=Number(values['max-cost']);
  if(!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>600||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>1000||!Number.isFinite(maxReportedCostUSD)||maxReportedCostUSD<0)throw new Error('invalid_limits');
  const outputDir=resolve(values.out??`artifacts/evaluation/trajectory-${new Date().toISOString().replaceAll(':','-')}-${provider.id}-${randomUUID().slice(0,8)}`);
  const sources=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','--','src','server','scripts','packages/core','package.json','package-lock.json','tsconfig.json'],{encoding:'utf8'}).trim().split('\n').filter(p=>/\.(ts|json|mjs)$/.test(p));
  const provenance={gitRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gitDirty:Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()),createdAt:new Date().toISOString(),sourceHashes:Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(p)).digest('hex')]))),
    runtime:{node:process.version,platform:process.platform,arch:process.arch},
    provider:{id:provider.id,model:provider.model,protocolVersion:provider.protocolVersion,expressionMode:provider.expressionMode??'program'},
    transport:provider.runtimeSettings??null,billingMode:provider.billingMode??(provider.paid?'metered-api':'offline'),
    settings:{seed:values.seed,durationSeconds,maxRequests,maxReportedCostUSD,concurrency:1,retries:0,
      requestTimeoutMs:provider.runtimeSettings?.requestTimeoutMs??(provider.paid?12000:null),maxOutputTokens:provider.runtimeSettings?.maxOutputTokens??null,
      temperature:provider.id.startsWith('llm')?0:null,dnsOverrideEnabled:provider.runtimeSettings?.backend==='self-hosted'?false:Boolean(process.env.JEV_DNS_SERVER?.trim()),
      budgetNote:'Stops before next call at reported cap; one call may overshoot. Missing paid billing stops; self-hosted infrastructure cost is unmeasured.'}};
  await mkdir(dirname(outputDir),{recursive:true});await mkdir(outputDir,{mode:0o700});
  await writeFile(resolve(outputDir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx',mode:0o600});
  const result=await runAutonomyTrajectory({provider,durationSeconds,maxRequests,maxReportedCostUSD,seed:values.seed,
    onCheckpoint:async value=>{const path=resolve(outputDir,'trajectory.json');await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);}});
  const {initialWorld,finalWorld,attempts,...summary}=result;
  const replay=await replayAutonomyTrajectory(result);
  await writeFile(resolve(outputDir,'summary.json'),JSON.stringify({...summary,attemptedCount:attempts.length,replay,
    costNote:provider.billingMode==='self-hosted-unmetered'?'Self-hosted infrastructure cost is unmeasured; null is not free inference.':'Reported API billing only.'},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({outputDir,complete:result.complete,stopReason:result.stopReason,simulatedSeconds:result.simulatedSeconds,attempts:attempts.length,completed:result.completed,residents:result.residents,totalCostUSD:result.totalCostUSD,validSave:result.validSave},null,2));
  if(!result.complete||!result.validSave)process.exitCode=1;
}
main().catch(()=>{console.error('Autonomy evaluation failed. Check fresh output directory, limits and provider configuration; no fallback was run.');process.exitCode=1;});

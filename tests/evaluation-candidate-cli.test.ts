import {it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {cp,mkdtemp,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const exec=promisify(execFile);
it('writes all source/scenario hashes and unattempted jobs before starting the first offline runner',async()=>{
  const root=process.cwd(),fixture=await mkdtemp(join(tmpdir(),'jev-batch-contract-')),repo=join(fixture,'repo'),out=join(fixture,'out');
  try{
    await mkdir(join(repo,'scripts'),{recursive:true});await mkdir(join(repo,'docs/research'),{recursive:true});
    for(const directory of ['src','server','scripts'])await cp(join(root,directory),join(repo,directory),{recursive:true});
    await writeFile(join(repo,'package.json'),'{}');await writeFile(join(repo,'.gitignore'),'node_modules/\n');
    await writeFile(join(repo,'docs/research/candidate-comparison-protocol-2026-09-27.md'),'offline test protocol');
    const runner=`import fs from 'node:fs'; import path from 'node:path';
const out=process.argv[process.argv.indexOf('--out')+1];
const batch=JSON.parse(fs.readFileSync(path.join(out,'..','batch.json'),'utf8'));
fs.mkdirSync(out); fs.writeFileSync(path.join(out,'before-execution.json'),JSON.stringify(batch));
if(process.env.JEV_BATCH_FIXTURE_CRASH==='1')fs.writeFileSync(path.join(out,'trajectory.json'),JSON.stringify({attempts:[{costUSD:.03}],knownCostUSD:.03,unknownCostCount:0,outstandingRequestCount:1,inFlight:{sequence:2}}));
else fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({complete:false,attemptedCount:0,knownCostUSD:0,unknownCostCount:0}));
process.exitCode=1;
`;
    await writeFile(join(repo,'scripts/evaluate-interactions.ts'),runner);
    await symlink(join(root,'node_modules'),join(repo,'node_modules'),'dir');
    for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']])await exec('git',args,{cwd:repo});
    await expect(exec(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),resolve(repo,'scripts/evaluate-candidate.ts'),'--offline','--out',out],{cwd:repo,timeout:30000})).rejects.toMatchObject({code:1});
    const first=JSON.parse(await readFile(join(out,'mei-continuity-rules/before-execution.json'),'utf8'));
    expect(first.sourceHashes['scripts/evaluate-interactions.ts']).toBe(createHash('sha256').update(runner).digest('hex'));
    expect(Object.keys(first.scenarioHashes)).toHaveLength(8);
    expect(Object.values(first.scenarioHashes).every(hash=>/^[a-f0-9]{64}$/.test(String(hash)))).toBe(true);
    expect(first.jobs).toHaveLength(18);
    expect(first.jobs[0].status).toBe('running');expect(first.jobs.slice(1).every((j:{status:string})=>j.status==='unattempted')).toBe(true);
    const final=JSON.parse(await readFile(join(out,'batch.json'),'utf8'));
    expect(final.stopReason).toBe('incomplete-run');expect(final.jobs[1].status).toBe('unattempted');
    const wrongOut=join(fixture,'wrong-checkout');
    await expect(exec(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),resolve(root,'scripts/evaluate-candidate.ts'),'--offline','--out',wrongOut],{cwd:repo,timeout:30000})).rejects.toMatchObject({code:1});
    await expect(readFile(join(wrongOut,'batch.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
    const crashOut=join(fixture,'checkpoint-recovery');
    await expect(exec(process.execPath,[join(root,'node_modules/tsx/dist/cli.mjs'),resolve(repo,'scripts/evaluate-candidate.ts'),'--offline','--out',crashOut],
      {cwd:repo,timeout:30000,env:{...process.env,JEV_BATCH_FIXTURE_CRASH:'1'}})).rejects.toMatchObject({code:1});
    const recovered=JSON.parse(await readFile(join(crashOut,'batch.json'),'utf8'));
    expect(recovered.stopReason).toBe('runner-checkpoint-recovered');
    expect(recovered.jobs[0].result).toMatchObject({knownCostUSD:.03,outstandingRequestCount:1,checkpointRecovered:true});
    expect(recovered.jobs[1].status).toBe('unattempted');
  }finally{await rm(fixture,{recursive:true,force:true});}
},40000);

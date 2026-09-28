/** Starts a disposable no-key server for the isolated fixture-only browser checks. */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

const cwd=fileURLToPath(new URL('..',import.meta.url));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const address=probe.address();
if(!address||typeof address==='string')throw new Error('No local test port');
const port=address.port;await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
const server=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd,env:{...process.env,PORT:String(port),NODE_ENV:'production',OPENROUTER_API_KEY:''},stdio:['ignore','pipe','pipe']});
let startupLog='';
for(const stream of [server.stdout,server.stderr])stream.on('data',data=>{startupLog=(startupLog+data.toString()).slice(-4000);});
let spawnFailure=null;server.on('error',error=>{spawnFailure=error;});
const serverClosed=once(server,'close').catch(()=>undefined);
try{
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(spawnFailure||server.exitCode!==null)throw new Error('Disposable server exited before startup');
    try{const response=await fetch(`http://127.0.0.1:${port}/api/status`,{signal:AbortSignal.timeout(500)});const status=await response.json();if(response.ok&&status.app==='jev-neighborhood'&&status.configured===false){ready=true;break;}}catch{/* Wait only for this child startup. */}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw new Error('Disposable server did not become ready');
  for (const endpoint of ['/api/status', '/API/status', '/Api/status']) {
    const denied = await fetch(`http://127.0.0.1:${port}${endpoint}`, {headers: {Origin: 'https://foreign.invalid'}});
    if (denied.status !== 403) throw new Error(`Foreign Origin accepted at ${endpoint}`);
    const local = await fetch(`http://127.0.0.1:${port}${endpoint}`);
    if (local.status !== 200 || local.headers.get('cache-control') !== 'no-store') throw new Error(`API response not protected at ${endpoint}`);
  }
  for(const locale of ['en','zh']) {
    const child=spawn(process.execPath,['--import','tsx','scripts/browser-smoke.ts'],{cwd,env:{...process.env,E2E_BASE_URL:`http://127.0.0.1:${port}`,E2E_LOCALE:locale},stdio:'inherit'});
    child.on('error',()=>{process.exitCode=1;});
    const [code]=await once(child,'close');
    if(code!==0)process.exitCode=1;
  }
}catch(error){console.error(error instanceof Error?error.message:'Browser check failed');console.error(startupLog);process.exitCode=1;}
finally{
  if(server.exitCode===null)server.kill('SIGTERM');
  const timeout=setTimeout(()=>{if(server.exitCode===null)server.kill('SIGKILL');},2000);
  timeout.unref();await serverClosed;clearTimeout(timeout);
}

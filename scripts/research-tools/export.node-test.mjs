import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));
const modulePath = join(root, 'export.mjs');
// Synthetic scan fixtures; no real host or user path is embedded in this test source.
const fixtureAddress = [192,168,1,2].join('.');
const hash = value => createHash('sha256').update(value).digest('hex');
async function api() { assert.ok(existsSync(modulePath), 'export implementation must exist'); return import(modulePath); }
function fixture(t, files) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'jev-export-test-')); t.after(() => rmSync(dir, { recursive:true, force:true }));
  const repo = join(dir,'repo'); mkdirSync(repo);
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(repo,path)),{recursive:true}); writeFileSync(join(repo,path),content); }
  const git = (...args) => execFileSync('git', ['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-q'); git('add','.'); git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  const revision = git('rev-parse','HEAD');
  const policy = { schemaVersion:1, revision, allowlist:Object.keys(files), reviewedEnvExamples:{}, jsonFields:[], markdown:[], checksumMaps:[], networkFixtures:{} };
  return { repo, revision, policy, destination:join(dir,'candidate'),git,dir };
}
function tarEntry(name, content, type='0') {
  const b=Buffer.from(content), h=Buffer.alloc(512); h.write(name,0,100); h.write('0000644\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
  h.write(b.length.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.fill(32,148,156);h.write(type,156);h.write('ustar\0',257);h.write('00',263);
  const sum=h.reduce((a,x)=>a+x,0);h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return Buffer.concat([h,b,Buffer.alloc((512-b.length%512)%512)]);
}
function archive(...entries) { return gzipSync(Buffer.concat([...entries,Buffer.alloc(1024)])); }

test('exports exact git blobs, preserves evidence, excludes explicit forbidden paths and rejects overwrite',async t=>{
  const a=await api(); const f=fixture(t,{'src/a.ts':'export const a=1;\n','package-lock.json':'{}\n','research/trace.json':'{"cost":null,"failure":"length","reply":"unchanged"}\n','.env':'SECRET=private\n','node_modules/x.js':'unused','dist/x.js':'built'});
  writeFileSync(join(f.repo,'src/a.ts'),'uncommitted');writeFileSync(join(f.repo,'ignored-save.json'),'player');
  const m=await a.exportRevision(f); assert.equal(readFileSync(join(f.destination,'src/a.ts'),'utf8'),'export const a=1;\n');
  assert.equal(m.files.length,3);assert.equal(m.excluded.length,3);assert.ok(!existsSync(join(f.destination,'.git')));assert.ok(!existsSync(join(f.destination,'ignored-save.json')));
  assert.equal(readFileSync(join(f.destination,'research/trace.json'),'utf8'),'{"cost":null,"failure":"length","reply":"unchanged"}\n');
  await assert.rejects(a.exportRevision(f),/destination exists/);
});
test('changes only reviewed JSON infrastructure fields and creates source/derivative hashes',async()=>{
  const a=await api(), path='research/kimi/provenance.json'; const original=Buffer.from(JSON.stringify({transport:{backend:'self-hosted',endpoint:'http://localhost:19091/v1',requestTimeoutMs:120000},reply:'unaltered',cost:null,sourceHashes:{'src/x.ts':'abc'}})+'\n');
  const policy={jsonFields:[{path,field:['transport','endpoint'],sourceValueSha256:hash(JSON.stringify('http://localhost:19091/v1')),replacement:'[REDACTED: self-hosted OpenAI-compatible endpoint]',reason:'Private routing endpoint'}],markdown:[]};
  const result=a.sanitizeFile(path,original,policy);const data=JSON.parse(result.bytes);assert.equal(data.reply,'unaltered');assert.equal(data.cost,null);assert.deepEqual(data.sourceHashes,{'src/x.ts':'abc'});assert.equal(data.transport.requestTimeoutMs,120000);
  assert.equal(result.transformations[0].sourceFileSha256,hash(original)); assert.equal(result.transformations[0].derivativeFileSha256,hash(result.bytes));assert.notEqual(hash(original),hash(result.bytes));assert.ok(!JSON.stringify(result.transformations).includes('19091'));
  assert.throws(()=>a.sanitizeFile(path,Buffer.from(original.toString().replace('19091','19092')),policy),/reviewed field changed/);
});
test('cannot configure scientific field redaction',async()=>{
  const a=await api();assert.throws(()=>a.sanitizeFile('research/x/trajectory.json',Buffer.from('{"reply":"secret"}'),{jsonFields:[{path:'research/x/trajectory.json',field:['reply'],replacement:'hidden',sourceValueSha256:hash('"secret"')}],markdown:[]}),/infrastructure/);
});
test('exact paragraph hashes gate markdown transformations',async()=>{
  const a=await api(); const path='docs/report.md', text='Title\n\nDeployment route private.\n\nResult: failed.\n';
  const policy={jsonFields:[],markdown:[{path,paragraphSha256:hash('Deployment route private.'),replacement:'Deployment via SSH loopback forward [routing redacted].',reason:'Infrastructure paragraph'}]};
  const out=a.sanitizeFile(path,Buffer.from(text),policy);assert.ok(out.bytes.toString().endsWith('Result: failed.\n'));assert.equal(out.transformations.length,1);
  assert.throws(()=>a.sanitizeFile(path,Buffer.from(text.replace('private.','changed.')),policy),/reviewed paragraph/);
});
test('suspicious scientific content blocks candidate instead of being dropped',async t=>{
  const a=await api();const secret='sk-'+'a'.repeat(40);const f=fixture(t,{'research/trajectory.json':JSON.stringify({reply:secret})});
  await assert.rejects(a.exportRevision(f),e=>/content review required/.test(e.message)&&!e.message.includes(secret));assert.ok(!existsSync(f.destination));
});
test('private paths and RFC1918 fail outside pinned network test fixture',async()=>{
  const a=await api(); const b=Buffer.from('host '+fixtureAddress); const policy={networkFixtures:{'tests/network.test.ts':{sourceSha256:hash(b),addresses:[fixtureAddress]}}};
  assert.equal(a.scanObject('tests/network.test.ts',b,policy).issues.length,0);assert.ok(a.scanObject('research/output.txt',b,policy).issues.length);
  assert.ok(a.scanObject('tests/network.test.ts',Buffer.from(b+' changed'),policy).issues.length);assert.ok(a.scanObject('research/output.txt',Buffer.from(['','mnt','nfs','private','model'].join('/')),policy).issues.length);
  assert.equal(a.scanObject('README.md',Buffer.from('Tutorial http://localhost:4317'),policy).issues.length,0);
});
test('archive scan checks nested content and rejects traversal, links, duplicates and corrupt headers without extraction',async()=>{
  const a=await api();const p={networkFixtures:{}};
  for(const bytes of [archive(tarEntry('../bad','x')),archive(tarEntry('/absolute','x')),archive(tarEntry('link','x','2')),archive(tarEntry('hard','x','1')),archive(tarEntry('a','1'),tarEntry('a','2')),archive(tarEntry('x',['','home','private','model'].join('/')))]) assert.ok(a.scanObject('research/a.tar.gz',bytes,p).issues.length);
  const nested=archive(tarEntry('inner.tar.gz',archive(tarEntry('trace.json','sk-'+'b'.repeat(40)))));assert.ok(a.scanObject('research/a.tar.gz',nested,p).issues.length);
  const valid=a.scanObject('research/a.tar.gz',archive(tarEntry('trace.json','{"failure":"length"}')),p);assert.equal(valid.issues.length,0);assert.equal(valid.archives[0].members.length,1);
  const corrupt=archive(tarEntry('trace.json','x')); corrupt[15]^=1;assert.ok(a.scanObject('research/a.tar.gz',corrupt,p).issues.length);
});
test('recomputes derivative checksum maps and preserves original hashes in transformation manifest',async t=>{
  const a=await api(), p='research/kimi/provenance.json';const raw='{"transport":{"backend":"self-hosted","endpoint":"http://localhost:19091/v1"}}\n';
  const f=fixture(t,{[p]:raw,'research/kimi/checksums.json':JSON.stringify({'provenance.json':hash(raw)})});
  f.policy.jsonFields=[{path:p,field:['transport','endpoint'],sourceValueSha256:hash(JSON.stringify('http://localhost:19091/v1')),replacement:'[REDACTED: self-hosted endpoint]',reason:'Infrastructure'}];f.policy.checksumMaps=['research/kimi/checksums.json'];
  const m=await a.exportRevision(f);const sums=JSON.parse(readFileSync(join(f.destination,'research/kimi/checksums.json')));assert.equal(sums['provenance.json'],hash(readFileSync(join(f.destination,p))));assert.notEqual(sums['provenance.json'],hash(raw));assert.ok(m.transformations.some(x=>x.category==='derivative-checksum'));
});
test('rejects unknown tracked files, git symlinks and unreviewed env examples',async t=>{
  const a=await api();const f=fixture(t,{'.env.example':'KEY=placeholder'});await assert.rejects(a.exportRevision(f),/env example/);
  f.policy.allowlist=[];await assert.rejects(a.exportRevision(f),/allowlist/);
  const g=fixture(t,{'src/a.ts':'hello'});symlinkSync('a.ts',join(g.repo,'src/link'));g.git('add','.');g.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','link');g.revision=g.git('rev-parse','HEAD');g.policy.revision=g.revision;g.policy.allowlist.push('src/link');await assert.rejects(a.exportRevision(g),/symlink/);
});
test('binary and invalid UTF-8 cannot conceal credentials or silently escape review',async()=>{
  const a=await api(), secret=Buffer.concat([Buffer.from([0xff]),Buffer.from('sk-'+'c'.repeat(40))]);
  assert.ok(a.scanObject('research/blob.bin',secret,{}).issues.some(x=>x.category==='suspicious-credential'));
  assert.ok(a.scanObject('research/blob.bin',Buffer.from([0xff,0]),{}).issues.length);
  const image=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const scan=a.scanObject('paper/figure.png',image,{reviewedBinary:{'paper/figure.png':hash(image)}});assert.equal(scan.issues.length,0);assert.equal(scan.binary.length,1);
});
test('archives cannot hide an unreviewed env example',async()=>{
  const a=await api();assert.ok(a.scanObject('research/a.tar.gz',archive(tarEntry('.env.example','KEY=unknown')),{}).issues.length);
});
test('allows timestamp-only PAX headers, rejects path override PAX and does not mistake prose for a private path',async()=>{
  const a=await api();const pax=(key,value)=>{let n=key.length+value.length+4;while(`${n} ${key}=${value}\n`.length!==n)n=`${n} ${key}=${value}\n`.length;return `${n} ${key}=${value}\n`;};
  assert.equal(a.scanObject('archive.tar.gz',archive(tarEntry('PaxHeader/a',pax('mtime','1234.5'),'x'),tarEntry('data/a.json','{}')),{}).issues.length,0);
  assert.ok(a.scanObject('archive.tar.gz',archive(tarEntry('PaxHeader/a',pax('path','../bad'),'x'),tarEntry('safe','{}')),{}).issues.length);
  assert.equal(a.scanObject('docs/a.md',Buffer.from('User/home/NFS absolute paths'),{}).issues.length,0);
});
test('detects reviewed private routing fingerprints without storing removed values in policy',async()=>{
  const a=await api(),policy={privateRoutingFingerprints:[{kind:'port',sha256:hash('19091')},{kind:'host-label',sha256:hash('head 999')}]};
  assert.ok(a.scanObject('docs/a.md',Buffer.from('http://localhost:19091/v1'),policy).issues.length);
  assert.ok(a.scanObject('docs/a.md',Buffer.from('Existing head 999 service'),policy).issues.length);
  assert.equal(a.scanObject('docs/a.md',Buffer.from('Tutorial http://localhost:4317'),policy).issues.length,0);
  assert.ok(!JSON.stringify(policy).includes('19091'));
});
test('a forbidden path under tracked evidence blocks review instead of silently dropping experimental data',async t=>{
  const a=await api(),f=fixture(t,{'research/diagnostic.log':'failed attempt preserved'});await assert.rejects(a.exportRevision(f),/experimental evidence/);assert.ok(!existsSync(f.destination));
});
function withHeader(entry, callback) {
  const copy=Buffer.from(entry);callback(copy.subarray(0,512));copy.fill(32,148,156);const sum=copy.subarray(0,512).reduce((a,x)=>a+x,0);copy.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return copy;
}
function gzipComment(bytes,comment){const h=Buffer.from(bytes.subarray(0,10));h[3]|=16;return Buffer.concat([h,Buffer.from(comment+'\0'),bytes.subarray(10)]);}
test('gzip metadata, tar header credentials, member padding and concatenated gzip cannot conceal content',async()=>{
  const a=await api(),secret='sk-'+'z'.repeat(27),clean=archive(tarEntry('trace.json','{}'));
  const owner=archive(withHeader(tarEntry('trace.json','{}'),h=>h.write(secret,265)));
  const paddingEntry=tarEntry('trace.json','{}');paddingEntry.write(secret,514);
  for(const bytes of [gzipComment(clean,secret),owner,archive(paddingEntry),Buffer.concat([clean,clean])])assert.ok(a.scanObject('research/a.tar.gz',bytes,{}).issues.length);
});
test('inventories ownership without printing owner names and requires normalization',async()=>{
  const a=await api();const b=archive(withHeader(tarEntry('trace.json','{}'),h=>{h.write('private-owner',265);h.write('0000501\0',108);}));
  const scan=a.scanObject('research/a.tar.gz',b,{});assert.ok(scan.issues.some(x=>x.category==='archive-ownership-metadata'));assert.ok(scan.archives[0].members[0].headerMetadata.unameSha256);assert.ok(!JSON.stringify(scan).includes('private-owner'));
});
test('final manifest rejects injected reasons and hashes excluded sensitive paths',async t=>{
  const a=await api(),path='research/x/provenance.json',raw='{"transport":{"backend":"self-hosted","endpoint":"http://localhost:19091"}}';
  const f=fixture(t,{[path]:raw});f.policy.jsonFields=[{path,field:['transport','endpoint'],sourceValueSha256:hash('"http://localhost:19091"'),replacement:'[redacted endpoint]',reason:'sk-'+'m'.repeat(40)}];
  await assert.rejects(a.exportRevision(f),/manifest.*review/);assert.ok(!existsSync(f.destination));
  const excluded='.env.sk-'+'n'.repeat(40),g=fixture(t,{[excluded]:'secret','src/a.ts':'hello'});const m=await a.exportRevision(g);assert.ok(!JSON.stringify(m).includes(excluded));assert.equal(m.excluded[0].pathSha256,hash(excluded));
});
test('explicit archive derivative normalizes ownership and gzip metadata while preserving scientific member bytes',async()=>{
  const a=await api();assert.equal(typeof a.sanitizeArchive,'function');const path='research/candidate-initial-20260927/attempt.tar.gz';
  const original=gzipComment(archive(withHeader(tarEntry('trajectory.json','{"reply":"exact","cost":null,"failure":"length"}\n'),h=>{h.write('private-owner',265);h.write('private-group',297);h.write('0000501\0',108);h.write('0000024\0',116);h.write('00000000123\0',136);})), 'benign archive comment');
  const policy={archiveDerivatives:[{path,sourceSha256:hash(original),normalizeMetadata:true}],jsonFields:[],markdown:[]};const out=a.sanitizeArchive(path,original,policy);
  assert.notEqual(hash(out.bytes),hash(original));assert.ok(out.transformations.some(x=>x.category==='archive-metadata'));assert.ok(!JSON.stringify(out).includes('private-owner'));
  const scan=a.scanObject(path,out.bytes,policy);assert.equal(scan.issues.length,0);const member=out.archiveDerivatives[0].members.find(x=>x.path==='trajectory.json');assert.equal(member.sourceSha256,member.derivativeSha256);assert.equal(member.sourceSha256,hash('{"reply":"exact","cost":null,"failure":"length"}\n'));
  const normalizedPolicy={...policy,archiveDerivatives:[{path,sourceSha256:hash(out.bytes),normalizeMetadata:true}]};assert.deepEqual(a.sanitizeArchive(path,out.bytes,normalizedPolicy).bytes,out.bytes);
});
test('nested provenance metadata and checksums change but trajectory and batch original source identities do not',async t=>{
  const a=await api();assert.equal(typeof a.sanitizeArchive,'function');const outer='research/candidate-continuation-20260927/runs.tar.gz',member='run/provenance.json',logical=outer+'!/'+member;
  const provenance='{"transport":{"backend":"self-hosted","endpoint":"http://localhost:19091/v1"},"sourceHashes":{"code.ts":"original-code-hash"}}\n';
  const batch='{"sourceHashes":{"code.ts":"original-code-hash"},"failure":"length"}\n',trace='{"reply":"unchanged","cost":null}\n';
  const nested=archive(tarEntry(member,provenance),tarEntry('run/trajectory.json',trace),tarEntry('batch.json',batch),tarEntry('run/checksums.json',JSON.stringify({'provenance.json':hash(provenance),'trajectory.json':hash(trace)})));
  const f=fixture(t,{[outer]:nested,'research/candidate-continuation-20260927/checksums.json':JSON.stringify({'runs.tar.gz':hash(nested)})});
  f.policy.archiveDerivatives=[{path:outer,sourceSha256:hash(nested),normalizeMetadata:true}];f.policy.jsonFields=[{path:logical,field:['transport','endpoint'],sourceValueSha256:hash('"http://localhost:19091/v1"'),replacement:'[REDACTED: self-hosted endpoint]',reason:'Private routing metadata'}];f.policy.checksumMaps=[outer+'!/run/checksums.json','research/candidate-continuation-20260927/checksums.json'];
  const m=await a.exportRevision(f);const ar=m.archiveDerivatives.find(x=>x.path===outer);assert.ok(ar);assert.equal(ar.members.find(x=>x.path==='batch.json').sourceSha256,ar.members.find(x=>x.path==='batch.json').derivativeSha256);assert.equal(ar.members.find(x=>x.path==='run/trajectory.json').sourceSha256,ar.members.find(x=>x.path==='run/trajectory.json').derivativeSha256);assert.notEqual(ar.members.find(x=>x.path===member).sourceSha256,ar.members.find(x=>x.path===member).derivativeSha256);
  const sums=JSON.parse(readFileSync(join(f.destination,'research/candidate-continuation-20260927/checksums.json')));assert.equal(sums['runs.tar.gz'],hash(readFileSync(join(f.destination,outer))));
  const decoded=gunzipSync(readFileSync(join(f.destination,outer))).toString();assert.ok(decoded.includes('original-code-hash'));assert.ok(!decoded.includes('19091'));
});
test('archive policy mismatch, unsafe scientific transformations and unlisted nested rules fail closed',async()=>{
  const a=await api();assert.equal(typeof a.sanitizeArchive,'function');const path='research/sources/frozen.tar.gz',b=archive(tarEntry('src/a.ts','unchanged'));
  assert.throws(()=>a.sanitizeArchive(path,b,{archiveDerivatives:[{path,sourceSha256:'wrong',normalizeMetadata:true}]}),/archive.*hash/);
  const base={archiveDerivatives:[{path,sourceSha256:hash(b),normalizeMetadata:true}],jsonFields:[{path:path+'!/missing/provenance.json',field:['transport','endpoint'],sourceValueSha256:'unknown',replacement:'redacted'}]};assert.throws(()=>a.sanitizeArchive(path,b,base),/target absent/);
  const p='research/candidate/x.tar.gz',trace=archive(tarEntry('run/trajectory.json','{"reply":"private"}'));assert.throws(()=>a.sanitizeArchive(p,trace,{archiveDerivatives:[{path:p,sourceSha256:hash(trace),normalizeMetadata:true}],jsonFields:[{path:p+'!/run/trajectory.json',field:['reply'],sourceValueSha256:hash('"private"'),replacement:'changed'}]}),/infrastructure/);
});
test('readArchive exposes bounded validated regular and directory entries for safe in-process extraction',async()=>{
  const a=await api();assert.equal(typeof a.readArchive,'function');const contents=Buffer.from('source bytes');const entries=a.readArchive(archive(tarEntry('src/','','5'),tarEntry('src/a.ts',contents)));
  assert.deepEqual(entries.map(x=>[x.name,x.type]),[['src','5'],['src/a.ts','0']]);assert.deepEqual(entries[1].bytes,contents);
  for(const b of [archive(tarEntry('../escape','x')),archive(tarEntry('link','','2')),archive(tarEntry('a','1'),tarEntry('a','2'))])assert.throws(()=>a.readArchive(b));
});
test('SHA256SUMS derivatives follow normalized archive bytes without changing member hash inventories',async t=>{
  const a=await api(),path='research/characterization-v1/data.tar.gz',raw=archive(withHeader(tarEntry('data/trace.json','{"failure":"length"}'),h=>h.write('owner',265)));
  const inventory=JSON.stringify({'data/trace.json':hash('{"failure":"length"}')});const f=fixture(t,{[path]:raw,'research/characterization-v1/data-sha256.json':inventory,'research/characterization-v1/SHA256SUMS':`${hash(raw)}  data.tar.gz\n${hash(inventory)}  data-sha256.json\n`});
  f.policy.archiveDerivatives=[{path,sourceSha256:hash(raw),normalizeMetadata:true}];f.policy.checksumLists=['research/characterization-v1/SHA256SUMS'];const m=await a.exportRevision(f);
  assert.equal(readFileSync(join(f.destination,'research/characterization-v1/SHA256SUMS'),'utf8').split('  ')[0],hash(readFileSync(join(f.destination,path))));assert.equal(readFileSync(join(f.destination,'research/characterization-v1/data-sha256.json'),'utf8'),inventory);assert.ok(m.transformations.some(x=>x.path.endsWith('/SHA256SUMS')));
});
test('recursive archive transformations preserve scientific grandchildren and enforce every policy target',async()=>{
  const a=await api(),path='research/candidate/outer.tar.gz',innerPath=path+'!/inner.tar.gz',member=innerPath+'!/run/provenance.json';const raw='{"transport":{"backend":"self-hosted","endpoint":"http://localhost:19091"}}';
  const inner=archive(tarEntry('run/provenance.json',raw),tarEntry('run/trajectory.json','{"reply":"exact"}')),outer=archive(tarEntry('inner.tar.gz',inner));
  const policy={archiveDerivatives:[{path,sourceSha256:hash(outer),normalizeMetadata:true},{path:innerPath,sourceSha256:hash(inner),normalizeMetadata:true}],jsonFields:[{path:member,field:['transport','endpoint'],sourceValueSha256:hash('"http://localhost:19091"'),replacement:'[redacted endpoint]',reason:'Private route'}]};
  const result=a.sanitizeArchive(path,outer,policy);assert.equal(result.archiveDerivatives.length,2);const child=result.archiveDerivatives.find(x=>x.path===innerPath);assert.equal(child.members.find(x=>x.path.endsWith('trajectory.json')).sourceSha256,child.members.find(x=>x.path.endsWith('trajectory.json')).derivativeSha256);
  assert.throws(()=>a.sanitizeArchive(path,outer,{...policy,archiveDerivatives:policy.archiveDerivatives.slice(0,1)}),/target absent/);
});
test('unused nested checksum rules cannot silently escape validation',async t=>{
  const a=await api(),f=fixture(t,{'src/a.ts':'a'});f.policy.checksumMaps=['research/missing.tar.gz!/checksums.json'];await assert.rejects(a.exportRevision(f),/target absent/);
});
test('structural parser rejects unused link metadata and file/directory prefix collisions',async()=>{
  const a=await api();assert.throws(()=>a.readArchive(archive(withHeader(tarEntry('file','x'),h=>h.write('hidden-target',157)))));
  assert.throws(()=>a.readArchive(archive(tarEntry('a','x'),tarEntry('a/file','x'))));
});
test('checksum dependency order cannot produce stale derivative checksums',async t=>{
  const a=await api(),p='research/x/provenance.json',raw='{"transport":{"backend":"self-hosted","endpoint":"http://localhost:19091"}}',inner=JSON.stringify({'provenance.json':hash(raw)}),outer=JSON.stringify({'inner-checksums.json':hash(inner)});
  const f=fixture(t,{[p]:raw,'research/x/inner-checksums.json':inner,'research/x/outer-checksums.json':outer});f.policy.jsonFields=[{path:p,field:['transport','endpoint'],sourceValueSha256:hash('"http://localhost:19091"'),replacement:'[redacted endpoint]',reason:'Private routing'}];f.policy.checksumMaps=['research/x/outer-checksums.json','research/x/inner-checksums.json'];
  await assert.rejects(a.exportRevision(f),/derivative checksum.*order/);assert.ok(!existsSync(f.destination));f.policy.checksumMaps.reverse();await a.exportRevision(f);
});

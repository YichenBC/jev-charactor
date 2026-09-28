#!/usr/bin/env node
// Draft source-snapshot exporter. No network calls, extraction, inference, or license grant.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync, inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = data => Buffer.from(JSON.stringify(data,null,2)+'\n');
const limits = { file:64*1024*1024, expanded:128*1024*1024, total:512*1024*1024, depth:4, members:10000 };
function safePath(path) {
  return typeof path==='string' && path.length>0 && !/[\\\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && path.split('/').every(x=>x && x!=='.' && x!=='..');
}
function forbidden(path) {
  return path.split('/').some(p=>['.git','node_modules','dist','.cache','coverage','saves','player-saves'].includes(p) || (p.startsWith('.env')&&p!=='.env.example')) || /\.(?:log|save)$/i.test(path);
}
function infrastructureRule(path, field, data) {
  if (path.startsWith('research/') && path.endsWith('/provenance.json')) return field.join('.')==='transport.endpoint' && data.transport?.backend==='self-hosted';
  if(path!=='research/kimi-interaction-pilot-20260927/service-check.json') return false;
  return ['endpoint','route','metricsObservation','loadBalancerObservation'].includes(field.join('.')) || (field.length===4 && field[0]==='modelResponse' && field[1]==='data' && /^\d+$/.test(String(field[2])) && field[3]==='root');
}
export function sanitizeFile(path, original, policy) {
  let bytes=original;const transformations=[];
  const fields=(policy.jsonFields??[]).filter(x=>x.path===path);
  if(fields.length) {
    let data;try{data=JSON.parse(original);}catch{throw new Error('reviewed JSON is invalid');}
    for(const rule of fields) {
      if(!infrastructureRule(path,rule.field,data)) throw new Error('Only explicit infrastructure fields may be sanitized');
      let parent=data;for(const key of rule.field.slice(0,-1))parent=parent?.[key];
      const key=rule.field.at(-1), old=parent?.[key];
      if(old===undefined || sha256(JSON.stringify(old))!==rule.sourceValueSha256)throw new Error('reviewed field changed');
      parent[key]=rule.replacement;
      transformations.push({path,field:rule.field,category:'infrastructure-metadata',sourceValueSha256:rule.sourceValueSha256,derivativeValueSha256:sha256(JSON.stringify(rule.replacement)),reason:rule.reason});
    }
    bytes=jsonBytes(data);
  }
  for(const rule of (policy.markdown??[]).filter(x=>x.path===path)) {
    if(!path.endsWith('.md') || !(path.startsWith('docs/') || /^research\/[^/]+\/README\.md$/.test(path)))throw new Error('Only reviewed documentation infrastructure paragraphs may be sanitized');
    const parts=bytes.toString('utf8').split(/(\r?\n\r?\n)/);const matches=parts.map((p,i)=>sha256(p)===rule.paragraphSha256?i:-1).filter(i=>i>=0);
    if(matches.length!==1)throw new Error('reviewed paragraph missing or duplicated');
    parts[matches[0]]=rule.replacement;bytes=Buffer.from(parts.join(''));
    transformations.push({path,field:['paragraph',rule.paragraphSha256],category:'infrastructure-documentation',sourceValueSha256:rule.paragraphSha256,derivativeValueSha256:sha256(rule.replacement),reason:rule.reason});
  }
  for(const entry of transformations){entry.sourceFileSha256=sha256(original);entry.derivativeFileSha256=sha256(bytes);}
  return {bytes,transformations};
}

const credential=/(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9_.-]{24,})/g;
const privatePath=/(?<![A-Za-z0-9])(?:\/Users\/[^\s/]+|\/home\/[^\s/]+|\/mnt\/(?:nfs|data)\/[^\s]+|[A-Za-z]:\\Users\\[^\s\\]+)/g;
const privateIP=/\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/g;
function scanText(path,text,policy,bytes) {
  const issues=[], issue=category=>issues.push({objectPathSha256:sha256(path),category});
  if([...text.matchAll(credential)].length)issue('suspicious-credential');
  if([...text.matchAll(privatePath)].length)issue('private-absolute-path');
  const fixture=policy.networkFixtures?.[path];
  const ips=[...text.matchAll(privateIP)].map(x=>x[0]);
  if(ips.length && !(fixture && /^tests\/[^/]+\.test\.[cm]?[jt]s$/.test(path) && fixture.sourceSha256===sha256(bytes) && ips.every(x=>fixture.addresses.includes(x))))issue('private-network-address');
  const routingTokens={port:[...text.matchAll(/:(\d{2,5})(?=[/\s]|$)/g)].map(x=>x[1]),'host-label':[...text.matchAll(/\b(?:head|node) \d+\b/g)].map(x=>x[0])};
  for(const fingerprint of policy.privateRoutingFingerprints??[])if(routingTokens[fingerprint.kind]?.some(value=>sha256(value)===fingerprint.sha256))issue('reviewed-private-deployment-fingerprint');
  return issues;
}
function decodeGzip(bytes) {
  if(bytes.length<18||bytes[0]!==0x1f||bytes[1]!==0x8b||bytes[2]!==8)throw new Error('invalid gzip header');
  const flags=bytes[3];if(flags&~(8|16))throw new Error('unsupported gzip extra, header CRC, reserved or text flags');
  let offset=10;const fields={mtime:bytes.subarray(4,8)};
  for(const [bit,name] of [[8,'filename'],[16,'comment']])if(flags&bit){const end=bytes.indexOf(0,offset);if(end<offset||end-offset>4096)throw new Error('invalid gzip metadata string');fields[name]=bytes.subarray(offset,end);offset=end+1;}
  const inflated=inflateRawSync(bytes.subarray(offset),{maxOutputLength:limits.expanded,info:true});
  if(offset+inflated.engine.bytesWritten+8!==bytes.length)throw new Error('concatenated gzip or trailing bytes are unsupported');
  // gunzip verifies both CRC32 and ISIZE; raw inflation above establishes one exact stream boundary.
  const expanded=gunzipSync(bytes,{maxOutputLength:limits.expanded});
  return {expanded,header:bytes.subarray(0,offset),fields,needsNormalization:flags!==0||bytes.readUInt32LE(4)!==0};
}
function headerMetadata(header) {
  const fields={uid:header.subarray(108,116),gid:header.subarray(116,124),mtime:header.subarray(136,148),uname:header.subarray(265,297),gname:header.subarray(297,329)};
  const result=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k+'Sha256',sha256(v)]));
  result.hasOwnerNames=fields.uname.some(x=>x!==0)||fields.gname.some(x=>x!==0);
  result.hasNonzeroIds=[fields.uid,fields.gid].some(b=>parseInt(b.toString().replace(/\0.*$/s,'').trim()||'0',8)!==0);
  return result;
}
function tarMembers(bytes) {
  const members=[], seen=new Map();let offset=0,pendingPax=false;
  while(offset+512<=bytes.length) {
    const h=bytes.subarray(offset,offset+512);if(h.every(x=>x===0)) {
      if(pendingPax || bytes.length-offset<1024 || !bytes.subarray(offset).every(x=>x===0))throw new Error('tar end marker');
      return members;
    }
    const str=(start,end)=>h.subarray(start,end).toString('utf8').replace(/\0.*$/s,'');
    const oct=(start,end)=>{const s=str(start,end).trim();if(!/^[0-7]+$/.test(s))throw new Error('tar numeric field');return parseInt(s,8);};
    const expected=oct(148,156);let checksum=0;for(let i=0;i<512;i++)checksum+=(i>=148&&i<156)?32:h[i];if(expected!==checksum)throw new Error('tar checksum');
    if(!h.subarray(257,263).equals(Buffer.from('ustar\0'))||h.subarray(500,512).some(x=>x!==0))throw new Error('unsupported tar header');
    if(h.subarray(157,257).some(x=>x!==0))throw new Error('unused tar link metadata is not allowed');
    oct(108,116);oct(116,124);oct(136,148);
    const type=str(156,157)||'0';if(!['0','5','x'].includes(type))throw new Error('tar unsupported member type or symlink');
    const prefix=str(345,500);let name=(prefix?prefix+'/':'')+str(0,100);if(type==='5')name=name.replace(/\/$/,'');
    const paxHeader=type==='x';
    // Python tarfile's conventional metadata header is never an extracted path.
    if(!(paxHeader&&name==='././@PaxHeader')&&!safePath(name))throw new Error('tar unsafe member path');
    if(forbidden(name)||(!paxHeader&&seen.has(name)))throw new Error('tar unsafe or duplicate member path');
    if(!paxHeader){for(const [existing,existingType] of seen)if((name.startsWith(existing+'/')&&existingType!=='5')||(existing.startsWith(name+'/')&&type!=='5'))throw new Error('tar file-directory prefix collision');seen.set(name,type);}
    const size=oct(124,136);if(!Number.isSafeInteger(size)||size>limits.file||(type==='5'&&size!==0))throw new Error('tar member size');
    offset+=512;if(offset+size>bytes.length)throw new Error('tar truncated data');
    if(paxHeader) {
      if(pendingPax)throw new Error('stacked PAX metadata');pendingPax=true;
      const content=bytes.subarray(offset,offset+size);let start=0;
      while(start<content.length) {
        const space=content.indexOf(32,start);if(space<0)throw new Error('PAX length');
        const lengthText=content.subarray(start,space).toString();if(!/^[1-9]\d*$/.test(lengthText))throw new Error('PAX length');
        const length=Number(lengthText);if(length<=space-start+1||start+length>content.length)throw new Error('PAX bounds');
        const record=content.subarray(space+1,start+length).toString('utf8');
        if(!/^(mtime|atime|ctime)=-?\d+(?:\.\d+)?\n$/.test(record))throw new Error('Unsupported PAX metadata; path/link/size overrides require review');
        start+=length;
      }
    } else pendingPax=false;
    const paddedEnd=offset+Math.ceil(size/512)*512;if(paddedEnd>bytes.length||bytes.subarray(offset+size,paddedEnd).some(x=>x!==0))throw new Error('nonzero or truncated tar member padding');
    members.push({name,type,bytes:bytes.subarray(offset,offset+size),header:h,headerMetadata:headerMetadata(h)});if(members.length>limits.members)throw new Error('tar member count');
    offset+=Math.ceil(size/512)*512;
  }
  throw new Error('tar missing end marker');
}
/** Structural validation only; callers must separately apply content/privacy review. Never extracts. */
export function readArchive(bytes) {
  if(!Buffer.isBuffer(bytes)||bytes.length>limits.file)throw new Error('archive input type or size limit');
  return tarMembers(decodeGzip(bytes).expanded).filter(x=>x.type!=='x').map(({name,type,bytes})=>({name,type,bytes}));
}
function isArchive(path,bytes) { return (bytes[0]===0x1f&&bytes[1]===0x8b)||/\.(?:tar\.gz|tgz)$/.test(path); }
function parseChecksumList(bytes) {
  const data=Object.create(null),lines=bytes.toString('utf8').replace(/\n$/,'').split('\n');
  for(const line of lines){const m=/^([0-9a-f]{64})  (.+)$/.exec(line);if(!m||!safePath(m[2])||Object.hasOwn(data,m[2]))throw new Error('invalid checksum list');data[m[2]]=m[1];}
  return data;
}
function checksumMap(path,originals,files,format='json') {
  const entry=files.get(path);if(!entry)throw new Error('checksum map/list target absent');let data;try{data=format==='list'?parseChecksumList(originals.get(path)):JSON.parse(originals.get(path));}catch{throw new Error('invalid checksum map/list');}
  if(Array.isArray(data)||!data||typeof data!=='object')throw new Error('invalid checksum map');const changes=[];
  for(const [relative,originalHash] of Object.entries(data)) {
    if(!safePath(relative))throw new Error('unsafe checksum path');const target=posix.join(posix.dirname(path),relative);
    if(!files.has(target)||originalHash!==sha256(originals.get(target)))throw new Error('original checksum mismatch or missing target');
    const derivative=sha256(files.get(target).bytes);if(derivative!==originalHash){data[relative]=derivative;changes.push({path,field:[relative],category:'derivative-checksum',sourceValueSha256:sha256(JSON.stringify(originalHash)),derivativeValueSha256:sha256(JSON.stringify(derivative)),originalArtifactSha256:originalHash,derivativeArtifactSha256:derivative,reason:'Recomputed checksum for sanitized derivative; original hash retained here'});}
  }
  if(changes.length){entry.bytes=format==='list'?Buffer.from(Object.entries(data).map(([p,h])=>h+'  '+p).join('\n')+'\n'):jsonBytes(data);for(const c of changes){c.sourceFileSha256=sha256(originals.get(path));c.derivativeFileSha256=sha256(entry.bytes);}entry.transformations.push(...changes);}
}
function verifyChecksumOutputs(policy,files,belongs) {
  for(const [paths,format] of [[policy.checksumMaps??[],'json'],[policy.checksumLists??[],'list']])for(const path of paths.filter(belongs)) {
    const data=format==='list'?parseChecksumList(files.get(path).bytes):JSON.parse(files.get(path).bytes);
    for(const [relative,hash] of Object.entries(data))if(sha256(files.get(posix.join(posix.dirname(path),relative)).bytes)!==hash)throw new Error('derivative checksum mismatch; review checksum dependency order');
  }
}
function checksumHeader(header) { header.fill(32,148,156);const sum=header.reduce((n,x)=>n+x,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148); }
function writeOctal(header,start,length,value) { const text=value.toString(8).padStart(length-1,'0');if(text.length!==length-1)throw new Error('tar output field overflow');header.write(text+'\0',start,length); }
/** Explicit, hash-pinned archive derivative. Scientific file bodies are never broadly rewritten. */
export function sanitizeArchive(path,original,policy,depth=0,budget={expanded:0}) {
  const rules=(policy.archiveDerivatives??[]).filter(x=>x.path===path);
  if(rules.length!==1||rules[0].sourceSha256!==sha256(original))throw new Error('archive policy hash missing, duplicated or mismatched');
  if(rules[0].normalizeMetadata!==true)throw new Error('archive policy requires explicit metadata normalization');
  if(depth>=limits.depth||original.length>limits.file)throw new Error('archive transformation bound');
  const gzipData=decodeGzip(original),members=tarMembers(gzipData.expanded);budget.expanded+=gzipData.expanded.length;if(budget.expanded>limits.total)throw new Error('archive expansion budget');
  const headerIssues=[...scanText(path+'!gzip-header',gzipData.header.toString('latin1'),policy,gzipData.header)];
  for(const member of members)headerIssues.push(...scanText(path+'!/'+member.name+'!tar-header',member.header.toString('latin1'),policy,member.header));
  if(headerIssues.length){const error=new Error('archive metadata content review required: '+JSON.stringify(headerIssues));error.issues=headerIssues;throw error;}
  const transformations=[],archiveDerivatives=[],originals=new Map(),files=new Map();
  for(const member of members.filter(x=>x.type!=='x')) {
    const full=path+'!/'+member.name;originals.set(full,member.bytes);
    let result;
    if(isArchive(full,member.bytes)&&(policy.archiveDerivatives??[]).some(x=>x.path===full))result=sanitizeArchive(full,member.bytes,policy,depth+1,budget);
    else result=sanitizeFile(full,member.bytes,policy);
    files.set(full,{...result,member});archiveDerivatives.push(...(result.archiveDerivatives??[]));
  }
  const nestedRoot=path+'!/';
  const immediate=target=>target.startsWith(nestedRoot)&&!target.slice(nestedRoot.length).includes('!/');
  for(const rule of [...(policy.jsonFields??[]),...(policy.markdown??[]),...(policy.archiveDerivatives??[])])if(immediate(rule.path)&&!files.has(rule.path))throw new Error('archive sanitization target absent');
  for(const mapPath of policy.checksumMaps??[])if(immediate(mapPath))checksumMap(mapPath,originals,files);
  for(const listPath of policy.checksumLists??[])if(immediate(listPath))checksumMap(listPath,originals,files,'list');
  verifyChecksumOutputs(policy,files,immediate);
  // Rules below an unlisted inner archive may not silently go unused.
  for(const target of [...(policy.jsonFields??[]).map(x=>x.path),...(policy.markdown??[]).map(x=>x.path),...(policy.checksumMaps??[]),...(policy.checksumLists??[]),...(policy.archiveDerivatives??[]).map(x=>x.path)]) {
    if(target.startsWith(nestedRoot)&&!immediate(target)) {
      const first=target.indexOf('!/',nestedRoot.length),inner=target.slice(0,first);
      if(!(policy.archiveDerivatives??[]).some(x=>x.path===inner))throw new Error('nested archive sanitization target absent from archive policy');
    }
  }
  const parts=[],metadataChanges=[],memberHashes=[];let changed=gzipData.needsNormalization;
  for(let index=0;index<members.length;index++) {
    const member=members[index],full=path+'!/'+member.name;
    if(member.type==='x') {
      changed=true;metadataChanges.push({path,field:['tar',index,'timestamp-pax-header'],category:'archive-metadata',sourceValueSha256:sha256(Buffer.concat([member.header,member.bytes])),derivativeValueSha256:sha256(Buffer.alloc(0)),reason:'Removed timestamp-only PAX metadata; regular member bytes preserved'});continue;
    }
    const entry=files.get(full),header=Buffer.from(member.header);
    for(const [field,start,length] of [['uid',108,8],['gid',116,8],['mtime',136,12],['uname',265,32],['gname',297,32]]) {
      const old=Buffer.from(header.subarray(start,start+length));if(field==='uname'||field==='gname')header.fill(0,start,start+length);else writeOctal(header,start,length,0);
      const value=header.subarray(start,start+length);if(!old.equals(value)){changed=true;metadataChanges.push({path,field:['tar',member.name,field],category:'archive-metadata',sourceValueSha256:sha256(old),derivativeValueSha256:sha256(value),reason:'Normalized archive ownership or timestamp metadata; no scientific member content changed by this operation'});}
    }
    if(!entry.bytes.equals(member.bytes))changed=true;
    writeOctal(header,124,12,entry.bytes.length);checksumHeader(header);
    parts.push(header,entry.bytes,Buffer.alloc((512-entry.bytes.length%512)%512));
    transformations.push(...entry.transformations);
    memberHashes.push({path:member.name,type:member.type,sourceSha256:sha256(member.bytes),derivativeSha256:sha256(entry.bytes),sourceSize:member.bytes.length,derivativeSize:entry.bytes.length,sourceHeaderMetadata:member.headerMetadata,derivativeHeaderMetadata:headerMetadata(header)});
  }
  // A normalized, unchanged source snapshot remains byte-identical, including gzip compression.
  const bytes=changed?gzipSync(Buffer.concat([...parts,Buffer.alloc(1024)]),{level:9}):original;
  const derivativeHeader=decodeGzip(bytes).header;if(!gzipData.header.equals(derivativeHeader))metadataChanges.push({path,field:['gzip','header'],category:'archive-metadata',sourceValueSha256:sha256(gzipData.header),derivativeValueSha256:sha256(derivativeHeader),reason:'Normalized gzip filename/comment/timestamp metadata; removed values are not recorded'});
  for(const entry of metadataChanges){entry.sourceFileSha256=sha256(original);entry.derivativeFileSha256=sha256(bytes);}transformations.push(...metadataChanges);
  archiveDerivatives.push({path,sourceSha256:sha256(original),derivativeSha256:sha256(bytes),members:memberHashes,removedTimestampPaxHeaders:members.filter(x=>x.type==='x').length});
  return {bytes,transformations,archiveDerivatives};
}
export function scanObject(path,bytes,policy={},depth=0,budget={expanded:0}) {
  const issues=scanText(path,path,policy,Buffer.from(path)),archives=[],binary=[];
  if(path.split('/').at(-1)==='.env.example'&&policy.reviewedEnvExamples?.[path]!==sha256(bytes))issues.push({objectPathSha256:sha256(path),category:'unreviewed-env-example'});
  if(bytes.length>limits.file){issues.push({objectPathSha256:sha256(path),category:'file-size-limit'});return {issues,archives,binary};}
  const gzip=bytes[0]===0x1f&&bytes[1]===0x8b;
  if(gzip||path.endsWith('.tar.gz')||path.endsWith('.tgz')) {
    try {
      if(depth>=limits.depth)throw new Error('archive recursion limit');
      const gzipData=decodeGzip(bytes),expanded=gzipData.expanded;budget.expanded+=expanded.length;if(budget.expanded>limits.total)throw new Error('archive expansion budget');
      issues.push(...scanText(path+'!gzip-header',gzipData.header.toString('latin1'),{},gzipData.header));
      if(gzipData.needsNormalization)issues.push({objectPathSha256:sha256(path),category:'gzip-metadata-requires-normalization'});
      const members=tarMembers(expanded), record={path,sourceSha256:sha256(bytes),gzipHeaderSha256:sha256(gzipData.header),members:[]};
      for(const member of members) {
        const full=path+'!/'+member.name;
        issues.push(...scanText(full+'!tar-header',member.header.toString('latin1'),{},member.header));
        if(member.headerMetadata.hasOwnerNames||member.headerMetadata.hasNonzeroIds)issues.push({objectPathSha256:sha256(full),category:'archive-ownership-metadata'});
        const child=scanObject(full,member.bytes,policy,depth+1,budget);issues.push(...child.issues);archives.push(...child.archives);binary.push(...child.binary);
        record.members.push({path:member.name,type:member.type,sha256:sha256(member.bytes),size:member.bytes.length,headerMetadata:member.headerMetadata});
      }
      archives.push(record);
    } catch {issues.push({objectPathSha256:sha256(path),category:'unsafe-unsupported-or-corrupt-archive'});}
  } else {
    try {const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw new Error('binary');issues.push(...scanText(path,text,policy,bytes));}
    catch {
      issues.push(...scanText(path,bytes.toString('latin1'),policy,bytes));
      if(policy.reviewedBinary?.[path]!==sha256(bytes))issues.push({objectPathSha256:sha256(path),category:'unreviewed-binary-content'});
      binary.push({path,sha256:sha256(bytes),reason:'Binary only scanned for ASCII patterns; visual/embedded-content manual review still required'});
    }
  }
  return {issues,archives,binary};
}
function noSymlinkParents(destination) {
  let p=dirname(destination);while(true){if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('destination parent symlink');const parent=dirname(p);if(parent===p)break;p=parent;}
}
export async function exportRevision({repo,revision,policy,destination}) {
  destination=resolve(destination);if(existsSync(destination))throw new Error('destination exists');noSymlinkParents(destination);
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{maxBuffer:limits.total,stdio:['ignore','pipe','pipe']});
  if(!/^[0-9a-f]{7,40}$/.test(revision))throw new Error('revision must be a commit hash');
  const commit=git('rev-parse','--verify',revision+'^{commit}').toString().trim();
  if(policy.schemaVersion!==1||policy.revision!==commit)throw new Error('policy revision mismatch');
  const allowed=new Set(policy.allowlist);if(allowed.size!==policy.allowlist.length)throw new Error('duplicate allowlist');
  const originals=new Map(),files=new Map(),excluded=[],excludedPaths=new Set(),archiveBudget={expanded:0};let total=0;
  for(const line of git('ls-tree','-rz','--full-tree',commit).toString().split('\0').filter(Boolean)) {
    const m=/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);if(!m)throw new Error('invalid git tree entry');const [,mode,type,object,path]=m;
    if(!safePath(path))throw new Error('unsafe git path');
    if(mode==='120000')throw new Error('git symlink is not allowed');if(type!=='blob'||!['100644','100755'].includes(mode))throw new Error('unsupported git entry');
    if(forbidden(path)){
      if(/^(research|artifacts)\//.test(path))throw new Error('Forbidden path may contain experimental evidence; explicit review required; path hash '+sha256(path));
      excludedPaths.add(path);excluded.push({pathSha256:sha256(path),reason:'Forbidden runtime, secret, cache, save or build path'});continue;
    }
    if(!allowed.has(path))throw new Error('tracked file outside reviewed allowlist; path hash '+sha256(path));
    const bytes=git('cat-file','blob',object);total+=bytes.length;if(total>limits.total||bytes.length>limits.file)throw new Error('source size limit');
    if(path.split('/').at(-1)==='.env.example'&&policy.reviewedEnvExamples?.[path]!==sha256(bytes))throw new Error('env example is not reviewed at this hash');
    const result=isArchive(path,bytes)&&(policy.archiveDerivatives??[]).some(x=>x.path===path)?sanitizeArchive(path,bytes,policy,0,archiveBudget):sanitizeFile(path,bytes,policy);
    originals.set(path,bytes);files.set(path,{...result,mode});
  }
  for(const path of allowed)if(!originals.has(path)&&!excludedPaths.has(path))throw new Error('allowlist file absent from revision');
  for(const rule of [...(policy.jsonFields??[]),...(policy.markdown??[]),...(policy.archiveDerivatives??[]),...[...(policy.checksumMaps??[]),...(policy.checksumLists??[])].map(path=>({path}))]) {
    const root=rule.path.split('!/')[0];if(!files.has(root)||rule.path.includes('!/')&&!(policy.archiveDerivatives??[]).some(x=>x.path===root))throw new Error('sanitization target absent');
  }
  for(const path of policy.checksumMaps??[])if(!path.includes('!/'))checksumMap(path,originals,files);
  for(const path of policy.checksumLists??[])if(!path.includes('!/'))checksumMap(path,originals,files,'list');
  verifyChecksumOutputs(policy,files,path=>!path.includes('!/'));
  const manifest={schemaVersion:1,kind:'sanitized-source-derivative-draft',sourceRevision:commit,policySha256:sha256(JSON.stringify(policy)),originalHashMeaning:'Hashes of private original git blobs; historical provenance and batch sourceHashes are unchanged original-source identities',derivativeHashMeaning:'Hashes of delivered sanitized bytes; not independent authenticity evidence',files:[],transformations:[],excluded,archives:[],archiveDerivatives:[],manualReview:[],limits:['Bounded credential/path pattern scan; not exhaustive security certification','Binary content requires manual review','Historical source snapshot availability and replay compatibility must be separately verified','No candidate replay, build, license grant or publication verification implied']};
  const issues=[],budget={expanded:0};
  for(const [path,entry] of files) {
    const scan=scanObject(path,entry.bytes,policy,0,budget);issues.push(...scan.issues);manifest.archives.push(...scan.archives);manifest.manualReview.push(...scan.binary);
    manifest.files.push({path,mode:entry.mode,size:entry.bytes.length,sourceSha256:sha256(originals.get(path)),derivativeSha256:sha256(entry.bytes)});manifest.transformations.push(...entry.transformations);
    manifest.archiveDerivatives.push(...(entry.archiveDerivatives??[]));
  }
  if(issues.length){const error=new Error('content review required: '+JSON.stringify(issues));error.issues=issues;throw error;}
  if(files.has('RELEASE-MANIFEST.json')||files.has('RELEASE-SHA256SUMS'))throw new Error('reserved manifest path collision');
  const manifestBytes=jsonBytes(manifest);
  const sums=[...manifest.files.map(x=>x.derivativeSha256+'  '+x.path),sha256(manifestBytes)+'  RELEASE-MANIFEST.json'].join('\n')+'\n';
  const strictPolicy={...policy,networkFixtures:{},reviewedBinary:{},reviewedEnvExamples:{}};
  const generatedIssues=[...scanObject('RELEASE-MANIFEST.json',manifestBytes,strictPolicy).issues,...scanObject('RELEASE-SHA256SUMS',Buffer.from(sums),strictPolicy).issues];
  if(generatedIssues.length){const error=new Error('generated manifest content review required: '+JSON.stringify(generatedIssues));error.issues=generatedIssues;throw error;}
  // mkdir without recursive is an exclusive creation: a racing existing destination is never overwritten.
  mkdirSync(destination,{mode:0o700});
  try {
    for(const [path,entry] of files){const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,entry.bytes,{flag:'wx',mode:entry.mode==='100755'?0o755:0o644});}
    writeFileSync(join(destination,'RELEASE-MANIFEST.json'),manifestBytes,{flag:'wx'});
    writeFileSync(join(destination,'RELEASE-SHA256SUMS'),sums,{flag:'wx'});
  } catch(error){rmSync(destination,{recursive:true,force:true});throw error;}
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [repo,revision,destination,policyFile]=process.argv.slice(2);
  if(!policyFile){console.error('Usage: node export.mjs REPO COMMIT FRESH_DESTINATION POLICY.json');process.exitCode=1;}
  else try {const manifest=await exportRevision({repo,revision,destination,policy:JSON.parse(readFileSync(policyFile))});console.log(JSON.stringify({sourceRevision:manifest.sourceRevision,files:manifest.files.length,transformations:manifest.transformations.length,archives:manifest.archives.length,manualReviewItems:manifest.manualReview.length}));}
  catch(error){console.error(error.issues?error.message:(error.message?.startsWith('Command failed')?'git read failed (details suppressed)':error.message));process.exitCode=1;}
}

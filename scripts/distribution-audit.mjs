import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const [tarPath,output]=process.argv.slice(2);
if(!tarPath||!output)throw Error('usage: node scripts/distribution-audit.mjs <tarball> <audit-json>');
const sha=data=>createHash('sha256').update(data).digest('hex');
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8',windowsHide:true,maxBuffer:20*1024*1024});if(r.status!==0)throw Error('AUDIT_COMMAND_FAILED');return r.stdout;}
const repo=resolve('.').replaceAll('\\','/');
const tracked=run('git',['-c','safe.directory='+repo,'-c','core.excludesFile=','ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean);
const inventory=run('tar',['-tf',tarPath]).trim().split(/\r?\n/);
if(inventory.some(p=>!p.startsWith('package/')||p.split('/').includes('..')||p.includes('node_modules/')))throw Error('UNEXPECTED_TAR_PATH');
const pkg=JSON.parse(await readFile('package.json','utf8'));
if(pkg.bundleDependencies||pkg.bundledDependencies)throw Error('BUNDLED_DEPENDENCIES');
const code=/\.(?:[cm]?js|ts)$/;
const candidates=[];
for(const path of tracked.filter(p=>code.test(p)))candidates.push({path:'tracked/'+path,text:await readFile(path,'utf8')});
for(const path of inventory.filter(p=>code.test(p)))candidates.push({path:'tar/'+path,text:run('tar',['-xOf',tarPath,path])});
async function files(root,prefix=''){const result=[];for(const e of await readdir(root+(prefix?'/'+prefix:''),{withFileTypes:true})){const p=prefix?prefix+'/'+e.name:e.name;if(e.isDirectory())result.push(...await files(root,p));else if(e.isFile()&&code.test(p))result.push(p);}return result;}
const upstream=[];
for(const name of ['@npmcli/agent','proxy-agent-negotiate']){
 const root='node_modules/'+name,metadata=JSON.parse(await readFile(root+'/package.json','utf8')),sources=[];
 for(const path of await files(root)){const text=await readFile(root+'/'+path,'utf8');sources.push({path,sha256:sha(text),text});}
 upstream.push({name,version:metadata.version,license:metadata.license,author:metadata.author,repository:metadata.repository,gitHead:metadata.gitHead,files:sources});
}
const normalize=s=>s.replace(/\s+/g,'');
const matches=[];
for(const dep of upstream)for(const source of dep.files){const normalized=normalize(source.text);for(const candidate of candidates){const target=normalize(candidate.text);if(sha(source.text)===sha(candidate.text))matches.push({upstream:dep.name+'/'+source.path,candidate:candidate.path,kind:'exact'});else for(let i=0;i+240<=normalized.length;i+=120)if(target.includes(normalized.slice(i,i+240))){matches.push({upstream:dep.name+'/'+source.path,candidate:candidate.path,kind:'240-character-block'});break;}}}
if(matches.length)throw Error('UPSTREAM_CODE_COPY_REQUIRES_REVIEW');
// The actual archive contains only tsc output, synthetic demo JSON and declared docs.
const allowed=/^package\/(?:dist\/(?:[^/]+\.(?:js|d\.ts)|demo-assets\/[^/]+\.json)|package\.json|compatibility\.json|README(?:_ZH)?\.md|LICENSE|THIRD_PARTY_NOTICES\.md|CHANGELOG\.md|SUPPORT\.md)$/;
if(inventory.some(p=>!allowed.test(p)))throw Error('UNEXPECTED_DISTRIBUTION_FILE');
const result={scope:'original source and unbundled compiled tarball',tarSha256:sha(await readFile(tarPath)),tarFiles:inventory.length,inventory,trackedFiles:tracked.length,scannedCodeFiles:candidates.length,bundledDependencies:false,upstreamCodeMatches:matches,method:'exact hashes and whitespace-normalized 240-character blocks; supplemented by source/import and build-script review',upstream:upstream.map(d=>({...d,files:d.files.map(({text,...f})=>f)})),copiedNoticeSources:['installed upstream LICENSE/COPYING/NOTICE files','licenses/*.txt (two metadata-only gaps explicitly labelled)'],standaloneLicenseTextGaps:['@npmcli/agent@5.0.2','proxy-agent-negotiate@1.1.0'],buildScriptSha256:sha(await readFile('scripts/build-assets.mjs')),packageSha256:sha(await readFile('package.json'))};
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({tarSha256:result.tarSha256,tarFiles:result.tarFiles,trackedFiles:result.trackedFiles,scannedCodeFiles:result.scannedCodeFiles,upstreamCodeMatches:matches.length,standaloneLicenseTextGaps:result.standaloneLicenseTextGaps}));

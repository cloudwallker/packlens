import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir, symlink, link } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fixture, expireBeforeIntent } from './helpers.ts';
import { analyzePackage } from '../src/analyze.ts';
import { snapshotPackage } from '../src/snapshot.ts';
import { runtimeProfile, require as profileRequire } from '../src/profile.ts';
import type { PackReport } from '../src/model.ts';
const api=async()=>{const m=await import('../src/cli.ts').catch(()=>undefined);assert.ok(m,'missing CLI implementation');return m;};
async function run(args:string[]){return new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../src/cli.ts',import.meta.url)),...args],{windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});}
test('CLI analyze JSON strips unrelated manifest and source paths; localized summary and version',async()=>{
  await api();const f=await fixture({'dist/a.js':'a','dist/.npmignore':'# unrelated-secret-marker\n*.css\nunmatched-private-rule-marker\n','dist/a.css':'b'},{files:['dist'],author:'synthetic-person@example.invalid',scripts:{prepare:'synthetic-secret-marker'}});
  try{
    const r=await run(['analyze',f.root,'--json']);assert.equal(r.code,0);const report=JSON.parse(r.out);
    assert.ok(!r.out.includes(f.root));assert.ok(!r.out.includes('synthetic-person'));assert.ok(!r.out.includes('synthetic-secret-marker'));assert.ok(!r.out.includes('unrelated-secret-marker'));
    assert.ok(!r.out.includes('unmatched-private-rule-marker'));
    assert.equal(report.snapshot.manifestText,undefined);assert.equal(report.snapshot.manifest.author,undefined);assert.deepEqual(report.snapshot.manifest.files,['dist']);
    assert.ok((await run(['analyze',f.root])).out.includes('原始字节'));
    assert.ok((await run(['analyze',f.root,'--locale','en'])).out.includes('Raw bytes'));
    assert.equal((await run(['--version'])).out.trim(),'0.1.0');
  }finally{await f.cleanup();}
});
test('CLI explain identifies physical source and simulate honors patch/intent with safe errors',async()=>{
  await api();const f=await fixture({'dist/.npmignore':'# assets\n*.css\n','dist/a.css':'123'},{files:['dist']});
  const controls=await fixture({});
  try{
    const explanation=await run(['explain',f.root,'dist/a.css','--json']);assert.equal(explanation.code,0);const e=JSON.parse(explanation.out);
    assert.equal(e.entry.membership,'excluded');assert.ok(e.ruleSources.some((s:any)=>s.path==='dist/.npmignore' && s.line===2));
    await writeFile(join(controls.root,'patch.json'),JSON.stringify({schemaVersion:1,operations:[{op:'removeIgnoreLine',path:'dist/.npmignore',line:2,expected:'*.css'}]}));
    await writeFile(join(controls.root,'intent.json'),JSON.stringify({schemaVersion:1,mustShip:['dist/a.css']}));
    const changed=await run(['simulate',f.root,'--patch',join(controls.root,'patch.json'),'--intent',join(controls.root,'intent.json'),'--json']);assert.equal(changed.code,0);assert.equal(JSON.parse(changed.out).scenario.assertions[0].status,'pass');
    await writeFile(join(controls.root,'intent.json'),JSON.stringify({schemaVersion:1,mustShip:['missing.css']}));
    assert.equal((await run(['analyze',f.root,'--intent',join(controls.root,'intent.json'),'--json'])).code,1);
    const bad=await run(['explain',f.root,'../private.js','--json']);assert.equal(bad.code,3);assert.ok(!bad.out.includes(f.root));assert.ok(!bad.err.includes(f.root));assert.ok(!bad.err.includes('at '));
  }finally{await f.cleanup();await controls.cleanup();}
});
test('output-json rejects inside roots, overwrite, and symlink aliases before writing',async()=>{
  const {writeReportOutput}=await api();const f=await fixture({'a.js':'a'}),out=await fixture({});
  try{
    await assert.rejects(writeReportOutput(f.root,join(f.root,'report.json'),'{}'),/OUTPUT_INSIDE_ROOT/);
    const target=join(out.root,'report.json');await writeReportOutput(f.root,target,'first');
    await assert.rejects(writeReportOutput(f.root,target,'second'),/OUTPUT_EXISTS/);assert.equal(await readFile(target,'utf8'),'first');
    await writeReportOutput(f.root,target,'second',true);assert.equal(await readFile(target,'utf8'),'second');
    await symlink(f.root,join(out.root,'alias'),'junction');
    await assert.rejects(writeReportOutput(f.root,join(out.root,'alias','report.json'),'{}',true),/OUTPUT_LINK/);
    await mkdir(join(f.root,'nested'));await assert.rejects(writeReportOutput(f.root,join(f.root,'nested','x.json'),'{}',true),/OUTPUT_INSIDE_ROOT/);
  }finally{await out.cleanup();await f.cleanup();}
});
test('exit-code priority keeps runtime failure above unknown above definite assertion failure',async()=>{
  const {reportExitCode}=await api();const f=await fixture({'a.js':'a'});
  try{
    const r=await analyzePackage(f.root);assert.equal(reportExitCode(r),0);
    r.scenario.assertions=[{assertionId:'x',type:'mustShip',selector:'x',matchedExistingPaths:[],matchedShippedPaths:[],status:'fail',reasonCodes:[]}];assert.equal(reportExitCode(r),1);
    r.entries.find(e=>e.path==='a.js')!.explanationStatus='unknown';assert.equal(reportExitCode(r,true),2);
    r.scenario.assertions.push({...r.scenario.assertions[0],status:'unknown'});assert.equal(reportExitCode(r),2);
    r.diagnostics.push({code:'ORACLE_ERROR',severity:'error',scope:'oracle',message:'safe'});assert.equal(reportExitCode(r),3);
    r.diagnostics=[{code:'LIMIT_EXCEEDED',severity:'error',scope:'snapshot',message:'safe'}];assert.equal(reportExitCode(r),2);
  }finally{await f.cleanup();}
});
test('public projection omitRuleText removes rule patterns and simulation patch contents',async()=>{
  const module=await import('../src/serialization.ts').catch(()=>undefined);assert.ok(module,'missing public projection');
  const f=await fixture({'.npmignore':'*.css\n','a.css':'a'});
  try{
    const r=await analyzePackage(f.root);r.scenario.patch={schemaVersion:1,operations:[{op:'replaceIgnoreText',path:'.npmignore',value:'private-marker'}]};
    const text=JSON.stringify(module.toPublicReport(r,{omitRuleText:true}));assert.ok(!text.includes('*.css'));assert.ok(!text.includes('private-marker'));assert.ok(!text.includes('manifestText'));
  }finally{await f.cleanup();}
});

test('selected npmrc control file is rejected before content read and control JSON is bounded',async()=>{
  const {readControlJson}=await api();const f=await fixture({'.npmrc':'{"schemaVersion":1}','large.json':'x'.repeat(1024*1024+1),'invalid.json':'not-json'});
  try{
    await assert.rejects(readControlJson(join(f.root,'.npmrc')),/CONTROL_CONFIG_FORBIDDEN/);
    await assert.rejects(readControlJson(join(f.root,'large.json')),/LIMIT_EXCEEDED/);
    await assert.rejects(readControlJson(join(f.root,'invalid.json')),/INVALID_CONTROL_JSON/);
  }finally{await f.cleanup();}
});

test('late output IO error keeps acquired analysis JSON with priority three and hides raw exception',async()=>{
  const {runCli}=await api();const f=await fixture({'a.js':'a'}),output=await fixture({});
  const target=join(output.root,'report.json');let out='',err='';const original=fs.open;
  try{
    fs.open=async(...args:any[])=>{if(args[0]===target)throw new Error('synthetic-private-error-marker');return (original as any)(...args);};
    const code=await runCli(['analyze',f.root,'--json','--output-json',target],{stdout:s=>out+=s,stderr:s=>err+=s});
    assert.equal(code,3);const report=JSON.parse(out);assert.ok(report.scenario,'acquired scenario dropped');assert.ok(report.scenario.oracleFiles.includes('a.js'));assert.ok(report.diagnostics.some((d:any)=>d.code==='OUTPUT_UNAVAILABLE'));
    assert.ok(!out.includes('synthetic-private-error-marker'));assert.ok(!err.includes('synthetic-private-error-marker'));
  }finally{fs.open=original;await output.cleanup();await f.cleanup();}
});

test('overwrite rejects external hardlink aliases without changing source asset bytes',async()=>{
  const {writeReportOutput}=await api();const f=await fixture({'a.js':'source-must-stay'}),output=await fixture({});
  try{
    const target=join(output.root,'linked.json');await link(join(f.root,'a.js'),target);
    await assert.rejects(writeReportOutput(f.root,target,'report',true),/OUTPUT_LINK/);
    assert.equal(await readFile(join(f.root,'a.js'),'utf8'),'source-must-stay');
  }finally{await output.cleanup();await f.cleanup();}
});

test('I1 public manifest path fields and associated rule text omit absolute values without running oracle',async()=>{
  const {toPublicReport}=await import('../src/serialization.ts');
  for(const absolute of ['Q:\\SyntheticPersonal\\account\\entry.js','/synthetic-personal/account/entry.js','\\\\synthetic-host\\private\\entry.js','file:///synthetic-personal/account/entry.js']) {
    for(const bin of [absolute,{unsafe:absolute,[absolute]:'dist/private-cli.js',safe:'dist/cli.js'}]) {
      const f=await fixture({},{main:absolute,browser:absolute,bin});
      try{
        const snapshot=await snapshotPackage(f.root);
        assert.ok(!snapshot.entries.some(e=>/SyntheticPersonal|synthetic-personal|synthetic-host/.test(e.path)),'absolute declaration became a tree node');
        const sourceId='manifest:/main';
        const report:PackReport={schemaVersion:1,profile:runtimeProfile(),snapshot,entries:structuredClone(snapshot.entries),ruleSources:[{sourceId,kind:'manifest',path:'package.json',jsonPointer:'/main',...snapshot.manifestLocations['/main'],text:absolute}],evidence:[{evidenceId:'unsafe',path:'package.json',evaluationOrder:0,ruleId:'strict/0',candidateSources:[sourceId],pattern:'!/'+absolute,matched:true,before:false,after:true,changed:true,ancestorChain:[],sourceMapping:'exact',basis:'synthetic',decision:'forced_include'}],diagnostics:[],complete:false,scenario:{scenarioId:'synthetic',baseSnapshotId:snapshot.snapshotId,revision:0,oracleFiles:[],tracedFiles:[],reconciliation:{status:'unavailable',missing:[],extra:[]},aggregate:{rawBytes:'0',fileCount:0},assertions:[]}};
        if(typeof bin!=='string') {
          const pointer='/bin/'+absolute.replaceAll('~','~0').replaceAll('/','~1');
          const binSourceId='manifest:'+pointer;report.ruleSources.push({sourceId:binSourceId,kind:'manifest',path:'package.json',jsonPointer:pointer,...snapshot.manifestLocations[pointer],text:'dist/private-cli.js'});report.evidence[0].candidateSources.push(binSourceId);
        }
        for(const options of [{},{omitRuleText:true}]) {
          const projected=toPublicReport(report,options),text=JSON.stringify(projected);
          assert.ok(!text.includes('SyntheticPersonal') && !text.includes('synthetic-personal') && !text.includes('synthetic-host'),'absolute manifest value leaked');
          assert.equal(projected.snapshot.manifest.main,undefined);assert.equal(projected.snapshot.manifest.browser,undefined);
          if(typeof bin==='string')assert.equal(projected.snapshot.manifest.bin,undefined);
          else assert.deepEqual(projected.snapshot.manifest.bin,{safe:'dist/cli.js'});
          assert.equal(projected.ruleSources[0].jsonPointer,'/main');assert.equal(projected.ruleSources[0].line,snapshot.manifestLocations['/main'].line);
        }
      }finally{await f.cleanup();}
    }
  }
  const f=await fixture({},{main:'./dist/index.js',browser:'dist/browser.js',bin:{safe:'dist/cli.js'}});
  try{
    const snapshot=await snapshotPackage(f.root);
    const r:PackReport={schemaVersion:1,profile:runtimeProfile(),snapshot,entries:[],evidence:[],ruleSources:[],diagnostics:[],complete:false,scenario:{scenarioId:'synthetic',baseSnapshotId:snapshot.snapshotId,revision:0,oracleFiles:[],tracedFiles:[],reconciliation:{status:'unavailable',missing:[],extra:[]},aggregate:{rawBytes:'0',fileCount:0},assertions:[]}};
    r.ruleSources=[{sourceId:'.npmignore:1',kind:'npmignore',path:'.npmignore',line:1,column:1,text:'/dist/*.css'}];
    r.evidence=[{evidenceId:'relative',path:'dist/a.css',evaluationOrder:0,ruleId:'ignore/0',candidateSources:['.npmignore:1'],pattern:'/dist/*.css',matched:true,before:true,after:false,changed:true,ancestorChain:[],sourceMapping:'exact',basis:'synthetic',decision:'match'}];
    for(const options of [{},{omitRuleText:true}]){const p=toPublicReport(r,options);assert.deepEqual(p.snapshot.manifest,{main:'./dist/index.js',browser:'dist/browser.js',bin:{safe:'dist/cli.js'}});assert.equal(p.snapshot.manifestLocations['/bin/safe'].line,snapshot.manifestLocations['/bin/safe'].line);if(!('omitRuleText' in options)){assert.equal(p.ruleSources[0].text,'/dist/*.css');assert.equal(p.evidence[0].pattern,'/dist/*.css');}}
    const absoluteRoot=structuredClone(snapshot);absoluteRoot.manifest.main='/dist';r.snapshot=absoluteRoot;
    r.ruleSources[0].path='sub/dist/.npmignore';
    const anchored=toPublicReport(r);assert.equal(anchored.snapshot.manifest.main,undefined);
    assert.equal(anchored.ruleSources[0]?.text,'/dist/*.css','root-anchored ignore was treated as an absolute manifest path');
    assert.equal(anchored.ruleSources[0]?.path,'sub/dist/.npmignore');assert.equal(anchored.evidence[0].pattern,'/dist/*.css');
    absoluteRoot.manifest.main='dist/app:entry.js';assert.equal(toPublicReport(r).snapshot.manifest.main,'dist/app:entry.js');
  }finally{await f.cleanup();}
});

test('I1 normalized bin key and UNC target hide unmapped evidence and manifest rule text without oracle',async()=>{
  const {toPublicReport}=await import('../src/serialization.ts');
  const arboristRequire=createRequire(profileRequire.resolve('@npmcli/arborist'));
  const packageRequire=createRequire(arboristRequire.resolve('@npmcli/package-json'));
  const normalizeBin=packageRequire('npm-normalize-package-bin');
  const bin={'nested/synthetic-cli':'\\\\synthetic-host\\private\\entry.js',safe:'dist/cli.js'};
  const normalized=normalizeBin({bin:structuredClone(bin)}).bin;
  assert.deepEqual(normalized,{'synthetic-cli':'synthetic-host/private/entry.js',safe:'dist/cli.js'});
  const pattern='!/'+normalized['synthetic-cli'];
  const f=await fixture({},{bin,files:['dist']});
  try{
    const snapshot=await snapshotPackage(f.root);
    const unknownId='manifest:normalized-bin',safeId='manifest:/bin/safe',ignoreId='.npmignore:1';
    const report:PackReport={schemaVersion:1,profile:runtimeProfile(),snapshot,entries:structuredClone(snapshot.entries),ruleSources:[
      {sourceId:unknownId,kind:'manifest',path:'package.json',jsonPointer:'/bin/synthetic-cli',text:pattern},
      {sourceId:safeId,kind:'manifest',path:'package.json',jsonPointer:'/bin/safe',...snapshot.manifestLocations['/bin/safe'],text:'dist/cli.js'},
      {sourceId:ignoreId,kind:'npmignore',path:'.npmignore',line:1,column:1,text:'/synthetic-host/private/entry.js'},
      {sourceId:'manifest:/files/0',kind:'files',path:'package.json',jsonPointer:'/files/0',text:'dist'},
    ],evidence:[],diagnostics:[],complete:false,scenario:{scenarioId:'synthetic',baseSnapshotId:snapshot.snapshotId,revision:0,oracleFiles:[],tracedFiles:[],reconciliation:{status:'unavailable',missing:[],extra:[]},aggregate:{rawBytes:'0',fileCount:0},assertions:[]}};
    for(const [index,candidateSources,value] of [[0,[],pattern],[1,[unknownId],pattern],[2,[safeId],'!/dist/cli.js'],[3,[ignoreId],'/synthetic-host/private/entry.js']] as const)report.evidence.push({evidenceId:String(index),path:'package.json',evaluationOrder:index,ruleId:'strict/'+index,candidateSources:[...candidateSources],pattern:value,matched:true,before:false,after:true,changed:true,ancestorChain:[],sourceMapping:index<2?'unknown':'exact',basis:'synthetic',decision:'forced_include'});
    for(const options of [{},{omitRuleText:true}]){
      const projected=toPublicReport(report,options);
      assert.deepEqual(projected.snapshot.manifest.bin,{safe:'dist/cli.js'});
      assert.equal(projected.evidence[0].pattern,undefined,'unmapped normalized private bin pattern leaked');
      assert.equal(projected.evidence[1].pattern,undefined,'unknown manifest provenance leaked');
      assert.equal(projected.ruleSources.find(s=>s.sourceId===unknownId)?.text,undefined,'normalized manifest rule text leaked');
      assert.equal(projected.ruleSources.find(s=>s.sourceId===safeId)?.jsonPointer,'/bin/safe');
      assert.equal(projected.ruleSources.find(s=>s.sourceId===safeId)?.line,snapshot.manifestLocations['/bin/safe'].line);
      if(!('omitRuleText' in options)){
        assert.equal(projected.evidence[2].pattern,'!/dist/cli.js');
        assert.equal(projected.ruleSources.find(s=>s.sourceId===safeId)?.text,'dist/cli.js');
        assert.equal(projected.evidence[3].pattern,'/synthetic-host/private/entry.js');
        assert.equal(projected.ruleSources.find(s=>s.sourceId===ignoreId)?.text,'/synthetic-host/private/entry.js');
        assert.equal(projected.ruleSources.find(s=>s.kind==='files')?.text,'dist');
      }
    }
    assert.deepEqual(snapshot.manifest.bin,bin,'normalization mutated the source snapshot');
  }finally{await f.cleanup();}
});

test('I2 CLI analyze and intent share the original request deadline',async()=>{
  const {runCli}=await api();const f=await fixture({'a.js':'a'}),controls=await fixture({'intent.json':JSON.stringify({schemaVersion:1,mustShip:['a.js']})});
  let out='',err='';
  try{
    const result=await expireBeforeIntent(30_000,()=>runCli(['analyze',f.root,'--intent',join(controls.root,'intent.json'),'--json'],{stdout:s=>out+=s,stderr:s=>err+=s}));
    assert.equal(result.expired,true);assert.equal(result.value,2,'intent renewed a consumed request budget');
    const report=JSON.parse(out);assert.equal(report.complete,false);assert.ok(report.diagnostics.some((d:any)=>d.code==='LIMIT_EXCEEDED'));assert.ok(!report.scenario.assertions.some((a:any)=>a.status==='pass'));
  }finally{await controls.cleanup();await f.cleanup();}
});

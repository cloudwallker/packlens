import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, expireBeforeIntent } from './helpers.ts';
import { snapshotPackage } from '../src/snapshot.ts';
import { snapshotContext } from '../src/snapshot.ts';
import { analyzeSnapshot } from '../src/analyze.ts';

const api = async () => {
  const module = await import('../src/scenario.ts').catch(() => undefined);
  assert.ok(module, 'missing scenario implementation');
  return module;
};

test('remove baseline CSS line ships 2048 bytes and leaves every source unchanged', async () => {
  const f = await fixture({ 'dist/.npmignore': '# assets\r\n*.css\r\n', 'dist/style.css': Buffer.alloc(2048), 'dist/index.js':'code' }, { files:['dist'] });
  try {
    const { simulate } = await api(); const snapshot = await snapshotPackage(f.root);
    const before = await Promise.all(['package.json','dist/.npmignore','dist/style.css','dist/index.js'].map(p => readFile(join(f.root,p))));
    const report = await simulate(snapshot, { schemaVersion:1, operations:[{op:'removeIgnoreLine',path:'dist/.npmignore',line:2,expected:'*.css'}] }, {schemaVersion:1,mustShip:['dist/style.css']});
    assert.ok(report.scenario.oracleFiles.includes('dist/style.css'));
    assert.equal(report.scenario.assertions[0].status,'pass');
    assert.equal(report.scenario.delta?.addedRawBytes,'2048');
    assert.equal(report.snapshot.ruleSources[0].text,'# assets\r\n');
    assert.ok(Object.isFrozen(report.snapshot.manifest));
    assert.deepEqual(await Promise.all(['package.json','dist/.npmignore','dist/style.css','dist/index.js'].map(p => readFile(join(f.root,p)))),before);
    await writeFile(join(f.root,'dist/.npmignore'),'changed');
    assert.equal((await analyzeSnapshot(report.snapshot)).entries.find(e=>e.path==='dist/style.css')?.membershipValidity,'stale');
  } finally { await f.cleanup(); }
});

test('batch physical lines are atomic with baseline expected and revision validation', async () => {
  const f = await fixture({'.npmignore':'# first\r\na.js\r\nb.js\r\nc.js\r\n','a.js':'a','b.js':'b','c.js':'c'});
  try {
    const {applyPatch} = await api(); const base=await snapshotPackage(f.root);
    const patch={schemaVersion:1 as const,baseSnapshotId:base.snapshotId,expectedRevision:0,operations:[{op:'removeIgnoreLine' as const,path:'.npmignore',line:2,expected:'a.js'},{op:'replaceIgnoreLine' as const,path:'.npmignore',line:4,expected:'c.js',value:'d.js'}]};
    assert.equal(applyPatch(base,patch).ruleSources[0].text,'# first\r\nb.js\r\nd.js\r\n');
    assert.throws(()=>applyPatch(base,{...patch,expectedRevision:1}),/REVISION_MISMATCH/);
    assert.throws(()=>applyPatch(base,{...patch,baseSnapshotId:'wrong'}),/SNAPSHOT_MISMATCH/);
    assert.throws(()=>applyPatch(base,{...patch,operations:[patch.operations[0],{...patch.operations[1],expected:'wrong'}]}),/EXPECTED_MISMATCH/);
    assert.throws(()=>applyPatch(base,{...patch,operations:[patch.operations[0],patch.operations[0]]}),/AMBIGUOUS_PATCH/);
    assert.equal(base.ruleSources[0].text,'# first\r\na.js\r\nb.js\r\nc.js\r\n');
  } finally {await f.cleanup();}
});

test('create/delete ignore changes virtual entries and reveals gitignore after deletion', async () => {
  const f=await fixture({'.gitignore':'a.js\n','a.js':'a','b.js':'bb'});
  try {
    const {applyPatch}=await api(); const base=await snapshotPackage(f.root);
    const made=applyPatch(base,{schemaVersion:1,operations:[{op:'createIgnore',path:'.npmignore',value:'b.js\n'}]});
    assert.equal(made.entries.find(e=>e.path==='.npmignore')?.rawBytes,'5');
    assert.ok((await analyzeSnapshot(made)).scenario.oracleFiles.includes('a.js'));
    const deleted=applyPatch(made,{schemaVersion:1,operations:[{op:'deleteIgnore',path:'.npmignore',expected:'b.js\n'}]});
    assert.equal(deleted.entries.find(e=>e.path==='.npmignore')?.exists,false);
    assert.ok(!(await analyzeSnapshot(deleted)).scenario.oracleFiles.includes('a.js'));
    assert.throws(()=>applyPatch(base,{schemaVersion:1,operations:[{op:'createIgnore',path:'../.npmignore',value:''}]}),/OUTSIDE_ROOT/);
  }finally{await f.cleanup();}
});

test('replaceFiles preserves unrelated original text and accounts UTF-8 retained bytes',async()=>{
  const original='{\r\n  "name": "合成",\r\n  "files": ["a.js"],\r\n  "version": "1.0.0", "description": "do not rewrite"\r\n}\r\n';
  const f=await fixture({'package.json':original,'a.js':'a','模板/x.html':'abc'});
  try{
    const {simulate}=await api();const base=await snapshotPackage(f.root);
    const result=await simulate(base,{schemaVersion:1,operations:[{op:'replaceFiles',expected:['a.js'],value:['a.js','模板']} ]});
    const expected=original.replace('["a.js"]','["a.js","模板"]');
    assert.equal(result.snapshot.manifestText,expected);
    assert.equal(result.snapshot.entries.find(e=>e.path==='package.json')?.rawBytes,String(Buffer.byteLength(expected)));
    assert.equal(result.snapshot.manifestLocations['/files/1'].line,3);
    assert.deepEqual(result.scenario.delta?.retainedContentByteChanges,[{path:'package.json',beforeRawBytes:String(Buffer.byteLength(original)),afterRawBytes:String(Buffer.byteLength(expected)),deltaRawBytes:'9'}]);
    assert.equal(result.scenario.delta?.addedRawBytes,'3');assert.equal(result.scenario.delta?.netRawBytes,'12');
  }finally{await f.cleanup();}
});

test('scenario session undo/reset use increasing revision and reject failed state changes',async()=>{
  const f=await fixture({'.npmignore':'a.js\n','a.js':'a'});
  try{
    const {createScenarioSession}=await api();const session=await createScenarioSession(await snapshotPackage(f.root));
    const changed=await session.apply({schemaVersion:1,expectedRevision:0,operations:[{op:'removeIgnoreLine',path:'.npmignore',line:1,expected:'a.js'}]});
    assert.equal(changed.scenario.revision,1);assert.ok(changed.scenario.oracleFiles.includes('a.js'));
    await assert.rejects(session.apply({schemaVersion:1,expectedRevision:0,operations:[]}),/REVISION_MISMATCH/);
    assert.equal(session.report.scenario.revision,1);
    const undo=await session.undo(1);assert.equal(undo.scenario.revision,2);assert.ok(!undo.scenario.oracleFiles.includes('a.js'));
    await session.apply({schemaVersion:1,expectedRevision:2,operations:[{op:'appendIgnoreLine',path:'.npmignore',value:'b.js'}]});
    const reset=await session.reset(3);assert.equal(reset.scenario.revision,4);assert.equal(reset.snapshot.ruleSources[0].text,'a.js\n');
  }finally{await f.cleanup();}
});

test('files edits refresh exact missing declarations and track virtual provenance across revisions',async()=>{
  const f=await fixture({'.npmignore':'# comment\n','a.js':'a'},{files:['old.js']});
  try{
    const {applyPatch}=await api();let snapshot=applyPatch(await snapshotPackage(f.root),{schemaVersion:1,operations:[{op:'replaceFiles',value:['a.js','new.js','none/**']}]});
    assert.ok(snapshot.entries.some(e=>e.path==='new.js' && !e.exists));
    assert.ok(!snapshot.entries.some(e=>e.path==='old.js'));
    assert.ok(!snapshot.entries.some(e=>e.path==='none/**'));
    snapshot=applyPatch(snapshot,{schemaVersion:1,operations:[{op:'appendIgnoreLine',path:'.npmignore',value:'b.js'}]});
    const report=await analyzeSnapshot(snapshot);
    assert.equal(report.ruleSources.find(s=>s.kind==='files' && s.jsonPointer==='/files/0')?.virtualRevision,1);
  }finally{await f.cleanup();}
});

test('replacing absent files preserves original other fields and guards virtual resource limits',async()=>{
  const f=await fixture({'package.json':'{\r\n "name": "synthetic", "version": "1.0.0"\r\n}\r\n','a.js':'a'});
  try{
    const {applyPatch}=await api();const base=await snapshotPackage(f.root);
    const next=applyPatch(base,{schemaVersion:1,operations:[{op:'replaceFiles',expected:null,value:['a.js']}]});
    assert.ok(next.manifestText.startsWith('{\r\n "name": "synthetic", "version": "1.0.0"\r\n'));assert.deepEqual(next.manifest.files,['a.js']);
    assert.throws(()=>applyPatch(base,{schemaVersion:1,operations:[{op:'createIgnore',path:'.npmignore',value:'x'.repeat(1024*1024+1)}]}),/LIMIT_EXCEEDED/);
    for(const value of ['!!../outside','!!!/outside','C:/outside'])assert.throws(()=>applyPatch(base,{schemaVersion:1,operations:[{op:'replaceFiles',value:[value]}]}),/OUTSIDE_ROOT/);
    assert.throws(()=>applyPatch(base,{schemaVersion:1,operations:[{op:'replaceIgnoreText',path:'node_modules/.npmignore',value:'x'}]}),/IGNORE_PARENT_UNAVAILABLE/);
  }finally{await f.cleanup();}
});

test('incomplete session analysis returns protected result without replacing previous state',async()=>{
  const f=await fixture({'.npmignore':'a.js\n','a.js':'a'});
  try{
    const {createScenarioSession}=await api();const session=await createScenarioSession(await snapshotPackage(f.root));
    await writeFile(join(f.root,'a.js'),'changed-size');
    const failed=await session.apply({schemaVersion:1,expectedRevision:0,operations:[{op:'appendIgnoreLine',path:'.npmignore',value:'b.js'}]});
    assert.equal(failed.complete,false);assert.equal(session.report.scenario.revision,0);assert.equal(session.report.snapshot.ruleSources[0].text,'a.js\n');
  }finally{await f.cleanup();}
});

test('caller deadline bounds the entire simulation while old capture time does not expire new work',async()=>{
  const f=await fixture({'a.js':'a'});
  try{
    const {simulate}=await api();const base=await snapshotPackage(f.root);
    snapshotContext(base)!.started=0;
    assert.equal((await analyzeSnapshot(base)).complete,true);
    const report=await simulate(base,{schemaVersion:1,operations:[]},undefined,{deadline:Date.now()-1});
    assert.equal(report.complete,false);assert.ok(report.diagnostics.some(d=>d.code==='LIMIT_EXCEEDED'));
  }finally{await f.cleanup();}
});

test('brace-expanded files root escapes are rejected before any oracle call',async()=>{
  const f=await fixture({'inside.js':'a'});
  try{
    const {applyPatch}=await api();const base=await snapshotPackage(f.root);
    for(const value of ['{../outside.js,inside.js}','{safe,../outside}/x.js','{.,x}./outside.js','{!!../outside.js,inside.js}','{/outside.js,inside.js}']) {
      assert.throws(()=>applyPatch(base,{schemaVersion:1,operations:[{op:'replaceFiles',value:[value]}]}),/OUTSIDE_ROOT/,value);
      await writeFile(join(f.root,'package.json'),JSON.stringify({name:'synthetic',version:'1.0.0',files:[value]}));
      await assert.rejects(snapshotPackage(f.root),/OUTSIDE_ROOT/,value);
    }
    await writeFile(join(f.root,'package.json'),JSON.stringify({name:'synthetic',version:'1.0.0',files:['{inside,other}.js']}));
    assert.deepEqual((await snapshotPackage(f.root)).uncoveredInputs,[]);
  }finally{await f.cleanup();}
});

test('snapshot alone rejects brace-expanded root branches before oracle',async()=>{
  const f=await fixture({'inside.js':'a'},{files:['{../outside.js,inside.js}']});
  try{await assert.rejects(snapshotPackage(f.root),/OUTSIDE_ROOT/);}finally{await f.cleanup();}
});

test('session seeded with derived snapshot retains original base identity through reset',async()=>{
  const f=await fixture({'.npmignore':'a.js\n','a.js':'a'});
  try{
    const {applyPatch,createScenarioSession}=await api();const base=await snapshotPackage(f.root);
    const derived=applyPatch(base,{schemaVersion:1,operations:[{op:'appendIgnoreLine',path:'.npmignore',value:'b.js'}]});
    const session=await createScenarioSession(derived);await session.reset(1);
    assert.equal(session.report.scenario.baseSnapshotId,base.snapshotId);
    assert.equal(session.report.snapshot.baseSnapshotId,base.snapshotId);
    await session.apply({schemaVersion:1,baseSnapshotId:base.snapshotId,expectedRevision:2,operations:[]});
  }finally{await f.cleanup();}
});

test('I2 session initialization does not renew a budget consumed before intent',async()=>{
  const {createScenarioSession}=await api();const f=await fixture({'a.js':'a'});
  try{
    const snapshot=await snapshotPackage(f.root);
    const {value:session,expired}=await expireBeforeIntent(snapshot.limits.timeoutMs,()=>createScenarioSession(snapshot,{schemaVersion:1,mustShip:['a.js']}));
    assert.equal(expired,true);assert.equal(session.report.complete,false,'session initialization renewed its request budget');
    assert.ok(session.report.diagnostics.some(d=>d.code==='LIMIT_EXCEEDED'));assert.ok(!session.report.scenario.assertions.some(a=>a.status==='pass'));
  }finally{await f.cleanup();}
});

test('I2 session patch construction consumes the same deadline as analysis',async()=>{
  const {createScenarioSession}=await api();const f=await fixture({'a.js':'a'});
  try{
    const session=await createScenarioSession(await snapshotPackage(f.root));const original=Date.now;let clock=original(),consumed=false;
    const patch={get schemaVersion(){if(!consumed){consumed=true;clock+=30_001;}return 1 as const;},expectedRevision:0,operations:[]};
    Date.now=()=>clock;
    try{
      const result=await session.apply(patch);assert.equal(consumed,true);assert.equal(result.complete,false,'patch construction received a fresh analysis budget');
      assert.ok(result.diagnostics.some(d=>d.code==='LIMIT_EXCEEDED'));assert.equal(session.report.scenario.revision,0);
    }finally{Date.now=original;}
  }finally{await f.cleanup();}
});

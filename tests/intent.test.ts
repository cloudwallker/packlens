import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { analyzePackage } from '../src/analyze.ts';
const api=async()=>{const m=await import('../src/intent.ts').catch(()=>undefined);assert.ok(m,'missing intent implementation');return m;};
test('mustShip rejects zero glob and exact missing; notShip overlap and dedup budget',async()=>{
  const f=await fixture({'dist/a.js':'123','dist/b.css':'45','tests/t.js':'x'},{files:['dist']});
  try{
    const {evaluateIntent}=await api();const report=await analyzePackage(f.root);
    const results=evaluateIntent(report,{schemaVersion:1,mustShip:['none/**','missing.js','dist/*'],mustNotShip:['dist/**','absent/**'],sizeBudget:{maxRawBytes:'5',include:['dist/**','dist/a.js']}});
    assert.deepEqual(results.map(x=>x.status),['fail','fail','pass','fail','pass','pass']);
    assert.ok(results[0].reasonCodes.includes('NO_MATCH'));
    assert.equal(report.entries.find(e=>e.path==='missing.js')?.membership,'missing');
    assert.equal(results[5].bytesActual,'5');
    assert.ok(results[2].reasonCodes.includes('INTENT_CONFLICT'));
    assert.equal(evaluateIntent(report,{schemaVersion:1,sizeBudget:{maxRawBytes:'4',include:['dist/**']}})[0].status,'fail');
    assert.ok(evaluateIntent(report,{schemaVersion:1,sizeBudget:{maxRawBytes:'0',include:['none/**']}})[0].reasonCodes.includes('EMPTY_BUDGET_SCOPE'));
  }finally{await f.cleanup();}
});
test('protected unknown overrides known failure and exact BigInt budgets stay exact',async()=>{
  const f=await fixture({'a.js':'x'},{workspaces:['packages/*']});
  try{
    const {evaluateIntent}=await api();const report=await analyzePackage(f.root);
    assert.deepEqual(evaluateIntent(report,{schemaVersion:1,mustShip:['missing.js'],mustNotShip:['**/*'],sizeBudget:{maxRawBytes:'0'}}).map(r=>r.status),['unknown','unknown','unknown']);
    const copy=structuredClone(report);copy.complete=true;copy.scenario.reconciliation.status='equal';copy.snapshot.complete=true;copy.snapshot.uncoveredInputs=[];
    copy.entries=[{path:'large.bin',kind:'file',exists:true,rawBytes:'9007199254740993',membership:'included',membershipValidity:'verified_packlist',explanationStatus:'unknown',evidenceIds:[]}];copy.scenario.oracleFiles=['large.bin'];
    assert.equal(evaluateIntent(copy,{schemaVersion:1,sizeBudget:{maxRawBytes:'9007199254740993'}})[0].status,'pass');
    assert.equal(evaluateIntent(copy,{schemaVersion:1,sizeBudget:{maxRawBytes:'9007199254740992'}})[0].status,'fail');
  }finally{await f.cleanup();}
});
test('small intent grammar rejects unsupported syntax and matches root/nested ** distinctly',async()=>{
  const {matchesSelector,validateIntent}=await api();
  assert.equal(matchesSelector('**/*.css','a.css'),true);assert.equal(matchesSelector('*.css','dist/a.css'),false);
  assert.equal(matchesSelector('dist/?.css','dist/a.css'),true);assert.equal(matchesSelector('dist/**','dist/deep/a.css'),true);
  for(const selector of ['!a','../a','/a','C:/a','a\\b','a[bc]','a{b,c}','@(a)','a/**x'])assert.throws(()=>validateIntent({schemaVersion:1,mustShip:[selector]}),/INVALID_SELECTOR/);
  for(const maxRawBytes of ['-1','1.2','1e3',1])assert.throws(()=>validateIntent({schemaVersion:1,sizeBudget:{maxRawBytes}}),/INVALID_INTENT/);
});

test('missing official entry bytes keep budget unknown instead of undercounting',async()=>{
  const f=await fixture({'a.js':'abc'});
  try{
    const {evaluateIntent}=await api();const r=await analyzePackage(f.root);r.entries=r.entries.filter(e=>e.path!=='a.js');
    const results=evaluateIntent(r,{schemaVersion:1,sizeBudget:{maxRawBytes:'999'}});
    assert.equal(results[0].status,'unknown');assert.ok(results[0].reasonCodes.includes('BYTES_UNAVAILABLE'));
    const [onlyA] = evaluateIntent(r,{schemaVersion:1,sizeBudget:{maxRawBytes:'999',include:['a.js']}});
    assert.deepEqual(onlyA.matchedExistingPaths, []);
    assert.deepEqual(onlyA.matchedShippedPaths, ['a.js']);
    assert.ok(!onlyA.reasonCodes.includes('EMPTY_BUDGET_SCOPE'));
    const [withoutA] = evaluateIntent(r,{schemaVersion:1,sizeBudget:{maxRawBytes:'999',exclude:['a.js']}});
    assert.equal(withoutA.status, 'pass');
  }finally{await f.cleanup();}
});

test('budget scope distinguishes local matches from shipped files and applies exclusions last', async () => {
  const f = await fixture({'dist/app.js':'abc', 'dist/app.js.map':'12345', 'dist/local.txt':'draft'},
    {files:['dist/app.js', 'dist/app.js.map']});
  try {
    const {evaluateIntent, validateIntent} = await api();
    const report = await analyzePackage(f.root);
    const sizeBudget = {maxRawBytes:'8', include:['dist/**']};
    const [all] = evaluateIntent(report, {schemaVersion:1, sizeBudget});
    assert.deepEqual(all.matchedExistingPaths, ['dist/app.js', 'dist/app.js.map', 'dist/local.txt']);
    assert.deepEqual(all.matchedShippedPaths, ['dist/app.js', 'dist/app.js.map']);
    assert.equal(all.bytesActual, '8');
    const [scripts] = evaluateIntent(report, {schemaVersion:1, sizeBudget:{...sizeBudget,
      maxRawBytes:'3', include:['dist/**', 'dist/app.js.map'], exclude:['**/*.map']}});
    assert.deepEqual(scripts.matchedExistingPaths, ['dist/app.js', 'dist/local.txt']);
    assert.deepEqual(scripts.matchedShippedPaths, ['dist/app.js']);
    assert.deepEqual(scripts.excludedSelectors, ['**/*.map']);
    assert.equal(scripts.bytesActual, '3');
    assert.equal(scripts.status, 'pass');
    const [empty] = evaluateIntent(report, {schemaVersion:1, sizeBudget:{maxRawBytes:'0', exclude:['**']}});
    assert.equal(empty.bytesActual, '0');
    assert.ok(empty.reasonCodes.includes('EMPTY_BUDGET_SCOPE'));
    assert.throws(() => validateIntent({schemaVersion:1, sizeBudget:{maxRawBytes:'0', exclude:'*.map'}}), /INVALID_INTENT/);
    assert.throws(() => validateIntent({schemaVersion:1, sizeBudget:{maxRawBytes:'0', exclude:['dir//file']}}), /INVALID_SELECTOR/);
  } finally { await f.cleanup(); }
});

test('intent evaluation observes caller deadline before returning any partial passing rows',async()=>{
  const f=await fixture({'a.js':'a'});
  try{
    const {evaluateIntent}=await api();const r=await analyzePackage(f.root);
    assert.throws(()=>evaluateIntent(r,{schemaVersion:1,mustShip:['a.js']},{deadline:Date.now()-1}),/LIMIT_EXCEEDED/);
  }finally{await f.cleanup();}
});

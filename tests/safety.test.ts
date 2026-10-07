import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from './helpers.ts';
import { snapshotPackage, inside, deriveSnapshot } from '../src/snapshot.ts';
import { analyzePackage, analyzeSnapshot } from '../src/analyze.ts';
import { traceFiles } from '../src/trace.ts';
import { officialFiles } from '../src/oracle.ts';
import { profileMatches, runtimeProfile } from '../src/profile.ts';
import { withShadow } from '../src/oracle.ts';

test('missing explicit manifest references are missing, not invented glob results', async () => {
  const f = await fixture({}, { main:'absent.js', files:['missing.txt','absent/**/*.css'] });
  try {
    const r = await analyzePackage(f.root);
    assert.equal(r.entries.find(e => e.path === 'absent.js')?.membership, 'missing');
    assert.equal(r.entries.find(e => e.path === 'missing.txt')?.membership, 'missing');
    assert.ok(!r.entries.some(e => e.path.includes('*')));
  } finally { await f.cleanup(); }
});

test('lost manifest source positions downgrade explanation while keeping membership', async () => {
  const f = await fixture({ 'a.js':'a' }, { files:['a.js'] });
  try {
    const s = structuredClone(await snapshotPackage(f.root));
    s.manifestLocations = {};
    const r = await analyzeSnapshot(s);
    const a = r.entries.find(e => e.path === 'a.js')!;
    assert.equal(a.membership, 'included');
    assert.equal(a.explanationStatus, 'unknown');
  } finally { await f.cleanup(); }
});

test('wrong source line cannot become confirmed just because collections agree', async () => {
  const f = await fixture({'a.js':'a'},{files:['a.js']});
  try { const s=structuredClone(await snapshotPackage(f.root)); s.manifestLocations['/files/0'].line=99; const r=await analyzeSnapshot(s); assert.equal(r.scenario.reconciliation.status,'equal'); assert.equal(r.entries.find(e=>e.path==='a.js')?.explanationStatus,'unknown'); }
  finally { await f.cleanup(); }
});

test('collection disagreement preserves official files and marks evidence conflict', async () => {
  const api = await import('../src/analyze.ts');
  assert.ok(api.reconcileSnapshot,'missing explicit reconciliation gate');
  const f=await fixture({'a.js':'a'});
  try { const s=await snapshotPackage(f.root); await withShadow(s,async root=>{ const files=await officialFiles(root,s); const trace=await traceFiles(root,s); trace.files=trace.files.filter(p=>p!=='a.js'); const r=api.reconcileSnapshot(s,files,trace,'verified_packlist'); assert.deepEqual(files,['a.js','package.json']); assert.deepEqual(r.reconciliation.missing,['a.js']); assert.equal(r.entries.find(e=>e.path==='a.js')?.membership,'included'); assert.equal(r.entries.find(e=>e.path==='a.js')?.explanationStatus,'conflict'); }); }
  finally { await f.cleanup(); }
});

test('derived virtual rules preserve baseline fingerprints while actual source edits become stale', async () => {
  const f=await fixture({'a.css':'a','.npmignore':'*.css\n'});
  try { const base=await snapshotPackage(f.root); const clone=structuredClone(base); clone.ruleSources.find(s=>s.path==='.npmignore')!.text=''; clone.baseSnapshotId=base.snapshotId; clone.revision=1; const derived=deriveSnapshot(base,clone); const preview=await analyzeSnapshot(derived); assert.equal(preview.entries.find(e=>e.path==='a.css')?.membership,'included'); assert.equal(preview.scenario.baseSnapshotId,base.snapshotId); assert.equal(preview.scenario.revision,1); await fs.writeFile(join(f.root,'.npmignore'),'changed\n'); const changed=await analyzeSnapshot(derived); assert.ok(changed.entries.every(e=>e.membershipValidity==='stale')); }
  finally { await f.cleanup(); }
});

test('unverified complex files syntax is uncovered', async () => {
  const f = await fixture({ 'a.js':'a' }, { files:['@(a|b).js'] });
  try { const r = await analyzePackage(f.root); assert.equal(r.complete, false); assert.equal(r.entries.find(e => e.path === 'a.js')?.membership, 'unknown'); assert.ok(r.snapshot.uncoveredInputs.includes('FILES_SYNTAX_UNCOVERED')); }
  finally { await f.cleanup(); }
});

test('npm extension hooks and normalized bundle aliases remain uncovered', async () => {
  for (const [files, manifest] of [ [{ '.npm-extension.mjs':'throw Error("must never run")' }, {}], [{}, { bundledDependencies:['alpha'] }], [{}, { workspaces:[] }], [{}, { dependencies:{alpha:'workspace:*'} }], [{}, { browser:{'a.js':'b.js'} }] ] as [Record<string,string>,object][]) {
    const f = await fixture(files, manifest);
    try { const r = await analyzePackage(f.root); assert.equal(r.complete, false); assert.ok(r.entries.every(e => e.membership === 'unknown')); }
    finally { await f.cleanup(); }
  }
});

test('links and Windows junctions are detected without following targets', async () => {
  const outside = await fixture({ 'target.txt':'do not scan' }); const f = await fixture({});
  try { await fs.symlink(outside.root, join(f.root,'linked'), process.platform === 'win32' ? 'junction' : 'dir'); const r = await analyzePackage(f.root); assert.equal(r.complete, false); assert.equal(r.entries.find(e => e.path === 'linked')?.kind, 'link'); assert.ok(!r.entries.some(e => e.path === 'linked/target.txt')); assert.ok(r.entries.every(e => e.membership === 'unknown')); }
  finally { await f.cleanup(); await outside.cleanup(); }
});

test('node, depth, per-rule, total-rule and time limits never pass truncated scans', async () => {
  for (const limits of [{maxNodes:1},{maxDepth:1},{maxRuleBytes:1},{maxTotalRuleBytes:1},{timeoutMs:0}]) {
    const f = await fixture({ 'deep/nested/a.js':'a', '.npmignore':'synthetic-long-rule\n' });
    try { const s = await snapshotPackage(f.root,{limits}); const r = await analyzeSnapshot(s); assert.equal(r.complete,false); assert.ok(r.diagnostics.some(d => d.code === 'LIMIT_EXCEEDED')); assert.ok(r.entries.every(e => e.membership === 'unknown')); }
    finally { await f.cleanup(); }
  }
});

test('scanning mutation and later snapshot mutation produce stale membership', async () => {
  const f = await fixture({ 'a.js':'a' });
  try {
    const during = await snapshotPackage(f.root, { onEntry: async path => { if(path === 'a.js') await fs.writeFile(join(f.root,'a.js'), 'changed'); } });
    const r = await analyzeSnapshot(during); assert.ok(r.entries.every(e => e.membershipValidity === 'stale'));
    const s = await snapshotPackage(f.root); await fs.writeFile(join(f.root,'new.js'),'new'); const after = await analyzeSnapshot(s); assert.ok(after.entries.every(e => e.membershipValidity === 'stale'));
    assert.ok(after.diagnostics.some(d => d.code === 'STALE'));
  } finally { await f.cleanup(); }
});

test('directory-to-junction scan race does not read out-of-root whitelist bodies', async () => {
  const outside = await fixture({ '.npmignore':'OUTSIDE-SYNTHETIC-BODY\n' }); const f = await fixture({ 'folder/a.js':'a' });
  try {
    const s = await snapshotPackage(f.root,{onEntry:async path => { if(path !== 'folder') return; const dir = join(f.root,path); assert.ok(inside(f.root,dir)); await fs.rm(dir,{recursive:true}); await fs.symlink(outside.root,dir,process.platform === 'win32'?'junction':'dir'); }});
    assert.ok(!JSON.stringify(s).includes('OUTSIDE-SYNTHETIC-BODY'));
    const r = await analyzeSnapshot(s); assert.equal(r.complete,false); assert.ok(r.entries.every(e => e.membership === 'unknown'));
  } finally { await f.cleanup(); await outside.cleanup(); }
});

test('snapshot records are immutable and cannot increase hard resource ceilings', async () => {
  const f = await fixture({'a.js':'a'});
  try { const s = await snapshotPackage(f.root); assert.throws(() => s.entries.push(s.entries[0]), TypeError); assert.throws(() => { s.manifest.name='changed'; },TypeError); await assert.rejects(snapshotPackage(f.root,{limits:{maxNodes:50_001}}),{code:'INVALID_LIMIT'}); }
  finally { await f.cleanup(); }
});

test('unsafe files paths reject before any out-of-root access', async () => {
  for (const p of ['../outside.js', '/outside.js', 'C:/outside.js']) {
    const f = await fixture({}, { files:[p] }); try { await assert.rejects(snapshotPackage(f.root), { code:'OUTSIDE_ROOT' }); } finally { await f.cleanup(); }
  }
  assert.equal(inside('C:/allowed', 'C:/allowed-sibling/file'), false);
});

test('I1 multiple leading negations reject root escapes before analysis calls the oracle', async () => {
  for (const path of ['!!../outside.js','!!!../outside.js','!!/outside.js','!!!/outside.js','!!C:/outside.js','!!!C:\\outside.js','!!!..\\outside.js','!!./../outside.js','!!./C:/outside.js']) {
    const f=await fixture({},{files:[path]});
    try {
      await assert.rejects(snapshotPackage(f.root),{code:'OUTSIDE_ROOT'},path);
      await assert.rejects(analyzePackage(f.root),{code:'OUTSIDE_ROOT'},path);
    } finally { await f.cleanup(); }
  }
});

test('ordinary bodies and .npmrc cannot be read; lifecycle scripts and source tree stay unchanged', async () => {
  const marker = 'lifecycle-marker.txt';
  const script = `node -e "require('fs').writeFileSync('${marker}','ran')"`;
  const f = await fixture({ 'a.js':'synthetic-body', '.npmrc':'not_a_real_secret=synthetic' }, { scripts:{prepack:script,prepare:script,postpack:script} });
  const originals = { open:fs.open, readFile:fs.readFile };
  const digest = async () => Promise.all(['package.json','a.js','.npmrc'].map(async p => createHash('sha256').update(await originals.readFile(join(f.root,p))).digest('hex')));
  try {
    const before = await digest();
    fs.open = (async (path: any, ...args: any[]) => { if (typeof path === 'string' && inside(f.root,path) && path !== join(f.root,'package.json')) throw Error('forbidden source body read'); return (originals.open as any)(path,...args); }) as typeof fs.open;
    fs.readFile = (async (path: any, ...args: any[]) => { if (typeof path === 'string' && inside(f.root,path) && path !== join(f.root,'package.json')) throw Error('forbidden source body read'); return (originals.readFile as any)(path,...args); }) as typeof fs.readFile;
    const r = await analyzePackage(f.root); assert.equal(r.complete,true);
    assert.deepEqual(await digest(),before); await assert.rejects(fs.stat(join(f.root,marker)),{code:'ENOENT'});
    assert.ok(!JSON.stringify(r).includes('synthetic-body')); assert.ok(!JSON.stringify(r).includes('not_a_real_secret'));
  } finally { fs.open = originals.open; fs.readFile = originals.readFile; await f.cleanup(); }
});

test('official root construction error stays unknown and shadow is cleaned on error', async () => {
  const f = await fixture({ 'a.js':'a' }, { dependencies:{alpha:5} });
  try {
    const r = await analyzePackage(f.root); assert.equal(r.complete,false); assert.ok(r.diagnostics.some(d => d.code === 'ORACLE_ERROR')); assert.ok(r.entries.every(e => e.membership === 'unknown'));
    let shadow = ''; await assert.rejects(withShadow(await snapshotPackage(f.root), async root => { shadow=root; throw Error('synthetic failure'); })); await assert.rejects(fs.stat(shadow),{code:'ENOENT'});
  } finally { await f.cleanup(); }
});

test('source fingerprint and untested runtime versions fail the adapter profile gate', () => {
  const p=runtimeProfile(); assert.equal(profileMatches(p),true); const changed=structuredClone(p); changed.sourceHashes['ignore-walk']='synthetic-mismatch'; assert.equal(profileMatches(changed),false); changed.sourceHashes=p.sourceHashes; changed.nodeVersion='25.0.0'; assert.equal(profileMatches(changed),false);
});

test('raw byte aggregation preserves integers beyond Number safe range', async () => {
  const document='{"name":"synthetic","version":"1.0.0"}'; const f=await fixture({'package.json':document,'a.js':'a'});
  try { const s=structuredClone(await snapshotPackage(f.root)); s.entries.find(e=>e.path==='a.js')!.rawBytes='900719925474099312345'; const r=await analyzeSnapshot(s); assert.equal(r.scenario.aggregate.rawBytes,(900719925474099312345n+BigInt(Buffer.byteLength(document))).toString()); assert.equal(typeof r.scenario.aggregate.rawBytes,'string'); }
  finally { await f.cleanup(); }
});

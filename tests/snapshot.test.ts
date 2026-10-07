import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPackage, checkSnapshot } from '../src/snapshot.ts';
import { fixture } from './helpers.ts';
import { promises as fs } from 'node:fs';

test('snapshot captures byte metadata without an absolute root or ordinary body', async () => {
  const f = await fixture({ 'a.js': 'synthetic-secret-body', '.npmrc': 'synthetic-token=not-real' });
  try {
    const s = await snapshotPackage(f.root);
    assert.equal(s.complete, true);
    assert.deepEqual(s.diagnostics.map(d => d.code), ['CONFIG_NOT_APPLIED']);
    const json = JSON.stringify(s);
    assert.ok(!json.includes(f.root));
    assert.ok(!json.includes('synthetic-secret-body'));
    assert.ok(!json.includes('synthetic-token'));
    assert.equal(s.entries.find(e => e.path === 'a.js')?.rawBytes, '21');
  } finally { await f.cleanup(); }
});

test('root enumeration case collisions are uncovered before accepting a collection', async () => {
  const f=await fixture({'A.js':'a'}); const original=fs.readdir;
  const canonicalRoot=await fs.realpath(f.root); let injected=false;
  try {
    fs.readdir=(async (path:any,...args:any[])=>{ const names=await (original as any)(path,...args); if(path!==canonicalRoot)return names; injected=true; return [...names,'a.js']; }) as typeof fs.readdir;
    const s=await snapshotPackage(f.root); assert.equal(injected,true); assert.ok(s.uncoveredInputs.includes('CASE_COLLISION'));
  } finally { fs.readdir=original; await f.cleanup(); }
});

test('fingerprint recheck observes the shared scenario deadline', async () => {
  const f=await fixture({'a.js':'a'});
  try { const s=await snapshotPackage(f.root); assert.equal(await checkSnapshot(s,Date.now()-1),'<limit>'); }
  finally { await f.cleanup(); }
});

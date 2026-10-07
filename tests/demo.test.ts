import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { snapshotPackage } from '../src/snapshot.ts';
import { createScenarioSession, applyPatch } from '../src/scenario.ts';
import { actualFiles, cliFiles } from './helpers.ts';

const names=['nested-ignore','empty-glob','css-missing','template-missing','unexpected-growth','forced-include'];
for(const name of names)test(`demo ${name}: baseline and physical patch match shadow, trace, actual packlist and npm 12`,async()=>{
  const api=await import('../src/demo.ts').catch(()=>null);
  assert.ok(api?.runDemo,'runDemo must exist');
  const base=resolve('fixtures',name),intent=JSON.parse(await readFile(join(base,'intent.json'),'utf8')),patch=JSON.parse(await readFile(join(base,'patch.json'),'utf8')),expected=JSON.parse(await readFile(join(base,'expected.json'),'utf8'));
  const root=await mkdtemp(join(tmpdir(),'packlens-demo-test-'));
  try{
    await cp(join(base,'package'),root,{recursive:true});
    const before=await snapshotPackage(root),session=await createScenarioSession(before,intent);
    const reports=[session.report,await session.apply(patch)];
    for(let index=0;index<2;index++){
      if(index){const next=applyPatch(before,patch);await writeFile(join(root,'package.json'),next.manifestText);for(const source of before.ruleSources)if(!next.ruleSources.some(s=>s.path===source.path))await unlink(join(root,source.path));for(const source of next.ruleSources)await writeFile(join(root,source.path),source.text??'');}
      const report=reports[index],list=expected[index].files;
      assert.equal(report.complete,true);assert.deepEqual([...report.scenario.oracleFiles].sort(),list);assert.deepEqual([...report.scenario.tracedFiles].sort(),list);assert.deepEqual(await actualFiles(root),list);assert.deepEqual(await cliFiles(root),list);
      assert.deepEqual(report.scenario.assertions.map(a=>a.status),expected[index].assertions);
      if(name==='css-missing'){assert.equal(report.entries.find(e=>e.path==='dist/style.css')?.rawBytes,'2048');if(!index)assert.ok(report.ruleSources.some(s=>s.path==='dist/.npmignore'&&s.line===2));else assert.equal(report.scenario.delta?.addedRawBytes,'2048');}
      if(name==='nested-ignore'){assert.equal(report.entries.find(e=>e.path==='blocked/template.html')?.membership,'excluded');assert.ok(report.evidence.some(e=>e.path==='blocked/template.html'&&e.decision==='ancestor_block'));assert.ok(!report.evidence.some(e=>e.path==='blocked/template.html'&&e.candidateSources.some(id=>report.ruleSources.find(s=>s.sourceId===id)?.path==='blocked/.npmignore')));}
      if(name==='empty-glob')assert.equal(report.ruleSources.some(s=>s.zeroMatch),index===0);
      if(name==='template-missing')assert.ok(report.ruleSources.some(s=>s.path==='.npmignore'&&s.active===false));
      if(name==='unexpected-growth'&&index){const budget=report.scenario.assertions.at(-1)!;assert.equal(budget.bytesActual,budget.bytesLimit);assert.ok(report.scenario.delta?.retainedContentByteChanges.some(c=>c.path==='package.json'));}
      if(name==='forced-include')assert.ok(report.ruleSources.some(s=>s.jsonPointer==='/main'));
    }
    const demo=await api.runDemo(name);assert.deepEqual(demo.baseline.scenario.oracleFiles,reports[0].scenario.oracleFiles);assert.deepEqual(demo.patched.scenario.oracleFiles,reports[1].scenario.oracleFiles);
  }finally{assert.ok(relative(tmpdir(),root).startsWith('packlens-demo-test-'));await rm(root,{recursive:true,force:true});}
});

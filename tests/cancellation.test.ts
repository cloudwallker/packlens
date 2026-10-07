import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {fixture} from './helpers.ts';
import type {Worker} from 'node:worker_threads';
const api:typeof import('../src/index.ts')=await import(process.env.PACKLENS_TEST_ENTRY?pathToFileURL(process.env.PACKLENS_TEST_ENTRY).href:'../src/index.ts');
const patch={schemaVersion:1 as const,expectedRevision:0,operations:[{op:'removeIgnoreLine' as const,path:'dist/.npmignore',line:2,expected:'*.css'}]};
const cancelled={name:'AbortError',code:'CANCELLED'};
async function cancelWorker(run:(signal:AbortSignal)=>Promise<unknown>){
 const controller=new AbortController();let exits=0,messages=0;
 const observe=(worker:Worker)=>{worker.on('exit',()=>exits++);worker.on('message',()=>messages++);controller.abort();};
 process.once('worker',observe);
 try{await assert.rejects(run(controller.signal),cancelled);assert.equal(exits,1);assert.equal(messages,0);}
 finally{process.off('worker',observe);}
}
test('public signal options cancel analysis/simulation/session atomically and do not poison subsequent calls',async()=>{
 const f=await fixture({'dist/.npmignore':'# styles\n*.css\n','dist/style.css':'synthetic'},{files:['dist']});
 try{
  const snapshot=await api.snapshotPackage(f.root),stopped=AbortSignal.abort();
  await assert.rejects(api.analyzeSnapshot(snapshot,{signal:stopped}),cancelled);
  await assert.rejects(api.simulate(snapshot,patch,undefined,{signal:stopped}),cancelled);
  await assert.rejects(api.createScenarioSession(snapshot,undefined,{signal:stopped}),cancelled);
  await cancelWorker(signal=>api.analyzeSnapshot(snapshot,{signal}));
  await cancelWorker(signal=>api.simulate(snapshot,patch,undefined,{signal}));
  await cancelWorker(signal=>api.createScenarioSession(snapshot,undefined,{signal}));
  const initial=new AbortController();
  const session=await api.createScenarioSession(snapshot,undefined,{signal:initial.signal});
  initial.abort(); // Initialization options must not be retained by the session.
  const baseline=session.report;
  await cancelWorker(signal=>session.apply(patch,{signal}));
  assert.strictEqual(session.report,baseline);
  await assert.rejects(session.undo(0),{code:'NO_UNDO'});
  const applied=await session.apply(patch);assert.equal(applied.scenario.revision,1);assert.equal(applied.complete,true);
  await cancelWorker(signal=>session.undo(1,{signal}));assert.strictEqual(session.report,applied);
  await cancelWorker(signal=>session.reset(1,{signal}));assert.strictEqual(session.report,applied);
  const undone=await session.undo(1);assert.equal(undone.scenario.revision,2);
  assert.equal(undone.entries.find(e=>e.path==='dist/style.css')?.membership,'excluded');
  assert.equal((await session.reset(2)).scenario.revision,3);
 }finally{await f.cleanup();}
});

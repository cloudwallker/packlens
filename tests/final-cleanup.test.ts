import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fixture } from './helpers.ts';
import { lockFile } from './lock-helper.ts';
const api:any=await import(process.env.PACKLENS_TEST_ENTRY?pathToFileURL(process.env.PACKLENS_TEST_ENTRY).href:'../src/index.ts');

test('real locked shadow reports safe recovery ID, preserves session and retries only its owned object',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture({'sentinel.txt':'unchanged','dist/.npmignore':'*.css\n','dist/style.css':'css'},{files:['dist']});
 const snapshot=await api.snapshotPackage(f.root),session=await api.createScenarioSession(snapshot),baseline=session.report;
 const original=fs.rm;let shadow='',release:(()=>Promise<void>)|undefined,actualCode='',workers=0,exits=0;
 const observe=(worker:any)=>{workers++;worker.once('exit',()=>exits++);};
 fs.rm=async(path,options)=>{
   if(!shadow&&basename(String(path)).startsWith('packlens-shadow-')){assert.equal(exits,1);shadow=String(path);release=await lockFile(join(shadow,'package.json'));}
   try{return await original(path,options);}catch(e){actualCode=(e as NodeJS.ErrnoException).code??'';throw e;}
 };
 process.on('worker',observe);
 try{
   const result=await session.apply({schemaVersion:1,operations:[{op:'replaceFiles',value:['dist/**']}]});
   assert.equal(actualCode,'EBUSY');assert.equal(result.complete,false);
   const diagnostic=result.diagnostics.find((d:any)=>d.code==='CLEANUP_FAILED');assert.ok(diagnostic,'dedicated cleanup diagnostic');
   assert.match(diagnostic.cleanupId,/^[0-9a-f-]{36}$/);assert.strictEqual(session.report,baseline);
   const json=JSON.stringify(api.toPublicReport(result)),html=api.renderHtml(result);
   for(const value of [json,html]){assert.ok(value.includes(diagnostic.cleanupId));assert.ok(!value.includes(shadow));assert.ok(!value.includes(f.root));assert.ok(!value.includes('Error: EBUSY'));}
   const hostile=structuredClone(result);hostile.diagnostics[0].cleanupId=shadow;assert.ok(!JSON.stringify(api.toPublicReport(hostile)).includes(shadow));
   assert.ok(diagnostic.actionableNextStep);
   assert.equal((await api.analyzeSnapshot(snapshot)).diagnostics.find((d:any)=>d.code==='CLEANUP_FAILED').cleanupId,diagnostic.cleanupId);
   assert.equal(workers,1,'blocked cleanup does not allocate another worker/shadow');
   for(const unknown of [f.root,shadow,'00000000-0000-0000-0000-000000000000',JSON.stringify({root:shadow})])await assert.rejects(api.retryCleanup(unknown),{code:'UNKNOWN_CLEANUP_ID'});
   await release!();release=undefined;
   await api.retryCleanup(diagnostic.cleanupId);
   await assert.rejects(fs.stat(shadow),{code:'ENOENT'});
   assert.equal(await fs.readFile(join(f.root,'sentinel.txt'),'utf8'),'unchanged');
   assert.equal((await session.apply({schemaVersion:1,operations:[{op:'replaceFiles',value:['dist/**']}]})).complete,true);
 }finally{
   process.off('worker',observe);fs.rm=original;await release?.();
   // Cleanup only the captured root created by this invocation, never a supplied ID.
   if(shadow){assert.equal(dirname(resolve(shadow)),await fs.realpath(tmpdir()));if(api.retryPendingCleanup)await api.retryPendingCleanup();else await original(shadow,{recursive:true,force:true});}
   await f.cleanup();
 }
});

test('cleanup failure preserves original cancellation and computation diagnostics',{skip:process.platform!=='win32'},async()=>{
 const oracle:any=await import(process.env.PACKLENS_TEST_ENTRY?new URL('./oracle.js',pathToFileURL(process.env.PACKLENS_TEST_ENTRY)).href:'../src/oracle.ts');
 const f=await fixture({'sentinel':'untouched'}),snapshot=await api.snapshotPackage(f.root);
 try{for(const cancelled of [false,true]){
   let release:(()=>Promise<void>)|undefined,root='',error:any;
   try{
     try{await oracle.withShadow(snapshot,async(shadow:string)=>{root=shadow;release=await lockFile(join(root,'package.json'));throw cancelled?new api.AnalysisCancelledError():Error('LIMIT_EXCEEDED');});}catch(e){error=e;}
     assert.ok(error?.cleanupId);assert.equal(error.code,cancelled?'CANCELLED':'CLEANUP_FAILED');
     if(cancelled)assert.equal(error.name,'AbortError');else assert.equal(error.computationCode,'LIMIT_EXCEEDED');
     await release!();release=undefined;await api.retryCleanup(error.cleanupId);await assert.rejects(fs.stat(root),{code:'ENOENT'});
   }finally{await release?.();await api.retryPendingCleanup();}
 }
 assert.equal(await fs.readFile(join(f.root,'sentinel'),'utf8'),'untouched');
 }finally{await f.cleanup();}
});

test('cleanup retry refuses a replacement directory even with the recorded name',{skip:process.platform!=='win32'},async()=>{
 const oracle:any=await import(process.env.PACKLENS_TEST_ENTRY?new URL('./oracle.js',pathToFileURL(process.env.PACKLENS_TEST_ENTRY)).href:'../src/oracle.ts');
 const f=await fixture({}),snapshot=await api.snapshotPackage(f.root);
 let root='',release:(()=>Promise<void>)|undefined,error:any,moved=false;
 try{
   try{await oracle.withShadow(snapshot,async(shadow:string)=>{root=shadow;release=await lockFile(join(root,'package.json'));});}catch(e){error=e;}
   await release!();release=undefined;
   assert.equal(dirname(root),await fs.realpath(tmpdir()));
   await fs.rename(root,root+'-held');moved=true;await fs.mkdir(root);await fs.writeFile(join(root,'sentinel'),'replacement');
   await assert.rejects(api.retryCleanup(error.cleanupId),{code:'CLEANUP_FAILED'});
   assert.equal(await fs.readFile(join(root,'sentinel'),'utf8'),'replacement');
 }finally{
   await release?.();
   if(moved){await fs.unlink(join(root,'sentinel'));await fs.rmdir(root);await fs.rename(root+'-held',root);}
   await api.retryPendingCleanup();await f.cleanup();
 }
});

test('cancellation arriving at cleanup keeps both AbortError and safe recovery ID',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture({}),snapshot=await api.snapshotPackage(f.root),controller=new AbortController();
 const original=fs.rm;let release:(()=>Promise<void>)|undefined,error:any,locked=false;
 fs.rm=async(path,options)=>{if(!locked&&basename(String(path)).startsWith('packlens-shadow-')){locked=true;release=await lockFile(join(String(path),'package.json'));controller.abort();}return original(path,options);};
 try{
   try{await api.analyzeSnapshot(snapshot,{signal:controller.signal});}catch(e){error=e;}
   assert.equal(error?.name,'AbortError');assert.equal(error?.code,'CANCELLED');assert.match(error?.cleanupId??'',/^[0-9a-f-]{36}$/);
 }finally{fs.rm=original;await release?.();await api.retryPendingCleanup();await f.cleanup();}
});

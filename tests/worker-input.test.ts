import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

function execute(args:string[],code:string):Promise<{status:number|null;stdout:string;stderr:string}>{return new Promise((resolve,reject)=>{const child=spawn(process.execPath,args,{windowsHide:true});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));child.stdin.end(code);});}
for(const args of [['--input-type=module','--no-warnings'],['--input-type','module','--no-warnings']])test(`stdin source API handles ${args.join(' ')}`,async()=>{
 const url=pathToFileURL(resolve('src/demo.ts')).href;
 const result=await execute(args,`import {runDemo} from ${JSON.stringify(url)};const r=await runDemo('css-missing');console.log(JSON.stringify({complete:r.patched.complete,diagnostics:r.patched.diagnostics.map(d=>d.code),assertion:r.patched.scenario.assertions[0].status}));`);
 assert.equal(result.status,0);assert.equal(result.stderr,'');const value=JSON.parse(result.stdout);assert.equal(value.complete,true);assert.equal(value.assertion,'pass');
});
test('file worker preserves unrelated execArgv options',async()=>{
 const url=pathToFileURL(resolve('src/worker.ts')).href;
 const worker=pathToFileURL(resolve('tests/argv-worker.cjs')).href;
 const result=await execute(['--input-type=module','--no-warnings'],`import {runWorker} from ${JSON.stringify(url)};console.log(JSON.stringify(await runWorker(new URL(${JSON.stringify(worker)}),{},5000)));`);
 assert.equal(result.status,0);assert.deepEqual(JSON.parse(result.stdout),['--no-warnings']);
});

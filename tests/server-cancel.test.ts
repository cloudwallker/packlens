import test from 'node:test';
import assert from 'node:assert/strict';
import {request, type ClientRequest} from 'node:http';
import {readdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Worker} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
const {servePackage}:typeof import('../src/index.ts')=await import(process.env.PACKLENS_TEST_ENTRY?pathToFileURL(process.env.PACKLENS_TEST_ENTRY).href:'../src/index.ts');
import {fixture} from './helpers.ts';

const patch={schemaVersion:1,expectedRevision:0,operations:[{op:'removeIgnoreLine',path:'dist/.npmignore',line:2,expected:'*.css'}]};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw Error('OBSERVATION_TIMEOUT');await pause(10);}}
async function setup(){
 const f=await fixture({'dist/.npmignore':'# styles\n*.css\n','dist/style.css':'synthetic'},{files:['dist']});
 const server=await servePackage(f.root,{intent:{schemaVersion:1,mustShip:['dist/style.css']}});
 const url=`http://${server.address}:${server.port}`;
 const html=await (await fetch(url)).text();
 const credential=JSON.parse(html.match(/<script id="live-data" type="application\/json">([\s\S]*?)<\/script>/)![1]).credential;
 const headers={origin:url,'content-type':'application/json','x-packlens-session':credential};
 async function api(path:string,body?:unknown){const r=await fetch(url+'/api/'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,text:await r.text()};}
 function post(path:string,body:unknown){
  let responded=false,req:ClientRequest;
  const settled=new Promise<{responded:boolean;status?:number;body?:string}>(resolve=>{
   req=request(url+'/api/'+path,{method:'POST',headers},res=>{responded=true;let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({responded,status:res.statusCode,body:text}));});
   req.on('error',()=>resolve({responded}));req.end(JSON.stringify(body));
  });
  return {get req(){return req!;},get responded(){return responded;},settled};
 }
 return {server,f,api,post};
}
function observeWorkers(onStart?:(worker:Worker)=>void){
 const initial=new Set(readdirSync(tmpdir()).filter(p=>p.startsWith('packlens-shadow-')));
 const workers:Worker[]=[],shadows=new Set<string>();let messages=0,exits=0;
 const observe=(worker:Worker)=>{workers.push(worker);for(const name of readdirSync(tmpdir()))if(name.startsWith('packlens-shadow-')&&!initial.has(name))shadows.add(join(tmpdir(),name));worker.on('message',()=>messages++);worker.on('exit',()=>exits++);onStart?.(worker);};
 process.on('worker',observe);
 return {workers,shadows,get messages(){return messages;},get exits(){return exits;},stop:()=>process.off('worker',observe)};
}

test('real response disconnect aborts the official worker and preserves revision, rules and saved history',async()=>{
 const s=await setup();let active:ReturnType<typeof s.post>|undefined;
 const watch=observeWorkers(()=>{assert.equal(active!.responded,false);active!.req.destroy();});
 try{
  const baseline=JSON.parse((await s.api('editor')).text);
  active=s.post('apply',patch);await active.settled;await until(()=>watch.exits===1);
  await until(()=>[...watch.shadows].every(p=>!existsSync(p)));
  assert.equal(watch.messages,0,'cancel must terminate before an official result is produced');
  watch.stop();
  assert.deepEqual(JSON.parse((await s.api('editor')).text),baseline);
  const saved=(await s.api('export',{})).text;const data=JSON.parse(saved.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);assert.equal(data.reports.length,1);
  assert.equal(JSON.parse((await s.api('undo',{expectedRevision:0})).text).error.code,'NO_UNDO');
  const good=await s.api('apply',patch);assert.equal(good.status,200);assert.equal(JSON.parse(good.text).report.scenario.revision,1);
 }finally{watch.stop();await s.server.close();await s.f.cleanup();}
});

test('a disconnected queued request never starts a second official calculation',async()=>{
 const s=await setup(),watch=observeWorkers();
 try{
  const first=s.post('apply',patch);await until(()=>watch.workers.length===1);
  const queued=s.post('reset',{expectedRevision:1});await pause(25);assert.equal(first.responded,false);assert.equal(queued.responded,false);queued.req.destroy();await queued.settled;
  const done=await first.settled;assert.equal(done.status,200);
  // Export joins the same queue, so its completion is a barrier after cancelled work.
  const saved=(await s.api('export',{})).text;
  assert.equal(watch.workers.length,1,'queued cancellation must skip the producer');
  assert.equal(JSON.parse((await s.api('editor')).text).revision,1);
  const data=JSON.parse(saved.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);assert.equal(data.reports.length,2);
  watch.stop();assert.equal(JSON.parse((await s.api('undo',{expectedRevision:1})).text).report.scenario.revision,2);
 }finally{watch.stop();await s.server.close();await s.f.cleanup();}
});

test('close cancels active official work, reclaims its shadow and is idempotent',async()=>{
 const s=await setup(),watch=observeWorkers();
 try{
  const active=s.post('apply',patch);await until(()=>watch.workers.length===1);assert.equal(active.responded,false);
  const queued=s.post('reset',{expectedRevision:1});await pause(25);assert.equal(queued.responded,false);
  const closed=await Promise.allSettled([s.server.close(),s.server.close()]);
  assert.ok(closed.every(r=>r.status==='fulfilled'));
  assert.equal((await active.settled).responded,false);
  assert.equal((await queued.settled).responded,false);
  assert.equal(watch.workers.length,1);
  assert.equal(watch.exits,1);assert.equal(watch.messages,0);
  assert.ok(watch.shadows.size>0);assert.ok([...watch.shadows].every(p=>!existsSync(p)));
  await assert.rejects(s.api('editor'));
 }finally{watch.stop();await s.server.close().catch(()=>{});await s.f.cleanup();}
});

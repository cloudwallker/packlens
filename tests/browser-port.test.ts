import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {Server,type AddressInfo} from 'node:net';
import {servePackage,type ServerHandle} from '../src/server.ts';
import {fixture} from './helpers.ts';

const read=(port:number)=>new Promise<{status:number;body:string}>((resolve,reject)=>{
 get(`http://127.0.0.1:${port}/`,response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode!,body}));}).on('error',reject);
});

test('explicit browser-restricted ports are rejected before reading a package',async()=>{
 for(const port of [25,4190,6666,6679,10080])await assert.rejects(servePackage('not-a-package',{port}),{code:'BROWSER_RESTRICTED_PORT'});
});

test('port validation still rejects invalid JavaScript values before reading a package',async()=>{
 for(const port of [null,NaN,Infinity,-1,1.5,65536,'3000'])await assert.rejects(servePackage('not-a-package',{port:port as number}),{code:'INVALID_PORT'});
});

test('an automatically assigned restricted port is released before retrying',async t=>{
 const f=await fixture({'index.js':'export default 1;'});
 const address=Server.prototype.address;let released=false,calls=0;
 // Keep real sockets but control the otherwise nondeterministic OS allocation.
 const mocked=t.mock.method(Server.prototype,'address',function(this:Server){
  const actual=address.call(this) as AddressInfo;
  if(actual&&calls++===0){
   this.once('close',()=>{released=!this.listening;});
   return {...actual,port:6666};
  }
  return actual;
 });
 let server:ServerHandle|undefined;
 try{
  server=await servePackage(f.root,{port:0});
  mocked.mock.restore();
  assert.notEqual(server.port,6666);
  assert.equal(released,true,'the discarded listener must close before retrying');
  assert.equal((await read(server.port)).status,200,'Host validation must use the final port');
 }finally{mocked.mock.restore();await server?.close();await f.cleanup();}
});

test('repeated restricted allocations stop with no open listener',async t=>{
 const f=await fixture({'index.js':'export default 1;'});
 const address=Server.prototype.address;const listeners=new Set<Server>();let allocations=0;
 t.mock.method(Server.prototype,'address',function(this:Server){
  const actual=address.call(this) as AddressInfo;
  if(actual){listeners.add(this);allocations++;return {...actual,port:6666};}
  return actual;
 });
 let server:ServerHandle|undefined;
 try{
  await assert.rejects(async()=>{server=await servePackage(f.root);},{code:'BROWSER_PORT_UNAVAILABLE'});
  assert.ok(allocations>1&&allocations<=32,'allocation retries must be bounded');
  assert.ok([...listeners].every(listener=>!listener.listening),'failed startup must release every listener');
 }finally{await server?.close();await f.cleanup();}
});

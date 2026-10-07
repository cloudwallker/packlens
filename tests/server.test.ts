import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers.ts';

function call(url:string,path:string,method='GET',headers:Record<string,string>={},body?:string):Promise<{status:number;body:string;headers:any}> {
  return new Promise((resolve,reject)=>{const req=request(url+path,{method,headers},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode!,body:text,headers:res.headers}));});req.setTimeout(5000,()=>req.destroy(Error('REQUEST_TIMEOUT')));req.on('error',reject);req.end(body);});
}
test('loopback session rejects foreign requests and arbitrary routes; real edits undo/reset with revisions preserve source',async()=>{
  const api=await import('../src/server.ts').catch(()=>null);
  assert.ok(api?.servePackage,'servePackage must exist');
  const f=await fixture({'dist/style.css':Buffer.alloc(2048),'dist/.npmignore':'# resources\n*.css\n'},{files:['dist'],author:'PRIVATE_MANIFEST'});
  let server:any;
  try {
    server=await api.servePackage(f.root,{intent:{schemaVersion:1,mustShip:['dist/style.css']}});
    assert.equal(server.address,'127.0.0.1');assert.ok(server.port>0);
    const url=`http://${server.address}:${server.port}`;
    assert.equal((await call(url,'/','GET',{host:'localhost:'+server.port})).status,403);
    assert.equal((await call(url,'/','GET',{origin:'https://foreign.invalid'})).status,403);
    assert.equal((await call(url,'/','GET',{'sec-fetch-site':'cross-site'})).status,403);
    const page=await call(url,'/');assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'no-store');
    const bootstrap=JSON.parse(page.body.match(/<script id="live-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);
    const headers={origin:url,'content-type':'application/json','x-packlens-session':bootstrap.credential};
    assert.equal((await call(url,'/api/editor')).status,403);
    assert.equal((await call(url,'/api/editor','GET',{...headers,'x-packlens-session':'é'.repeat(64)})).status,403);
    assert.equal((await call(url,'/api/editor','GET',{...headers,origin:'null'})).status,403);
    assert.equal((await call(url,'/api/editor','GET',headers)).status,200);
    for(const path of ['/api/file?path=package.json','/api/directory','/api/exec','/../package.json'])assert.equal((await call(url,path,'GET',headers)).status,404);
    assert.equal((await call(url,'/api/apply','POST',headers,'x'.repeat(1_048_577))).status,413);
    assert.equal((await call(url,'/api/apply','POST',{...headers,'transfer-encoding':'chunked'},'x'.repeat(1_048_577))).status,413);
    const patch={schemaVersion:1,expectedRevision:0,operations:[{op:'removeIgnoreLine',path:'dist/.npmignore',line:2,expected:'*.css'}]};
    const changed=await call(url,'/api/apply','POST',headers,JSON.stringify(patch));assert.equal(changed.status,200);
    const result=JSON.parse(changed.body);assert.equal(result.report.scenario.assertions[0].status,'pass');assert.equal(result.report.scenario.revision,1);
    assert.equal((await call(url,'/api/apply','POST',headers,JSON.stringify(patch))).status,409);
    assert.equal((await call(url,'/api/apply','POST',headers,JSON.stringify({schemaVersion:1,expectedRevision:1,operations:[{op:'createIgnore',path:'../.npmignore',value:'x'}]}))).status,400);
    const exported=await call(url,'/api/export','POST',headers,JSON.stringify({omitRuleText:true}));assert.equal(exported.status,200);
    assert.ok(!exported.body.includes(bootstrap.credential));assert.ok(!exported.body.includes('PRIVATE_MANIFEST'));
    const undo=JSON.parse((await call(url,'/api/undo','POST',headers,JSON.stringify({expectedRevision:1}))).body);
    assert.equal(undo.report.scenario.revision,2);assert.equal(undo.report.scenario.assertions[0].status,'fail');
    const reset=JSON.parse((await call(url,'/api/reset','POST',headers,JSON.stringify({expectedRevision:2}))).body);assert.equal(reset.report.scenario.revision,3);
    assert.equal(await readFile(f.root+'/dist/.npmignore','utf8'),'# resources\n*.css\n');
    // Two writes based on one revision cannot overwrite one another.
    const both=await Promise.all([call(url,'/api/reset','POST',headers,'{"expectedRevision":3}'),call(url,'/api/reset','POST',headers,'{"expectedRevision":3}')]);
    assert.deepEqual(both.map(x=>x.status).sort(),[200,409]);
  }finally{await server?.close();await f.cleanup();}
});

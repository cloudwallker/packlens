import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.ts';
const {snapshotPackage,simulate,toPublicReport}=await import('../dist/index.js');
const f=await fixture({'dist/style.css':Buffer.alloc(2048),'dist/.npmignore':'# assets\n*.css\n','dist/index.js':'code'},{files:['dist'],author:'synthetic-author@example.invalid'});
const controls=await fixture({});
async function cli(args:string[]){return new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{const c=spawn(process.execPath,[fileURLToPath(new URL('../dist/cli.js',import.meta.url)),...args],{windowsHide:true});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);c.on('error',reject);c.on('close',code=>resolve({code,out,err}));});}
try {
  const patch={schemaVersion:1 as const,operations:[{op:'removeIgnoreLine' as const,path:'dist/.npmignore',line:2,expected:'*.css'}]},intent={schemaVersion:1 as const,mustShip:['dist/style.css']};
  await writeFile(join(controls.root,'patch.json'),JSON.stringify(patch));await writeFile(join(controls.root,'intent.json'),JSON.stringify(intent));
  const base=await snapshotPackage(f.root),report=await simulate(base,patch,intent);
  assert.equal(report.complete,true);assert.equal(report.scenario.delta?.addedRawBytes,'2048');assert.equal(report.scenario.assertions[0].status,'pass');
  const analysis=await cli(['analyze',f.root,'--json','--intent',join(controls.root,'intent.json')]);assert.equal(analysis.code,1);
  const a=JSON.parse(analysis.out);assert.equal(a.scenario.assertions[0].status,'fail');
  const explanation=await cli(['explain',f.root,'dist/style.css','--json']);assert.equal(explanation.code,0);
  const e=JSON.parse(explanation.out);assert.equal(e.entry.membership,'excluded');assert.ok(e.ruleSources.some((s:any)=>s.path==='dist/.npmignore' && s.line===2));
  const changed=await cli(['simulate',f.root,'--patch',join(controls.root,'patch.json'),'--intent',join(controls.root,'intent.json'),'--json']);assert.equal(changed.code,0);
  const s=JSON.parse(changed.out);assert.equal(s.scenario.assertions[0].status,'pass');assert.equal(s.scenario.delta.addedRawBytes,'2048');
  for(const text of [analysis.out,explanation.out,changed.out,JSON.stringify(toPublicReport(report))]) {assert.ok(!text.includes(f.root));assert.ok(!text.includes('synthetic-author'));assert.ok(!text.includes('manifestText'));}
  console.log(JSON.stringify({compiledApi:'PASS',analyze:{exit:analysis.code,files:a.scenario.oracleFiles,rawBytes:a.scenario.aggregate.rawBytes,assertion:'fail'},explain:{exit:explanation.code,membership:e.entry.membership,source:'dist/.npmignore:2'},simulate:{exit:changed.code,files:s.scenario.oracleFiles,rawBytes:s.scenario.aggregate.rawBytes,addedRawBytes:s.scenario.delta.addedRawBytes,netRawBytes:s.scenario.delta.netRawBytes,assertion:'pass'},publicPrivacy:'PASS'}));
}finally{await controls.cleanup();await f.cleanup();}

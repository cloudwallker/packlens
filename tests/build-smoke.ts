import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
const { analyzePackage }=await import('../dist/analyze.js');
const f=await fixture({'dist/a.css':Buffer.alloc(2048),'dist/.npmignore':'# synthetic\n*.css\n','README.md':'synthetic'});
try { const r=await analyzePackage(f.root); assert.equal(r.complete,true); assert.deepEqual(r.scenario.oracleFiles,['README.md','package.json']); assert.equal(r.entries.find((e:{path:string})=>e.path==='dist/a.css')?.rawBytes,'2048'); console.log('compiled API + compiled Worker: PASS'); }
finally { await f.cleanup(); }

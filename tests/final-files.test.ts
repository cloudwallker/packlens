import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateFilesPaths, snapshotPackage } from '../src/snapshot.ts';
import { applyPatch } from '../src/scenario.ts';
import { fixture } from './helpers.ts';

test('files checks every official normalized brace branch before any oracle', async()=>{
  const input='{a{1..300},../outside}'+'/'.repeat(16384);
  const require=createRequire(import.meta.url),expand=require('minimatch').braceExpand;
  assert.equal(input.length,16406);
  assert.equal(expand(input,{braceExpandMax:50001}).length,244);
  assert.equal(expand(input.replace(/^!+/,'').replace(/^\.?\//,'').replace(/\/+$/,''),{braceExpandMax:50001}).at(-1),'../outside');
  let workers=0;const observe=()=>workers++;process.on('worker',observe);
  const f=await fixture({},{files:[input]});
  try {
    for(const suffix of ['', '/', '/'.repeat(16384)])assert.throws(()=>validateFilesPaths(['{a{1..300},../outside}'+suffix]),{code:'OUTSIDE_ROOT'});
    await assert.rejects(snapshotPackage(f.root),{code:'OUTSIDE_ROOT'});
    const safe=await fixture({});
    const excessive=Array(513).fill('x'.repeat(1023)+'{a,b}');
    const large=await fixture({},{files:excessive});
    try{
      const snapshot=await snapshotPackage(safe.root);
      assert.throws(()=>applyPatch(snapshot,{schemaVersion:1,operations:[{op:'replaceFiles',value:[input]}]}),{code:'OUTSIDE_ROOT'});
      assert.throws(()=>applyPatch(snapshot,{schemaVersion:1,operations:[{op:'replaceFiles',value:excessive}]}),{code:'LIMIT_EXCEEDED'});
      await assert.rejects(snapshotPackage(large.root),{code:'LIMIT_EXCEEDED'});
    }finally{await safe.cleanup();await large.cleanup();}
  }finally{process.off('worker',observe);await f.cleanup();assert.equal(workers,0);}
});

test('files cumulative UTF-8 expansion budget rejects overflow and upstream truncation',()=>{
  const unit='a'.repeat(16384);
  assert.doesNotThrow(()=>validateFilesPaths(Array(64).fill(unit)));
  assert.throws(()=>validateFilesPaths([...Array(64).fill(unit),'a']),{code:'LIMIT_EXCEEDED'});
  assert.doesNotThrow(()=>validateFilesPaths(Array(512).fill('x'.repeat(1023)+'{a,b}')));
  assert.doesNotThrow(()=>validateFilesPaths(Array(64).fill('é'.repeat(8192))));
  assert.throws(()=>validateFilesPaths([...Array(64).fill('é'.repeat(8192)),'é']),{code:'LIMIT_EXCEEDED'});
  assert.throws(()=>validateFilesPaths([unit+'{1..512}']),{code:'LIMIT_EXCEEDED'});
  assert.throws(()=>validateFilesPaths(['{1..50001}']),{code:'LIMIT_EXCEEDED'});
  assert.doesNotThrow(()=>validateFilesPaths(['{1..50000}']));
  for(const unproven of ['{9007199254740992..9007199254740994}', '{a}'+ '}'.repeat(1001)+',b}', '{'.repeat(1001)+'a,b'+'}'.repeat(1001), 'x\\{a,b}', '{}{a,b}'])assert.throws(()=>validateFilesPaths([unproven]),{code:'LIMIT_EXCEEDED'});
  assert.doesNotThrow(()=>validateFilesPaths(['!!./dist/{css,js}/','src/{1..4}/**','{a{1..3},b}/']));
  for(const value of ['/dist','!!/dist','C:/dist','!!C:/dist','//host/share','!!../outside'])assert.throws(()=>validateFilesPaths([value]),{code:'OUTSIDE_ROOT'});
});

test('safe brace budget follows nested alternatives and official normalization',()=>{
  const require=createRequire(import.meta.url),expand=require('minimatch').braceExpand;
  for(const value of ['!!./dist/{css,js}///','{a{1..3},b}/','{{a,b}}/','{a,b}{c,d}/','x{03..01}y/','x{a..e..2}/']){
    assert.doesNotThrow(()=>validateFilesPaths([value]));
    const pattern=value.replace(/^!+/,'').replace(/^\.?\//,'').replace(/\/+$/,'');
    assert.ok(expand(pattern,{braceExpandMax:50001}).length>0);
  }
  assert.doesNotThrow(()=>validateFilesPaths(['é'.repeat(4094)+'{a,b}']));
});

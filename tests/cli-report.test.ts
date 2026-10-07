import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { runCli,parseArguments } from '../src/cli.ts';

test('CLI demo and analyze HTML integrate computed reports and protect source output',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'packlens-html-test-'));let out='',err='';const io={stdout:(s:string)=>out+=s,stderr:(s:string)=>err+=s};
 try{
  assert.equal(await runCli(['demo','css-missing','--html',join(folder,'demo.html')],io),0,'demo CLI must calculate and export');
  const html=await readFile(join(folder,'demo.html'),'utf8');const data=JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);assert.equal(data.reports.length,2);assert.equal(data.reports[0].scenario.assertions[0].status,'fail');assert.equal(data.reports[1].scenario.assertions[0].status,'pass');
  assert.equal(await runCli(['analyze','fixtures/css-missing/package','--html',join(folder,'analyze.html')],io),0);
  assert.equal(await runCli(['simulate','fixtures/css-missing/package','--patch','fixtures/css-missing/patch.json','--intent','fixtures/css-missing/intent.json','--html',join(folder,'simulate.html')],io),0);
  const sim=JSON.parse((await readFile(join(folder,'simulate.html'),'utf8')).match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);assert.equal(sim.reports.length,2);assert.equal(sim.reports[0].scenario.assertions[0].status,'fail');
  assert.equal(await runCli(['analyze','fixtures/css-missing/package','--html','fixtures/css-missing/package/report.html'],io),3);
  assert.equal(parseArguments(['serve','fixtures/css-missing/package','--port','0']).port,0);
  assert.throws(()=>parseArguments(['serve','fixtures/css-missing/package','--port','-1']));
 }finally{await rm(folder,{recursive:true,force:true});}
});

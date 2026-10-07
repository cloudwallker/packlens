import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const {runCli}=await import(process.env.PACKLENS_TEST_CLI?pathToFileURL(process.env.PACKLENS_TEST_CLI).href:'../src/cli.ts');

for(const boundary of ['before-baseline','before-apply'])test(`CLI simulate shares deadline with HTML at ${boundary}`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),'packlens-test-deadline-'));
  try{for(const html of [false,true]){
    const original=Date.now,start=original();let expired=false,out='',workers=0;
    const observe=()=>workers++;
    process.on('worker',observe);
    Date.now=()=>{
      const stack=new Error().stack??'';
      if(boundary==='before-baseline' ? /at (createScenarioSession|simulate) /.test(stack) : /at (?:ScenarioSession\.#change|analyzeScenario) /.test(stack)&&workers>=1)expired=true;
      return start+(expired?30001:0);
    };
    let exit:number;
    try{exit=await runCli(['simulate','fixtures/css-missing/package','--patch','fixtures/css-missing/patch.json','--intent','fixtures/css-missing/intent.json','--json',...(html?['--html',join(dir,boundary+'.html')]:[])],{stdout:(s:string)=>out+=s,stderr:()=>{}});}
    finally{Date.now=original;process.off('worker',observe);}
    assert.equal(expired,true);assert.equal(exit,2,`html=${html}`);
    const report=JSON.parse(out);assert.equal(report.complete,false);assert.ok(report.diagnostics.some((d:any)=>d.code==='LIMIT_EXCEEDED'));assert.ok(!report.scenario.assertions.some((a:any)=>a.status==='pass'));
    if(html){const data=JSON.parse((await readFile(join(dir,boundary+'.html'),'utf8')).match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]);assert.equal(data.reports.at(-1).complete,false);}
  }}finally{await rm(dir,{recursive:true,force:true});}
});

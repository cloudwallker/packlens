import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { fixture } from './helpers.ts';
import { lockFile } from './lock-helper.ts';
const api:any=await import(process.env.PACKLENS_TEST_ENTRY?pathToFileURL(process.env.PACKLENS_TEST_ENTRY).href:'../src/index.ts');

test('live cleanup error displays recovery ID, keeps old scene and retries normally after unlock',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture({'dist/.npmignore':'*.css\n','dist/style.css':'css'},{files:['dist']});
 const server=await api.servePackage(f.root);let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 let release:(()=>Promise<void>)|undefined,shadow='';const original=fs.rm;
 try{
   browser=await chromium.launch();const page=await browser.newPage();
   await page.goto(`http://${server.address}:${server.port}/`);await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent?.includes('计算完成'));
   await page.locator('#rule-editor').fill('');
   fs.rm=async(path,options)=>{if(!shadow&&basename(String(path)).startsWith('packlens-shadow-')){shadow=String(path);release=await lockFile(join(shadow,'package.json'));}return original(path,options);};
   const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/apply'));
   await page.getByRole('button',{name:'重算虚拟规则',exact:true}).click();
   const response=await responsePromise;assert.equal(response.status(),422);
   const failed=await response.json(),id=failed.diagnostics.find((d:any)=>d.code==='CLEANUP_FAILED').cleanupId;
   await page.waitForFunction(()=>document.querySelector('[role=status]')?.textContent?.includes('请求未完成'));
   assert.ok((await page.getByRole('status').innerText()).includes(id));
   assert.ok(!(await page.locator('body').innerText()).includes(shadow));assert.equal(await page.locator('#scenario option').count(),1);
   await release!();release=undefined;fs.rm=original;
   await page.getByRole('button',{name:'重算虚拟规则',exact:true}).click();
   await page.waitForFunction(()=>document.querySelectorAll('#scenario option').length===2);
   assert.ok((await page.getByRole('button',{name:'dist/style.css',exact:false}).innerText()).includes('✓'));
   await assert.rejects(fs.stat(shadow),{code:'ENOENT'});
 }finally{fs.rm=original;await release?.();await api.retryPendingCleanup();await browser?.close();await server.close();await f.cleanup();}
});

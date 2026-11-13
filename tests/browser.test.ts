import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {readFile,readdir,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {servePackage} from '../src/server.ts';
import {runDemo,demoNames} from '../src/demo.ts';
import {renderHtml} from '../src/report.ts';

async function fingerprints(root:string,prefix=''):Promise<string[]>{const found:string[]=[];for(const e of await readdir(join(root,prefix),{withFileTypes:true})){const path=prefix?prefix+'/'+e.name:e.name;if(e.isDirectory())found.push(...await fingerprints(root,path));else found.push(path+':'+createHash('sha256').update(await readFile(join(root,path))).digest('hex'));}return found.sort();}

test('real browser: live CSS edit, undo/reset, export, offline scenes, source pointers, keyboard and narrow layout', {timeout:120_000},async()=>{
 const root=resolve('fixtures/css-missing/package'),before=await fingerprints(root),intent=JSON.parse(await readFile('fixtures/css-missing/intent.json','utf8'));
 const server=await servePackage(root,{intent});let folder:string|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  folder=await mkdtemp(join(tmpdir(),'packlens-browser-'));
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true}),page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://${server.address}:${server.port}/`);await page.waitForFunction(()=>document.querySelector('#rule-editor')?.textContent!==undefined&&!(document.querySelector('main')?.getAttribute('aria-busy')==='true'));
  await page.locator('#edit-target').selectOption('dist/.npmignore');assert.equal(await page.locator('#rule-editor').inputValue(),'# styles\n*.css\n');
  assert.match(await page.getByRole('button',{name:'dist 目录',exact:false}).innerText(),/3 文件 · 1 已包含/);
  await page.getByRole('button',{name:'dist/style.css',exact:false}).click();assert.match(await page.locator('#evidence').innerText(),/dist\/.npmignore:2/);
  await page.getByRole('button',{name:'dist/.npmignore:2',exact:true}).click();assert.match(await page.locator('#evidence').innerText(),/\*\.css/);
  if(process.env.PACKLENS_CAPTURE_SCREENSHOTS){await mkdir('docs/images',{recursive:true});await page.screenshot({path:'docs/images/css-baseline-1440.png',fullPage:true});}
  await page.locator('#rule-editor').fill('# styles\n');await page.getByRole('button',{name:'重算虚拟规则',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#assertions')?.textContent?.includes('mustShip · pass'));
  assert.match(await page.locator('#evidence').innerText(),/已包含/);
  if(process.env.PACKLENS_CAPTURE_SCREENSHOTS)await page.screenshot({path:'docs/images/css-patched-1440.png',fullPage:true});
  await page.getByRole('button',{name:'字节与路径变化',exact:true}).click();assert.match(await page.locator('#delta').innerText(),/2048 B/);
  await page.getByRole('button',{name:'交付断言',exact:true}).click();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线 HTML',exact:true}).click();const download=await downloadPromise,offlinePath=join(folder,'saved.html');await download.saveAs(offlinePath);
  const saved=await readFile(offlinePath,'utf8');assert.ok(!saved.includes('"credential":'));assert.ok(!saved.includes('id="live-data"'));
  await page.getByRole('button',{name:'撤销',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#assertions')?.textContent?.includes('mustShip · fail'));
  await page.getByRole('button',{name:'重置',exact:true}).click();await page.waitForFunction(()=>!(document.querySelector('main')?.getAttribute('aria-busy')==='true'));assert.equal(await page.locator('#rule-editor').inputValue(),'# styles\n*.css\n');
  assert.deepEqual(await fingerprints(root),before);
  await context.setOffline(true);await context.route('http://**/*',route=>route.abort());await context.route('https://**/*',route=>route.abort());
  await page.goto(pathToFileURL(offlinePath).href);assert.match(await page.locator('.mode').innerText(),/已保存场景/);assert.equal(await page.locator('#scenario option').count(),2);
  assert.match(await page.locator('#assertions').innerText(),/mustShip · pass/);await page.locator('#scenario').selectOption('0');assert.match(await page.locator('#assertions').innerText(),/mustShip · fail/);
  await page.locator('#search').fill('style.css');assert.equal(await page.locator('.entry').count(),1);await page.locator('#status-filter').selectOption('included');assert.equal(await page.locator('.entry').count(),0);await page.locator('#scenario').selectOption('1');assert.equal(await page.locator('.entry').count(),1);
  await page.locator('#search').fill('');await page.locator('#status-filter').selectOption('all');await page.getByRole('button',{name:'折叠或展开 dist',exact:true}).click();assert.equal(await page.getByRole('button',{name:'dist/style.css',exact:false}).count(),0);await page.getByRole('button',{name:'折叠或展开 dist',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.locator('#scenario').selectOption('0');await page.getByRole('button',{name:'dist/style.css',exact:false}).click();await page.getByRole('button',{name:'dist/.npmignore:2',exact:true}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#search').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.id),'status-filter');assert.notEqual(await page.locator('#status-filter').evaluate(e=>getComputedStyle(e).outlineStyle),'none');
  if(process.env.PACKLENS_CAPTURE_SCREENSHOTS)await page.screenshot({path:'docs/images/css-saved-390.png',fullPage:true});
  assert.deepEqual(errors,[]);
 }finally{try{await browser?.close();}finally{try{await server.close();}finally{if(folder)await rm(folder,{recursive:true,force:true});}}}
});

test('all six computed demos render saved comparisons offline; hostile text and large trees stay usable',{timeout:120_000},async()=>{
 const folder=await mkdtemp(join(tmpdir(),'packlens-browser-scenes-'));let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:390,height:844}});await context.setOffline(true);const page=await context.newPage(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  for(const name of demoNames){const demo=await runDemo(name),file=join(folder,name+'.html');await writeFile(file,renderHtml(demo.baseline,{scenarios:[demo.patched]}));await page.goto(pathToFileURL(file).href);assert.equal(await page.locator('#scenario option').count(),2);for(const index of [0,1]){await page.locator('#scenario').selectOption(String(index));assert.equal(await page.locator('#assertions .assertion').count(),[demo.baseline,demo.patched][index].scenario.assertions.length);}assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  const demo=await runDemo('css-missing'),hostile='evil</script><script>globalThis.injected=1</script>';
  const report=demo.baseline;report.entries.push({...report.entries[0],path:hostile});const source=report.ruleSources.find(s=>s.path==='dist/.npmignore'&&s.line===2)!;source.text=hostile;
  for(let i=0;i<250;i++)report.entries.push({...report.entries[0],path:'long/'+('segment-'.repeat(20))+i+'.js'});
  const file=join(folder,'hostile.html');await writeFile(file,renderHtml(report));await page.goto(pathToFileURL(file).href);assert.ok(await page.locator('.entry').count()<=100);await page.getByRole('button',{name:'下一页',exact:true}).click();assert.match(await page.locator('.pager').innerText(),/2\/3/);
  await page.locator('#search').fill('evil');assert.equal(await page.locator('.entry').count(),1);assert.match(await page.locator('.entry').innerText(),/evil<\/script>/);assert.equal(await page.evaluate(()=>Object.hasOwn(globalThis,'injected')),false);
  await page.locator('#search').fill('style.css');await page.getByRole('button',{name:'dist/style.css',exact:false}).click();await page.getByRole('button',{name:'dist/.npmignore:2',exact:true}).click();assert.match(await page.locator('#evidence').innerText(),/evil<\/script>/);assert.equal(await page.evaluate(()=>Object.hasOwn(globalThis,'injected')),false);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{try{await browser?.close();}finally{await rm(folder,{recursive:true,force:true});}}
});

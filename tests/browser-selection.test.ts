import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {pathToFileURL} from 'node:url';
const {servePackage}:typeof import('../src/index.ts')=await import(process.env.PACKLENS_TEST_ENTRY?pathToFileURL(process.env.PACKLENS_TEST_ENTRY).href:'../src/index.ts');

test('tree selection updates old/new pressed state, visible highlight and details without replacing focus',async()=>{
 const server=await servePackage('fixtures/css-missing/package');
 let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
 try{
  browser=await chromium.launch();const page=await browser.newPage();
  await page.goto(`http://${server.address}:${server.port}/`);
  const css=page.getByRole('button',{name:'dist/style.css',exact:false}),js=page.getByRole('button',{name:'dist/index.js',exact:false});
  await css.click();assert.equal(await css.getAttribute('aria-pressed'),'true');assert.equal(await css.evaluate(e=>document.activeElement===e),true);
  const selectedColor=await css.evaluate(e=>getComputedStyle(e).backgroundColor);
  await js.focus();await page.keyboard.press('Enter');
  assert.equal(await css.getAttribute('aria-pressed'),'false');assert.equal(await js.getAttribute('aria-pressed'),'true');
  assert.equal(await js.evaluate(e=>document.activeElement===e),true);assert.equal(await js.evaluate(e=>getComputedStyle(e).backgroundColor),selectedColor);
  assert.notEqual(await css.evaluate(e=>getComputedStyle(e).backgroundColor),selectedColor);
  assert.equal(await page.locator('#evidence h3').innerText(),'dist/index.js');
 }finally{try{await browser?.close();}finally{await server.close();}}
});

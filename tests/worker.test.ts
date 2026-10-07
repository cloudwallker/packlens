import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './helpers.ts';
import { withShadow } from '../src/oracle.ts';
import { snapshotPackage } from '../src/snapshot.ts';

test('deadline terminates real synchronous busy worker before cleanup and prevents late writes', async () => {
  const api = await import('../src/worker.ts').catch(() => null);
  assert.ok(api?.runWorker, 'missing hard deadline worker boundary');
  const f = await fixture({});
  try {
    await assert.rejects(api.runWorker(new URL('./busy-worker.cjs', import.meta.url), { marker:join(f.root,'late.txt') }, 100), /LIMIT_EXCEEDED/);
    await new Promise(resolve => setTimeout(resolve, 500));
    await assert.rejects(fs.stat(join(f.root,'late.txt')),{code:'ENOENT'});
  } finally { await f.cleanup(); }
});

test('real worker resource-limit failure remains LIMIT_EXCEEDED', async () => {
  const {runWorker}=await import('../src/worker.ts');
  await assert.rejects(runWorker(new URL('./limit-worker.cjs',import.meta.url),{},1000),/LIMIT_EXCEEDED/);
});

test('real worker deadline finishes termination before private shadow cleanup', async () => {
  const { runWorker } = await import('../src/worker.ts');
  const f = await fixture({}); let shadow='';
  try {
    await assert.rejects(withShadow(await snapshotPackage(f.root),async root => { shadow=root; return runWorker(new URL('./busy-worker.cjs', import.meta.url),{marker:join(root,'late.txt')},100); }),/LIMIT_EXCEEDED/);
    await assert.rejects(fs.stat(shadow),{code:'ENOENT'});
    await new Promise(resolve => setTimeout(resolve,500)); await assert.rejects(fs.stat(shadow),{code:'ENOENT'});
  } finally { await f.cleanup(); }
});

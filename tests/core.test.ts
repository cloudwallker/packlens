import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { analyzePackage } from '../src/analyze.ts';

function entry(report: Awaited<ReturnType<typeof analyzePackage>>, path: string) { return report.entries.find(e => e.path === path)!; }
function reasons(report: Awaited<ReturnType<typeof analyzePackage>>, path: string) { return report.evidence.filter(e => entry(report, path).evidenceIds.includes(e.evidenceId)); }

test('analysis excludes 2048-byte CSS and preserves forced root README', async () => {
  const f = await fixture({ 'dist/style.css': Buffer.alloc(2048), 'dist/index.js': 'module.exports=1', 'dist/.npmignore': '# resources\n*.css\n', '.npmignore': 'README.md\n', 'README.md': 'synthetic' });
  try {
    const api = await import('../src/analyze.ts').catch(() => null);
    assert.ok(api?.analyzePackage, 'missing analyzePackage behavior');
    const report = await api.analyzePackage(f.root);
    assert.deepEqual(report.scenario.oracleFiles, ['README.md', 'dist/index.js', 'package.json']);
    const css = report.entries.find(e => e.path === 'dist/style.css');
    assert.equal(css?.membership, 'excluded');
    assert.equal(css?.rawBytes, '2048');
  } finally { await f.cleanup(); }
});

test('CRLF comments and blanks preserve physical exclusion line 2', async () => {
  const f = await fixture({ 'dist/a.css': 'css', 'dist/.npmignore': '# comment\r\n*.css\r\n\r\n# final\r\n' });
  try {
    const report = await analyzePackage(f.root);
    assert.equal(entry(report, 'dist/a.css').explanationStatus, 'confirmed');
    const reason = reasons(report, 'dist/a.css').find(e => e.changed && !e.after)!;
    const source = report.ruleSources.find(s => reason.candidateSources.includes(s.sourceId))!;
    assert.equal(source.path, 'dist/.npmignore');
    assert.equal(source.line, 2);
  } finally { await f.cleanup(); }
});

test('files disables root ignore while root README has builtin forced evidence', async () => {
  const f = await fixture({ 'dist/a.js': 'a', '.npmignore': 'dist/\nREADME.md\n', 'README.md': 'read' }, { files: ['dist'] });
  try {
    const report = await analyzePackage(f.root);
    assert.equal(entry(report, 'dist/a.js').membership, 'included');
    assert.ok(report.ruleSources.some(s => s.path === '.npmignore' && s.active === false && s.inactiveReason === 'FILES_ROOT_OVERRIDE'));
    assert.equal(entry(report, 'README.md').explanationStatus, 'confirmed');
    assert.ok(reasons(report, 'README.md').some(e => e.candidateSources.some(id => report.ruleSources.find(s => s.sourceId === id)?.builtinId?.includes('readme'))));
  } finally { await f.cleanup(); }
});

test('ancestor exclusion is recorded without crediting unvisited child ignore', async () => {
  const f = await fixture({ 'blocked/a.css': 'a', '.npmignore': 'blocked/\n', 'blocked/.npmignore': '*.css\n' });
  try {
    const report = await analyzePackage(f.root);
    assert.equal(entry(report, 'blocked/a.css').membership, 'excluded');
    assert.equal(entry(report, 'blocked/a.css').explanationStatus, 'confirmed');
    const reason = reasons(report, 'blocked/a.css').find(e => e.decision === 'ancestor_block')!;
    assert.ok(reason.ancestorChain.includes('blocked'));
    assert.ok(!reason.candidateSources.some(id => report.ruleSources.find(s => s.sourceId === id)?.path === 'blocked/.npmignore'));
  } finally { await f.cleanup(); }
});

test('duplicate files expansion retains both JSON pointers as ambiguous', async () => {
  const f = await fixture({ 'a.js': 'a' }, { files: ['a.js', 'a.js'] });
  try {
    const report = await analyzePackage(f.root);
    assert.equal(entry(report, 'a.js').explanationStatus, 'ambiguous');
    const sources = reasons(report, 'a.js').flatMap(e => e.candidateSources).map(id => report.ruleSources.find(s => s.sourceId === id)?.jsonPointer);
    assert.ok(sources.includes('/files/0'));
    assert.ok(sources.includes('/files/1'));
  } finally { await f.cleanup(); }
});

test('escaped ignore names and repeated rules preserve actual physical first decision', async () => {
  const f=await fixture({'#item.txt':'a','!item.txt':'b','a.css':'c','.npmignore':'# comment\n\\#item.txt\n\\!item.txt\n\n*.css\n*.css\n'});
  try { const r=await analyzePackage(f.root); for(const [path,line] of [['#item.txt',2],['!item.txt',3],['a.css',5]] as const) { assert.equal(entry(r,path).membership,'excluded'); assert.equal(entry(r,path).explanationStatus,'confirmed'); const reason=reasons(r,path).filter(e=>e.changed&&!e.after).at(-1)!; assert.equal(r.ruleSources.find(s=>reason.candidateSources.includes(s.sourceId))?.line,line); } }
  finally { await f.cleanup(); }
});

test('dynamic normalized bin targets never masquerade as static builtin rules', async () => {
  const f=await fixture({'cli.js':'a'},{files:[],bin:{'tools/execute':'./cli.js'}});
  try { const r=await analyzePackage(f.root); assert.equal(entry(r,'cli.js').membership,'included'); assert.equal(entry(r,'cli.js').explanationStatus,'unknown'); }
  finally { await f.cleanup(); }
});

test('main and simple normalized string bin retain exact JSON pointers', async () => {
  const f=await fixture({'main.js':'a','cli.js':'b'},{files:[],main:'main.js',bin:'cli.js'});
  try { const r=await analyzePackage(f.root); for(const [path,pointer] of [['main.js','/main'],['cli.js','/bin']] as const) { assert.equal(entry(r,path).explanationStatus,'confirmed'); assert.ok(reasons(r,path).some(e=>e.candidateSources.some(id=>r.ruleSources.find(s=>s.sourceId===id)?.jsonPointer===pointer))); } }
  finally { await f.cleanup(); }
});

test('I2 bin normalization collision cannot confirm b.js to the a.js source pointer', async () => {
  const f=await fixture({'a.js':'a','b.js':'b'},{files:[],bin:{x:'a.js','tools/x':'b.js'}});
  try {
    const report=await analyzePackage(f.root);
    assert.equal(report.complete,true);
    assert.deepEqual(report.scenario.oracleFiles,['b.js','package.json']);
    assert.equal(entry(report,'b.js').membershipValidity,'verified_packlist');
    assert.equal(entry(report,'b.js').explanationStatus,'unknown');
    const decision=reasons(report,'b.js').find(e=>e.pattern==='!/b.js'&&e.changed)!;
    assert.ok(decision,'official bin inclusion must still be recorded');
    assert.equal(decision.sourceMapping,'unknown');
    assert.ok(!decision.candidateSources.includes('manifest:/bin/x'),'the original /bin/x value is a.js');
    assert.ok(!report.ruleSources.some(s=>s.sourceId==='manifest:/bin/x'&&decision.candidateSources.includes(s.sourceId)));
  } finally { await f.cleanup(); }
});

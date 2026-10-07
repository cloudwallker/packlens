import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, cliFiles, actualFiles } from './helpers.ts';
import { analyzePackage } from '../src/analyze.ts';
import { runtimeProfile, rootNode, require } from '../src/profile.ts';

const matrix = [
  { name: 'absent files', manifest: {}, files: { 'a.js': 'a', 'dist/b.css': 'b' }, want: ['a.js','dist/b.css','package.json'] },
  { name: 'empty files', manifest: { files: [] }, files: { 'a.js': 'a' }, want: ['package.json'] },
  { name: 'npmignore outranks gitignore', manifest: {}, files: { '.gitignore': 'a.js\n', '.npmignore': 'b.js\n', 'a.js':'a','b.js':'b' }, want: ['a.js','package.json'] },
  { name: 'files root inactive nested active', manifest: { files: ['dist'] }, files: { '.npmignore': 'dist/\n', 'dist/.npmignore': '*.css\n','dist/a.js':'a','dist/b.css':'b' }, want: ['dist/a.js','package.json'] },
  { name: 'exact files nested ignore', manifest: { files: ['dist/b.css'] }, files: { 'dist/.npmignore':'*.css\n','dist/b.css':'b' }, want: ['package.json'] },
  { name: 'directory glob nested ignore', manifest: { files: ['dist/**'] }, files: { 'dist/.npmignore':'*.css\n','dist/b.css':'b','dist/a.js':'a' }, want: ['dist/a.js','package.json'] },
  { name: 'multilevel negation', manifest: {}, files: { '.npmignore':'*.css\n!dist/\n', 'dist/.npmignore':'!a.css\n', 'dist/deep/.npmignore':'b.css\n', 'dist/a.css':'a', 'dist/deep/b.css':'b' }, want: ['dist/a.css','package.json'] },
  { name: 'blocked ancestor', manifest: {}, files: { '.npmignore':'dist/\n', 'dist/.npmignore':'!a.js\n', 'dist/a.js':'a' }, want: ['package.json'] },
  { name: 'zero match', manifest: { files: ['absent/**/*.js'] }, files: { 'a.js':'a' }, want: ['package.json'] },
  { name: 'main bin browser and metadata forced', manifest: { files: [], main:'index.js', bin:'cli.js', browser:'browser.js' }, files: { 'index.js':'i','cli.js':'c','browser.js':'b','README.md':'r','LICENSE':'l','types.d.ts':'t','.npmignore':'*\n' }, want: ['LICENSE','README.md','browser.js','cli.js','index.js','package.json'] },
  { name: 'files negate expanded directory', manifest: { files:['dist','!dist/private'] }, files: { 'dist/a.js':'a','dist/private/b.js':'b' }, want: ['dist/a.js','package.json'] },
  { name: 'brace glob and escaped spaces', manifest: { files:['dist/*.{js,css}', 'assets/a b.txt'] }, files: { 'dist/a.js':'a','dist/b.css':'b','dist/x.json':'x','assets/a b.txt':'t' }, want: ['assets/a b.txt','dist/a.js','dist/b.css','package.json'] },
  { name: 'broad glob folded exclusions and nested manifest', manifest: { files:['**/*'] }, files: { '.npmrc':'synthetic=nothing', '.git/deep/config':'synthetic', 'node_modules/dependency/index.js':'synthetic', 'nested/package.json':'invalid ordinary JSON', 'a.js':'a' }, want: ['a.js','nested/package.json','package.json'] },
] satisfies { name:string; manifest:object; files:Record<string,string>; want:string[] }[];

for (const row of matrix) test(`four-way differential: ${row.name}`, async () => {
  const f = await fixture(row.files, row.manifest);
  try {
    const report = await analyzePackage(f.root);
    assert.equal(report.complete, true);
    assert.deepEqual(report.scenario.oracleFiles, row.want);
    assert.deepEqual(report.scenario.tracedFiles, row.want);
    assert.deepEqual(await actualFiles(f.root), row.want);
    assert.deepEqual(await cliFiles(f.root), row.want);
    if (row.name === 'zero match') assert.ok(report.ruleSources.some(s => s.jsonPointer === '/files/0' && s.zeroMatch));
  } finally { await f.cleanup(); }
});

test('actual npm CLI and independent oracle dependency profiles agree', () => {
  const p = runtimeProfile();
  assert.equal(p.cliVersions.npm, '12.2.0');
  for (const name of ['npm-packlist','@npmcli/arborist','ignore-walk','glob','minimatch','@npmcli/package-json','npm-normalize-package-bin']) assert.equal(p.versions[name], p.cliVersions[name], name);
  assert.ok(p.supportedFeatures.includes('files-negation'));
  assert.ok(p.supportedFeatures.includes('files-brace-glob'));
});

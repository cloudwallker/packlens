import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function fixture(files: Record<string, string | Buffer>, manifest: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'packlens-test-'));
  for (const [path, body] of Object.entries({ 'package.json': JSON.stringify({ name: 'synthetic-packlens', version: '1.0.0', ...manifest }), ...files })) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
  }
  return { root, async cleanup() {
    const base = resolve(tmpdir());
    const child = relative(base, resolve(root));
    if (!child.startsWith('packlens-test-') || child.includes('..') || isAbsolute(child)) throw new Error('unsafe fixture cleanup');
    await rm(root, { recursive: true, force: true });
  } };
}

const require = createRequire(import.meta.url);
export async function cliFiles(root: string): Promise<string[]> {
  const isolation = await mkdtemp(join(tmpdir(), 'packlens-cli-'));
  try {
    for (const name of ['user', 'global', 'ignore']) await writeFile(join(isolation, name), '');
    const cli = join(require.resolve('npm/package.json'), '..', 'bin', 'npm-cli.js');
    const args = [cli, 'pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--loglevel=error', '--update-notifier=false', `--cache=${join(isolation,'cache')}`, `--userconfig=${join(isolation,'user')}`, `--globalconfig=${join(isolation,'global')}`, `--global-ignore-file=${join(isolation,'ignore')}`, `--pack-destination=${isolation}`];
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['PATH', 'SystemRoot', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, timeout: 30_000 });
      let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`isolated npm CLI failed (${code}): ${err.slice(0,500)}`)));
    });
    // npm 12 buffers JSON keyed by package name (not npm 11's array).
    const records = Object.values(JSON.parse(output)) as { files: { path: string }[] }[];
    if (records.length !== 1 || !Array.isArray(records[0].files)) throw Error('unexpected pinned CLI JSON schema');
    return [...new Set<string>(records[0].files.map(f => f.path.replace(/^\.\//,'')))].sort();
  } finally {
    const child = relative(resolve(tmpdir()), resolve(isolation));
    if (!child.startsWith('packlens-cli-') || child.includes('..') || isAbsolute(child)) throw Error('unsafe CLI cleanup');
    await rm(isolation, { recursive: true, force: true });
  }
}
export async function actualFiles(root: string): Promise<string[]> {
  const Arborist = require('@npmcli/arborist');
  const tree = await new Arborist({ path: root }).loadActual();
  return (await require('npm-packlist')(tree)).map((p: string) => p.replace(/^\.\//, '')).sort();
}

// Consume a request's budget at the analysis-to-intent boundary without a
// thirty-second wait. Workers and real filesystem operations remain intact.
export async function expireBeforeIntent<T>(timeoutMs:number,action:()=>Promise<T>) {
  const original=Date.now,started=original();let expired=false;
  Date.now=()=>{if(new Error().stack?.includes('at evaluateIntent'))expired=true;return started+(expired?timeoutMs+1:0);};
  try{return {value:await action(),expired};}finally{Date.now=original;}
}

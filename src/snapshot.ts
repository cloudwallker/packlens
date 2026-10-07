import { promises as fs } from 'node:fs';
import { resolve, relative, isAbsolute, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from './cancellation.ts';
import { createRequire } from 'node:module';
import type { Snapshot, Limits, Diagnostic, SourceLocation } from './model.ts';

export const DEFAULT_LIMITS: Limits = { maxNodes: 50_000, maxDepth: 64, maxRuleBytes: 1024 * 1024, maxTotalRuleBytes: 8 * 1024 * 1024, timeoutMs: 30_000 };
type Stamp = { size: string; mtime: string; ctime: string; ino: string; mode: string };
export interface SnapshotContext { root: string; stamps: Map<string, Stamp>; started: number }
const contexts = new WeakMap<Snapshot, SnapshotContext>();
export function snapshotContext(snapshot: Snapshot) { return contexts.get(snapshot); }
export function inheritSnapshotContext(base: Snapshot, derived: Snapshot) { const c = contexts.get(base); if (c) contexts.set(derived, c); }
/** Rule/manifest edits change only derived records. The baseline filesystem
 * fingerprints remain those of the original capture, without exporting root. */
export function deriveSnapshot(base: Snapshot, derived: Snapshot): Snapshot { inheritSnapshotContext(base, derived); return freezeSnapshot(derived); }
export function inside(root: string, target: string) { const r = relative(resolve(root), resolve(target)); return r === '' || (!r.startsWith('..' + '/') && !r.startsWith('..' + '\\') && r !== '..' && !isAbsolute(r)); }
export function safeRelative(path: string) { return typeof path === 'string' && path !== '' && !isAbsolute(path) && !/^[a-zA-Z]:/.test(path) && !path.includes('\\') && !path.split('/').some(p => p === '..' || p === '.' || p === ''); }
function stamp(s: { size: bigint; mtimeNs: bigint; ctimeNs: bigint; ino: bigint; mode: bigint }) { return { size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs), ino: String(s.ino), mode: String(s.mode) }; }
function same(a: Stamp, b: Stamp) { return JSON.stringify(a) === JSON.stringify(b); }
export class PackageInputError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }

// The fixed upstream expander can silently truncate at 4,000,000 characters.
// Prove every intermediate expansion fits our smaller UTF-8 budget first.
export const MAX_FILES_EXPANSION_BYTES = 1_048_576;
type ExpansionBound = { count: number; bytes: number };
function filesExpansionBound(pattern: string, maxCount: number): ExpansionBound {
  const fail = (): never => { throw new PackageInputError('LIMIT_EXCEEDED'); };
  const bound = (count: number, bytes: number): ExpansionBound => {
    if (count > maxCount || bytes > MAX_FILES_EXPANSION_BYTES) fail();
    return { count, bytes };
  };
  const concat = (a: ExpansionBound, b: ExpansionBound) => bound(a.count*b.count, a.bytes*b.count+b.bytes*a.count);
  // Escaped braces use random upstream sentinels; malformed braces can trigger
  // rewrites. Neither belongs to the grammar whose complete bounds we prove.
  if (/[{}]/.test(pattern) && (/[\\$]/.test(pattern) || pattern.startsWith('{}'))) fail();
  let i=0;
  const parse = (depth: number): ExpansionBound => {
    if (depth > 1000) fail();
    let result=bound(1,0);
    while(i<pattern.length && !'},'.includes(pattern[i])) {
      if(pattern[i]!=='{') {
        const start=i;while(i<pattern.length && !'{},'.includes(pattern[i]))i++;
        result=concat(result,bound(1,Buffer.byteLength(pattern.slice(start,i))));
        continue;
      }
      i++;const start=i;let part=parse(depth+1),options=false;
      while(pattern[i]===','){options=true;i++;const next=parse(depth+1);part=bound(part.count+next.count,part.bytes+next.bytes);}
      if(pattern[i]!=='}')fail();
      const body=pattern.slice(start,i++);
      if(!options) {
        const sequence=body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/) ?? body.match(/^([a-zA-Z])\.\.([a-zA-Z])(?:\.\.(-?\d+))?$/);
        if(sequence){
          const alpha=/^[a-zA-Z]$/.test(sequence[1]);
          const from=alpha?BigInt(sequence[1].charCodeAt(0)):BigInt(sequence[1]),to=alpha?BigInt(sequence[2].charCodeAt(0)):BigInt(sequence[2]);
          let step=sequence[3]?BigInt(sequence[3]):1n;if(step<0n)step=-step;if(!step)step=1n;
          const count=(from>to?from-to:to-from)/step+1n;if(count>BigInt(maxCount))fail();
          // Upstream numeric iteration uses Number; reject ranges that cannot
          // advance exactly rather than claiming this BigInt proof describes it.
          if(!alpha && [from,to,step].some(n=>n>BigInt(Number.MAX_SAFE_INTEGER)||n < -BigInt(Number.MAX_SAFE_INTEGER)))fail();
          const padded=/^-?0\d/.test(sequence[1])||/^-?0\d/.test(sequence[2])||/^-?0\d/.test(sequence[3]??'');
          let bytes=0;const width=Math.max(sequence[1].length,sequence[2].length);
          for(let n=0n;n<count;n++){const value=from+(from>to?-step:step)*n;bytes+=alpha?1:padded?Math.max(width,String(value).length):String(value).length;bound(Number(count),bytes);}
          part=bound(Number(count),bytes);
        } else {
          // A nested comma set without its own comma is wrapped in literal
          // braces by upstream. Ordinary non-expanding groups are also literal.
          if(!body.includes(','))fail();
          part=concat(bound(1,2),part);
        }
      }
      result=concat(result,part);
    }
    return result;
  };
  // A top-level comma is literal; unmatched braces are not proven safe.
  let result=parse(0);
  while(pattern[i]===','){i++;result=concat(concat(result,bound(1,1)),parse(0));}
  if(i!==pattern.length)fail();
  return result;
}
const localRequire=createRequire(import.meta.url);
const packRequire=createRequire(localRequire.resolve('npm-packlist'));
const globRequire=createRequire(packRequire.resolve('glob'));
const braceExpand=globRequire('minimatch').braceExpand as (pattern:string,options:{braceExpandMax:number})=>string[];
export function validateFilesPaths(values:string[],maxExpansions=DEFAULT_LIMITS.maxNodes) {
  maxExpansions=Math.min(maxExpansions,DEFAULT_LIMITS.maxNodes);
  let expanded=0,totalBytes=0;
  const check=(value:string)=>{
    const path=value.replace(/^!+/,'').replace(/^\.\//,'');
    if(isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.split(/[\\/]/).includes('..') || path.includes('\0'))throw new PackageInputError('OUTSIDE_ROOT');
    return path;
  };
  for(const value of values) {
    check(value); // Never normalize a forbidden raw absolute path into acceptance.
    const path=value.replace(/^!+/,'').replace(/^\.?\//,'').replace(/\/+$/,'');
    if(!path)continue;
    filesExpansionBound(path,maxExpansions-expanded);
    let branches:string[];
    try{branches=braceExpand(path,{braceExpandMax:maxExpansions-expanded+1});}catch{throw new PackageInputError('INVALID_FILES');}
    expanded+=branches.length;if(expanded>maxExpansions)throw new PackageInputError('LIMIT_EXCEEDED');
    for(const branch of branches){check(branch);totalBytes+=Buffer.byteLength(branch);}
    if(totalBytes>MAX_FILES_EXPANSION_BYTES)throw new PackageInputError('LIMIT_EXCEEDED');
  }
}

// Strict JSON has already been parsed. This lexer records positions by JSON pointer;
// it never searches for a repeated string to infer its field location.
export function jsonLocations(text: string): Record<string, SourceLocation> {
  const locations: Record<string, SourceLocation> = {};
  let i = 0;
  const lineStarts = [0];
  for (let n=0; n<text.length; n++) if (text[n] === '\n') lineStarts.push(n + 1);
  const skipWhitespace = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const recordLocation = (pointer: string) => {
    let low=0, high=lineStarts.length;
    while(low+1<high) {
      const mid=Math.floor((low+high)/2);
      if(lineStarts[mid] <= i) low=mid;
      else high=mid;
    }
    locations[pointer] = { line:low+1, column:i-lineStarts[low]+1, jsonPointer:pointer };
  };
  const readString = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i++] === '"') break;
      if (text[i - 1] === '\\') i++;
    }
    return JSON.parse(text.slice(start, i)) as string;
  };
  const walk = (pointer: string) => {
    skipWhitespace();
    recordLocation(pointer);
    if (text[i] === '{') {
      i++;skipWhitespace();
      while (text[i] !== '}') {
        const key = readString();
        skipWhitespace();i++;
        const escapedKey=key.replace(/~/g, '~0').replace(/\//g, '~1');
        walk(pointer + '/' + escapedKey);
        skipWhitespace();
        if (text[i] !== ',') break;
        i++;skipWhitespace();
      }
      i++;
    } else if (text[i] === '[') {
      i++;skipWhitespace();
      let index = 0;
      while (text[i] !== ']') {
        walk(pointer + '/' + index++);
        skipWhitespace();
        if (text[i] !== ',') break;
        i++;
      }
      i++;
    } else if (text[i] === '"') readString();
    else while (i < text.length && !/[\s,}\]]/.test(text[i])) i++;
  };
  walk('');
  return locations;
}

function declaredPaths(manifest: Record<string, unknown>): string[] {
  const declared: string[] = [...(manifest.files ?? []) as string[]];
  for (const field of ['main', 'browser']) if (typeof manifest[field] === 'string') declared.push(manifest[field]);
  if (typeof manifest.bin === 'string') declared.push(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
    for (const value of Object.values(manifest.bin)) if (typeof value === 'string') declared.push(value);
  }
  return declared;
}
function missingCandidate(value: string, snapshot: Snapshot): string | undefined {
  const path = value.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!safeRelative(path) || /[!\*?{}\[\]\\()]/.test(path)) return undefined;
  return snapshot.entries.some(entry => entry.path === path) ? undefined : path;
}

export interface SnapshotOptions { limits?: Partial<Limits>; onEntry?: (path: string) => void | Promise<void> }
export async function snapshotPackage(dir: string, options: SnapshotOptions = {}): Promise<Snapshot> {
  const requestedRoot = resolve(dir), started = Date.now(), limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) if (!Number.isInteger(limits[key]) || limits[key] < 0 || limits[key] > DEFAULT_LIMITS[key]) throw new PackageInputError('INVALID_LIMIT');
  const rootStat = await fs.lstat(requestedRoot, { bigint: true }).catch(() => { throw new PackageInputError('ROOT_UNAVAILABLE'); });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new PackageInputError('ROOT_NOT_DIRECTORY');
  const root = await fs.realpath(requestedRoot);
  const snapshot: Snapshot = { snapshotId: randomUUID(), projectLabel: basename(root), capturedAt: new Date().toISOString(), complete: true, limits, entries: [], ruleSources: [], manifest: {}, manifestText: '', manifestLocations: {}, uncoveredInputs: [], diagnostics: [] };
  const stamps = new Map<string, Stamp>(); let total = 0;
  const diagnostic = (code: string, path?: string) => { snapshot.complete = false; snapshot.diagnostics.push({ code, severity: 'error', scope: 'snapshot', message: code, relativePath: path }); };
  const uncover = (code: string, path?: string) => { snapshot.uncoveredInputs.push(code); snapshot.diagnostics.push({ code, severity: 'warning', scope: 'snapshot', message: code, relativePath: path }); };
  const readRule = async (path: string, size: number) => {
    if (size > limits.maxRuleBytes || total + size > limits.maxTotalRuleBytes) { diagnostic('LIMIT_EXCEEDED', path); return undefined; }
    total += size;
    const target = resolve(root, path);
    if (!inside(root, target)) throw new PackageInputError('OUTSIDE_ROOT');
    if (!inside(root, await fs.realpath(target))) { diagnostic('STALE', path); return undefined; }
    const before = await fs.lstat(target, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) { uncover('LINK_OR_SPECIAL', path); return undefined; }
    const handle = await fs.open(target, 'r');
    try {
      const openStat = await handle.stat({ bigint: true });
      if (!same(stamp(before), stamp(openStat))) { diagnostic('STALE', path); return undefined; }
      // Bounded reads also protect against a file growing after the first stat.
      const buffer = Buffer.alloc(limits.maxRuleBytes + 1); let used = 0;
      while (used < buffer.length) { const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used); if (!bytesRead) break; used += bytesRead; }
      if (used > limits.maxRuleBytes || used !== size) { diagnostic(used > limits.maxRuleBytes ? 'LIMIT_EXCEEDED' : 'STALE', path); return undefined; }
      const after = await fs.lstat(target, { bigint: true });
      if (!same(stamp(before), stamp(after))) { diagnostic('STALE', path); return undefined; }
      return buffer.subarray(0, used).toString('utf8');
    } finally { await handle.close(); }
  };
  const scan = async (path: string, depth: number): Promise<void> => {
    if (Date.now() - started > limits.timeoutMs || depth > limits.maxDepth || snapshot.entries.length >= limits.maxNodes) { diagnostic('LIMIT_EXCEEDED', path); return; }
    const target = resolve(root, path); if (!inside(root, target)) throw new PackageInputError('OUTSIDE_ROOT');
    const s = await fs.lstat(target, { bigint: true }); stamps.set(path, stamp(s as never));
    const collapsed = path === '.git' || path === 'node_modules';
    const kind = s.isSymbolicLink() ? 'link' : collapsed ? 'collapsed' : s.isDirectory() ? 'directory' : s.isFile() ? 'file' : 'special';
    snapshot.entries.push({ path, kind, exists: true, rawBytes: kind === 'file' ? String(s.size) : '0', membership: 'unknown', membershipValidity: 'uncovered', explanationStatus: 'unknown', evidenceIds: [] });
    if (kind === 'link' || kind === 'special') { uncover('LINK_OR_SPECIAL', path); return; }
    if (collapsed) return;
    if (!inside(root, await fs.realpath(target))) { diagnostic('STALE', path); return; }
    if (kind === 'file' && (path === 'package.json' || basename(path) === '.npmignore' || basename(path) === '.gitignore')) {
      const text = await readRule(path, Number(s.size)); if (text !== undefined) {
        if (path === 'package.json') snapshot.manifestText = text;
        else snapshot.ruleSources.push({ sourceId: path, kind: basename(path) === '.npmignore' ? 'npmignore' : 'gitignore', path, text });
      }
    }
    if (path === '.npmrc') snapshot.diagnostics.push({ code: 'CONFIG_NOT_APPLIED', severity: 'info', scope: 'snapshot', message: 'Project npm configuration is not read or applied.', relativePath: path });
    if (path === '.npm-extension.mjs' || path === '.npm-extension.cjs') uncover('NPM_EXTENSION', path);
    await options.onEntry?.(path);
    if (kind === 'directory') {
      const current = await fs.lstat(target, { bigint: true });
      if (!same(stamp(s), stamp(current)) || current.isSymbolicLink() || !inside(root, await fs.realpath(target))) { diagnostic('STALE', path); return; }
      const children = (await fs.readdir(target)).sort(); const caseNames = new Set<string>();
      for (const child of children) { const folded = child.toLowerCase(); if (caseNames.has(folded)) uncover('CASE_COLLISION', path); caseNames.add(folded); await scan(path + '/' + child, depth + 1); if (!snapshot.complete && snapshot.diagnostics.some(d => d.code === 'LIMIT_EXCEEDED')) break; }
    }
  };
  stamps.set('', stamp(rootStat));
  try {
    const rootNames=new Set<string>();
    for (const name of (await fs.readdir(root)).sort()) {
      const folded=name.toLowerCase(); if(rootNames.has(folded)) uncover('CASE_COLLISION',name); rootNames.add(folded);
      await scan(name,1); if(snapshot.diagnostics.some(d=>d.code==='LIMIT_EXCEEDED')) break;
    }
  } catch (error) { if (error instanceof PackageInputError) throw error; diagnostic('IO_ERROR'); }
  if (!snapshot.manifestText && snapshot.complete) throw new PackageInputError('MANIFEST_UNAVAILABLE');
  if (snapshot.manifestText) {
    try { const parsed: unknown = JSON.parse(snapshot.manifestText); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); snapshot.manifest = parsed as Record<string, unknown>; snapshot.manifestLocations = jsonLocations(snapshot.manifestText); } catch { throw new PackageInputError('INVALID_MANIFEST'); }
    const m = snapshot.manifest;
    if (m.files !== undefined && (!Array.isArray(m.files) || m.files.some(p => typeof p !== 'string'))) throw new PackageInputError('INVALID_FILES');
    validateFilesPaths((m.files ?? []) as string[],limits.maxNodes);
    if (((m.files ?? []) as string[]).some(p => /\\|\[|\]|[?+@*!]\(/.test(p))) uncover('FILES_SYNTAX_UNCOVERED');
    if ((m.bundleDependencies && (!Array.isArray(m.bundleDependencies) || m.bundleDependencies.length)) || (m.bundledDependencies && (!Array.isArray(m.bundledDependencies) || m.bundledDependencies.length))) uncover('BUNDLES');
    if (m.workspaces !== undefined) uncover('WORKSPACES');
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) if (Object.values((m[key] ?? {}) as object).some(v => typeof v === 'string' && v.startsWith('workspace:'))) uncover('WORKSPACE_DEPENDENCY');
    for (const key of ['patchedDependencies', 'publishConfig', 'directories']) if (m[key] !== undefined) uncover('MANIFEST_EXTENSION_' + key);
    if (m.browser && typeof m.browser !== 'string') uncover('BROWSER_OBJECT');
    if (Array.isArray(m.bin)) uncover('BIN_ARRAY_UNCOVERED');
    for (const value of declaredPaths(m)) {
      const path=missingCandidate(value,snapshot);
      if (path===undefined) continue;
      if (snapshot.entries.length >= limits.maxNodes) { diagnostic('LIMIT_EXCEEDED'); break; }
      snapshot.entries.push({ path, kind:'file', exists:false, rawBytes:'0', membership:'missing', membershipValidity:'uncovered', explanationStatus:'not_applicable', evidenceIds:[] });
    }
  }
  contexts.set(snapshot, { root, stamps, started });
  const stale = await checkSnapshot(snapshot,started+limits.timeoutMs); if (stale) diagnostic(stale === '<limit>' ? 'LIMIT_EXCEEDED' : 'STALE', stale.startsWith('<') ? undefined : stale);
  return freezeSnapshot(snapshot);
}
export function freezeSnapshot(snapshot: Snapshot): Snapshot {
  const freeze = (value: any) => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } };
  freeze(snapshot); return snapshot;
}
export async function checkSnapshot(snapshot: Snapshot, deadline=Infinity, signal?: AbortSignal): Promise<string | undefined> {
  throwIfCancelled(signal);
  if (Date.now()>deadline) return '<limit>';
  const context = contexts.get(snapshot); if (!context) return undefined;
  for (const [path, before] of context.stamps) {
    throwIfCancelled(signal);
    if(Date.now()>deadline) return '<limit>';
    try { const after = await fs.lstat(join(context.root, path), { bigint: true }); if (!same(before, stamp(after as never))) return path || '<root>'; }
    catch { return path || '<root>'; }
  }
  throwIfCancelled(signal);
  return undefined;
}

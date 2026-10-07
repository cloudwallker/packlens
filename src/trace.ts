import { relative, join } from 'node:path';
import { require, rootNode } from './profile.ts';
import { normalizeFiles } from './oracle.ts';
import { jsonLocations } from './snapshot.ts';
import type { Snapshot, Evidence, RuleSource } from './model.ts';

const OfficialWalker = require('npm-packlist').Walker;
interface Frame { path: string; partial: boolean; included: boolean; events: Evidence[] }
export interface FilterDecision { path: string; partial: boolean; included: boolean; evidenceIds: string[]; blockedByParent: boolean }
export interface TraceResult { files: string[]; evidence: Evidence[]; sources: RuleSource[]; decisions: FilterDecision[]; visitedDirectories: string[] }
interface BinOrigin { rawKey:string; pointer:string; target:string }
interface Context { snapshot: Snapshot; root: string; evidence: Evidence[]; sources: Map<string, RuleSource>; frames: Frame[]; decisions: FilterDecision[]; visited: Set<string>; filesMap: Map<string, string[]>; binsMap:Map<string,BinOrigin[]>; deadline: number; trueLocations: Snapshot['manifestLocations'] }
const slash = (p: string) => p.replace(/\\/g, '/');
function builtin(context: Context, group: string, pattern: string): string {
  const id = `builtin:${group}:${pattern}`;
  context.sources.set(id, { sourceId: id, kind: 'builtin', path: 'npm-packlist/lib/index.js', builtinId: `npm-single-package-v1:${group}:${pattern}`, officialSource: 'npm-packlist@11.3.0/lib/index.js', text: pattern, active: true });
  return id;
}

// Expand each files item using the release's own processPackage. This observes
// original injected rules, and deliberately uses no separate glob implementation.
async function filesSources(context: Context) {
  const files = context.snapshot.manifest.files;
  if (!Array.isArray(files)) return;
  for (const [index, entry] of files.entries()) {
    if (Date.now() > context.deadline) throw new Error('LIMIT_EXCEEDED');
    const pointer = `/files/${index}`, id = `manifest:${pointer}`;
    const source: RuleSource = { sourceId: id, kind: 'files', path: 'package.json', jsonPointer: pointer, ...context.snapshot.manifestLocations[pointer], text: entry, active: true, generatedPatterns: [], virtualRevision:context.snapshot.manifestVirtualRevision };
    const tree = await rootNode(context.root, { ...context.snapshot.manifest, files: [entry] });
    const collector = new OfficialWalker(tree, { isPackage: true });
    collector.injectRules = (filename: unknown, rules: string[], callback = () => {}) => { if (filename === 'package.json') source.generatedPatterns = rules.slice(1); callback(); };
    OfficialWalker.prototype.processPackage.call(collector, () => {});
    source.zeroMatch = !source.generatedPatterns?.length;
    context.sources.set(id, source);
    for (const pattern of source.generatedPatterns ?? []) { const ids = context.filesMap.get(pattern) ?? []; if (!ids.includes(id)) ids.push(id); context.filesMap.set(pattern, ids); }
  }
}

// Observe the official normalization of each original bin entry, so key
// collisions are detected before a surviving key is used as a source pointer.
async function binSources(context:Context) {
  const bin=context.snapshot.manifest.bin;
  if(!bin || typeof bin !== 'object' || Array.isArray(bin)) return;
  for(const [rawKey,value] of Object.entries(bin)) {
    if(Date.now()>context.deadline) throw new Error('LIMIT_EXCEEDED');
    const single=await rootNode(context.root,{...context.snapshot.manifest,bin:{[rawKey]:value}});
    for(const [key,target] of Object.entries(single.package.bin ?? {})) {
      if(typeof target !== 'string') continue;
      const origins=context.binsMap.get(key) ?? [];
      origins.push({rawKey,pointer:'/bin/'+rawKey.replace(/~/g,'~0').replace(/\//g,'~1'),target});
      context.binsMap.set(key,origins);
    }
  }
}

class RecordingWalker extends OfficialWalker {
  // Published CJS Walker has no declarations. These members describe only
  // the inspected, fingerprinted release boundary, not a replacement engine.
  declare path: string;
  declare ignoreRules: Record<string | symbol, any[] | null>;
  declare tree: any;
  declare parent: RecordingWalker | null;
  declare exact: boolean;
  declare walkerOpt: (entry: string, options: unknown) => any;
  declare on: (event: string, callback: any) => this;
  declare start: () => this;
  context: Context;
  constructor(tree: unknown, options: any, context: Context) {
    super(tree, options);
    this.context = context;
    context.visited.add(slash(relative(context.root, this.path)));
    // Default injections happen during super(), before context is available.
    // Attach observers to those existing instance objects afterwards.
    for (const key of Reflect.ownKeys(this.ignoreRules)) this.wrapRules(key, undefined);
  }
  onReadIgnoreFile(file: unknown, data: string, callback: () => void) {
    super.onReadIgnoreFile(file, data, () => {});
    if (this.context) this.wrapRules(file, data);
    callback();
  }
  wrapRules(file: any, data: string | undefined) {
    const ctx = this.context; const group = typeof file === 'symbol' ? file.description?.split('.').at(-1) ?? 'unknown' : String(file);
    if (file === '.npmignore' || file === '.gitignore') { const path = slash(relative(ctx.root, join(this.path, file))); const source = ctx.sources.get(path); if (source) { source.active = true; source.inactiveReason = undefined; } }
    const physical = data?.split(/\r?\n/).map((text,line) => ({ text: text.trim(), line: line + 1, column: text.search(/\S/) + 1 })).filter(r => r.text && !r.text.startsWith('#'));
    (this.ignoreRules[file] ?? []).forEach((rule: any, index: number) => {
      if (rule.__packlensObserved) return;
      const pattern = rule.negate ? '!' + rule.pattern : rule.pattern;
      // rule.pattern is the parsed Minimatch input with leading negation stripped.
      // Physical raw input retains escaped leading characters and repeated '!'.
      const rawPattern = physical?.[index]?.text ?? pattern;
      let sourceIds: string[] = [];
      if (file === 'package.json') {
        sourceIds = rawPattern === '*' ? [builtin(ctx, 'files-deny-all', '*')] : ctx.filesMap.get(rawPattern) ?? [];
      } else if (file === '.npmignore' || file === '.gitignore') {
        const path = slash(relative(ctx.root, join(this.path, file)));
        const record = physical?.[index];
        if (record) { const id = `${path}:${record.line}`; sourceIds = [id]; ctx.sources.set(id, { sourceId: id, kind: file === '.npmignore' ? 'npmignore' : 'gitignore', path, line: record.line, column: record.column, text: record.text, active: true, virtualRevision:ctx.snapshot.ruleSources.find(s=>s.path===path)?.virtualRevision }); }
      } else {
        // This exact release has 17 static root strict rules. Later injected
        // entries come from manifest fields, so missing field mapping is unknown.
        const dynamic = group === 'strict' && index >= 17;
        sourceIds = dynamic ? [] : [builtin(ctx, group, rawPattern)];
        if (dynamic && rule.negate) {
          const normalized = this.tree.package; const manifest = ctx.snapshot.manifest;
          const pointers: string[] = [];
          for (const field of ['main', 'browser']) if (typeof manifest[field] === 'string' && rawPattern === `!/${normalized[field]}`) pointers.push('/' + field);
          for (const [key, value] of Object.entries(normalized.bin ?? {})) if (rawPattern === `!/${value}`) {
            if (typeof manifest.bin === 'string') pointers.push('/bin');
            else {
              const origins=ctx.binsMap.get(key) ?? [];
              const origin=origins.length===1 ? origins[0] : undefined;
              // Transformed keys remain outside confirmed coverage. Even an
              // unchanged key needs one origin and the same normalized target.
              if(origin && origin.rawKey===key && origin.target===value) pointers.push(origin.pointer);
            }
          }
          if (pointers.length) sourceIds = [...new Set(pointers)].map(pointer => { const id = 'manifest:' + pointer; ctx.sources.set(id, { sourceId: id, kind: 'manifest', path: 'package.json', jsonPointer: pointer, ...ctx.snapshot.manifestLocations[pointer], active: true, officialSource: 'Arborist Node normalization + npm-packlist@11.3.0/processPackage' }); return id; });
        }
      }
      const original = rule.match;
      Object.defineProperty(rule, '__packlensObserved', { value: true });
      rule.match = function(input: string, partial = false) {
        const result = original.call(this, input, partial);
        const frame = ctx.frames.at(-1);
        if (frame) {
          if (Date.now() > ctx.deadline || ctx.evidence.length > 200_000) throw new Error('LIMIT_EXCEEDED');
          let event = frame.events.find(e => e.ruleId === `${slash(relative(ctx.root, join((rule as any).__owner, '')))}/${group}/${index}`);
          if (!event) {
            const precise = sourceIds.every(id => {
              const source = ctx.sources.get(id); if (!source) return false;
              if (source.kind === 'builtin') return !!source.builtinId && !!source.officialSource;
              if (!Number.isInteger(source.line) || !Number.isInteger(source.column)) return false;
              if (source.kind === 'manifest' || source.kind === 'files') { const truth=ctx.trueLocations[source.jsonPointer ?? '']; return !!truth && truth.line===source.line && truth.column===source.column && truth.jsonPointer===source.jsonPointer; }
              return true;
            });
            event = { evidenceId: `e${ctx.evidence.length}`, path: frame.path, evaluationOrder: ctx.evidence.length, ruleId: `${slash(relative(ctx.root, join((rule as any).__owner, '')))}/${group}/${index}`, candidateSources: sourceIds, pattern: rawPattern, matched: false, before: frame.included, after: frame.included, changed: false, ancestorChain: [], sourceMapping: precise && sourceIds.length === 1 ? 'exact' : precise && sourceIds.length > 1 ? 'ambiguous' : 'unknown', basis: 'npm-packlist@11.3.0 + ignore-walk@9.0.0 original filterEntry/match; packlens-recording-v1', decision: group === 'strict' && rule.negate ? 'forced_include' : 'match', mode: frame.partial ? 1 : 0, matchCalls: [] };
            frame.events.push(event); ctx.evidence.push(event);
          }
          event.matchCalls!.push({ input, partial: !!partial, result: !!result });
          if (result) { event.matched = true; event.after = !!rule.negate; event.changed = event.before !== event.after; frame.included = event.after; }
        }
        return result;
      };
      Object.defineProperty(rule, '__owner', { value: this.path });
    });
  }
  filterEntry(entry: string, partial = false, entryBasename?: string) {
    const ctx = this.context;
    const frame: Frame = { path: slash(relative(ctx.root, join(this.path, entry))).replace(/\/$/, ''), partial: !!partial, included: true, events: [] };
    ctx.frames.push(frame);
    const result = super.filterEntry(entry, partial, entryBasename);
    ctx.frames.pop();
    ctx.decisions.push({ path: frame.path, partial: !!partial, included: !!result, evidenceIds: frame.events.filter(e => e.matched).map(e => e.evidenceId), blockedByParent: !!this.parent && !this.exact && !result && frame.events.length === 0 });
    // The parent return is exactly the initial included state used by the
    // original child's filterEntry. It is observed, not recalculated.
    const caller = ctx.frames.at(-1); if (caller) { caller.included = !!result; for (const event of frame.events) if (!caller.events.includes(event)) caller.events.push(event); }
    return result;
  }
  filterEntries() {
    const previous = new Map(['.npmignore', '.gitignore'].map(file => [file, this.ignoreRules[file]]));
    const result = super.filterEntries();
    for (const file of ['.npmignore', '.gitignore']) {
      if (previous.get(file) && this.ignoreRules[file] === null) {
        const path = slash(relative(this.context.root, join(this.path, file)));
        for (const source of this.context.sources.values()) if (source.path === path) { source.active = false; source.inactiveReason = this.ignoreRules['package.json'] ? 'FILES_ROOT_OVERRIDE' : 'NPMIGNORE_PRECEDENCE'; }
      }
    }
    return result;
  }
  walker(entry: string, options: unknown, callback: () => void) {
    new RecordingWalker(this.tree, this.walkerOpt(entry, options), this.context).on('done', callback).start();
  }
}

export async function traceFiles(root: string, snapshot: Snapshot): Promise<TraceResult> {
  const ctx: Context = { snapshot, root, evidence: [], sources: new Map(snapshot.ruleSources.map(s => [s.sourceId, { ...s, active: false, inactiveReason: 'NOT_VISITED' }])), frames: [], decisions: [], visited: new Set(), filesMap: new Map(), binsMap:new Map(), deadline: Date.now() + snapshot.limits.timeoutMs, trueLocations: jsonLocations(snapshot.manifestText) };
  await binSources(ctx);
  await filesSources(ctx);
  const tree = await rootNode(root, snapshot.manifest);
  const files: string[] = await new Promise((resolve, reject) => {
    new RecordingWalker(tree, { isPackage: true }, ctx).on('done', resolve).on('error', reject).start();
  });
  return { files: normalizeFiles(files), evidence: ctx.evidence, sources: [...ctx.sources.values()], decisions: ctx.decisions, visitedDirectories: [...ctx.visited] };
}

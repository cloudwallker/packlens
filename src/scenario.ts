import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Snapshot, Patch, PatchOperation, PackReport, Intent, Delta } from './model.ts';
import { deriveSnapshot, PackageInputError, safeRelative, jsonLocations, validateFilesPaths } from './snapshot.ts';
import { analyzeSnapshot } from './analyze.ts';
import type { AnalysisOptions } from './analyze.ts';
import { evaluateIntent, validateIntent } from './intent.ts';
import { throwIfCancelled } from './cancellation.ts';

function fail(code:string):never {throw new PackageInputError(code);}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const singleLine=(s:unknown):s is string=>typeof s==='string' && !/[\r\n\u0000]/.test(s);
function filesValue(value:unknown):asserts value is string[] {
  if(!Array.isArray(value) || value.some(p=>typeof p!=='string'))fail('INVALID_PATCH');
  validateFilesPaths(value);
}
export function validatePatch(value:unknown):asserts value is Patch {
  if(!value || typeof value!=='object' || Array.isArray(value))fail('INVALID_PATCH');
  const p=value as Record<string,unknown>;
  if(p.schemaVersion!==1 || !Array.isArray(p.operations) || Object.keys(p).some(k=>!['schemaVersion','baseSnapshotId','expectedRevision','operations'].includes(k)))fail('INVALID_PATCH');
  if(p.baseSnapshotId!==undefined && typeof p.baseSnapshotId!=='string')fail('INVALID_PATCH');
  if(p.expectedRevision!==undefined && (!Number.isSafeInteger(p.expectedRevision) || (p.expectedRevision as number)<0))fail('INVALID_PATCH');
  for(const raw of p.operations as unknown[]) {
    if(!raw || typeof raw!=='object' || Array.isArray(raw))fail('INVALID_PATCH');
    const o=raw as Record<string,unknown>;
    const allowed:Record<string,string[]>={replaceFiles:['value','expected'],removeIgnoreLine:['path','line','expected'],replaceIgnoreLine:['path','line','expected','value'],appendIgnoreLine:['path','value'],replaceIgnoreText:['path','value','expected'],createIgnore:['path','value'],deleteIgnore:['path','expected']};
    if(typeof o.op!=='string' || !Object.hasOwn(allowed,o.op) || Object.keys(o).some(k=>k!=='op' && !allowed[o.op as string].includes(k)))fail('INVALID_PATCH');
    if(o.op==='replaceFiles') {filesValue(o.value);if(o.expected!==undefined && o.expected!==null)filesValue(o.expected);continue;}
    if(typeof o.path!=='string' || !safeRelative(o.path) || /[\u0000-\u001f]/.test(o.path))fail('OUTSIDE_ROOT');
    if(!['.npmignore','.gitignore'].includes(basename(o.path)))fail('INVALID_IGNORE_PATH');
    if(['removeIgnoreLine','replaceIgnoreLine'].includes(o.op) && (!Number.isSafeInteger(o.line) || (o.line as number)<1 || !singleLine(o.expected)))fail('INVALID_PATCH');
    if(['replaceIgnoreLine','appendIgnoreLine'].includes(o.op) && !singleLine(o.value))fail('INVALID_PATCH');
    if(['replaceIgnoreText','createIgnore'].includes(o.op) && (typeof o.value!=='string' || o.value.includes('\0')))fail('INVALID_PATCH');
    if(o.expected!==undefined && typeof o.expected!=='string')fail('INVALID_PATCH');
  }
}
function physicalLines(text:string) {
  const result:{body:string;ending:string}[]=[];
  const re=/([^\r\n]*)(\r\n|\n|\r|$)/g;let m:RegExpExecArray|null;
  while((m=re.exec(text)) && m[0])result.push({body:m[1],ending:m[2]});
  return result.length?result:[{body:'',ending:''}];
}
function replaceFilesText(snapshot:Snapshot,value:string[]) {
  const text=snapshot.manifestText,loc=snapshot.manifestLocations['/files'];
  if(!loc) {
    const end=text.lastIndexOf('}'); if(end<0)fail('INVALID_MANIFEST');
    return text.slice(0,end)+(Object.keys(snapshot.manifest).length?',':'')+'"files":'+JSON.stringify(value)+text.slice(end);
  }
  const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
  const start=starts[loc.line-1]+loc.column-1;
  let end=start,depth=0,quoted=false,escaped=false;
  for(;end<text.length;end++) {
    const c=text[end];
    if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;
    else if(c==='[')depth++;
    else if(c===']' && --depth===0){end++;break;}
  }
  return text.slice(0,start)+JSON.stringify(value)+text.slice(end);
}
/** Validate every operation against the request baseline before deriving data. */
export function applyPatch(snapshot:Snapshot,patch:Patch):Snapshot {
  validatePatch(patch);
  const baseId=snapshot.baseSnapshotId ?? snapshot.snapshotId,revision=snapshot.revision ?? 0;
  if(patch.baseSnapshotId!==undefined && patch.baseSnapshotId!==baseId)fail('SNAPSHOT_MISMATCH');
  if(patch.expectedRevision!==undefined && patch.expectedRevision!==revision)fail('REVISION_MISMATCH');
  const groups=new Map<string,PatchOperation[]>();
  for(const op of patch.operations) {const key=op.op==='replaceFiles'?'package.json':op.path;groups.set(key,[...(groups.get(key)??[]),op]);}
  for(const [path,ops] of groups) {
    if(path==='package.json') {
      if(ops.length!==1)fail('AMBIGUOUS_PATCH');const op=ops[0] as Extract<PatchOperation,{op:'replaceFiles'}>;
      validateFilesPaths(op.value,snapshot.limits.maxNodes);
      if(op.expected!==undefined && !same(op.expected,snapshot.manifest.files ?? null))fail('EXPECTED_MISMATCH');continue;
    }
    const parent=path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';
    if(parent && !snapshot.entries.some(e=>e.path===parent && e.kind==='directory' && e.exists))fail('IGNORE_PARENT_UNAVAILABLE');
    if(snapshot.entries.some(e=>e.exists && e.path.toLowerCase()===path.toLowerCase() && e.path!==path))fail('CASE_COLLISION');
    const source=snapshot.ruleSources.find(s=>s.path===path),entry=snapshot.entries.find(e=>e.path===path);
    const whole=ops.filter(o=>['createIgnore','deleteIgnore','replaceIgnoreText'].includes(o.op));
    if(whole.length && ops.length!==1)fail('AMBIGUOUS_PATCH');
    const targeted=new Set<number>();const lines=physicalLines(source?.text??'');
    for(const op of ops) {
      if(op.op==='replaceFiles')continue;
      if(op.op==='createIgnore') {if(source || entry?.exists)fail('IGNORE_EXISTS');continue;}
      if(!source || !entry?.exists || entry.kind!=='file' || source.text===undefined)fail('IGNORE_UNAVAILABLE');
      if('line' in op) {if(targeted.has(op.line))fail('AMBIGUOUS_PATCH');targeted.add(op.line);if(lines[op.line-1]?.body!==op.expected)fail('EXPECTED_MISMATCH');}
      else if('expected' in op && op.expected!==undefined && op.expected!==source.text)fail('EXPECTED_MISMATCH');
    }
  }
  const next:Snapshot=structuredClone(snapshot);next.snapshotId=randomUUID();next.baseSnapshotId=baseId;next.revision=revision+1;next.appliedPatch=structuredClone(patch);
  for(const [path,ops] of groups) {
    if(path==='package.json') {
      const op=ops[0] as Extract<PatchOperation,{op:'replaceFiles'}>;next.manifestText=replaceFilesText(snapshot,op.value);next.manifest=JSON.parse(next.manifestText);next.manifestLocations=jsonLocations(next.manifestText);
      next.manifestVirtualRevision=revision+1;
      // Missing declaration markers are derived metadata, never ordinary assets.
      next.entries=next.entries.filter(e=>e.exists || ['.npmignore','.gitignore'].includes(basename(e.path)));
      const declared=[...op.value];
      for(const key of ['main','browser'])if(typeof next.manifest[key]==='string')declared.push(next.manifest[key] as string);
      if(typeof next.manifest.bin==='string')declared.push(next.manifest.bin);
      else if(next.manifest.bin && typeof next.manifest.bin==='object' && !Array.isArray(next.manifest.bin))for(const target of Object.values(next.manifest.bin))if(typeof target==='string')declared.push(target);
      for(const raw of declared){const path=raw.replace(/^\.\//,'').replace(/\/+$/,'');if(safeRelative(path) && !/[!*?{}\[\]\\()]/.test(path) && !next.entries.some(e=>e.path===path))next.entries.push({path,kind:'file',exists:false,rawBytes:'0',membership:'missing',membershipValidity:'uncovered',explanationStatus:'not_applicable',evidenceIds:[]});}
      next.entries.find(e=>e.path==='package.json')!.rawBytes=String(Buffer.byteLength(next.manifestText));
      next.uncoveredInputs=next.uncoveredInputs.filter(c=>c!=='FILES_SYNTAX_UNCOVERED');next.diagnostics=next.diagnostics.filter(d=>d.code!=='FILES_SYNTAX_UNCOVERED');
      if(op.value.some(p=>/\\|\[|\]|[?+@*!]\(/.test(p))) {next.uncoveredInputs.push('FILES_SYNTAX_UNCOVERED');next.diagnostics.push({code:'FILES_SYNTAX_UNCOVERED',severity:'warning',scope:'snapshot',message:'FILES_SYNTAX_UNCOVERED'});}
      continue;
    }
    let source=next.ruleSources.find(s=>s.path===path),entry=next.entries.find(e=>e.path===path);
    if(ops[0].op==='deleteIgnore') {next.ruleSources=next.ruleSources.filter(s=>s.path!==path);entry!.exists=false;entry!.rawBytes='0';continue;}
    let text=source?.text??'';
    if(ops[0].op==='createIgnore' || ops[0].op==='replaceIgnoreText')text=ops[0].value;
    else {
      const lines=physicalLines(text), edits=new Map(ops.filter(o=>'line' in o).map(o=>[(o as {line:number}).line,o]));
      text=lines.map((line,index)=>{const op=edits.get(index+1);if(op?.op==='removeIgnoreLine')return '';return (op?.op==='replaceIgnoreLine'?op.value:line.body)+line.ending;}).join('');
      const ending=lines.find(l=>l.ending)?.ending??'\n';
      for(const op of ops)if(op.op==='appendIgnoreLine')text+=(text && !/[\r\n]$/.test(text)?ending:'')+op.value+ending;
    }
    if(!source) {source={sourceId:path,kind:basename(path)==='.npmignore'?'npmignore':'gitignore',path};next.ruleSources.push(source);}
    source.text=text;source.virtualRevision=revision+1;
    if(!entry) {entry={path,kind:'file',exists:true,rawBytes:'0',membership:'unknown',membershipValidity:'uncovered',explanationStatus:'unknown',evidenceIds:[]};next.entries.push(entry);}
    entry.exists=true;entry.rawBytes=String(Buffer.byteLength(text));
  }
  if(next.entries.length>next.limits.maxNodes || next.entries.some(e=>e.path.split('/').length>next.limits.maxDepth))fail('LIMIT_EXCEEDED');
  const texts=[next.manifestText,...next.ruleSources.map(s=>s.text??'')];
  if(texts.some(t=>Buffer.byteLength(t)>next.limits.maxRuleBytes) || texts.reduce((n,t)=>n+Buffer.byteLength(t),0)>next.limits.maxTotalRuleBytes)fail('LIMIT_EXCEEDED');
  return deriveSnapshot(snapshot,next);
}
export function calculateDelta(base:PackReport,current:PackReport):Delta|undefined {
  if(!base.complete || !current.complete)return undefined;
  const before=new Map(base.entries.filter(e=>e.membership==='included').map(e=>[e.path,BigInt(e.rawBytes)]));
  const after=new Map(current.entries.filter(e=>e.membership==='included').map(e=>[e.path,BigInt(e.rawBytes)]));
  const addedPaths=[...after.keys()].filter(p=>!before.has(p)).sort(),removedPaths=[...before.keys()].filter(p=>!after.has(p)).sort();
  const added=addedPaths.reduce((n,p)=>n+after.get(p)!,0n),removed=removedPaths.reduce((n,p)=>n+before.get(p)!,0n);
  const retainedContentByteChanges=[...after.keys()].filter(p=>before.has(p) && before.get(p)!==after.get(p)).sort().map(path=>({path,beforeRawBytes:before.get(path)!.toString(),afterRawBytes:after.get(path)!.toString(),deltaRawBytes:(after.get(path)!-before.get(path)!).toString()}));
  return {addedPaths,removedPaths,addedRawBytes:added.toString(),removedRawBytes:removed.toString(),retainedContentByteChanges,netRawBytes:(added-removed+retainedContentByteChanges.reduce((n,c)=>n+BigInt(c.deltaRawBytes),0n)).toString()};
}
async function analyzeScenario(snapshot:Snapshot,base:PackReport|undefined,intent?:Intent,options:AnalysisOptions={}) {
  const deadline=Math.min(Date.now()+snapshot.limits.timeoutMs,options.deadline??Infinity);
  const report=await analyzeSnapshot(snapshot,{deadline,signal:options.signal});if(base)report.scenario.delta=calculateDelta(base,report);
  throwIfCancelled(options.signal);
  if(intent) {
    try{report.scenario.assertions=evaluateIntent(report,intent,{deadline});}
    catch(error){
      if(!(error instanceof PackageInputError) || error.code!=='LIMIT_EXCEEDED')throw error;
      report.complete=false;delete report.scenario.delta;
      if(!report.diagnostics.some(d=>d.code==='LIMIT_EXCEEDED'))report.diagnostics.push({code:'LIMIT_EXCEEDED',severity:'error',scope:'intent',message:'Scenario deadline was exceeded.'});
      for(const entry of report.entries){entry.membership='unknown';entry.membershipValidity='error';entry.explanationStatus='unknown';}
    }
  }
  throwIfCancelled(options.signal);
  return report;
}
export async function simulate(snapshot:Snapshot,patch:Patch,intent?:Intent,options:AnalysisOptions={}):Promise<PackReport> {
  throwIfCancelled(options.signal);
  const deadline=Math.min(Date.now()+snapshot.limits.timeoutMs,options.deadline??Infinity);
  if(intent)validateIntent(intent);const next=applyPatch(snapshot,patch),base=await analyzeSnapshot(snapshot,{deadline,signal:options.signal});
  return analyzeScenario(next,base,intent,{deadline,signal:options.signal});
}
/** A session commits complete analyses only. Revisions increase across undo/reset;
 * the original frozen snapshot and live fingerprint always remain the baseline. */
export class ScenarioSession {
  #base:PackReport;#report:PackReport;#history:Snapshot[]=[];#busy=false;#intent?:Intent;
  constructor(base:PackReport,intent?:Intent){this.#base=base;this.#report=base;this.#intent=intent;}
  get report(){return this.#report;}
  async #change(expected:number|undefined,make:()=>Snapshot,commit:()=>void,options:AnalysisOptions={}):Promise<PackReport>{
    throwIfCancelled(options.signal);
    const deadline=Math.min(Date.now()+this.#report.snapshot.limits.timeoutMs,options.deadline??Infinity);
    if(this.#busy)fail('SCENARIO_BUSY');if(expected!==undefined && expected!==this.#report.scenario.revision)fail('REVISION_MISMATCH');
    this.#busy=true;
    try{
      const result=await analyzeScenario(make(),this.#base,this.#intent,{deadline,signal:options.signal});
      throwIfCancelled(options.signal);
      if(result.complete){commit();this.#report=result;}
      return result;
    }finally{this.#busy=false;}
  }
  async apply(patch:Patch,options:AnalysisOptions={}){const previous=this.#report.snapshot;return this.#change(patch.expectedRevision,()=>applyPatch(previous,patch),()=>this.#history.push(previous),options);}
  #restore(snapshot:Snapshot){const next=structuredClone(snapshot);next.snapshotId=randomUUID();next.baseSnapshotId=this.#base.scenario.baseSnapshotId;next.revision=this.#report.scenario.revision+1;delete next.appliedPatch;return deriveSnapshot(this.#base.snapshot,next);}
  async undo(expectedRevision?:number,options:AnalysisOptions={}){throwIfCancelled(options.signal);if(!this.#history.length)fail('NO_UNDO');return this.#change(expectedRevision,()=>this.#restore(this.#history.at(-1)!),()=>{this.#history.pop();},options);}
  async reset(expectedRevision?:number,options:AnalysisOptions={}){return this.#change(expectedRevision,()=>this.#restore(this.#base.snapshot),()=>{this.#history=[];},options);}
}
export async function createScenarioSession(snapshot:Snapshot,intent?:Intent,options:AnalysisOptions={}){throwIfCancelled(options.signal);const deadline=Math.min(Date.now()+snapshot.limits.timeoutMs,options.deadline??Infinity);if(intent)validateIntent(intent);const base=await analyzeScenario(snapshot,undefined,intent,{deadline,signal:options.signal});return new ScenarioSession(base,intent);}

import type { PackReport, RuleSource, Evidence, Snapshot } from './model.ts';
import { safeRelative } from './snapshot.ts';
import { createRequire } from 'node:module';
import { require } from './profile.ts';
// Resolve through the same producer chain as rootNode; normalization is string-only.
const arboristRequire=createRequire(require.resolve('@npmcli/arborist'));
const packageRequire=createRequire(arboristRequire.resolve('@npmcli/package-json'));
const normalizeBin=packageRequire('npm-normalize-package-bin') as (pkg:{bin:Record<string,string>})=>{bin?:Record<string,string>};
export interface ProjectionOptions { omitRuleText?: boolean }
export type PublicRuleSource=Omit<RuleSource,'text'|'generatedPatterns'> & {text?:string};
export type PublicEvidence=Omit<Evidence,'pattern'|'matchCalls'> & {pattern?:string};
export interface PublicSnapshot extends Pick<Snapshot,'snapshotId'|'baseSnapshotId'|'revision'|'projectLabel'|'capturedAt'|'complete'|'limits'|'entries'|'uncoveredInputs'> {
  manifest:Record<string,unknown>;manifestLocations:Snapshot['manifestLocations'];
}
export interface PublicPackReport extends Omit<PackReport,'snapshot'|'ruleSources'|'evidence'|'scenario'> {
  snapshot:PublicSnapshot;ruleSources:PublicRuleSource[];evidence:PublicEvidence[];scenario:Omit<PackReport['scenario'],'patch'>;
}
/** External consumers share this allowlist; internal snapshots never serialize. */
export function toPublicReport(report:PackReport,options:ProjectionOptions={}):PublicPackReport {
  const snapshot=report.snapshot;
  const manifest:Record<string,unknown>={};
  const privatePathValues=new Set<string>();
  const privateManifestPointers=new Set<string>(),privateBinNamePointers=new Set<string>();
  const publicManifestPointers=new Set<string>();
  const privateBinTarget=(name:string,value:string)=>{
    // Normalize each rejected target separately so duplicate normalized keys cannot
    // discard a private variant. This never resolves or reads the declared path.
    for(const target of Object.values(normalizeBin({bin:{[name]:value}}).bin??{}))privatePathValues.add(target);
  };
  const publicPath=(value:unknown):value is string=>{
    if(typeof value!=='string')return false;
    const normalized=value.replaceAll('\\','/').replace(/^(\.\/)+/,'');
    if(safeRelative(normalized) && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized) && !/[\u0000-\u001f]/.test(normalized))return true;
    if(value){privatePathValues.add(value);privatePathValues.add(value.replaceAll('\\','/'));}
    return false;
  };
  for(const key of ['files','main','browser']) {
    const value=snapshot.manifest[key];
    if(key==='files' && !options.omitRuleText && Array.isArray(value) && value.every(x=>typeof x==='string'))manifest[key]=structuredClone(value);
    else if(key!=='files') {if(publicPath(value)){manifest[key]=value;publicManifestPointers.add('/'+key);}else if(typeof value==='string')privateManifestPointers.add('/'+key);}
  }
  if(typeof snapshot.manifest.bin==='string'){if(publicPath(snapshot.manifest.bin)){manifest.bin=snapshot.manifest.bin;publicManifestPointers.add('/bin');}else {privateManifestPointers.add('/bin');privateBinTarget('packlens-private-bin',snapshot.manifest.bin);}}
  else if(snapshot.manifest.bin && typeof snapshot.manifest.bin==='object' && !Array.isArray(snapshot.manifest.bin))manifest.bin=Object.fromEntries(Object.entries(snapshot.manifest.bin).filter(([name,value])=>{
    const safeName=publicPath(name),safeValue=publicPath(value),pointer='/bin/'+name.replaceAll('~','~0').replaceAll('/','~1');
    if(!safeName)privateBinNamePointers.add(pointer);if(!safeName || !safeValue)privateManifestPointers.add(pointer);
    if(!safeValue && typeof value==='string')privateBinTarget(name,value);
    if(safeName && safeValue)publicManifestPointers.add(pointer);
    return safeName && safeValue;
  }));
  const privateText=(text:string)=>[...privatePathValues].some(value=>text.includes(value));
  const underPointer=(pointer:string|undefined,pointers:Set<string>)=>{
    if(pointer===undefined)return false;
    for(let current=pointer;;){if(pointers.has(current))return true;const slash=current.lastIndexOf('/');if(slash<0)return false;current=current.slice(0,slash);}
  };
  const privateSourceId=(id:string)=>id.startsWith('manifest:') && underPointer(id.slice('manifest:'.length),privateBinNamePointers);
  const manifestLocations=Object.fromEntries(Object.entries(snapshot.manifestLocations).filter(([pointer])=>!underPointer(pointer,privateBinNamePointers) && ['/files','/main','/bin','/browser'].some(p=>pointer===p || pointer.startsWith(p+'/'))));
  const relevantEvidence=report.evidence.filter(e=>e.matched || e.decision==='ancestor_block');
  const relevantSources=new Set(relevantEvidence.flatMap(e=>e.candidateSources));
  const sourcesById=new Map(report.ruleSources.map(s=>[s.sourceId,s]));
  const privateSourceIds=new Set(report.ruleSources.filter(s=>underPointer(s.jsonPointer,privateBinNamePointers) || privateSourceId(s.sourceId)).map(s=>s.sourceId));
  const ruleSources=report.ruleSources.filter(s=>!privateSourceIds.has(s.sourceId)).map(source=>{
    const {text,generatedPatterns,...rest}=source;
    // Whole, inactive ignore texts have no physical line and must stay internal.
    const privateManifestText=source.kind==='manifest' && (underPointer(source.jsonPointer,privateManifestPointers) || (text!==undefined && privateText(text) && !underPointer(source.jsonPointer,publicManifestPointers)));
    return {...rest,...(!options.omitRuleText && text!==undefined && !privateManifestText && (source.kind==='files' || relevantSources.has(source.sourceId))?{text}:{})};
  });
  const evidence=relevantEvidence.map(({pattern,matchCalls,candidateSources,...rest})=>{
    const candidates=candidateSources.map(id=>sourcesById.get(id));
    const privateManifest=candidates.some(s=>s?.kind==='manifest' && underPointer(s.jsonPointer,privateManifestPointers));
    // A leading slash in an ignore rule anchors to the package root. Only an
    // associated manifest rule (or unmapped generated rule) hides private values.
    const privateUnmapped=privateText(pattern) && !candidates.some(s=>s && ['files','npmignore','gitignore','builtin'].includes(s.kind));
    return {...rest,candidateSources:candidateSources.filter(id=>!privateSourceIds.has(id) && !privateSourceId(id)),...(!options.omitRuleText && !privateManifest && !privateUnmapped?{pattern}:{})};
  });
  const {patch,...scenario}=report.scenario;
  const diagnostics=report.diagnostics.map(({cleanupId,...diagnostic})=>({...diagnostic,...(cleanupId&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(cleanupId)?{cleanupId}:{})}));
  return structuredClone({schemaVersion:1,profile:report.profile,snapshot:{snapshotId:snapshot.snapshotId,baseSnapshotId:snapshot.baseSnapshotId,revision:snapshot.revision,projectLabel:snapshot.projectLabel,capturedAt:snapshot.capturedAt,complete:snapshot.complete,limits:snapshot.limits,entries:report.entries,uncoveredInputs:snapshot.uncoveredInputs,manifest,manifestLocations},entries:report.entries,evidence,ruleSources,diagnostics,scenario,complete:report.complete});
}

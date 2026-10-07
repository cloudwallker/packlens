import { randomUUID } from 'node:crypto';
import { snapshotPackage, checkSnapshot } from './snapshot.ts';
import { runtimeProfile } from './profile.ts';
import { withShadow } from './oracle.ts';
import { CleanupFailedError, CLEANUP_NEXT_STEP } from './cleanup.ts';
import { runWorker } from './worker.ts';
import type { TraceResult, FilterDecision } from './trace.ts';
import type { Snapshot, PackReport, MembershipValidity, Evidence, Scenario } from './model.ts';
import { AnalysisCancelledError, throwIfCancelled } from './cancellation.ts';
export { snapshotPackage } from './snapshot.ts';

/** Collection equality and exact provenance are separate gates. */
export function reconcileSnapshot(snapshot: Snapshot, files: string[], trace: TraceResult | undefined, validity: MembershipValidity) {
  const officialSet = new Set(files), traceSet = new Set(trace?.files);
  const missing = trace ? files.filter(p => !traceSet.has(p)) : [];
  const extra = trace ? trace.files.filter(p => !officialSet.has(p)) : [];
  const equal = !!trace && !missing.length && !extra.length;
  const reconciliation: Scenario['reconciliation'] = { status: trace ? equal ? 'equal' : 'conflict' : 'unavailable', missing, extra };
  const evidence: Evidence[] = structuredClone(trace?.evidence ?? []);
  const byId = new Map(evidence.map(e => [e.evidenceId,e]));
  const decisions = new Map<string,FilterDecision>();
  for (const decision of trace?.decisions ?? []) decisions.set(`${decision.path}:${decision.partial}`,decision);
  const visited = new Set(trace?.visitedDirectories);
  const entries = structuredClone(snapshot.entries);
  for (const entry of entries) {
    entry.membershipValidity = validity;
    entry.membership = validity !== 'verified_packlist' ? 'unknown' : !entry.exists ? 'missing' : officialSet.has(entry.path) ? 'included' : 'excluded';
    entry.explanationStatus = !entry.exists && validity === 'verified_packlist' ? 'not_applicable' : 'unknown';
    entry.evidenceIds = [];
    if (!entry.exists || validity !== 'verified_packlist' || !trace) continue;
    if (!equal) { entry.explanationStatus = 'conflict'; continue; }
    const directory = entry.kind === 'directory' || entry.kind === 'collapsed';
    const decision = decisions.get(`${entry.path}:${directory}`);
    if (decision) {
      entry.evidenceIds = decision.evidenceIds;
      // A traversed directory is not a file in a packlist. Traversal evidence
      // must not be labelled a confirmed reason for its absent file membership.
      if (directory && decision.included) continue;
    } else {
      const ancestors = entry.path.split('/').slice(0,-1).map((_,i,parts) => parts.slice(0,i+1).join('/'));
      const blocked = ancestors.map(path => decisions.get(`${path}:true`)).find(d => d && !d.included && !visited.has(d.path));
      if (blocked) {
        const original = blocked.evidenceIds.map(id => byId.get(id)).filter(e => e?.changed).at(-1);
        if (original) {
          const derived: Evidence = { ...original, evidenceId:`e${evidence.length}`, path:entry.path, evaluationOrder:evidence.length, ancestorChain:[blocked.path], decision:'ancestor_block' };
          evidence.push(derived); byId.set(derived.evidenceId,derived); entry.evidenceIds=[derived.evidenceId];
        }
      }
    }
    const actual = entry.evidenceIds.map(id => byId.get(id));
    const last = actual.filter(e => e?.changed && e.after === (entry.membership === 'included')).at(-1);
    if (last) entry.explanationStatus = last.sourceMapping === 'exact' ? 'confirmed' : last.sourceMapping === 'ambiguous' ? 'ambiguous' : 'unknown';
  }
  return { entries, evidence, reconciliation, equal };
}

export interface AnalysisOptions { deadline?: number; signal?: AbortSignal }
export async function analyzeSnapshot(snapshot: Snapshot, options: AnalysisOptions = {}): Promise<PackReport> {
  throwIfCancelled(options.signal);
  if(options.deadline!==undefined && !Number.isFinite(options.deadline))throw new Error('INVALID_DEADLINE');
  const deadline=Math.min(Date.now()+snapshot.limits.timeoutMs,options.deadline ?? Infinity);
  const profile=runtimeProfile(), diagnostics=[...snapshot.diagnostics];
  if (!profile.matched) diagnostics.push({ code:'PROFILE_UNCOVERED', severity:'warning', scope:'profile', message:'Installed versions or recording source fingerprints are not verified.' });
  let validity: MembershipValidity='verified_packlist';
  const stale=await checkSnapshot(snapshot,deadline,options.signal);
  if(stale === '<limit>') { validity='error'; diagnostics.push({code:'LIMIT_EXCEEDED',severity:'error',scope:'snapshot',message:'Scenario deadline was exceeded.'}); }
  else if (stale || diagnostics.some(d => d.code === 'STALE')) validity='stale';
  else if (!snapshot.complete) validity='error';
  else if (snapshot.uncoveredInputs.length || !profile.matched) validity='uncovered';
  let files: string[]=[], trace: TraceResult | undefined;
  if (validity === 'verified_packlist') {
    try {
      const workerUrl=new URL('./oracle-worker'+(import.meta.url.endsWith('.ts') ? '.ts' : '.js'),import.meta.url);
      const result=await withShadow(snapshot,(root,end) => runWorker<{files:string[];trace?:TraceResult;traceError?:string}>(workerUrl,{root,snapshot},end-Date.now(),options.signal),deadline,options.signal);
      files=result.files; trace=result.trace;
      if (result.traceError) {
        diagnostics.push({ code:result.traceError, severity:'error', scope:'trace', message:'Recording adapter did not finish.' });
        if (result.traceError === 'LIMIT_EXCEEDED') validity='error';
      }
    } catch (error) {
      if (error instanceof AnalysisCancelledError) throw error;
      validity='error';
      if(error instanceof CleanupFailedError){
        if(options.signal?.aborted){const cancelled=new AnalysisCancelledError();cancelled.cleanupId=error.cleanupId;throw cancelled;}
        diagnostics.push({code:'CLEANUP_FAILED',severity:'error',scope:'cleanup',message:'Owned temporary rules could not be removed.',cleanupId:error.cleanupId,actionableNextStep:CLEANUP_NEXT_STEP});
        if(error.computationCode)diagnostics.push({code:error.computationCode,severity:'error',scope:'oracle',message:'Official file-list calculation did not finish.'});
      }else{
        const code=error instanceof Error && error.message === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'ORACLE_ERROR';
        diagnostics.push({ code, severity:'error', scope:'oracle', message:'Official file-list calculation did not finish.' });
      }
    }
  }
  throwIfCancelled(options.signal);
  const changed=stale || await checkSnapshot(snapshot,deadline,options.signal);
  if(changed === '<limit>') { validity='error'; if(!diagnostics.some(d=>d.code==='LIMIT_EXCEEDED')) diagnostics.push({code:'LIMIT_EXCEEDED',severity:'error',scope:'snapshot',message:'Scenario deadline was exceeded.'}); }
  else if (changed) {
    validity='stale';
    if (!diagnostics.some(d => d.code === 'STALE')) diagnostics.push({ code:'STALE', severity:'error', scope:'snapshot', message:'Source metadata changed; rescan is required.', relativePath:changed === '<root>' ? undefined : changed });
  }
  const {entries,evidence,reconciliation,equal}=reconcileSnapshot(snapshot,files,trace,validity);
  if (trace && !equal) diagnostics.push({ code:'TRACE_CONFLICT', severity:'error', scope:'trace', message:'Recorded traversal differs from the official collection.' });
  return {
    schemaVersion:1, profile, snapshot, entries, evidence, ruleSources:trace?.sources ?? structuredClone(snapshot.ruleSources), diagnostics,
    complete:validity === 'verified_packlist' && equal,
    scenario:{
      scenarioId:randomUUID(), baseSnapshotId:snapshot.baseSnapshotId ?? snapshot.snapshotId, revision:snapshot.revision ?? 0, patch:snapshot.appliedPatch,
      oracleFiles:files, tracedFiles:trace?.files ?? [], reconciliation,
      aggregate:{rawBytes:entries.filter(e => e.membership === 'included').reduce((a,e) => a+BigInt(e.rawBytes),0n).toString(),fileCount:files.length}, assertions:[],
    },
  };
}

export async function analyzePackage(dir: string): Promise<PackReport> { return analyzeSnapshot(await snapshotPackage(dir)); }

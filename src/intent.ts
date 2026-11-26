import type { Intent, PackReport, AssertionResult } from './model.ts';
import { PackageInputError, safeRelative } from './snapshot.ts';

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(k => allowed.includes(k)); }
export function validateSelector(selector: unknown): asserts selector is string {
  if (typeof selector !== 'string' || !safeRelative(selector) || /[!\[\]{}()\u0000-\u001f]/.test(selector) || selector.split('/').some(s => s.includes('**') && s !== '**')) throw new PackageInputError('INVALID_SELECTOR');
}
export function validateIntent(value: unknown): asserts value is Intent {
  if (!object(value) || !keys(value,['schemaVersion','mustShip','mustNotShip','sizeBudget']) || value.schemaVersion !== 1) throw new PackageInputError('INVALID_INTENT');
  for (const key of ['mustShip','mustNotShip']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key])) throw new PackageInputError('INVALID_INTENT');
    for (const selector of value[key]) validateSelector(selector);
  }
  if (value.sizeBudget !== undefined) {
    const b=value.sizeBudget;
    if (!object(b) || !keys(b,['maxRawBytes','include','exclude']) || typeof b.maxRawBytes !== 'string' || !/^\d+$/.test(b.maxRawBytes)) throw new PackageInputError('INVALID_INTENT');
    for (const selectors of [b.include, b.exclude]) {
      if (selectors === undefined) continue;
      if (!Array.isArray(selectors)) throw new PackageInputError('INVALID_INTENT');
      for (const selector of selectors) validateSelector(selector);
    }
  }
}
// '*' and '?' consume characters only within one segment. '**' is a complete
// segment and consumes zero or more segments, independently of npm's glob.
function segmentMatches(pattern: string, text: string) {
  let p=0,t=0,star=-1,retry=0;
  while(t<text.length) {
    if(pattern[p]==='?' || pattern[p]===text[t]) {p++;t++;}
    else if(pattern[p]==='*') {star=p++;retry=t;}
    else if(star>=0) {p=star+1;t=++retry;}
    else return false;
  }
  while(pattern[p]==='*')p++;
  return p===pattern.length;
}
export function matchesSelector(selector: string, path: string): boolean {
  validateSelector(selector);
  const patterns=selector.split('/'), parts=path.split('/'); let reachable=new Set([0]);
  for(const pattern of patterns) {
    const next=new Set<number>();
    for(const index of reachable) {
      if(pattern==='**') for(let i=index;i<=parts.length;i++) next.add(i);
      else if(index<parts.length && segmentMatches(pattern,parts[index]))next.add(index+1);
    }
    reachable=next;
  }
  return reachable.has(parts.length);
}
export interface IntentEvaluationOptions { deadline?:number }
export function evaluateIntent(report: PackReport, intent: Intent, options:IntentEvaluationOptions={}): AssertionResult[] {
  const deadline=Math.min(Date.now()+report.snapshot.limits.timeoutMs,options.deadline??Infinity);
  const checkDeadline=()=>{if(!Number.isFinite(deadline) || Date.now()>deadline)throw new PackageInputError('LIMIT_EXCEEDED');};
  const match=(selector:string,path:string)=>{checkDeadline();return matchesSelector(selector,path);};
  checkDeadline();
  validateIntent(intent);
  const protectedState=!report.complete || report.scenario.reconciliation.status!=='equal' || report.entries.some(e=>e.membershipValidity!=='verified_packlist');
  const results: AssertionResult[]=[];
  const files=report.entries.filter(e=>e.exists && e.kind==='file');
  const shipped=new Set(report.scenario.oracleFiles);
  for(const type of ['mustShip','mustNotShip'] as const) for(const selector of intent[type] ?? []) {
    const matching=files.filter(e=>match(selector,e.path));
    const existing=matching.map(e=>e.path).sort(), included=existing.filter(p=>shipped.has(p));
    const reasons: string[]=[];
    let fail=false;
    if(type==='mustShip') { if(!existing.length){reasons.push('NO_MATCH');fail=true;} else if(included.length!==existing.length){reasons.push('NOT_SHIPPED');fail=true;} }
    else if(included.length){reasons.push('UNEXPECTED_SHIPPED');fail=true;}
    if(protectedState)reasons.push('RESULT_UNKNOWN');
    if(type==='mustShip' && !/[?*]/.test(selector) && !report.entries.some(e=>e.path===selector)) {
      report.entries.push({path:selector,kind:'file',exists:false,rawBytes:'0',membership:protectedState?'unknown':'missing',membershipValidity:protectedState?'uncovered':'verified_packlist',explanationStatus:'not_applicable',evidenceIds:[]});
    }
    const opposite=intent[type==='mustShip'?'mustNotShip':'mustShip'] ?? [];
    if(existing.some(p=>opposite.some(s=>match(s,p)))) reasons.push('INTENT_CONFLICT');
    results.push({assertionId:`${type}:${results.length}`,type,selector,matchedExistingPaths:existing,matchedShippedPaths:included,status:protectedState?'unknown':fail?'fail':'pass',reasonCodes:reasons});
  }
  if(intent.sizeBudget) {
    const budget = intent.sizeBudget;
    const inScope = (path:string) =>
      (budget.include === undefined || budget.include.some(selector => match(selector, path))) &&
      !budget.exclude?.some(selector => match(selector, path));
    const bytesByPath = new Map(files.filter(entry => inScope(entry.path)).map(entry => [entry.path, entry.rawBytes]));
    const matchedExistingPaths = [...bytesByPath.keys()].sort();
    const matchedShippedPaths = [...shipped].filter(inScope).sort();
    const reasons: string[] = [];
    let total = 0n;
    for (const path of matchedShippedPaths) {
      checkDeadline();
      const bytes = bytesByPath.get(path);
      if (bytes !== undefined && /^\d+$/.test(bytes)) total += BigInt(bytes);
      else if (!reasons.includes('BYTES_UNAVAILABLE')) reasons.push('BYTES_UNAVAILABLE');
    }
    const unknown = protectedState || reasons.includes('BYTES_UNAVAILABLE');
    if (!matchedShippedPaths.length && (budget.include !== undefined || budget.exclude?.length)) reasons.push('EMPTY_BUDGET_SCOPE');
    if(unknown)reasons.push('RESULT_UNKNOWN');
    const exceeded=total>BigInt(budget.maxRawBytes);if(exceeded)reasons.push('BUDGET_EXCEEDED');
    results.push({assertionId:`sizeBudget:${results.length}`, type:'sizeBudget', selector:budget.include ?? ['**/*'],
      ...(budget.exclude?.length ? {excludedSelectors:[...budget.exclude]} : {}),
      matchedExistingPaths, matchedShippedPaths, status:unknown?'unknown':exceeded?'fail':'pass',
      reasonCodes:reasons, bytesActual:unknown?undefined:total.toString(), bytesLimit:budget.maxRawBytes});
  }
  checkDeadline();return results;
}

#!/usr/bin/env node
import { promises as fs, constants } from 'node:fs';
import { resolve, dirname, parse, join, basename } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { PackReport, Intent, Patch } from './model.ts';
import { snapshotPackage, PackageInputError, inside, safeRelative, DEFAULT_LIMITS } from './snapshot.ts';
import { analyzeSnapshot } from './analyze.ts';
import { simulate, validatePatch } from './scenario.ts';
import { evaluateIntent, validateIntent } from './intent.ts';
import { toPublicReport } from './serialization.ts';
import { renderHtml } from './report.ts';
import { servePackage } from './server.ts';
import { runDemo } from './demo.ts';
import { createScenarioSession } from './scenario.ts';
import { execFile } from 'node:child_process';

export interface CliArguments { command:string;dir?:string;path?:string;json:boolean;strict:boolean;locale:'zh-CN'|'en';overwrite:boolean;intentPath?:string;patchPath?:string;outputJson?:string;html?:string;port?:number;open?:boolean }
export interface CliIo { stdout:(text:string)=>void;stderr:(text:string)=>void }
const defaultIo:CliIo={stdout:text=>process.stdout.write(text),stderr:text=>process.stderr.write(text)};
const inputError=(code:string):never=>{throw new PackageInputError(code);};
export function parseArguments(argv:string[]):CliArguments {
  if(argv.length===1 && argv[0]==='--version')return {command:'version',json:false,strict:false,locale:'zh-CN',overwrite:false};
  const args:CliArguments={command:argv[0]??'',json:false,strict:false,locale:'zh-CN',overwrite:false},positional:string[]=[];
  const booleans:Record<string,keyof CliArguments>={'--json':'json','--strict-explanations':'strict','--overwrite':'overwrite','--open':'open'};
  const values:Record<string,keyof CliArguments>={'--locale':'locale','--intent':'intentPath','--patch':'patchPath','--output-json':'outputJson','--html':'html','--port':'port'};
  for(let i=1;i<argv.length;i++) {
    const arg=argv[i];
    if(Object.hasOwn(booleans,arg)){if((args as any)[booleans[arg]])inputError('DUPLICATE_OPTION');(args as any)[booleans[arg]]=true;}
    else if(Object.hasOwn(values,arg)){if(i+1>=argv.length || argv[i+1].startsWith('--'))inputError('OPTION_VALUE_REQUIRED');const key=values[arg];if(key!=='locale' && args[key]!==undefined)inputError('DUPLICATE_OPTION');(args as any)[key]=argv[++i];}
    else if(arg.startsWith('-'))inputError('INVALID_OPTION');
    else positional.push(arg);
  }
  if(!['zh-CN','en'].includes(args.locale))inputError('INVALID_LOCALE');
  if(!['analyze','explain','simulate','serve','demo'].includes(args.command))inputError('INVALID_COMMAND');
  if(positional.length!==(args.command==='explain'?2:1) && !(args.command==='demo'&&positional.length===0))inputError('INVALID_ARGUMENTS');
  args.dir=positional[0];args.path=positional[1];
  if(args.command==='simulate' && !args.patchPath)inputError('PATCH_REQUIRED');
  if(args.command!=='simulate' && args.patchPath)inputError('INVALID_OPTION');
  if(args.command==='explain' && args.intentPath)inputError('INVALID_OPTION');
  if(args.command!=='serve' && (args.port!==undefined||args.open))inputError('INVALID_OPTION');
  if(args.command==='serve' && (args.json||args.html||args.outputJson||args.overwrite||args.strict))inputError('INVALID_OPTION');
  if(args.command==='demo' && args.intentPath)inputError('INVALID_OPTION');
  if(args.command==='explain' && args.html)inputError('INVALID_OPTION');
  if(args.port!==undefined){if(!/^\d+$/.test(String(args.port))||Number(args.port)>65535)inputError('INVALID_PORT');args.port=Number(args.port);}
  if(args.path && (!safeRelative(args.path) || /[\u0000-\u001f]/.test(args.path)))inputError('OUTSIDE_ROOT');
  return args;
}
/** Only explicitly selected control files are read, with the rule-file bound. */
export async function readControlJson(path:string):Promise<unknown> {
  if(basename(path).toLowerCase()==='.npmrc')inputError('CONTROL_CONFIG_FORBIDDEN');
  const handle=await fs.open(resolve(path),'r').catch(()=>inputError('CONTROL_UNAVAILABLE'));
  try{
    const stat=await handle.stat();if(!stat.isFile())inputError('INVALID_CONTROL');
    if(stat.size>DEFAULT_LIMITS.maxRuleBytes)inputError('LIMIT_EXCEEDED');
    const buffer=Buffer.alloc(DEFAULT_LIMITS.maxRuleBytes+1);let used=0;
    while(used<buffer.length){const {bytesRead}=await handle.read(buffer,used,buffer.length-used,used);if(!bytesRead)break;used+=bytesRead;}
    if(used>DEFAULT_LIMITS.maxRuleBytes)inputError('LIMIT_EXCEEDED');
    const after=await handle.stat();if(after.size!==stat.size || after.mtimeMs!==stat.mtimeMs || used!==stat.size)inputError('CONTROL_CHANGED');
    try{return JSON.parse(buffer.subarray(0,used).toString('utf8'));}catch{inputError('INVALID_CONTROL_JSON');}
  }finally{await handle.close();}
}
async function outputTarget(inputRoot:string,path:string,overwrite:boolean) {
  const root=await fs.realpath(resolve(inputRoot)).catch(()=>inputError('ROOT_UNAVAILABLE')),target=resolve(path);
  if(inside(resolve(inputRoot),target) || inside(root,target))inputError('OUTPUT_INSIDE_ROOT');
  const parts=target.slice(parse(target).root.length).split(/[\\/]/).filter(Boolean);let current=parse(target).root;
  for(let i=0;i<parts.length;i++) {
    current=join(current,parts[i]);const stat=await fs.lstat(current).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT' && i===parts.length-1)return undefined;inputError('OUTPUT_UNAVAILABLE');});
    if(stat?.isSymbolicLink() || (stat?.isFile() && stat.nlink>1))inputError('OUTPUT_LINK');
    if(i<parts.length-1 && !stat?.isDirectory())inputError('OUTPUT_UNAVAILABLE');
    if(i===parts.length-1 && stat) {if(!stat.isFile())inputError('OUTPUT_UNAVAILABLE');if(!overwrite)inputError('OUTPUT_EXISTS');}
  }
  const canonicalParent=await fs.realpath(dirname(target)).catch(()=>inputError('OUTPUT_UNAVAILABLE'));
  if(inside(root,join(canonicalParent,parts.at(-1)!)))inputError('OUTPUT_INSIDE_ROOT');
  return target;
}
export async function writeReportOutput(inputRoot:string,path:string,text:string,overwrite=false) {
  const target=await outputTarget(inputRoot,path,overwrite);
  const handle=await fs.open(target,overwrite?constants.O_WRONLY|constants.O_CREAT:constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600).catch((error:NodeJS.ErrnoException)=>inputError(error.code==='EEXIST'?'OUTPUT_EXISTS':'OUTPUT_UNAVAILABLE'));
  try{
    await outputTarget(inputRoot,path,true);
    const current=await fs.lstat(target),opened=await handle.stat();
    if(current.ino!==opened.ino || current.dev!==opened.dev || current.isSymbolicLink() || opened.nlink>1)inputError('OUTPUT_CHANGED');
    await handle.truncate(0);await handle.writeFile(text,'utf8');
  }finally{await handle.close();}
}
export function reportExitCode(report:PackReport,strict=false):number {
  const protectedCodes=new Set(['LIMIT_EXCEEDED','STALE','PROFILE_UNCOVERED','TRACE_CONFLICT']);
  if(report.diagnostics.some(d=>d.severity==='error' && !protectedCodes.has(d.code)))return 3;
  if(!report.complete || report.scenario.assertions.some(a=>a.status==='unknown') || report.diagnostics.some(d=>['LIMIT_EXCEEDED','STALE','PROFILE_UNCOVERED','TRACE_CONFLICT'].includes(d.code)) || (strict && report.entries.some(e=>e.exists && e.kind==='file' && ['unknown','conflict'].includes(e.explanationStatus))))return 2;
  if(report.scenario.assertions.some(a=>a.status==='fail'))return 1;
  return 0;
}
function explainPublic(report:PackReport,path:string) {
  const projected=toPublicReport(report);let entry=projected.entries.find(e=>e.path===path);
  if(!entry)entry={path,kind:'file',exists:false,rawBytes:'0',membership:report.complete?'missing':'unknown',membershipValidity:report.complete?'verified_packlist':'uncovered',explanationStatus:'not_applicable',evidenceIds:[]};
  const evidence=projected.evidence.filter(e=>entry!.evidenceIds.includes(e.evidenceId)),ids=new Set(evidence.flatMap(e=>e.candidateSources));
  return {schemaVersion:1,profile:projected.profile,entry,evidence,ruleSources:projected.ruleSources.filter(s=>ids.has(s.sourceId)),diagnostics:projected.diagnostics,complete:report.complete};
}
export async function runCli(argv:string[],io:CliIo=defaultIo):Promise<number> {
  const deadline=Date.now()+DEFAULT_LIMITS.timeoutMs;
  let args:CliArguments|undefined,report:PackReport|undefined;
  try {
    args=parseArguments(argv);
    if(args.command==='version'){io.stdout('0.1.0\n');return 0;}
    if(args.command==='serve'){
      let intent:Intent|undefined;
      if(args.intentPath){const value=await readControlJson(args.intentPath);validateIntent(value);intent=value;}
      if(args.open&&process.platform!=='win32')inputError('OPEN_UNSUPPORTED');
      const handle=await servePackage(args.dir!,{intent,port:args.port,locale:args.locale}),url=`http://${handle.address}:${handle.port}/`;
      io.stdout(url+'\n');
      if(args.open)await new Promise<void>((resolve,reject)=>{execFile('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true},error=>error?reject(new PackageInputError('OPEN_FAILED')):resolve());}).catch(async e=>{await handle.close();throw e;});
      await new Promise<void>(resolve=>{const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);void handle.close().then(resolve);};process.once('SIGINT',stop);process.once('SIGTERM',stop);});return 0;
    }
    if(args.command==='demo'){
      const result=await runDemo(args.dir),html=renderHtml(result.baseline,{scenarios:result.patched.complete?[result.patched]:[],locale:args.locale});
      const runtimeRoot=fileURLToPath(new URL('.',import.meta.url));
      if(args.html)await writeReportOutput(runtimeRoot,args.html,html,args.overwrite);
      if(args.outputJson)await writeReportOutput(runtimeRoot,args.outputJson,JSON.stringify(toPublicReport(result.patched),null,2)+'\n',args.overwrite);
      io.stdout(args.json?JSON.stringify(toPublicReport(result.patched),null,2)+'\n':`PackLens demo: ${result.name}\n${result.baseline.scenario.aggregate.rawBytes} → ${result.patched.scenario.aggregate.rawBytes} B\n${result.baseline.scenario.assertions.map(a=>a.status).join(', ')} → ${result.patched.scenario.assertions.map(a=>a.status).join(', ')}\n`);
      return reportExitCode(result.patched,args.strict);
    }
    if(args.outputJson)await outputTarget(args.dir!,args.outputJson,args.overwrite);
    if(args.html)await outputTarget(args.dir!,args.html,args.overwrite);
    let intent:Intent|undefined,patch:Patch|undefined;
    if(args.intentPath){const value=await readControlJson(args.intentPath);validateIntent(value);intent=value;}
    if(args.patchPath){const value=await readControlJson(args.patchPath);validatePatch(value);patch=value;}
    const snapshot=await snapshotPackage(args.dir!);let baseline:PackReport|undefined;
    if(patch&&args.html){const session=await createScenarioSession(snapshot,intent,{deadline});baseline=session.report;report=await session.apply(patch,{deadline});}
    else report=patch?await simulate(snapshot,patch,intent,{deadline}):await analyzeSnapshot(snapshot,{deadline});
    if(intent && !patch)report.scenario.assertions=evaluateIntent(report,intent,{deadline});
    const projected=args.command==='explain'?explainPublic(report,args.path!):toPublicReport(report),json=JSON.stringify(projected,null,2)+'\n';
    if(args.outputJson)await writeReportOutput(args.dir!,args.outputJson,json,args.overwrite);
    if(args.html)await writeReportOutput(args.dir!,args.html,renderHtml(report.complete?(baseline??report):report,{scenarios:baseline&&report.complete?[report]:[],locale:args.locale}),args.overwrite);
    if(args.json)io.stdout(json);
    else if(args.command==='explain'){
      const explanation=explainPublic(report,args.path!),source=explanation.ruleSources.map(s=>`${s.path}${s.line?':'+s.line:s.jsonPointer?' '+s.jsonPointer:''}`).join(', ');
      io.stdout(`${args.path}: ${explanation.entry.membership} (${explanation.entry.explanationStatus})\n${source?source+'\n':''}`);
    }else{
      const code=reportExitCode(report,args.strict);
      io.stdout(args.locale==='en'?`PackLens: ${code===0?'complete':'needs attention'}\nFiles: ${report.scenario.aggregate.fileCount}\nRaw bytes: ${report.scenario.aggregate.rawBytes} B\n`:`PackLens：${code===0?'完成':'需要关注'}\n文件数：${report.scenario.aggregate.fileCount}\n原始字节：${report.scenario.aggregate.rawBytes} B\n`);
      for(const result of report.scenario.assertions)io.stdout(`${result.type}: ${result.status} (${result.reasonCodes.join(', ')})\n`);
      if(report.scenario.delta)io.stdout(`${args.locale==='en'?'Net bytes':'净字节变化'}: ${report.scenario.delta.netRawBytes} B\n`);
    }
    for(const diagnostic of toPublicReport(report).diagnostics)io.stderr(`${diagnostic.code}${diagnostic.cleanupId?' '+diagnostic.cleanupId:''}${diagnostic.actionableNextStep?' '+diagnostic.actionableNextStep:''}\n`);
    return reportExitCode(report,args.strict);
  }catch(error){
    const code=error instanceof PackageInputError?error.code:'RUN_FAILED';
    if(args?.json || argv.includes('--json')) {
      if(report) {if(code==='LIMIT_EXCEEDED')report.complete=false;report.diagnostics.push({code,severity:'error',scope:'cli',message:'CLI operation did not finish.'});io.stdout(JSON.stringify(toPublicReport(report))+'\n');}
      else io.stdout(JSON.stringify({schemaVersion:1,error:{code},complete:false})+'\n');
    }
    io.stderr(`${args?.locale==='en'?'PackLens error':'PackLens 错误'}: ${code}\n`);
    return code==='LIMIT_EXCEEDED'?2:3;
  }
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url)process.exitCode=await runCli(process.argv.slice(2));

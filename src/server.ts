import { createServer, type IncomingMessage } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { snapshotPackage, PackageInputError } from './snapshot.ts';
import { createScenarioSession } from './scenario.ts';
import { AnalysisCancelledError, throwIfCancelled } from './cancellation.ts';
import { toPublicReport } from './serialization.ts';
import { renderHtml, safeJson } from './report.ts';
import type { Intent, PackReport, Patch } from './model.ts';
import {listenForBrowser,validateBrowserPort} from './browser-ports.ts';

export interface ServerOptions { intent?:Intent; port?:number; locale?:'zh-CN'|'en' }
export interface ServerHandle { address:'127.0.0.1'; port:number; close:()=>Promise<void> }
export interface EditorState { revision:number; files:unknown; ignores:Record<string,string> }
const MAX_BODY=1_048_576;
async function body(req:IncomingMessage):Promise<unknown>{
  if(req.headers['content-type']!=='application/json')throw new PackageInputError('CONTENT_TYPE');
  let size=0;const chunks:Buffer[]=[];
  // Reject an oversized stream without destroying its response socket. Actual
  // peer aborts still reach the per-request cancellation controller.
  for await(const chunk of req.iterator({destroyOnReturn:false})){
    size+=chunk.length;
    if(size>MAX_BODY){req.resume();throw new PackageInputError('BODY_TOO_LARGE');}
    chunks.push(chunk);
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch{throw new PackageInputError('INVALID_JSON');}
}
function editorState(report:PackReport):EditorState{
  return {
    revision:report.scenario.revision,
    files:report.snapshot.manifest.files??null,
    ignores:Object.fromEntries(report.snapshot.ruleSources
      .filter(s=>s.kind==='npmignore'||s.kind==='gitignore').map(s=>[s.path,s.text??'']))
  };
}
/** The only filesystem root is fixed at startup. Clients send patches, never reports. */
export async function servePackage(dir:string,options:ServerOptions={}):Promise<ServerHandle>{
  validateBrowserPort(options.port===undefined?0:options.port);
  const session=await createScenarioSession(await snapshotPackage(dir),options.intent);
  const base=session.report,saved:PackReport[]=[];
  const credential=randomBytes(32).toString('hex');
  const controllers=new Set<AbortController>(),pending=new Set<Promise<void>>();
  let origin='',queue=Promise.resolve(),closing=false,closePromise:Promise<void>|undefined;
  const server=createServer((req,res)=>{
    res.setHeader('cache-control','no-store');
    res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');
    res.setHeader('content-security-policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    const send=(status:number,value:unknown,type='application/json')=>{
      if(res.destroyed||res.writableEnded)return;
      res.writeHead(status,{'content-type':type+'; charset=utf-8'});
      res.end(type==='application/json'?JSON.stringify(value):String(value));
    };
    const error=(status:number,code:string)=>send(status,{error:{code}});
    if(closing)return error(503,'SERVER_CLOSING');
    if(req.headers.host!==origin.slice('http://'.length)||(req.headers.origin!==undefined&&req.headers.origin!==origin)||req.headers['sec-fetch-site']==='cross-site')return error(403,'FORBIDDEN_ORIGIN');
    if(req.method==='GET'&&req.url==='/'){
      const html=renderHtml(base,{scenarios:saved,locale:options.locale}).replace('<script id="report-data"',`<script id="live-data" type="application/json">${safeJson({credential})}</script><script id="report-data"`);
      return send(200,html,'text/html');
    }
    const token=req.headers['x-packlens-session'];
    if(typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token)||!timingSafeEqual(Buffer.from(token),Buffer.from(credential)))return error(403,'SESSION_REQUIRED');
    if(req.method==='GET'&&req.url==='/api/editor')return send(200,editorState(session.report));
    if(req.method!=='POST'||!['/api/apply','/api/undo','/api/reset','/api/export'].includes(req.url??''))return error(404,'ROUTE_NOT_FOUND');
    if(req.headers.origin!==origin)return error(403,'FORBIDDEN_ORIGIN');
    if(Number(req.headers['content-length']??0)>MAX_BODY)return error(413,'BODY_TOO_LARGE');

    const controller=new AbortController(),signal=controller.signal;
    controllers.add(controller);
    const abort=()=>controller.abort();
    const responseClosed=()=>{if(!res.writableFinished)abort();};
    req.once('aborted',abort);
    res.once('close',responseClosed);
    const operation=(async()=>{
      try{
        const input=await body(req);
        throwIfCancelled(signal);
        const perform=async()=>{
          throwIfCancelled(signal);
          if(!input||typeof input!=='object'||Array.isArray(input))throw new PackageInputError('INVALID_REQUEST');
          const value=input as Record<string,unknown>;
          if(req.url==='/api/export'){
            if(Object.keys(value).some(k=>k!=='omitRuleText')||(value.omitRuleText!==undefined&&typeof value.omitRuleText!=='boolean'))throw new PackageInputError('INVALID_REQUEST');
            return send(200,renderHtml(base,{scenarios:saved,omitRuleText:value.omitRuleText as boolean|undefined,locale:options.locale}),'text/html');
          }
          if(typeof value.expectedRevision!=='number'||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<0)throw new PackageInputError('REVISION_REQUIRED');
          if(req.url!=='/api/apply'&&Object.keys(value).some(k=>k!=='expectedRevision'))throw new PackageInputError('INVALID_REQUEST');
          const result=req.url==='/api/apply'
            ?await session.apply(value as unknown as Patch,{signal})
            :req.url==='/api/undo'
              ?await session.undo(value.expectedRevision,{signal})
              :await session.reset(value.expectedRevision,{signal});
          throwIfCancelled(signal);
          if(!result.complete)return send(422,{error:{code:'SCENARIO_INCOMPLETE'},diagnostics:toPublicReport(result).diagnostics});
          saved.push(result);
          if(saved.length>20)saved.shift();
          send(200,{report:toPublicReport(result),editor:editorState(result)});
        };
        const task=queue.then(perform);
        // One rejected/cancelled request must not poison the following queue item.
        queue=task.catch(()=>{});
        await task;
      }catch(e){
        if(signal.aborted||e instanceof AnalysisCancelledError)return;
        const code=e instanceof PackageInputError?e.code:'REQUEST_FAILED';
        error(code==='BODY_TOO_LARGE'?413:code==='REVISION_MISMATCH'||code==='SCENARIO_BUSY'?409:400,code);
      }finally{
        req.off('aborted',abort);
        res.off('close',responseClosed);
        controllers.delete(controller);
      }
    })();
    pending.add(operation);
    void operation.finally(()=>pending.delete(operation));
  });
  server.requestTimeout=35_000;server.headersTimeout=10_000;
  const port=await listenForBrowser(server,options.port??0);origin=`http://127.0.0.1:${port}`;
  const close=()=>{
    if(closePromise)return closePromise;
    closing=true;
    for(const controller of controllers)controller.abort();
    const stopped=new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    server.closeAllConnections();
    closePromise=(async()=>{await stopped;await Promise.all([...pending]);await queue;})();
    return closePromise;
  };
  return {address:'127.0.0.1',port,close};
}

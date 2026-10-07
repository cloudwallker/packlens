import { Worker } from 'node:worker_threads';
import { AnalysisCancelledError, throwIfCancelled } from './cancellation.ts';

/** A real termination boundary, including synchronous glob/normalization work.
 * Resolve/reject only after worker exit, so callers may safely clean its shadow. */
export async function runWorker<T>(url: URL, data: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('LIMIT_EXCEEDED');
  // --input-type configures eval/stdin only. A file-backed Worker must not
  // inherit it, while flags such as --no-warnings and loaders remain intact.
  const execArgv=process.execArgv.filter((arg,index,args)=>arg!=='--input-type'&&!arg.startsWith('--input-type=')&&args[index-1]!=='--input-type');
  // Preserve Node's implicit inheritance when nothing needs changing: test
  // runners can carry internal flags that Node rejects if passed explicitly.
  const worker = new Worker(url, { workerData: data, env: {}, ...(execArgv.length===process.execArgv.length?{}:{execArgv}) });
  return new Promise<T>((resolve, reject) => {
    let result: T | undefined, failure: Error | undefined, gotMessage = false;
    const stop = (error?: Error) => { if (error) failure = error; void worker.terminate().catch(() => { failure ??= new Error('WORKER_ERROR'); }); };
    const timer = setTimeout(() => stop(new Error('LIMIT_EXCEEDED')), timeoutMs);
    const cancel = () => stop(new AnalysisCancelledError());
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once('message', message => { gotMessage = true; if (message?.error) failure = new Error(message.error === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : message.error === 'TRACE_ERROR' ? 'TRACE_ERROR' : 'ORACLE_ERROR'); else result = message; stop(); });
    worker.once('error', error => stop(new Error(error instanceof Error && error.message === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'ORACLE_ERROR')));
    worker.once('exit', () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); if (signal?.aborted) reject(new AnalysisCancelledError()); else if (failure) reject(failure); else if (gotMessage) resolve(result as T); else reject(new Error('ORACLE_ERROR')); });
  });
}

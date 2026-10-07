import { parentPort, workerData } from 'node:worker_threads';
import { officialFiles } from './oracle.ts';
import { traceFiles } from './trace.ts';
import type { Snapshot } from './model.ts';
const { root, snapshot } = workerData as { root: string; snapshot: Snapshot };
try {
  const files = await officialFiles(root, snapshot);
  // Trace is independent. A recording failure never erases a completed oracle.
  try { parentPort!.postMessage({ files, trace: await traceFiles(root, snapshot) }); }
  catch (error) { parentPort!.postMessage({ files, traceError: error instanceof Error && error.message === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'TRACE_ERROR' }); }
} catch (error) { parentPort!.postMessage({ error: error instanceof Error && error.message === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'ORACLE_ERROR' }); }

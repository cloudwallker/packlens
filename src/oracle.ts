import { promises as fs } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { inside, safeRelative } from './snapshot.ts';
import { require, rootNode } from './profile.ts';
import type { Snapshot } from './model.ts';
import { AnalysisCancelledError, throwIfCancelled } from './cancellation.ts';
import { createOwnedShadow, cleanupOwnedShadow, CleanupFailedError } from './cleanup.ts';
export function normalizeFiles(files: string[]) { return [...new Set(files.map(p => p.replace(/\\/g, '/').replace(/^\.\//, '')))].sort(); }
export async function withShadow<T>(snapshot: Snapshot, action: (root: string, deadline: number) => Promise<T>, deadline = Date.now() + snapshot.limits.timeoutMs, signal?: AbortSignal): Promise<T> {
  throwIfCancelled(signal);
  const owned = await createOwnedShadow(),root=owned.root;
  let failure:unknown;
  try {
    const rules = new Map(snapshot.ruleSources.filter(s => s.kind === 'npmignore' || s.kind === 'gitignore').map(s => [s.path, s.text ?? '']));
    for (const entry of snapshot.entries.filter(e => e.exists).sort((a,b) => a.path.length - b.path.length)) {
      throwIfCancelled(signal);
      if (Date.now() > deadline) throw new Error('LIMIT_EXCEEDED');
      if (!safeRelative(entry.path)) throw new Error('INVALID_SNAPSHOT_PATH');
      const target = resolve(root, entry.path); if (!inside(root, target)) throw new Error('OUTSIDE_ROOT');
      if (entry.kind === 'directory' || entry.kind === 'collapsed') await fs.mkdir(target, { recursive: true });
      else if (entry.kind === 'file') { await fs.mkdir(dirname(target), { recursive: true }); await fs.writeFile(target, entry.path === 'package.json' ? snapshot.manifestText : rules.get(entry.path) ?? ''); }
      else throw new Error('UNCOVERED_FILE_TYPE');
    }
    // Virtual rule edits can introduce an ignore source absent from the original tree.
    for (const [path, text] of rules) { throwIfCancelled(signal); if (!safeRelative(path) || !inside(root, resolve(root, path))) throw new Error('OUTSIDE_ROOT'); await fs.mkdir(dirname(join(root, path)), { recursive: true }); await fs.writeFile(join(root, path), text); }
    throwIfCancelled(signal);
    return await action(root, deadline);
  } catch(error) { failure=error;throw error;
  } finally {
    try{await cleanupOwnedShadow(owned);}catch(error){
      if(!(error instanceof CleanupFailedError))throw error;
      if(failure instanceof AnalysisCancelledError || signal?.aborted){
        const cancelled=failure instanceof AnalysisCancelledError?failure:new AnalysisCancelledError();
        cancelled.cleanupId=error.cleanupId;throw cancelled;
      }
      const computationCode=failure===undefined?undefined:failure instanceof Error&&failure.message==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'ORACLE_ERROR';
      throw new CleanupFailedError(error.cleanupId,computationCode);
    }
  }
}
export async function officialFiles(root: string, snapshot: Snapshot): Promise<string[]> {
  return normalizeFiles(await require('npm-packlist')(await rootNode(root, snapshot.manifest)));
}

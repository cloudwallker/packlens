import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { PackageInputError } from './snapshot.ts';

interface OwnedShadow { id:string; root:string; parent:string; dev:bigint; ino:bigint; birthtimeNs:bigint; pending:boolean }
// Only objects created here grant cleanup authority. IDs are lookup keys, never
// paths, and a serialized report cannot recreate the registration after exit.
const owned=new Map<string,OwnedShadow>();
export const CLEANUP_NEXT_STEP='Release the file lock, then retry this operation or call retryCleanup(cleanupId) in the same process. After process exit, inspect the exact packlens-shadow-<cleanupId> folder in your OS temporary directory and remove it manually only after confirming ownership; the ID cannot authorize deletion in another process.';
export class CleanupFailedError extends Error {
  readonly code='CLEANUP_FAILED';
  readonly cleanupId:string;
  readonly computationCode?:string;
  constructor(cleanupId:string,computationCode?:string){super('CLEANUP_FAILED');this.cleanupId=cleanupId;this.computationCode=computationCode;}
}
async function removeOwned(record:OwnedShadow):Promise<void> {
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const stat=await fs.lstat(record.root,{bigint:true}).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return undefined;throw error;});
      if(!stat){owned.delete(record.id);return;}
      // Revalidate the exact real directory identity immediately before removal.
      // A matching name/prefix, external path or substituted symlink is insufficient.
      if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==record.dev||stat.ino!==record.ino||stat.birthtimeNs!==record.birthtimeNs||dirname(record.root)!==record.parent||await fs.realpath(record.root)!==record.root)throw new Error('OWNERSHIP_CHANGED');
      await fs.rm(record.root,{recursive:true,force:true,maxRetries:0});
      owned.delete(record.id);return;
    }catch{
      record.pending=true;
      if(attempt===0)await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  throw new CleanupFailedError(record.id);
}
/** Bounded retry for this process's registered object; no filesystem search. */
export async function retryCleanup(cleanupId:string):Promise<void> {
  const record=owned.get(cleanupId);
  if(!record?.pending)throw new PackageInputError('UNKNOWN_CLEANUP_ID');
  await removeOwned(record);
}
/** A later operation retries unresolved objects before allocating a new shadow. */
export async function retryPendingCleanup():Promise<void> {
  for(const record of owned.values())if(record.pending)await removeOwned(record);
}
export async function createOwnedShadow():Promise<OwnedShadow> {
  await retryPendingCleanup();
  const parent=await fs.realpath(tmpdir()),id=randomUUID(),root=join(parent,'packlens-shadow-'+id);
  await fs.mkdir(root,{mode:0o700});
  const stat=await fs.lstat(root,{bigint:true});
  const record:OwnedShadow={id,root,parent,dev:stat.dev,ino:stat.ino,birthtimeNs:stat.birthtimeNs,pending:false};
  owned.set(id,record);return record;
}
export async function cleanupOwnedShadow(record:OwnedShadow):Promise<void> {
  if(owned.get(record.id)!==record)throw new Error('UNKNOWN_OWNED_OBJECT');
  await removeOwned(record);
}

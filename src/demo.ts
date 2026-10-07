import { mkdtemp, readFile, cp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshotPackage, PackageInputError, safeRelative } from './snapshot.ts';
import { createScenarioSession, validatePatch } from './scenario.ts';
import { validateIntent } from './intent.ts';
export const demoNames=['nested-ignore','empty-glob','css-missing','template-missing','unexpected-growth','forced-include'] as const;
export async function runDemo(name:string='css-missing'){
  if(!(demoNames as readonly string[]).includes(name))throw new PackageInputError('INVALID_DEMO');
  const sourceMode=import.meta.url.endsWith('.ts'),assets=fileURLToPath(new URL(sourceMode?'../fixtures/':'./demo-assets/',import.meta.url));
  const folder=join(assets,name),bundle=sourceMode?undefined:JSON.parse(await readFile(join(assets,name+'.json'),'utf8'));
  const intent=bundle?.intent??JSON.parse(await readFile(join(folder,'intent.json'),'utf8')),patch=bundle?.patch??JSON.parse(await readFile(join(folder,'patch.json'),'utf8'));
  validateIntent(intent);validatePatch(patch);
  const root=await mkdtemp(join(tmpdir(),'packlens-demo-'));
  try{
    if(sourceMode)await cp(join(folder,'package'),root,{recursive:true});
    else for(const [path,text] of Object.entries(bundle.files)){if(!safeRelative(path)||typeof text!=='string')throw new PackageInputError('INVALID_DEMO_ASSET');await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),text);}
    const session=await createScenarioSession(await snapshotPackage(root),intent);const baseline=session.report;const patched=await session.apply(patch);return {name,baseline,patched};
  }
  finally{const path=relative(resolve(tmpdir()),resolve(root));if(!path.startsWith('packlens-demo-')||path.includes('..')||isAbsolute(path))throw new PackageInputError('UNSAFE_CLEANUP');await rm(root,{recursive:true,force:true});}
}

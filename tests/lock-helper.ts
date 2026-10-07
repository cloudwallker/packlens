import { spawn } from 'node:child_process';
/** Real Windows exclusive handle; no substituted filesystem errors. */
export async function lockFile(path:string) {
  const script="$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:PACKLENS_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }";
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...process.env,PACKLENS_LOCK_FILE:path},stdio:['pipe','pipe','pipe']});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  try{await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('lock readiness timeout')),10000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',()=>{clearTimeout(timeout);reject(Error('lock helper exited before ready'));});
    child.stdout.on('data',data=>{if(String(data).includes('LOCKED')){clearTimeout(timeout);resolve();}});
  });}catch(error){child.kill();await exited;throw error;}
  return async()=>{child.stdin.end('\n');const timer=setTimeout(()=>child.kill(),3000);await exited;clearTimeout(timer);};
}

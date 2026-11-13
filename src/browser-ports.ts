import type {Server} from 'node:http';
import {PackageInputError} from './snapshot.ts';

// Union of the Fetch and Chromium HTTP port restrictions. Zero is the public
// API's automatic-allocation sentinel, never an actual listening port.
// https://fetch.spec.whatwg.org/#port-blocking
// https://chromium.googlesource.com/chromium/src/+/main/net/base/port_util.cc
const RESTRICTED_PORTS=new Set([
 1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,
 109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,
 515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,
 1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080
]);

export function validateBrowserPort(port:number):void{
 if(!Number.isInteger(port)||port<0||port>65535)throw new PackageInputError('INVALID_PORT');
 if(RESTRICTED_PORTS.has(port))throw new PackageInputError('BROWSER_RESTRICTED_PORT');
}

export async function listenForBrowser(server:Server,requestedPort=0):Promise<number>{
 validateBrowserPort(requestedPort);
 for(let attempt=0;attempt<16;attempt++){
  await new Promise<void>((resolve,reject)=>{
   server.once('error',reject);
   server.listen(requestedPort,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  const port=(server.address() as {port:number}).port;
  if(!RESTRICTED_PORTS.has(port))return port;
  // Close the actual listener before asking the OS for another allocation.
  const stopped=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  server.closeAllConnections();await stopped;
 }
 throw new PackageInputError('BROWSER_PORT_UNAVAILABLE');
}

import {readFile,readdir,writeFile} from 'node:fs/promises';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const directDev=new Set(['node_modules/playwright','node_modules/playwright-core','node_modules/typescript','node_modules/npm','node_modules/@types/node']);
const seen=new Set(),missing=[],records=[];
const upstreamGaps=new Set(['@npmcli/agent@5.0.2','proxy-agent-negotiate@1.1.0']);
for(const [path,record] of Object.entries(lock.packages)){
 if(!path.startsWith('node_modules/')||(record.dev&&!directDev.has(path)))continue;
 const pkg=JSON.parse(await readFile(path+'/package.json','utf8'));
 const key=pkg.name+'@'+pkg.version;if(seen.has(key))continue;seen.add(key);
 const files=(await readdir(path)).filter(name=>/^(licen[sc]e|copying|notice)([.-]|$)/i.test(name));
 const texts=[];for(const file of files){try{texts.push({file,text:await readFile(path+'/'+file,'utf8')});}catch{}}
 if(!texts.length){try{texts.push({file:upstreamGaps.has(key)?'Package metadata — upstream license text unavailable':'Upstream license and attribution',text:await readFile('licenses/'+pkg.name.replaceAll('/','__')+'.txt','utf8')});}catch{missing.push(key);}}
 records.push({key,license:pkg.license??record.license??'See upstream',repository:typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url,texts});
}
records.sort((a,b)=>a.key.localeCompare(b.key));
let output='# Third-party notices\n\nOriginal PackLens code and synthetic materials use MIT. Runtime dependencies are installed separately by npm; the PackLens source and compiled tarball do not vendor or bundle their code. This inventory records installed locked runtime packages and direct development tools (including Playwright core), with available upstream copyright/license texts and sources preserved below. npm includes its own bundled dependency notices in its license. The version-bound adapter calls upstream npm-packlist/ignore-walk methods.\n\nThe published releases @npmcli/agent@5.0.2 (ISC) and proxy-agent-negotiate@1.1.0 (MIT) did not supply standalone license texts during the recorded inspection. Their sections contain actual package metadata and public author attribution, not invented license grants. Both missing-text gaps remain open. The current distribution audit covers original source and an unbundled tarball; any future vendoring, bundled dependencies or binary embedding requires a new license review and the corresponding authorization evidence. Full available license texts for third-party text/assets actually copied into this distribution remain included.\n\n中文：原创材料采用 MIT；运行依赖由 npm 另行安装。本次源码及不捆绑 tar 的分发审计与上游正文取得是两项事实：上述两项正文仍未取得，其元数据不等于授权原文；未来捆绑必须重新审查。\n\n';
for(const r of records){output+=`## ${r.key}\n\nLicense: ${r.license}. Source: ${r.repository??'npm registry package metadata'}.\n\n`;for(const doc of r.texts)output+=`### ${doc.file}\n\n\`\`\`text\n${doc.text.trim()}\n\`\`\`\n\n`;}
await writeFile('THIRD_PARTY_NOTICES.md',output);
console.log(JSON.stringify({packages:records.length,missingNoticeMaterial:missing,upstreamStandaloneLicenseGaps:[...upstreamGaps]}));
if(missing.length)process.exitCode=1;

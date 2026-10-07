import {mkdir,readFile,readdir,writeFile,chmod} from 'node:fs/promises';
const names=['nested-ignore','empty-glob','css-missing','template-missing','unexpected-growth','forced-include'];
async function collect(root,prefix=''){const files={};for(const e of await readdir(root+(prefix?'/'+prefix:''),{withFileTypes:true})){const path=prefix?prefix+'/'+e.name:e.name;if(e.isDirectory())Object.assign(files,await collect(root,path));else if(e.isFile())files[path]=await readFile(root+'/'+path,'utf8');else throw Error('DEMO_ASSET_TYPE');}return files;}
await mkdir('dist/demo-assets',{recursive:true});
for(const name of names){const base=`fixtures/${name}`;const data={files:await collect(base+'/package'),intent:JSON.parse(await readFile(base+'/intent.json','utf8')),patch:JSON.parse(await readFile(base+'/patch.json','utf8'))};await writeFile(`dist/demo-assets/${name}.json`,JSON.stringify(data));}
await chmod('dist/cli.js',0o755);

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,lstat,realpath} from 'node:fs/promises';
import {join,relative,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
const run=promisify(execFile);
export async function readPublishedFile(packageRoot,commit,name) {
 const base=await realpath(packageRoot),file=resolve(base,name),rel=relative(base,file);
 if(!rel||rel.startsWith('..')||isAbsolute(rel)||await realpath(file)!==file||(await lstat(file)).isSymbolicLink())throw new Error('Unpublished package path');
 const gitRoot=(await run('git',['rev-parse','--show-toplevel'],{cwd:base})).stdout.trim();
 let path=relative(gitRoot,file).split('\\').join('/');
 if(relative(gitRoot,base)==='dist/my-crm')path=['examples/','src/','clients/'].some(prefix=>rel.startsWith(prefix))||['LICENSE','NOTICE','README.md'].includes(rel)?rel:'plugins/my-crm/'+rel;
 const expected=(await run('git',['show',commit+':'+path],{cwd:gitRoot,encoding:'buffer',maxBuffer:64*1024*1024})).stdout;
 const actual=await readFile(file);
 if(!actual.equals(expected))throw new Error('Unpublished package bytes');
 return actual;
}
async function checkPublishedPackage(packageRoot,commit) {
 const base=await realpath(packageRoot),gitRoot=(await run('git',['rev-parse','--show-toplevel'],{cwd:base})).stdout.trim();
 const prefix=relative(gitRoot,base).split('\\').join('/');
 if(prefix.startsWith('..')||isAbsolute(prefix))throw new Error('Package outside published repository');
 if(prefix==='dist/my-crm')return await verifyGeneratedMyCrm(base,gitRoot,commit);
 const listed=(await run('git',['ls-tree','-r','--name-only','-z',commit,'--',prefix||'.'],{cwd:gitRoot})).stdout.split('\0').filter(Boolean);
 const expected=listed.map(path=>prefix?path.slice(prefix.length+1):path).sort();
 const actual=[];
 async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){if(directory===base&&entry.name==='.git')continue;const file=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Unpublished package symlink');if(entry.isDirectory())await walk(file);else if(entry.isFile())actual.push(relative(base,file).split('\\').join('/'));else throw new Error('Unsupported package entry');}}
 await walk(base);actual.sort();
 if(!expected.length||JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Unpublished package additions or omissions');
 const hash=createHash('sha256');
 for(const name of actual){hash.update(name+'\0');hash.update(await readPublishedFile(base,commit,name));}
 return hash.digest('hex');
}
export function assertPackageOwnedBinding(manualServers,owners,bosPluginId,binding) {
 const matches=Object.entries(manualServers??{}).filter(([name,row])=>name==='BOS-Platform'||row?.url===binding.url);
 if(matches.length||owners.length!==1||owners[0]!==bosPluginId)throw new Error('BOS binding is not exclusively package owned');
}
export async function verifyPackageOwnedBinding(entries,bosPluginId,binding) {
 const python='import os,json,tomllib;from pathlib import Path;p=Path(os.environ.get("CODEX_HOME",str(Path.home()/".codex")))/"config.toml";v=tomllib.loads(p.read_text()) if p.exists() else {};print(json.dumps({k:{"url":r.get("url")} for k,r in v.get("mcp_servers",{}).items()}))';
 const manual=JSON.parse((await run('python3',['-c',python])).stdout),owners=[];
 for(const entry of entries.filter(row=>row.installed&&row.enabled&&row.source?.path)){
  let value;try{value=JSON.parse(await readFile(join(entry.source.path,'.mcp.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const [name,row] of Object.entries(value.mcpServers??{}))if(name==='BOS-Platform'||row.url===binding.url)owners.push(entry.pluginId);
 }
 assertPackageOwnedBinding(manual,owners,bosPluginId,binding);
}

export async function verifyPublishedPackage(root,commit){try{return await checkPublishedPackage(root,commit);}catch{const error=new Error("Installed package bytes are not published");error.acceptance_reason="installed_package_not_published";throw error;}}

function releasePathOrder(a,b){const left=a.split('/'),right=b.split('/');for(let i=0;i<Math.min(left.length,right.length);i++){const result=left[i].localeCompare(right[i]);if(result)return result;}return left.length-right.length;}
async function verifyGeneratedMyCrm(base,gitRoot,commit){
 const sourcePaths=(await run('git',['ls-tree','-r','--name-only','-z',commit,'--','plugins/my-crm','examples','src','clients','LICENSE','NOTICE','README.md'],{cwd:gitRoot})).stdout.split('\0').filter(Boolean);
 const expected=sourcePaths.map(name=>name.startsWith('plugins/my-crm/')?name.slice('plugins/my-crm/'.length):name).sort(releasePathOrder);
 const actual=[];
 async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const file=join(directory,entry.name);if(entry.isSymbolicLink())throw new Error('Unpublished release symlink');if(entry.isDirectory())await walk(file);else if(entry.isFile())actual.push(relative(base,file));else throw new Error('Unsupported release entry');}}
 await walk(base);actual.sort(releasePathOrder);
 if(!expected.length||JSON.stringify(actual)!==JSON.stringify([...expected,'release-manifest.json'].sort(releasePathOrder)))throw new Error('Unpublished generated release inventory');
 const inventory=[];
 for(const name of expected)inventory.push({path:name,sha256:createHash('sha256').update(await readPublishedFile(base,commit,name)).digest('hex')});
 const pkg=JSON.parse((await run('git',['show',commit+':package.json'],{cwd:gitRoot})).stdout);
 const content=createHash('sha256').update(inventory.map(row=>row.path+'\0'+row.sha256+'\n').join('')).digest('hex');
 const manifest={schema:'my-crm.release/v1',name:pkg.name,version:pkg.version,files:inventory,content_sha256:content};
 if((await readFile(join(base,'release-manifest.json'),'utf8'))!==JSON.stringify(manifest,null,2)+'\n')throw new Error('Unpublished release manifest');
 return content;
}

// Portable, source-only maintenance publication. No model or deployment effects.
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {readFile, writeFile, mkdir, readdir, lstat} from 'node:fs/promises';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bootstrapCommands, publishedContract} from './validation-contract.mjs';
const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const git = async (root, ...args) => (await exec('git', args, {cwd: root, maxBuffer: 16*1024*1024})).stdout.trim();
export const checks = [['npm','run','check:privacy'], ['npm','run','check:boundary'], ['npm','run','check:contracts'], ...bootstrapCommands];
export function maintenancePath(name) {
  return /^(?:scripts\/[^/]+\.(?:mjs|json|md)|tests\/[^/]+\.test\.mjs|\.agents\/skills\/[^/]+\/SKILL\.md|AGENTS\.md|README\.md)$/.test(name);
}
function withoutVersions(value) {
  if (Array.isArray(value)) return value.map(withoutVersions);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'version').map(([key,item]) => [key,withoutVersions(item)]));
  return value;
}
export async function scope(root, base, source) {
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(source)) throw new Error('Exact base and source commits are required');
  await git(root,'merge-base','--is-ancestor',base,source);
  // Every outgoing intermediate tree is checked, not just the final diff.
  const commits = (await git(root,'rev-list','--reverse',`${base}..${source}`)).split('\n').filter(Boolean);
  for (const commit of commits) {
    if ((await git(root,'rev-list','--parents','-n','1',commit)).split(' ').length !== 2) throw new Error('Maintenance admission requires linear source history');
    const names=(await git(root,'diff-tree','--no-commit-id','--name-only','-r',commit)).split('\n').filter(Boolean);
    for (const name of names) {
      if (maintenancePath(name)) continue;
      if (!/^(?:package(?:-lock)?\.json|(?:clients|plugins)\/.+\/(?:plugin|gemini-extension|\.bos-product)\.json)$/.test(name)) throw new Error(`Outside source maintenance scope: ${name}`);
      const before=JSON.parse(await git(root,'show',`${commit}^:${name}`)), after=JSON.parse(await git(root,'show',`${commit}:${name}`));
      if (name === 'clients/gemini/extensions/my-crm/plugin.json') {
        for (const metadata of [before,after]) metadata.description = metadata.description?.replace(/ Version \d+\.\d+\.\d+\.$/, ' Version <package>.');
      }
      if (JSON.stringify(withoutVersions(before)) !== JSON.stringify(withoutVersions(after))) throw new Error(`Non-version product change: ${name}`);
    }
  }
  if (publishedContract(root)) throw new Error('This bootstrap admission cannot override a selected contract');
  return commits;
}
async function runtime(root) {
  const entries=[];
  async function walk(directory, relative='') {
    for (const name of (await readdir(directory)).sort()) {
      const file=path.join(directory,name), rel=path.join(relative,name), stat=await lstat(file);
      if (stat.isDirectory()) await walk(file,rel);
      else if (stat.isFile()) entries.push([rel,stat.mode,hash(await readFile(file))]);
      else throw new Error('Dependency tree contains an unsupported file type');
    }
  }
  await walk(path.join(root,'node_modules'));
  return {node:hash(await readFile(process.execPath)),version:process.version,platform:process.platform,architecture:process.arch,dependencies:jsonHash(entries)};
}
async function identity(root) {
  if (await git(root,'status','--porcelain','--untracked-files=all')) throw new Error('Clean committed source is required');
  return {source:await git(root,'rev-parse','HEAD'),tree:await git(root,'rev-parse','HEAD^{tree}'),runtime:await runtime(root)};
}
function location(root, source) { return path.join(root,'.git','oracle','deterministic-publication',source+'.json'); }
export async function validate({root=process.cwd(),base,requestStartedAt}={}) {
  const started=requestStartedAt === 'unknown' ? null : Date.parse(requestStartedAt);
  if (started !== null && (!Number.isFinite(started) || started>Date.now())) throw new Error('Original request time or explicit unknown is required; retries retain it');
  const before=await identity(root); await scope(root,base,before.source);
  const directory=path.dirname(location(root,before.source)); await mkdir(directory,{recursive:true,mode:0o700});
  const runs=[];
  for (const command of checks) {
    const began=new Date().toISOString(); let result;
    try { result=await exec(command[0],command.slice(1),{cwd:root,maxBuffer:32*1024*1024,timeout:300000,env:{...process.env,NO_COLOR:'1'}}); }
    catch(error) {await writeFile(path.join(directory,`${before.source}-${Date.now()}.failure.log`),`${error.stdout??''}\n${error.stderr??''}`,{mode:0o600}); throw error;}
    const output=result.stdout+'\n'+result.stderr;
    if (command.includes('--test') && (!/(?:#|ℹ) tests [1-9]\d*/.test(output) || !/(?:#|ℹ) fail 0\b/.test(output) || !/(?:#|ℹ) skipped 0\b/.test(output) || !/(?:#|ℹ) cancelled 0\b/.test(output) || !/(?:#|ℹ) todo 0\b/.test(output))) throw new Error('Incomplete or skipped test execution');
    const outputHash=hash(output); await writeFile(path.join(directory,outputHash+'.log'),output,{mode:0o600});
    runs.push({command,started_at:began,completed_at:new Date().toISOString(),output_sha256:outputHash,exit_code:0});
  }
  const after=await identity(root); if(JSON.stringify(before)!==JSON.stringify(after)) throw new Error('Source or runtime changed during validation');
  const record={schema:'my-crm.deterministic-publication/v1',...before,base,request_started_at:started === null ? null : requestStartedAt,sla_status:'NOT_ESTABLISHED',completed_at:new Date().toISOString(),environment_sha256:jsonHash(Object.entries(process.env).sort()),runs};
  record.sha256=jsonHash(record);
  await writeFile(location(root,before.source),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
  return verify({root,reference:before.source});
}
export async function verify({root=process.cwd(),reference}={}) {
  const current=await identity(root); if(reference!==current.source) throw new Error('Deterministic source differs from checkout');
  const record=JSON.parse(await readFile(location(root,reference),'utf8')), {sha256,...unsigned}=record;
  if(record.schema!=='my-crm.deterministic-publication/v1'||jsonHash(unsigned)!==sha256||record.source!==current.source||record.tree!==current.tree||JSON.stringify(record.runtime)!==JSON.stringify(current.runtime)||JSON.stringify(record.runs.map(run=>run.command))!==JSON.stringify(checks)) throw new Error('Deterministic validation identity changed');
  await scope(root,record.base,reference);
  for(const run of record.runs) if(run.exit_code!==0||hash(await readFile(path.join(path.dirname(location(root,reference)),run.output_sha256+'.log')))!==run.output_sha256) throw new Error('Original deterministic output changed');
  return {status:'ADMITTED',technical_mode:'DETERMINISTIC_SOURCE_MAINTENANCE',source_commit:record.source,target_tree:record.tree,technical_receipt_sha256:sha256,plan_sha256:jsonHash(checks),protected_effects:[]};
}
async function main() {
  const [command,base,requestStartedAt]=process.argv.slice(2);
  if(command==='validate') console.log(JSON.stringify(await validate({base,requestStartedAt})));
  else if(command==='prepare') {
    const {preparePublication}=await import('./publication-checkpoint.mjs');
    console.log(JSON.stringify(await preparePublication({admit:verify,attest:async()=>({status:'NOT_EXPORTED',reason:'Required CI executes the complete native contract independently'})})));
  } else throw new Error('Usage: deterministic-publication.mjs validate <baseSHA> <original-request-ISO-time>|prepare');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error.message);process.exitCode=1;});

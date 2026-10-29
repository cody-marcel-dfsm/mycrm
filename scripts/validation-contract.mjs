// Native maintainer validation. No business execution or authentication owner.
import {createHash} from 'node:crypto';
import {readFileSync,existsSync,writeFileSync,renameSync,mkdirSync,readdirSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export const catalogPath='scripts/validation-catalog.json', selectionPath='scripts/validation-selection.json';
const rootDefault=fileURLToPath(new URL('..',import.meta.url));
const canonical=v=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:v&&typeof v==='object'?`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`:JSON.stringify(v);
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
const git=(root,...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}).trim();
export const runtime=()=>({node:process.version,node_sha256:createHash('sha256').update(readFileSync(process.execPath)).digest('hex'),platform:process.platform,architecture:process.arch,options_sha256:hash(Object.fromEntries(['NODE_OPTIONS','NODE_PATH'].map(k=>[k,process.env[k]??null])))});
const same=(a,b)=>canonical(a)===canonical(b);
export const classes={docs_only:['sanity'],bug_fix:['sanity','focused'],deep_bug_fix:['sanity','focused','interactions'],feature:['sanity','interactions','acceptance']};
export const slaSeconds={docs_only:120,bug_fix:180,deep_bug_fix:300,feature:300};
export const deliveryPolicy=kind=>({sla_seconds:slaSeconds[kind],clock_owner:'build_host',clock_start:'original_insertion',completion:'verified_remote_git',retries_reset_clock:false,reasoning_effort:['docs_only','bug_fix'].includes(kind)?'low':'medium',maximum_reasoning_effort:'medium'});
export function boundedSettings(settings,root=rootDefault){
 const file=path.join(root,selectionPath),kind=existsSync(file)?JSON.parse(readFileSync(file,'utf8')).selection.change_class:'deep_bug_fix';
 return {...settings,reasoning_effort:['none','minimal','low'].includes(settings.reasoning_effort)?settings.reasoning_effort:deliveryPolicy(kind).reasoning_effort};
}
const safe=p=>typeof p==='string'&&p.length&&!p.startsWith('/')&&!p.startsWith('-')&&!/[\\\r\n\0]/.test(p)&&!p.split('/').includes('..');
function blob(root,tree,name){const r=spawnSync('git',['show',`${tree}:${name}`],{cwd:root,encoding:'utf8'});if(r.status!==0)return null;return JSON.parse(r.stdout);}
export function checkCatalog(c){
 if(c?.schema!=='my-crm.validation-catalog/v1'||!same(c.sla_seconds,slaSeconds)||c.maximum_reasoning_effort!=='medium'||!same(c.classes,classes)||!Array.isArray(c.regression)||!c.regression.length||c.regression.length>8)throw Error('Invalid class catalog or uncurated regression registry');
 if(new Set(c.regression.map(r=>r.test)).size!==c.regression.length)throw Error('Duplicate regression test');
 for(const r of c.regression)if(!safe(r.test)||!r.test.startsWith('tests/')||!r.test.endsWith('.test.mjs')||/[*?\[\]]/.test(r.test)||!r.recurrence?.trim()||!r.boundary?.trim())throw Error('Regression needs an exact test, recurrence and boundary rationale');
 return c;
}
export function checkSelection(s,c){
 checkCatalog(c);
 if(!s||!same(Object.keys(s).sort(),['change_class','scope_paths','categories','reason','revision_of'].sort())||!Object.hasOwn(classes,s.change_class)||!s.reason?.trim())throw Error('Invalid Oracle validation selection');
 if(!Array.isArray(s.scope_paths)||!s.scope_paths.length||s.scope_paths.some(p=>!safe(p)))throw Error('Selection needs bounded planned source paths');
 if(s.revision_of!==null&&!/^[a-f0-9]{64}$/.test(s.revision_of))throw Error('Revision must bind the previous contract');
 if(!Array.isArray(s.categories)||!s.categories.length)throw Error('No selected categories');
 const names=s.categories.map(r=>r.name);
 if(new Set(names).size!==names.length||classes[s.change_class].some(n=>!names.includes(n))||['docs_only','bug_fix'].includes(s.change_class)&&!same(names,classes[s.change_class]))throw Error('Missing or duplicate selected category');
 for(const r of s.categories){
  if(!same(Object.keys(r).sort(),['fixtures','name','tests'])||!['sanity','focused','interactions','acceptance','regression'].includes(r.name)||!Array.isArray(r.tests)||new Set(r.tests).size!==r.tests.length)throw Error('Malformed category');
  if(!Array.isArray(r.fixtures)||new Set(r.fixtures).size!==r.fixtures.length||r.fixtures.some(p=>!safe(p)||!p.startsWith('tests/')||/[*?\[\]]/.test(p))||r.fixtures.some(p=>r.tests.includes(p)))throw Error('Fixtures need distinct exact test-input paths');
  if(['sanity','regression'].includes(r.name)){if(r.tests.length||r.fixtures.length)throw Error('Fixed category commands cannot be replaced');}
  else if(!r.tests.length||r.tests.some(p=>!safe(p)||!p.startsWith('tests/')||!p.endsWith('.test.mjs')||/[*?\[\]]/.test(p)))throw Error('Test category needs exact nonempty planned tests');
 }
 return s;
}
export function selectedCommands(s,c){return s.categories.map(r=>{const tests=r.name==='regression'?c.regression.map(v=>v.test):r.tests;return {category:r.name,tests,fixtures:r.fixtures,argv:r.name==='sanity'?['node','scripts/validation-contract.mjs','sanity']:['node','--test','--test-reporter=tap',...tests]};});}
export function proposalSelection(output){
 const lines=output.split(/\r?\n/).filter(line=>line.startsWith('VALIDATION_SELECTION='));
 if(lines.length!==1)throw Error('Independent proposal omitted or duplicated validation selection');
 return JSON.parse(lines[0].slice('VALIDATION_SELECTION='.length));
}
export function sealSelection(root,selection,proposal,review){
 const catalog=JSON.parse(readFileSync(path.join(root,catalogPath),'utf8'));checkSelection(selection,catalog);
 const filename=path.join(root,selectionPath),previous=existsSync(filename)?JSON.parse(readFileSync(filename,'utf8')):null;
 if(selection.revision_of!==(previous?.contract_sha256??null))throw Error('Revision does not name current original contract');
 const base=git(root,'rev-parse','HEAD'),value={schema:'my-crm.validation-contract/v1',selection,base_commit:base,base_tree:git(root,'rev-parse',`${base}^{tree}`),catalog_sha256:hash(catalog),runtime:runtime(),proposal_sha256:hash(proposal),review_sha256:hash(review),commands:selectedCommands(selection,catalog),delivery_policy:deliveryPolicy(selection.change_class)};
 return {...value,contract_sha256:hash(value)};
}
export function writeSelection(root,value){
 const p=path.join(root,selectionPath),previous=existsSync(p)?JSON.parse(readFileSync(p,'utf8')):null;
 if(value.selection.revision_of!==(previous?.contract_sha256??null))throw Error('Original contract moved before publication');
 writeFileSync(`${p}.tmp`,`${JSON.stringify(value,null,2)}\n`,{flag:'wx'});renameSync(`${p}.tmp`,p);
}
export function validateContract(contract,catalog){
 if(!contract)return null;
 const {contract_sha256,...body}=contract;
 if(contract.schema!=='my-crm.validation-contract/v1'||hash(body)!==contract_sha256)throw Error('Contract identity changed');
 checkSelection(contract.selection,catalog);
 if(!same(contract.delivery_policy,deliveryPolicy(contract.selection.change_class)))throw Error('Delivery policy changed; preserve the original host clock');
 if(contract.catalog_sha256!==hash(catalog)||!same(contract.commands,selectedCommands(contract.selection,catalog)))throw Error('Catalog or exact commands changed; obtain explicit revision');
 return contract;
}
export function publishedContract(root=rootDefault){
 const file=path.join(root,selectionPath);
 return existsSync(file)?validateContract(JSON.parse(readFileSync(file,'utf8')),JSON.parse(readFileSync(path.join(root,catalogPath),'utf8'))):null;
}
export function requiredFor(contract){return contract?contract.commands.map(r=>['node','scripts/validation-contract.mjs','run','--category',r.category]):[['npm','run','build'],['npm','test'],['npm','run','check:release']];}
export function verifyContract(root,tree='HEAD',proposal){
 const contract=validateContract(blob(root,tree,selectionPath),blob(root,tree,catalogPath));if(!contract)return null;
 if(proposal&&!same(proposal.validation_contract,contract))throw Error('Selection lacks its exact original independent proposal');
 if(git(root,'rev-parse',`${contract.base_commit}^{tree}`)!==contract.base_tree)throw Error('Baseline differs');
 const candidate=git(root,'cat-file','-t',tree)==='commit'?tree:git(root,'rev-parse','HEAD');
 if(git(root,'rev-parse',`${candidate}^{tree}`)!==git(root,'rev-parse',`${tree}^{tree}`)||spawnSync('git',['merge-base','--is-ancestor',contract.base_commit,candidate],{cwd:root}).status!==0)throw Error('Candidate does not descend from contract baseline');
 const match=(name,pattern)=>new RegExp(`^${pattern.split('*').map(v=>v.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')}$`).test(name);
 for(const name of git(root,'diff','--name-only',contract.base_commit,tree).split('\n').filter(Boolean)){
  if(name===selectionPath)continue;
  if(!contract.selection.scope_paths.some(p=>match(name,p)))throw Error(`Changed path outside selected scope: ${name}`);
  if(contract.selection.change_class==='docs_only'&&(!name.endsWith('.md')||name==='AGENTS.md'||name.startsWith('.agents/')||name.startsWith('plugins/')||name.startsWith('clients/')))throw Error('Executable guidance or non-document source cannot use docs_only');
 }
 return contract;
}
export function testSummary(output,code,test){
 if(!test)return {passed:code===0,tests:null,skipped:0};
 const c={};for(const key of ['tests','pass','fail','cancelled','skipped','todo']){const m=[...output.matchAll(new RegExp(`^# ${key} (\\d+)\\s*$`,'gm'))];if(m.length!==1)return {passed:false,reason:'Missing or ambiguous complete TAP summary'};c[key]=Number(m[0][1]);}
 const complete=c.tests>0&&c.tests===c.pass+c.fail+c.cancelled+c.skipped+c.todo;
 return {...c,complete,passed:code===0&&complete&&c.fail===0&&c.cancelled===0&&c.skipped===0&&c.todo===0&&!/# (?:SKIP|TODO)\b/.test(output)};
}
function originals(root,contract,phase){
 const folder=path.join(git(root,'rev-parse','--absolute-git-dir'),'oracle','validation-contract-results',contract.contract_sha256),rows=[];if(!existsSync(folder))return rows;
 for(const commit of readdirSync(folder))for(const name of readdirSync(path.join(folder,commit))){
  if(!name.includes(`-${phase}-`)||!name.endsWith('.json'))continue;
  const filename=path.join(folder,commit,name),record=JSON.parse(readFileSync(filename,'utf8')),{record_sha256,...body}=record;
  if(hash(body)!==record_sha256||hash(readFileSync(record.output_file,'utf8'))!==record.output_sha256)throw Error('Original validation result/output changed');rows.push({...record,_record_path:filename});
 }
 return rows;
}
export function executeCategory(root,category,phase='after',run=spawnSync){
 if(git(root,'status','--porcelain=v1','--untracked-files=all'))throw Error('Use a clean committed candidate');
 const commit=git(root,'rev-parse','HEAD'),contract=verifyContract(root,commit);if(!contract||!same(runtime(),contract.runtime))throw Error('Missing contract or changed runtime');
 const row=contract.commands.find(r=>r.category===category);if(!row)throw Error('Category was not selected');
 const fixtures=Object.fromEntries([...row.tests,...row.fixtures].map(p=>[p,git(root,'rev-parse',`${commit}:${p}`)]));
 if(phase==='before'){
  if(category!=='focused'||!['bug_fix','deep_bug_fix'].includes(contract.selection.change_class))throw Error('Only selected bug reproduction has a before phase');
  if(git(root,'diff','--name-only',contract.base_commit,commit).split('\n').filter(Boolean).some(p=>p!==selectionPath&&!Object.hasOwn(fixtures,p)))throw Error('Fail-before includes implementation changes');
 }else if(category==='focused'&&['bug_fix','deep_bug_fix'].includes(contract.selection.change_class)){
  if(!originals(root,contract,'before').some(r=>r.category===category&&same(r.fixtures,fixtures)&&same(r.runtime,contract.runtime)&&r.exit_code!==0&&r.summary.complete&&r.summary.fail>0&&readFileSync(r.output_file,'utf8').includes('ERR_ASSERTION')&&['skipped','todo','cancelled'].every(k=>r.summary[k]===0)))throw Error('Missing unchanged-test fail-before; an infrastructure error is not a reproduction');
 }
 const result=run(row.argv[0],row.argv.slice(1),{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,env:Object.fromEntries(Object.entries(process.env).filter(([k])=>k!=='NODE_TEST_CONTEXT'))}),output=(result.stdout??'')+(result.stderr??''),summary=testSummary(output,result.status,!!row.tests.length);
 const stable=git(root,'rev-parse','HEAD')===commit&&!git(root,'status','--porcelain=v1','--untracked-files=all')&&same(runtime(),contract.runtime);
 const folder=path.join(git(root,'rev-parse','--absolute-git-dir'),'oracle','validation-contract-results',contract.contract_sha256,commit);mkdirSync(folder,{recursive:true});const log=path.join(folder,`${hash(output)}.log`);if(!existsSync(log))writeFileSync(log,output);
 const record={schema:'my-crm.validation-execution/v1',result_scope:'validation_phase',e2e_status:'NOT_EVALUATED',delivery_policy:contract.delivery_policy,contract_sha256:contract.contract_sha256,catalog_sha256:contract.catalog_sha256,commit,tree:git(root,'rev-parse',`${commit}^{tree}`),category,phase,command:row.argv,fixtures,runtime:contract.runtime,finished_at:new Date().toISOString(),exit_code:result.status,signal:result.signal,error:result.error?.message??null,summary,inputs_unchanged:stable,passed:phase==='after'&&summary.passed&&stable,output_file:log,output_sha256:hash(output)};record.record_sha256=hash(record);const filename=path.join(folder,`${category}-${phase}-${record.record_sha256}.json`);writeFileSync(filename,`${JSON.stringify(record,null,2)}\n`,{flag:'wx'});
 return {record,filename,exit_code:record.passed||phase==='before'&&stable&&summary.complete&&summary.fail>0&&['skipped','todo','cancelled'].every(k=>summary[k]===0)&&output.includes('ERR_ASSERTION')&&result.status!==0?0:1};
}
export function admitContract(root,tree,proposal){
 const contract=verifyContract(root,tree,proposal);
 if(!contract){if(blob(root,proposal.base_commit,catalogPath))throw Error('Oracle must select validation before implementation');return null;}
 const all=originals(root,contract,'after'),results=contract.commands.map(row=>{
  const r=all.filter(v=>v.tree===tree&&v.category===row.category&&same(v.command,row.argv)&&same(v.runtime,contract.runtime)&&v.catalog_sha256===contract.catalog_sha256).sort((a,b)=>a.finished_at.localeCompare(b.finished_at)).at(-1);
  if(!r?.passed)throw Error(`Selected category incomplete or failed: ${row.category}`);return r;
 });return {contract,results,before:originals(root,contract,'before')};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const action=process.argv[2];if(action==='sanity'){
  const contract=verifyContract(rootDefault,'HEAD');
  for(const argv of [['git','diff','--check',contract?.base_commit??'HEAD~1','HEAD'],['npm','run','check:privacy'],['npm','run','check:boundary']]){const r=spawnSync(argv[0],argv.slice(1),{cwd:rootDefault,stdio:'inherit'});if(r.status!==0)throw Error('Minimal sanity failed');}
 }else if(action==='run'){const category=process.argv[process.argv.indexOf('--category')+1],phase=process.argv.includes('--phase')?process.argv[process.argv.indexOf('--phase')+1]:'after';if(!['before','after'].includes(phase))throw Error('Unknown phase');const r=executeCategory(rootDefault,category,phase);console.log(JSON.stringify({record:r.filename,passed:r.record.passed,phase,summary:r.record.summary}));process.exitCode=r.exit_code;
 }else throw Error('Usage: validation-contract.mjs sanity | run --category NAME [--phase before|after]');}catch(e){console.error(e.message);process.exitCode=2;}
}

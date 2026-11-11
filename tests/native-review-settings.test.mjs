import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, chmod, rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),launcher=fileURLToPath(new URL('../scripts/oracle-review.mjs',import.meta.url));

test('actual native proposal dispatch binds the owner reasoning cap without changing selected model',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'crm-native-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),bin=path.join(root,'bin');await mkdir(repo);await mkdir(bin);
 for(const directory of ['Vault/docs','Vault/tmp','.agents/skills/oracle'])await mkdir(path.join(repo,directory),{recursive:true});
 for(const [name,text] of Object.entries({'AGENTS.md':'Synthetic authority.','.agents/skills/oracle/SKILL.md':'Synthetic independent approver.','Vault/docs/CONSTITUTION.md':'Synthetic constitution.','.gitignore':'Vault/\n','candidate.txt':'Synthetic source.'}))await writeFile(path.join(repo,name),text);
 const git=async(...args)=>(await execute('git',args,{cwd:repo})).stdout.trim();await git('init','-q','-b','main');await git('add','.');await git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic baseline');
 const fake=path.join(bin,'codex');await writeFile(fake,`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(process.env.SYNTHETIC_CAPTURE,JSON.stringify(args));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Synthetic isolated review.\\nAUTHENTICATION_IMPACT=NONE\\nAPI_VERSION_ASSESSMENT={"impact":"NONE","request_kind":"NOT_REQUIRED","requested_change":null,"request_quote":null,"request_evidence":null}\\nOWNER_APPROVAL_STATUS=NOT_REQUIRED\\nORACLE_VERDICT=APPROVED\\n');\n`);await chmod(fake,0o700);
 for(const [requested,expected] of [['ultra','medium'],['low','low']]){
  const capture=path.join(repo,'Vault/tmp',`${requested}.json`);
  await execute(process.execPath,[launcher,'proposal',`Problem: synthetic ${requested}. Cause: test dispatch. Recommended change: preserve owner cap.`],{cwd:repo,env:{...process.env,CLAUDECODE:'',PATH:`${bin}${path.delimiter}${process.env.PATH}`,CODEX_THREAD_ID:'',CODEX_SELECTED_MODEL:'synthetic-selected-model',CODEX_SELECTED_REASONING_EFFORT:requested,SYNTHETIC_CAPTURE:capture},timeout:30000});
  const argv=JSON.parse(await readFile(capture,'utf8'));assert.equal(argv[argv.indexOf('--model')+1],'synthetic-selected-model');assert.ok(argv.includes(`model_reasoning_effort="${expected}"`));
  const record=JSON.parse(await readFile(path.join(repo,'.git/oracle/proposal.json'),'utf8'));assert.equal(record.reviewer.reasoning_effort,expected);
 }
});

// A contract-producing synthetic checkout with a fetched origin/main.
async function contractRepository(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'crm-native-spec-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=path.join(root,'repo'),origin=path.join(root,'origin.git'),bin=path.join(root,'bin');await mkdir(repo);await mkdir(bin);
 for(const directory of ['Vault/docs','Vault/tmp','.agents/skills/oracle','scripts','tests'])await mkdir(path.join(repo,directory),{recursive:true});
 const catalog=await readFile(new URL('../scripts/validation-catalog.json',import.meta.url),'utf8');
 for(const [name,text] of Object.entries({'AGENTS.md':'Synthetic authority.','.agents/skills/oracle/SKILL.md':'Synthetic independent approver.','Vault/docs/CONSTITUTION.md':'Synthetic constitution.','.gitignore':'Vault/\n','candidate.mjs':'export default 1;\n','tests/candidate.test.mjs':"import test from 'node:test';test('candidate',()=>{});\n",'scripts/validation-catalog.json':catalog}))await writeFile(path.join(repo,name),text);
 const git=async(...args)=>(await execute('git',args,{cwd:repo})).stdout.trim();
 await git('init','-q','-b','main');await git('add','.');await git('-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qm','Synthetic baseline');
 await execute('git',['init','-q','-b','main','--bare',origin]);await git('remote','add','origin',origin);await git('push','-q','origin','main');
 const selection={change_class:'bug_fix',scope_paths:['candidate.mjs','tests/*'],categories:[{name:'sanity',tests:[],fixtures:[]},{name:'focused',tests:['tests/candidate.test.mjs'],fixtures:[]}],reason:'Synthetic focused repair.',revision_of:null,design:null};
 const spec={title:'Synthetic candidate repair',runtime_paths:['candidate.mjs'],acceptance:[{criterion:'The candidate exports the corrected value.',tests:['tests/candidate.test.mjs']}],tests:[{module:'tests/candidate.test.mjs',purpose:'Prove the corrected export.'}],findings:[{severity:'warning',message:'Synthetic warning.'}]};
 const api={impact:'NONE',request_kind:'NOT_REQUIRED',requested_change:null,request_quote:null,request_evidence:null};
 const env={...process.env,CLAUDECODE:'',PATH:`${bin}${path.delimiter}${process.env.PATH}`,CODEX_THREAD_ID:'',CODEX_SELECTED_MODEL:'synthetic-selected-model',CODEX_SELECTED_REASONING_EFFORT:'low',SYNTHETIC_CAPTURE:path.join(repo,'Vault/tmp/capture.json')};
 return {repo,bin,git,selection,spec,api,env};
}
const markers=(f,verdict='APPROVED')=>`Synthetic isolated review.\nVALIDATION_SELECTION=${JSON.stringify(f.selection)}\nORACLE_SPEC=${JSON.stringify(f.spec)}\nAPI_VERSION_ASSESSMENT=${JSON.stringify(f.api)}\nAUTHENTICATION_IMPACT=NONE\nOWNER_APPROVAL_STATUS=NOT_REQUIRED\nORACLE_VERDICT=${verdict}\n`;
const proposalText='Problem: synthetic defect. Cause: synthetic cause. Recommended change: synthetic repair.';
async function sealed(f){
 const contract=JSON.parse(await readFile(path.join(f.repo,'scripts/validation-selection.json'),'utf8')),spec=await import('../scripts/oracle-spec.mjs');
 assert.equal(spec.verifyContractSpec(contract).seal,contract.spec.seal);assert.equal(spec.computeSeal(contract.spec),contract.spec.seal);
 assert.equal(contract.spec.base,await f.git('rev-parse','refs/remotes/origin/main'));assert.equal(contract.base_commit,contract.spec.base);
 const record=JSON.parse(await readFile(path.join(f.repo,'.git/oracle/proposal.json'),'utf8'));assert.equal(record.base_commit,contract.spec.base);
 assert.equal(JSON.stringify(contract).includes(proposalText),false);return contract;
}

test('codex proposal outputs a stamped sealed spec inside the contract with the fetched base',async t=>{
 const f=await contractRepository(t);
 await writeFile(path.join(f.bin,'codex'),`#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(process.env.SYNTHETIC_CAPTURE,JSON.stringify(args));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],${JSON.stringify(markers(f))});\n`);await chmod(path.join(f.bin,'codex'),0o700);
 await writeFile(path.join(f.repo,'Vault/tmp/request.md'),'Synthetic request bytes.\n');
 await execute(process.execPath,[launcher,'proposal',proposalText,'--engine','codex','--request-file','Vault/tmp/request.md'],{cwd:f.repo,env:f.env,timeout:30000});
 const contract=await sealed(f),argv=JSON.parse(await readFile(f.env.SYNTHETIC_CAPTURE,'utf8'));
 assert.deepEqual([contract.spec.stamp.engine,contract.spec.stamp.model,contract.spec.stamp.request_sha256],['codex','synthetic-selected-model',(await import('node:crypto')).createHash('sha256').update('Synthetic request bytes.\n').digest('hex')]);
 assert.match(argv.at(-1),/ORACLE_SPEC=<single-line JSON/);assert.match(argv.at(-1),/<request>\nSynthetic request bytes/);
});

test('claude proposal runs read-only from stdin and its structured answer seals the same contract',async t=>{
 const f=await contractRepository(t),stdin=path.join(f.repo,'Vault/tmp/stdin.txt');
 const answer={summary:'### Problem\nSynthetic.',verdict:'APPROVED',authentication_impact:'NONE',owner_approval_status:'NOT_REQUIRED',api_version_assessment:f.api,validation_selection:f.selection,spec:f.spec};
 await writeFile(path.join(f.bin,'claude'),`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.SYNTHETIC_CAPTURE,JSON.stringify({args:process.argv.slice(2),claudecode:process.env.CLAUDECODE??null}));fs.writeFileSync(${JSON.stringify(stdin)},fs.readFileSync(0));process.stdout.write(JSON.stringify({type:'result',is_error:false,structured_output:${JSON.stringify(answer)},modelUsage:{'synthetic-claude-model':{}}}));\n`);await chmod(path.join(f.bin,'claude'),0o700);
 await execute(process.execPath,[launcher,'proposal',proposalText],{cwd:f.repo,env:{...f.env,CLAUDECODE:'1'},timeout:30000});
 const contract=await sealed(f),capture=JSON.parse(await readFile(f.env.SYNTHETIC_CAPTURE,'utf8'));
 assert.deepEqual([contract.spec.stamp.engine,contract.spec.stamp.model,contract.spec.stamp.request_sha256],['claude','synthetic-claude-model',null]);
 assert.equal(capture.claudecode,null);assert.equal(capture.args[capture.args.indexOf('--tools')+1],'Read,Grep,Glob');assert.ok(capture.args.includes('--restricted')&&capture.args.includes('--strict-mcp-config'));
 assert.equal(capture.args.includes(proposalText),false);assert.match(await readFile(stdin,'utf8'),/Synthetic defect|synthetic defect/);
 const record=JSON.parse(await readFile(path.join(f.repo,'.git/oracle/proposal.json'),'utf8'));assert.deepEqual(record.engine,{name:'claude',model:'synthetic-claude-model'});assert.equal(record.reviewer.sandbox,'restricted-read-tools');
});

test('a proposal is refused before dispatch when main lacks fetched origin/main or the engine is missing',async t=>{
 const f=await contractRepository(t);
 await writeFile(path.join(f.bin,'codex'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.SYNTHETIC_CAPTURE,'dispatched');\n`);await chmod(path.join(f.bin,'codex'),0o700);
 const clone=path.join(path.dirname(f.repo),'ahead');await execute('git',['clone','-q',path.join(path.dirname(f.repo),'origin.git'),clone]);
 await writeFile(path.join(clone,'candidate.mjs'),'export default 2;\n');await execute('git',['-c','user.name=Synthetic','-c','user.email=synthetic@example.invalid','commit','-qam','Remote advance'],{cwd:clone});await execute('git',['push','-q','origin','main'],{cwd:clone});
 await assert.rejects(execute(process.execPath,[launcher,'proposal',proposalText,'--engine','codex'],{cwd:f.repo,env:f.env,timeout:30000}),/does not contain fetched origin\/main/);
 await assert.rejects(execute(process.execPath,[launcher,'proposal',proposalText,'--engine','claude'],{cwd:f.repo,env:{...f.env,PATH:`${f.bin}${path.delimiter}${path.dirname((await execute('sh',['-c','command -v git'])).stdout.trim())}`},timeout:30000}),/claude CLI is not installed/);
 await assert.rejects(readFile(f.env.SYNTHETIC_CAPTURE,'utf8'),{code:'ENOENT'});
 await assert.rejects(readFile(path.join(f.repo,'scripts/validation-selection.json'),'utf8'),{code:'ENOENT'});
});

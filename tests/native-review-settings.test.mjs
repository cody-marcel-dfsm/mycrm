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
  await execute(process.execPath,[launcher,'proposal',`Problem: synthetic ${requested}. Cause: test dispatch. Recommended change: preserve owner cap.`],{cwd:repo,env:{...process.env,PATH:`${bin}${path.delimiter}${process.env.PATH}`,CODEX_THREAD_ID:'',CODEX_SELECTED_MODEL:'synthetic-selected-model',CODEX_SELECTED_REASONING_EFFORT:requested,SYNTHETIC_CAPTURE:capture},timeout:30000});
  const argv=JSON.parse(await readFile(capture,'utf8'));assert.equal(argv[argv.indexOf('--model')+1],'synthetic-selected-model');assert.ok(argv.includes(`model_reasoning_effort="${expected}"`));
  const record=JSON.parse(await readFile(path.join(repo,'.git/oracle/proposal.json'),'utf8'));assert.equal(record.reviewer.reasoning_effort,expected);
 }
});

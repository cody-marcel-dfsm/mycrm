import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {maintenancePath,scope,checks} from '../scripts/deterministic-publication.mjs';
test('maintenance admission excludes workflow, product source, private and deployment paths',()=>{
 for(const name of ['src/client.mjs','.github/workflows/ci.yml','.env','Vault/private.md','infra/main.tf','scripts/nested/deploy.mjs','scripts/codex-maintainer-install.mjs','scripts/build-release.mjs','scripts/unknown.mjs']) assert.equal(maintenancePath(name),false,name);
 assert.equal(maintenancePath('scripts/validation-contract.mjs'),true);
 assert(checks.some(command=>command.includes('check:privacy')));
 assert(checks.some(command=>command.includes('tests/publication-checkpoint.test.mjs')));
});
test('scope rejects intermediate product changes even when reverted',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'crm-source-scope-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 try {
  git('init','-q');git('config','user.name','Synthetic Maintainer');git('config','user.email','synthetic@example.invalid');
  await writeFile(path.join(root,'README.md'),'base\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  await mkdir(path.join(root,'src'));await writeFile(path.join(root,'src/client.mjs'),'export const changed=true;');git('add','.');git('commit','-qm','product change');
  git('revert','--no-edit','HEAD');
  await assert.rejects(scope(root,base,git('rev-parse','HEAD')),/Outside source maintenance scope/);
 } finally {await rm(root,{recursive:true,force:true});}
});
test('scope admits version-only metadata but rejects dependency changes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'crm-source-version-'));
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
 try {
  git('init','-q');git('config','user.name','Synthetic Maintainer');git('config','user.email','synthetic@example.invalid');
  const file=path.join(root,'package.json');
  await writeFile(file,JSON.stringify({version:'0.1.0',dependencies:{example:'1.0.0'}}));git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
  await writeFile(file,JSON.stringify({version:'0.1.1',dependencies:{example:'1.0.0'}}));git('add','.');git('commit','-qm','version');await scope(root,base,git('rev-parse','HEAD'));
  await writeFile(file,JSON.stringify({version:'0.1.1',dependencies:{example:'2.0.0'}}));git('add','.');git('commit','-qm','dependency');await assert.rejects(scope(root,base,git('rev-parse','HEAD')),/Non-version product change/);
 }finally{await rm(root,{recursive:true,force:true});}
});

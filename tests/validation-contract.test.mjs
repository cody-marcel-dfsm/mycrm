import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import * as v from '../scripts/validation-contract.mjs';

function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'crm-contract-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const put=(name,text)=>writeFileSync(path.join(root,name),text);
  for(const dir of ['scripts','tests'])mkdirSync(path.join(root,dir));
  const catalog={schema:'my-crm.validation-catalog/v1',classes:structuredClone(v.classes),sla_seconds:structuredClone(v.slaSeconds),maximum_reasoning_effort:'medium',regression:[{test:'tests/regression.test.mjs',recurrence:'Synthetic recurrence',boundary:'Synthetic boundary'}]};
  put(v.catalogPath,JSON.stringify(catalog));
  for(const name of ['validation-contract.mjs','release-validation.mjs'])put(`scripts/${name}`,readFileSync(new URL(`../scripts/${name}`,import.meta.url)));
  put('package.json',JSON.stringify({type:'module',scripts:{'check:privacy':'node -e "process.exit(0)"','check:boundary':'node -e "process.exit(0)"'}}));
  put('source.mjs','export default false;\n');
  put('tests/regression.test.mjs',"import test from 'node:test';test('recurrence',()=>{});\n");
  git('init','-q');git('config','user.email','synthetic@example.invalid');git('config','user.name','Synthetic');
  const commit=()=>{git('add','-A');git('commit','-qm','Synthetic fixture');return git('rev-parse','HEAD');};commit();
  const selection=(kind='bug_fix')=>({change_class:kind,scope_paths:['source.mjs','tests/*'],categories:v.classes[kind].map(name=>({name,tests:['sanity','regression'].includes(name)?[]:['tests/reproduction.test.mjs'],fixtures:[]})),reason:'Synthetic exact contract',revision_of:null});
  const publish=(kind='bug_fix',fixtures=[])=>{const selected=selection(kind);if(fixtures.length)selected.categories[1].fixtures=fixtures;const c=v.sealSelection(root,selected,'Synthetic proposal',{verdict:'APPROVED'});v.writeSelection(root,c);return c;};
  return {root,git,put,commit,catalog,selection,publish};
}

test('class minima, exact tests and explicit revisions fail closed',t=>{
  const f=fixture(t);
  for(const kind of Object.keys(v.classes))assert.equal(v.checkSelection(f.selection(kind),f.catalog).change_class,kind);
  for(const change of [s=>s.categories=[],s=>s.categories.push(s.categories[0]),s=>s.categories[1].tests=[],s=>s.categories[1].tests=['tests/*.test.mjs'],s=>s.scope_paths=['../escape'],s=>s.revision_of='unknown']){
    const s=f.selection();change(s);assert.throws(()=>v.checkSelection(s,f.catalog));
  }
  const c=f.publish();assert.throws(()=>f.publish(),/Revision/);
  f.commit();const next=f.selection();next.revision_of=c.contract_sha256;
  assert.equal(v.sealSelection(f.root,next,'Revised proposal',{}).selection.revision_of,c.contract_sha256);
});

test('zero exit, partial, empty, skipped and ambiguous TAP cannot pass',()=>{
  const tap=values=>Object.entries({tests:2,pass:2,fail:0,cancelled:0,skipped:0,todo:0,...values}).map(([key,value])=>`# ${key} ${value}\n`).join('');
  assert.equal(v.testSummary(tap(),0,true).passed,true);
  for(const [text,code] of [[tap({tests:0,pass:0}),0],[tap({pass:1,skipped:1}),0],[tap({pass:1,todo:1}),0],[tap({pass:1,cancelled:1}),0],[tap({pass:1}),0],[tap(),1],['',0],[tap()+tap(),0]])assert.equal(v.testSummary(text,code,true).passed,false);
});

test('real unchanged reproduction fails then passes; release uses every selected command',async t=>{
  const f=fixture(t),contract=f.publish('bug_fix',['tests/case.json']);
  f.put('tests/case.json','{\"expected\":true}');
  f.put('tests/reproduction.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import value from '../source.mjs';import{readFileSync}from'node:fs';const expected=JSON.parse(readFileSync(new URL('./case.json',import.meta.url))).expected;test('reproduce',()=>assert.equal(value,expected));\n");f.commit();
  const before=v.executeCategory(f.root,'focused','before');assert.equal(before.exit_code,0);assert.notEqual(before.record.exit_code,0);assert.equal(before.record.passed,false);
  const original=readFileSync(before.filename);
  f.put('source.mjs','export default true;\n');f.commit();const tree=f.git('rev-parse','HEAD^{tree}');
  assert.throws(()=>v.admitContract(f.root,tree,{validation_contract:contract}),/incomplete/);
  for(const category of ['sanity','focused'])assert.equal(v.executeCategory(f.root,category).exit_code,0);
  assert.equal(v.admitContract(f.root,tree,{validation_contract:contract}).results.length,2);
  assert.deepEqual(readFileSync(before.filename),original);
  const release=await import(pathToFileURL(path.join(f.root,'scripts/release-validation.mjs')));
  const executed=[];await release.validateRelease({nativeEvidence:false,priorCoverage:{covered:[],invalidated:[]},execute:async argv=>executed.push(argv)});
  assert.deepEqual(executed,v.requiredFor(contract));
  // Reuse is exact-command only: all uncovered selected commands still run.
  const remaining=[];await release.validateRelease({nativeEvidence:false,priorCoverage:{covered:[{command:executed[1],coverage:'EXACT_INPUT_EXECUTION'}],invalidated:[]},execute:async argv=>remaining.push(argv)});
  assert.deepEqual(remaining,[executed[0]]);
});

test('a rejected source-mutating before run cannot become reproduction after commit',t=>{
 const f=fixture(t);f.publish();
 f.put('tests/reproduction.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';import value from '../source.mjs';test('mutation is not reproduction',()=>{if(!value)writeFileSync(new URL('../source.mjs',import.meta.url),'export default true;');assert.equal(value,true);});");f.commit();
 const before=v.executeCategory(f.root,'focused','before');assert.equal(before.exit_code,1);assert.equal(before.record.inputs_unchanged,false);assert.equal(before.record.summary.fail,1);
 const original=readFileSync(before.filename);f.commit();assert.throws(()=>v.executeCategory(f.root,'focused'),/unchanged-test/);assert.deepEqual(readFileSync(before.filename),original);
});

test('syntax failures and changed reproduction do not supply bug-before evidence',t=>{
  const f=fixture(t);f.publish();
  f.put('tests/reproduction.test.mjs','not valid javascript {{{');f.commit();
  const invalid=v.executeCategory(f.root,'focused','before');assert.equal(invalid.exit_code,1);
  f.put('tests/reproduction.test.mjs',"import test from 'node:test';test('different test',()=>{});");f.commit();
  assert.throws(()=>v.executeCategory(f.root,'focused'),/unchanged-test/);
});

test('source, catalog, runtime and original output remain bound',t=>{
  const f=fixture(t),c=f.publish('feature');
  f.put('tests/reproduction.test.mjs',"import test from 'node:test';test('synthetic',()=>{});");f.commit();
  const execution=v.executeCategory(f.root,'acceptance');assert.equal(execution.exit_code,0);
  writeFileSync(execution.record.output_file,'changed original');
  assert.throws(()=>v.admitContract(f.root,f.git('rev-parse','HEAD^{tree}'),{validation_contract:c}),/custody|changed/);
  f.put('outside.mjs','changed');f.commit();assert.throws(()=>v.verifyContract(f.root),/outside/);
  const changed=structuredClone(c);changed.runtime.node='different';changed.contract_sha256=v.hash(Object.fromEntries(Object.entries(changed).filter(([k])=>k!=='contract_sha256')));
  f.git('rm','outside.mjs');f.put(v.selectionPath,JSON.stringify(changed));f.commit();assert.throws(()=>v.executeCategory(f.root,'acceptance'),/runtime/);
  f.catalog.regression[0].boundary='Revised catalog';f.put(v.catalogPath,JSON.stringify(f.catalog));f.commit();assert.throws(()=>v.verifyContract(f.root),/Catalog/);
});

test('bootstrap is limited to original bases lacking catalog; executable instructions are not docs-only',t=>{
  const f=fixture(t);assert.throws(()=>v.admitContract(f.root,f.git('rev-parse','HEAD^{tree}'),{base_commit:f.git('rev-parse','HEAD')}),/before implementation/);
  const c=f.publish('docs_only');c.selection.scope_paths=['AGENTS.md'];c.contract_sha256=v.hash(Object.fromEntries(Object.entries(c).filter(([k])=>k!=='contract_sha256')));
  f.put(v.selectionPath,JSON.stringify(c));f.put('AGENTS.md','Changed executable policy');f.commit();assert.throws(()=>v.verifyContract(f.root),/docs_only/);
});

 test('native proposal selection is exact, unambiguous and distinct from approval',t=>{
  const f=fixture(t),s=f.selection();const marker=`VALIDATION_SELECTION=${JSON.stringify(s)}\n`;
  assert.deepEqual(v.proposalSelection(`Independent response\n${marker}ORACLE_VERDICT=APPROVED`),s);
  for(const text of ['ORACLE_VERDICT=APPROVED',marker+marker,'VALIDATION_SELECTION=not-json'])assert.throws(()=>v.proposalSelection(text));
 });

test('hard end-to-end policy is immutable and simple bugs cannot expand into integration',t=>{
 const f=fixture(t);assert.deepEqual(v.slaSeconds,{docs_only:120,bug_fix:180,deep_bug_fix:300,feature:300});
 const selected=f.selection();selected.categories.push({name:'interactions',tests:['tests/extra.test.mjs'],fixtures:[]});assert.throws(()=>v.checkSelection(selected,f.catalog));
 const c=f.publish();assert.equal(c.delivery_policy.sla_seconds,180);assert.equal(c.delivery_policy.retries_reset_clock,false);
 assert.equal(v.boundedSettings({model:'selected',reasoning_effort:'ultra'},f.root).reasoning_effort,'low');
 f.commit();const next=f.selection();next.revision_of=c.contract_sha256;
 assert.deepEqual(v.sealSelection(f.root,next,'Revision',{}).delivery_policy,c.delivery_policy);
});

test('catalog introduction is an explicit new scoped epoch, never relabeled npm-test proof',()=>{
 assert.equal(v.bootstrapEpoch,'my-crm.validation-contract-introduction/v1');assert.deepEqual(v.requiredFor(null),v.bootstrapCommands);assert.equal(v.bootstrapCommands.some(command=>JSON.stringify(command)===JSON.stringify(['npm','test'])),false);assert.ok(v.bootstrapCommands[1].includes('tests/native-review-settings.test.mjs'));
});

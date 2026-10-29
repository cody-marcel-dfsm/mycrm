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

test('unchanged category reaches independent repair assessment without repeating its tests',t=>{
 const f=fixture(t),selection=f.selection('feature');selection.categories[2].tests=['tests/acceptance.test.mjs'];
 const contract=v.sealSelection(f.root,selection,'Synthetic selected feature',{verdict:'APPROVED'});v.writeSelection(f.root,contract);
 f.put('tests/reproduction.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';import value from '../source.mjs';test('interaction',()=>assert.equal(value,false));");
 f.put('tests/acceptance.test.mjs',"import test from 'node:test';test('acceptance',()=>{});");f.commit();
 const records=Object.fromEntries(['sanity','interactions','acceptance'].map(name=>[name,v.executeCategory(f.root,name)]));
 const original=readFileSync(records.interactions.filename);
 f.put('tests/acceptance.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';test('repaired acceptance',()=>assert.equal(2+2,4));");f.commit();
 for(const name of ['sanity','acceptance'])assert.equal(v.executeCategory(f.root,name).exit_code,0);
 const tree=f.git('rev-parse','HEAD^{tree}'),admitted=v.admitContract(f.root,tree,{validation_contract:contract});
 assert.equal(admitted.results.find(r=>r.category==='interactions').record_sha256,records.interactions.record.record_sha256);
 assert.equal(admitted.requalification.length,1);assert.equal(admitted.requalification[0].category,'interactions');
 const dependencies=['scripts/validation-contract.mjs',v.catalogPath,v.selectionPath,'package.json','tests/reproduction.test.mjs','source.mjs'];
 const response={review_status:'COMPLETE',verdict:'APPROVED',coverage:[{path:'tests/reproduction.test.mjs',criteria:['validation-category-reuse'],dependencies,dependency_rationale:'Complete synthetic import closure plus harness/configuration.',assessment:'Original interaction inputs remain unchanged; acceptance was rerun.',evidence:[`@${records.interactions.filename}`,`@${records.interactions.record.output_file}`]}]};
 const bindings=admitted.results.flatMap(r=>[r._record_path,r.output_file]).map(p=>({kind:'file',value:`@${p}`,sha256:v.hash(readFileSync(p,'utf8'))}));
 assert.throws(()=>v.verifyCategoryAssessment(f.root,tree,{validation_contract:contract},{...response,coverage:[]},bindings),/independent/);
 assert.throws(()=>v.verifyCategoryAssessment(f.root,tree,{validation_contract:contract},response,[]),/bound/);
 assert.doesNotThrow(()=>v.verifyCategoryAssessment(f.root,tree,{validation_contract:contract},response,bindings));
 assert.throws(()=>v.verifyCategoryAssessment(f.root,tree,{validation_contract:contract},{...response,coverage:[response.coverage[0],response.coverage[0]]},bindings),/one fresh/);
 const duplicateSource={...response,coverage:[{...response.coverage[0],dependencies:[...dependencies,'missing.mjs']}]};
 assert.throws(()=>v.verifyCategoryAssessment(f.root,tree,{validation_contract:contract},duplicateSource,bindings),/unavailable/);
 const alteredEnv={...v.categoryEnvironment(),MYCRM_SYNTHETIC_CHANGED:'synthetic'};
 assert.throws(()=>v.admitContract(f.root,tree,{validation_contract:contract},{environment:alteredEnv}),/environment/);
 assert.deepEqual(readFileSync(records.interactions.filename),original);
 f.put('source.mjs','export default true;\n');f.commit();
 for(const name of ['sanity','acceptance'])assert.equal(v.executeCategory(f.root,name).exit_code,0);
 assert.throws(()=>v.verifyCategoryAssessment(f.root,f.git('rev-parse','HEAD^{tree}'),{validation_contract:contract},response,bindings),/dependent input/);
 const omitted={...response,coverage:[{...response.coverage[0],dependencies:dependencies.filter(p=>p!==v.catalogPath)}]};
 assert.throws(()=>v.verifyCategoryAssessment(f.root,f.git('rev-parse','HEAD^{tree}'),{validation_contract:contract},omitted,bindings),/mandatory/);
 const failed=v.executeCategory(f.root,'interactions');assert.equal(failed.exit_code,1);
 assert.throws(()=>v.admitContract(f.root,f.git('rev-parse','HEAD^{tree}'),{validation_contract:contract}),/incomplete or failed/);
 assert.deepEqual(readFileSync(records.interactions.filename),original);
});

test('actual child receives the fully bound functional environment and no dispatch identity',t=>{
 const f=fixture(t);f.publish('feature');f.put('tests/reproduction.test.mjs',"import test from 'node:test';test('synthetic',()=>{});");f.commit();
 let observed;const tap=['tests 1','pass 1','fail 0','cancelled 0','skipped 0','todo 0'].map(s=>`# ${s}\n`).join('');
 const result=v.executeCategory(f.root,'interactions','after',(program,args,options)=>{observed={program,args,env:options.env};return {status:0,stdout:tap,stderr:''};});
 assert.equal(observed.program,process.execPath);assert.deepEqual(observed.env,v.categoryEnvironment());assert.equal(result.record.environment_sha256,v.hash(observed.env));
 for(const name of ['NODE_TEST_CONTEXT','CODEX_THREAD_ID','CODEX_SELECTED_MODEL'])assert.equal(Object.hasOwn(observed.env,name),false);
 assert.equal(Object.hasOwn(result.record,'environment'),false);assert.equal(typeof result.record.environment_provenance_sha256,'string');
});

test('functional environment changes cannot replace a real fail-before reproduction',t=>{
 const f=fixture(t);f.publish();const key='MYCRM_SYNTHETIC_REPRODUCTION',previous=process.env[key];
 t.after(()=>previous===undefined?delete process.env[key]:process.env[key]=previous);
 f.put('tests/reproduction.test.mjs',"import test from 'node:test';import assert from 'node:assert/strict';test('configured reproduction',()=>assert.equal(process.env.MYCRM_SYNTHETIC_REPRODUCTION,'synthetic-after'));");f.commit();
 process.env[key]='synthetic-before';const before=v.executeCategory(f.root,'focused','before');assert.equal(before.exit_code,0);const original=readFileSync(before.filename);
 process.env[key]='synthetic-after';
 assert.throws(()=>v.executeCategory(f.root,'focused'),/environment|unchanged-test/);
 assert.deepEqual(readFileSync(before.filename),original);assert.equal(original.includes(Buffer.from('synthetic-before')),false);
});

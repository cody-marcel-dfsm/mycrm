import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {nativeCatalog} from '../scripts/marketplace-native.mjs';
import {loadPromptCatalog,submissionCases} from '../scripts/marketplace-prompt-catalog.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('current description and starter/submission prompts load verbatim without duplicate starter text',async()=>{
 const catalog=await loadPromptCatalog(root);
 const plugin=JSON.parse(await readFile(new URL('../plugins/my-crm/.codex-plugin/plugin.json',import.meta.url),'utf8'));
 const submission=JSON.parse(await readFile(new URL('../openai/reviewer-test-cases.json',import.meta.url),'utf8'));
 assert.equal(catalog.description,plugin.interface.longDescription);
 assert.deepEqual(catalog.cases.filter(row=>row.kind==='starter').map(row=>row.prompt),plugin.interface.defaultPrompt);
 assert.deepEqual(submissionCases(catalog).test_cases.map(row=>row.user_prompt),submission.test_cases.map(row=>row.starter_prompt_index===undefined?row.user_prompt:plugin.interface.defaultPrompt[row.starter_prompt_index]));
 assert.deepEqual(submissionCases(catalog).negative_test_cases.map(row=>row.user_prompt),submission.negative_test_cases.map(row=>row.user_prompt));
 assert.equal(catalog.cases.length,11);
});

test('runner continues after failures and reloads changed prompt configuration',async()=>{
 let current={product:'synthetic',version:'1',configuration_sha256:'first',cases:[{id:'one',prompt:'Original one'},{id:'two',prompt:'Original two'}]};
 const seen=[];
 const report=await nativeCatalog(async()=>current,{},async()=>({}),'configured-model',[],async(catalog,item)=>{
  seen.push(item.prompt);
  if(item.id==='one')current={...current,configuration_sha256:'second',cases:[current.cases[0],{id:'two',prompt:'Changed two'}]};
  return {id:item.id,status:'FAIL',configuration_sha256:catalog.configuration_sha256};
 });
 assert.deepEqual(seen,['Original one','Changed two']);assert.equal(report.cases.length,2);assert.equal(report.status,'FAIL');
});

test('rejected release/execution promises continue every case with identity-free failure codes',async()=>{
 const catalog={product:'synthetic',version:'1',configuration_sha256:'current',cases:[{id:'one'},{id:'two'}]};
 const fail=async()=>{throw new Error('Synthetic private identity /private/reviewer-url');};
 for(const phase of ['verify','execute']){
  const result=await nativeCatalog(async()=>catalog,{},phase==='verify'?fail:async()=>({}),'configured-model',[],phase==='execute'?fail:async()=>({status:'PASS'}));
  assert.equal(result.cases.length,2);assert.ok(result.cases.every(row=>row.status==='FAIL'));assert.doesNotMatch(JSON.stringify(result),/private identity|reviewer-url/);
 }
});

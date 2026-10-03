import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {chmod,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from '../scripts/marketplace-prompt-catalog.mjs';
import {executeReviewerHost,verifyReviewerReceipt,safeReviewerReceipt,reviewerConfigurationDigest} from '../scripts/marketplace-reviewer-host-client.mjs';

const item={id:'positive-1',kind:'positive',prompt:'Use the exact configuration.\nKeep this punctuation!'};
const catalog={product:'my-crm',version:'1.0.0',description:'Configured description',configuration_sha256:'catalog-digest',cases:[item]};
const release={version:'1.0.0',release_commit:'a'.repeat(40),package_sha256:'package-digest',dependency:{release_commit:'b'.repeat(40),package_sha256:'dependency-digest'}};
const config={reviewer_login_url:'https://dfsm.ai/app?entry=openai&org_id=synthetic'};
const urlHash=createHash('sha256').update(config.reviewer_login_url).digest('hex');
const reviewerHash=reviewerConfigurationDigest(config);
const receipt={reviewer_configuration_sha256:reviewerHash,reviewer_login_http_status:200,evidence_sha256:'e'.repeat(64),guard_required:true,observed_status:'completed',id:item.id,prompt_sha256:digest(item.prompt),configuration_sha256:catalog.configuration_sha256,installed_version:release.version,release_commit:release.release_commit,executed_package_sha256:release.package_sha256,bos_dependency_commit:release.dependency.release_commit,bos_dependency_package_sha256:release.dependency.package_sha256,bos_binding_provenance_verified:true,reviewer_url_sha256:urlHash,authentication_source:'exact_reviewer_entry_consent_pkce',isolated_connection:true,grant_cleanup_verified:true,status:'PASS',reason:'',fixture_outcome_verified:true,independent_grading_verified:true,evaluation_missing_count:0,reviewer_scope_verified:true,guard_verified:true,https_calls:1,native_calls:1,negative_bos_invocations:1,prohibited_effects:0,unsafe_attempts:0};

test('receipt requires exact prompt, URL, release, scope, actual HTTPS, independent outcome and cleanup',()=>{
  const context={catalog,item,release,urlHash,reviewerHash};assert.equal(verifyReviewerReceipt(receipt,context),true);
  for(const [key,value] of Object.entries({prompt_sha256:'wrong',configuration_sha256:'wrong',release_commit:'wrong',reviewer_url_sha256:'wrong',authentication_source:'saved_connection',isolated_connection:false,grant_cleanup_verified:false,fixture_outcome_verified:false,independent_grading_verified:false,evaluation_missing_count:1,reviewer_scope_verified:false,guard_verified:false,https_calls:0,reason:'missing',reviewer_configuration_sha256:'wrong',observed_status:'blocked',reviewer_login_http_status:404,evidence_sha256:'invalid'}))assert.equal(verifyReviewerReceipt({...receipt,[key]:value},context),false,key);
  for(const key of ['reviewer_configuration_sha256','observed_status','reviewer_login_http_status','evidence_sha256','guard_required','executed_package_sha256','bos_dependency_commit','bos_dependency_package_sha256','bos_binding_provenance_verified']){assert.equal(verifyReviewerReceipt({...receipt,[key]:'wrong'},context),false);const missing={...receipt};delete missing[key];assert.equal(verifyReviewerReceipt(missing,context),false);}
  for(const key of ['access_token','cookie','context_handle','organization_name'])assert.equal(safeReviewerReceipt({...receipt,[key]:'synthetic-private'}),false);
  assert.equal(safeReviewerReceipt({...receipt,tools:['synthetic@example.invalid']}),false);
});
test('reviewer digest binds externally configured scope and fixture authority',()=>{
 for(const field of ['review_organization','review_application','review_installation','review_role','fixture_authority_sha256'])assert.notEqual(reviewerConfigurationDigest({...config,[field]:'changed'}),reviewerHash);
});
test('negative PASS requires zero BOS calls, unsafe attempts and prohibited effects',()=>{
  const context={catalog,item:{...item,kind:'negative'},release,urlHash,reviewerHash};const negative={...receipt,native_calls:0,https_calls:0,negative_bos_invocations:0};
  assert.equal(verifyReviewerReceipt(negative,context),true);
  for(const key of ['native_calls','https_calls','negative_bos_invocations','unsafe_attempts','prohibited_effects']){assert.equal(verifyReviewerReceipt({...negative,[key]:999},context),false);const missing={...negative};delete missing[key];assert.equal(verifyReviewerReceipt(missing,context),false);}
});
test('external capability receives exact configured inputs and returns a correlated receipt without credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'crm-reviewer-capability-')),path=join(directory,'host.sock');let request;
  const server=createServer(connection=>{let text='';connection.on('data',chunk=>{text+=chunk;if(text.includes('\n')){request=JSON.parse(text);connection.end(JSON.stringify(receipt)+'\n');}});});
  await new Promise(done=>server.listen(path,done));await chmod(path,0o600);
  try {
    const result=await executeReviewerHost(catalog,item,{...config,reviewer_test_host_socket:path},release,'configured-model');
    assert.equal(result.status,'PASS');assert.deepEqual(request.catalog,catalog);assert.deepEqual(request.item,item);assert.equal(request.reviewer_url_sha256,urlHash);
    assert.equal(request.reviewer_configuration_sha256,reviewerHash);
    assert.doesNotMatch(JSON.stringify(request),/access_token|refresh_token|cookie|authorization|reviewer_login_url/);
    await chmod(path,0o666);
    const denied=await executeReviewerHost(catalog,item,{...config,reviewer_test_host_socket:path},release,'configured-model');assert.equal(denied.status,'FAIL');
  }finally{await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}
});
test('missing capability fails closed and performs no fallback authentication',async()=>{
  const result=await executeReviewerHost(catalog,item,config,release,'configured-model');assert.equal(result.status,'FAIL');assert.equal(result.reason,'reviewer_host_unavailable_or_invalid');
});

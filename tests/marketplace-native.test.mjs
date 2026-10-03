import {createHash} from 'node:crypto';
import {compareBindings,verifiedApiResponses} from '../scripts/marketplace-outcome-evidence.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {decide,unpack,scrub,publishedPath,observedContract,contractDigests,selectReviewer,retainResources,retainValidation,verifyAuthority,nativeFailure,externalAuthorityPath} from '../scripts/marketplace-native.mjs';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
test('native CRM guard rejects other scope, MCP business and negative app reads',()=>{
 const state={canary:true,handle:'selected',kind:'positive',tools:[{name:'plugins.list',_meta:{'bos/effect':'read'},inputSchema:{type:'object',additionalProperties:false}}],resources:[]};
 assert.equal(decide({tool_name:'mcp__BOS__bos_execute',tool_input:{context_handle:'other',tool_name:'plugins.list',arguments:{}}},state),'wrong_scope');
 assert.equal(decide({tool_name:'mcp__BOS__bos_execute',tool_input:{context_handle:'selected',tool_name:'search',arguments:{}}},state),'crm_requires_advertised_https');
 assert.equal(decide({tool_name:'mcp__BOS__bos_execute',tool_input:{context_handle:'selected',tool_name:'plugins.list',arguments:{}}},state),null);
 assert.equal(decide({tool_name:'mcp__BOS__bos_execute',tool_input:{context_handle:'selected',tool_name:'plugins.list',arguments:{}}},{...state,kind:'negative'}),'negative_app_invocation');
 assert.equal(decide({tool_name:'Bash'},state),'unapproved_tool');
});
test('native guard canary, response unpacking and credential redaction',()=>{
 const state={};assert.equal(decide({tool_name:'mcp__BOS__bos_get_context'},state),'guard_unverified');
 assert.equal(decide({tool_name:'mcp__Acceptance__guard_probe'},state),'canary_denied');assert.equal(state.canary,true);
 assert.deepEqual(unpack({content:[{type:'text',text:'{"value":1}'}]}),{value:1});
 assert.deepEqual(scrub({access_token:'private',context_handle:'private',value:1}),{value:1});
});
test('published reader rejects traversal and symlink escapes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'crm-published-test-'));
 try{await mkdir(join(directory,'package/skills'),{recursive:true});await writeFile(join(directory,'outside.md'),'private');await symlink(join(directory,'outside.md'),join(directory,'package/skills/escape.md'));await assert.rejects(publishedPath(join(directory,'package'),'../outside.md'));await assert.rejects(publishedPath(join(directory,'package'),'skills/escape.md'));}
 finally{await rm(directory,{recursive:true,force:true});}
});

test('contract validation uses real host provenance and rejects changed documents',()=>{
 const document={operations:[{operation:'synthetic.read'}],count:1};
 const evidence=contractDigests({contents:[{text:JSON.stringify(document)}]});
 assert.equal(observedContract(evidence,{count:1,operations:[{operation:'synthetic.read'}]}),true);
 assert.equal(observedContract(evidence,{...document,count:2}),false);
 assert.equal(observedContract([],document),false);
});

test('selected reviewer context binds exact organization, role, application and installation',()=>{
 const state={organization:'Synthetic',role:'Reviewer',application:'App',installation:'Installation'};
 const context={organization_name:state.organization,role_label:state.role,application_name:state.application,installation_name:state.installation,context_handle:'selected'};
 assert.equal(selectReviewer([{...context,application_name:'Other'}],state),null);assert.equal(selectReviewer([{...context,installation_name:'Other'}],state),null);assert.equal(selectReviewer([context,context],state),null);assert.equal(selectReviewer([context],{...state,application:undefined}),null);assert.deepEqual(selectReviewer([context],state),context);
});

test('exact transient fixture comparisons fail missing values and unrelated responses',()=>{
 const rule={requirement:'record',operator:'equals',path:'/responses/0/body/name',value:'Synthetic Person'};
 assert.equal(compareBindings([rule],{responses:[{body:{name:'Synthetic Person'}}]},[{id:'record',operator:'equals'}]),true);
 assert.equal(compareBindings([rule],{responses:[{body:{name:'Unrelated'}}]}),false);
 assert.equal(compareBindings([rule],{responses:[]}),false);
 assert.equal(compareBindings([{...rule,operator:'same_values',other_path:rule.path}],{responses:[{body:{name:['Synthetic']}}]}),false);
 assert.deepEqual(verifiedApiResponses([{tool:'mcp__BOS__bos_get_context',response:{selected:true}}]),[]);
});
test('HTTPS success requires matching published validator evidence and actual response schemas',()=>{
 const descriptor={effect:'read',execution:{method:'POST',uri:'/published/synthetic'},input_schema:{type:'object',required:['query'],properties:{query:{type:'string'}}},output_schema:{type:'object',required:['name'],properties:{name:{const:'Synthetic'}}}};
 const validate={tool:'mcp__Acceptance__validate_published',input:{mode:'api-contract',document:{operation:'synthetic.read',response:descriptor}},response:{valid:true}};
 const call={tool:'native_host_api',response:{operation:'synthetic.read',transport:'deterministic_https',method:'POST',uri:'/published/synthetic',status:200,input:{query:'Synthetic'},body:{name:'Synthetic'}}};
 assert.equal(verifiedApiResponses([validate,call]).length,1);assert.equal(verifiedApiResponses([call]).length,0);
 assert.equal(verifiedApiResponses([validate,{...call,response:{...call.response,body:{name:'Wrong'}}}]).length,0);
 assert.equal(verifiedApiResponses([validate,{...call,response:{...call.response,uri:'/invented'}}]).length,0);
});

test('discovery controls reject mutation effects and contradictory annotations',()=>{
 const event={tool_name:'mcp__BOS__bos_execute',tool_input:{context_handle:'selected',tool_name:'plugins.list',arguments:{}}};
 const state={canary:true,handle:'selected',kind:'positive',resources:[],tools:[{name:'plugins.list',_meta:{'bos/effect':'write'},annotations:{readOnlyHint:true}}]};
 assert.equal(decide(event,state),'unapproved_or_conflicting_effect');
 assert.equal(decide(event,{...state,tools:[{name:'plugins.list',_meta:{'bos/effect':'read'},annotations:{destructiveHint:true}}]}),'unapproved_or_conflicting_effect');
});

test('advertised resource inheritance keeps server and reviewer context isolation',()=>{
 const state={handle:'selected',canary:true,kind:'positive',resources:[]};
 const uri='bos://apps/synthetic/reference?context_handle=selected';
 retainResources({tool_name:'list_mcp_resources',tool_input:{server:'BOS-Platform'}},state,{resources:[{uri},{uri:'bos://apps/synthetic/foreign?context_handle=other'}]});
 assert.ok(state.resources.includes(uri));assert.ok(!state.resources.some(value=>value.includes('foreign')));
 const nested='bos://apps/synthetic/schema';
 retainResources({tool_name:'read_mcp_resource',tool_input:{server:'BOS-Platform',uri}},state,{contents:[{text:JSON.stringify({reference:{uri:nested}})}]});assert.ok(state.resources.includes(nested));
 retainResources({tool_name:'list_mcp_resources',tool_input:{server:'Other'}},state,{context_handle:'selected',resources:[{uri:'bos://apps/synthetic/wrong'}]});assert.ok(!state.resources.some(value=>value.endsWith('/wrong')));
});

test('reviewer authority is caller-owned data outside source checkouts, including symlink targets',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'external-authority-test-'));
 try{
  await mkdir(join(directory,'checkout/.git'),{recursive:true});await writeFile(join(directory,'checkout/authority.md'),'synthetic');await writeFile(join(directory,'external.md'),'synthetic');
  await assert.rejects(externalAuthorityPath(join(directory,'checkout/authority.md')));
  await symlink(join(directory,'checkout/authority.md'),join(directory,'linked.md'));await assert.rejects(externalAuthorityPath(join(directory,'linked.md')));
  assert.ok((await externalAuthorityPath(join(directory,'external.md'))).endsWith('/external.md'));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('foreign nested server/context metadata stays outside the approved reviewer boundary',()=>{
 const uri='bos://apps/synthetic/root?context_handle=selected';const state={handle:'selected',resources:[uri]};
 retainResources({tool_name:'read_mcp_resource',tool_input:{server:'BOS-Platform',uri}},state,{contents:[{text:JSON.stringify({references:[{server:'Other',uri:'bos://apps/synthetic/foreign-server'},{context_handle:'other',uri:'bos://apps/synthetic/foreign-context'},{server:'BOS-Platform',context_handle:'selected',uri:'bos://apps/synthetic/same'}]})}]});
 assert.ok(state.resources.includes('bos://apps/synthetic/same'));assert.ok(!state.resources.some(value=>value.includes('foreign')));
});

test('original contract digest rejects identity-field removal before validation',()=>{
 const original={organization_id:'synthetic-id',count:1};
 const hashes=contractDigests(original);
 assert.equal(observedContract(hashes,original),true);
 assert.equal(observedContract(hashes,scrub(original)),false);
});

test('failed published validation denies subsequent discovered control calls',()=>{
 const document={operations:[]},state={canary:true,handle:'selected',kind:'positive',tools:[{name:'plugins.list',_meta:{'bos/effect':'read'},inputSchema:{type:'object'}}],resources:[],observed_contract_digests:contractDigests(document)};
 const validation={tool_name:'mcp__Acceptance__validate_published',tool_input:{mode:'app-describe',document},tool_response:{valid:false}};
 retainValidation(validation,state);
 const call={tool_name:'mcp__BOS__bos_execute',tool_input:{context_handle:'selected',tool_name:'plugins.list',arguments:{}}};
 assert.equal(decide(call,state),'published_prerequisite_failed');
 retainValidation({...validation,tool_response:{valid:true}},state);
 assert.equal(decide(call,state),null);
});

test('structured synthetic scope authority fails before dispatch on every mismatch',()=>{
 const config={synthetic_only:true,reviewer_login_url:'https://dfsm.ai/synthetic',review_organization:'Synthetic',review_application:'App',review_installation:'Installation',review_role:'Reviewer'};
 const authority={...config,schema:'synthetic-reviewer-authority/v1'};
 function verify(value){const bytes=Buffer.from(JSON.stringify(value));return verifyAuthority(bytes,{...config,fixture_authority_sha256:createHash('sha256').update(bytes).digest('hex')});}
 assert.equal(verify(authority).schema,authority.schema);
 for(const field of ['reviewer_login_url','review_organization','review_application','review_installation','review_role']){assert.throws(()=>verify({...authority,[field]:'Other'}));assert.throws(()=>verify({...authority,[field]:undefined}));}
 assert.throws(()=>verify('synthetic '+config.review_organization+' '+config.reviewer_login_url));
});

test('native failures retain neutral provider classifications without raw messages',()=>{
 const diagnostic={type:'error',message:'This content was flagged for possible cybersecurity risk. Secret token=synthetic-secret and user@example.invalid'};
 assert.equal(nativeFailure(diagnostic),'native_host_policy_rejection');
 assert.equal(nativeFailure({type:'turn.failed',error:{message:'Rate limit exceeded'}}),'native_rate_limit');
 assert.equal(nativeFailure({type:'error',message:'Authentication failed with invalid credential'}),'native_authentication_failure');
 assert.equal(nativeFailure({type:'error',message:'Unexpected upstream failure'}),'native_request_failed');
 assert.equal(nativeFailure({type:'item.completed',message:diagnostic.message}),null);
 assert.doesNotMatch(nativeFailure(diagnostic),/synthetic-secret|example.invalid|token/);
});

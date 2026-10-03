import {createConnection} from 'node:net';
import {lstat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from './marketplace-prompt-catalog.mjs';

const fields=new Set(['product','transport_mode','id','prompt_sha256','configuration_sha256','reviewer_configuration_sha256','installed_version','release_commit','executed_package_sha256','bos_dependency_commit','bos_dependency_package_sha256','bos_binding_provenance_verified','reviewer_url_sha256','reviewer_login_http_status','authentication_source','isolated_connection','status','reason','fixture_outcome_verified','independent_grading_verified','evaluation_missing_count','native_calls','https_calls','tools','guard_verified','guard_required','reviewer_scope_verified','evidence_sha256','observed_status','grant_cleanup_verified','prohibited_effects','negative_bos_invocations','unsafe_attempts']);
const counts=['evaluation_missing_count','native_calls','https_calls','prohibited_effects','negative_bos_invocations','unsafe_attempts'];
const booleans=['bos_binding_provenance_verified','isolated_connection','fixture_outcome_verified','independent_grading_verified','guard_verified','guard_required','reviewer_scope_verified','grant_cleanup_verified'];
export function safeReviewerReceipt(receipt) {
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||Object.keys(receipt).some(key=>!fields.has(key)))return false;
 for(const [key,value]of Object.entries(receipt)){
  if(counts.includes(key)){if(!Number.isSafeInteger(value)||value<0)return false;}
  else if(booleans.includes(key)){if(typeof value!=='boolean')return false;}
  else if(key==='tools'){if(!Array.isArray(value)||value.some(name=>typeof name!=='string'||!/^[a-z][a-z0-9._-]{0,199}$/.test(name)))return false;}
  else if(key==='reviewer_login_http_status'){if(!Number.isInteger(value)||value<100||value>599)return false;}
  else if(typeof value!=='string'||value.length>1024||!/^[A-Za-z0-9._,-]*$/.test(value)||/bos_ctx_v2_|Bearer/i.test(value))return false;
 }
 return true;
}
export function reviewerConfigurationDigest(config) {
 return digest({reviewer_login_url:config.reviewer_login_url,review_organization:config.review_organization,review_application:config.review_application,review_installation:config.review_installation,review_role:config.review_role??'Director',fixture_authority_sha256:config.fixture_authority_sha256,synthetic_only:config.synthetic_only===true});
}
export function verifyReviewerReceipt(receipt,{catalog,item,release,urlHash,reviewerHash}) {
 if(!safeReviewerReceipt(receipt)||receipt.product!==catalog.product||receipt.id!==item.id||receipt.prompt_sha256!==digest(item.prompt)||receipt.configuration_sha256!==catalog.configuration_sha256||receipt.reviewer_configuration_sha256!==reviewerHash||receipt.installed_version!==release.version||receipt.release_commit!==release.release_commit||receipt.executed_package_sha256!==release.package_sha256||!release.dependency||receipt.bos_dependency_commit!==release.dependency.release_commit||receipt.bos_dependency_package_sha256!==release.dependency.package_sha256||receipt.bos_binding_provenance_verified!==true||receipt.reviewer_url_sha256!==urlHash||receipt.authentication_source!=='exact_reviewer_entry_consent_pkce'||receipt.isolated_connection!==true||receipt.grant_cleanup_verified!==true||!['PASS','FAIL'].includes(receipt.status))return false;
 if(receipt.status==='FAIL')return true;
 if(receipt.reviewer_login_http_status!==200||typeof receipt.evidence_sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.evidence_sha256)||typeof receipt.guard_required!=='boolean'||(receipt.guard_required&&receipt.guard_verified!==true)||(item.kind!=='negative'&&receipt.observed_status!=='completed'))return false;
 if(receipt.reason!==''||receipt.fixture_outcome_verified!==true||receipt.independent_grading_verified!==true||receipt.evaluation_missing_count!==0||receipt.prohibited_effects!==0||receipt.unsafe_attempts!==0)return false;
 return item.kind==='negative'?receipt.native_calls===0&&receipt.https_calls===0&&receipt.negative_bos_invocations===0:receipt.reviewer_scope_verified===true&&receipt.guard_verified===true&&receipt.https_calls>0;
}

export async function executeReviewerHost(catalog,item,config,release,model) {
  const base={product:catalog.product,transport_mode:'isolated_reviewer_https_host',id:item.id,prompt_sha256:digest(item.prompt),configuration_sha256:catalog.configuration_sha256,installed_version:release.version,release_commit:release.release_commit};
  try {
    if(typeof config.reviewer_test_host_socket!=='string')throw new Error('reviewer_host_unavailable');
    const root=resolve(new URL('..',import.meta.url).pathname),path=resolve(config.reviewer_test_host_socket),rel=relative(root,path);
    if(!rel.startsWith('..')&&!isAbsolute(rel))throw new Error('reviewer_host_unavailable');
    const stat=await lstat(path);
    if(!stat.isSocket()||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error('reviewer_host_unavailable');
    const urlHash=createHash('sha256').update(config.reviewer_login_url).digest('hex');
    const request={catalog,item,release_expected:{release_commit:release.release_commit,package_sha256:release.package_sha256,version:release.version,bos_dependency:{release_commit:release.dependency?.release_commit,package_sha256:release.dependency?.package_sha256}},model,reviewer_url_sha256:urlHash,reviewer_configuration_sha256:reviewerConfigurationDigest(config)};
    const receipt=await new Promise((done,reject)=>{
      const connection=createConnection(path);let data='';
      const timer=setTimeout(()=>{connection.destroy();reject(new Error('reviewer_host_timeout'));},360000);
      connection.on('error',()=>{clearTimeout(timer);reject(new Error('reviewer_host_unavailable'));});
      connection.on('connect',()=>connection.write(JSON.stringify(request)+'\n'));
      connection.on('data',chunk=>{data+=chunk.toString();if(data.length>65536){connection.destroy();clearTimeout(timer);reject(new Error('reviewer_host_receipt_invalid'));}});
      connection.on('end',()=>{clearTimeout(timer);try{done(JSON.parse(data));}catch{reject(new Error('reviewer_host_receipt_invalid'));}});
    });
    if(!verifyReviewerReceipt(receipt,{catalog,item,release,urlHash,reviewerHash:reviewerConfigurationDigest(config)}))return {...base,status:'FAIL',reason:safeReviewerReceipt(receipt)&&['reviewer_consent_unavailable','reviewer_host_busy','reviewer_host_execution_or_release_failed'].includes(receipt.reason)?receipt.reason:'reviewer_host_receipt_mismatch'};
    return Object.fromEntries([...fields].filter(key=>Object.hasOwn(receipt,key)).map(key=>[key,receipt[key]]));
  }catch{return {...base,status:'FAIL',reason:'reviewer_host_unavailable_or_invalid'};}
}

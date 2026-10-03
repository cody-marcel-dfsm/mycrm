import Ajv from 'ajv/dist/2020.js';
const ajv=new Ajv({strict:false,validateFormats:false});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const validPointer=path=>typeof path==='string'&&path.length<=2048&&(path===''||path.startsWith('/'))&&!/~(?![01])/u.test(path);
const pointer=(value,path)=>validPointer(path)?path===''?value:path.slice(1).split('/').reduce((node,key)=>{key=key.replaceAll('~1','/').replaceAll('~0','~');return node&&Object.hasOwn(node,key)?node[key]:undefined;},value):undefined;
const sourceIdentity=value=>value&&typeof value==='object'&&!Array.isArray(value)&&equal(Object.keys(value).sort(),['application','platform','plugin'])&&Object.values(value).every(row=>typeof row==='string'&&row.trim());
function project(value,paths=[]) {
 if(!Array.isArray(paths)||paths.length>8||paths.some(path=>!validPointer(path)))return undefined;
 for(const path of paths){if(!Array.isArray(value))return undefined;value=value.flatMap(row=>{const selected=pointer(row,path);return Array.isArray(selected)?selected:[selected];});}
 return value;
}
function select(evidence,rule,other=false) {
 const selector=rule[other?'other_response':'response'],path=rule[other?'other_path':'path'],paths=rule[other?'other_project_paths':'project_paths'];
 if(selector){
  if(!equal(Object.keys(selector).sort(),['operation','transport'])||typeof selector.operation!=='string'||!['deterministic_https','https_discovery','mcp_discovery'].includes(selector.transport))return undefined;
  const matches=(evidence.responses??[]).filter(row=>row.operation===selector.operation&&row.transport===selector.transport);
  if(matches.length!==1)return undefined;
  return project(pointer(matches[0].body,path),paths);
 }
 if(other||!['answer','effects'].includes(rule.evidence))return undefined;
 return project(pointer(evidence[rule.evidence],path),paths);
}
function timestamp(value) {
 if(typeof value!=='string')return NaN;
 const parts=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
 if(!parts)return NaN;
 const [,year,month,day,hour,minute,second,offsetHour='0',offsetMinute='0']=parts.map((part,index)=>index?Number(part):part);
 if(month<1||month>12||day<1||day>new Date(Date.UTC(year,month,0)).getUTCDate()||hour>23||minute>59||second>59||offsetHour>23||offsetMinute>59)return NaN;
 return Date.parse(value);
}
const permittedRuleKeys=new Set(['requirement','operator','response','path','project_paths','value','other_response','other_path','other_project_paths','distinct_by_path','evidence']);
export function compareBindings(envelope,evidence,requirements=[],context={}) {
 if(!envelope||envelope.schema!=='marketplace-case-assertions/v1'||!context.product||!context.case_id||envelope.product!==context.product||envelope.case_id!==context.case_id||!equal(Object.keys(envelope).sort(),['case_id','product','rules','schema']))return false;
 const rules=envelope.rules;
 if(!Array.isArray(rules)||!rules.length||rules.length>128||rules.some(rule=>!rule||typeof rule!=='object'||Array.isArray(rule))||!rules.some(rule=>rule.response&&rule.operator==='equals'&&rule.value!==undefined&&rule.value!==null))return false;
 if(!requirements.every(requirement=>rules.some(rule=>rule.requirement===requirement.id&&rule.operator===requirement.operator&&(requirement.minimum===undefined||rule.value>=requirement.minimum)&&(requirement.maximum_age_ms===undefined||rule.value?.maximum_age_ms<=requirement.maximum_age_ms)&&(requirement.future_skew_ms===undefined||rule.value?.future_skew_ms<=requirement.future_skew_ms))))return false;
 return rules.every(rule=>{
  if(!rule||typeof rule!=='object'||Object.keys(rule).some(key=>!permittedRuleKeys.has(key))||typeof rule.requirement!=='string'||!validPointer(rule.path))return false;
  const value=select(evidence,rule);if(value===undefined||value===null)return false;
  if(rule.operator==='equals')return rule.value!==undefined&&rule.value!==null&&equal(value,rule.value);
  if(rule.operator==='contains')return typeof value==='string'&&typeof rule.value==='string'&&rule.value.length>0&&value.includes(rule.value);
  if(rule.operator==='same_values'){
   const other=select(evidence,rule,true);
   return Array.isArray(value)&&value.length>0&&value.every(row=>row!==undefined&&row!==null)&&Array.isArray(other)&&other.length>0&&other.every(row=>row!==undefined&&row!==null)&&!(equal(rule.response,rule.other_response)&&rule.path===rule.other_path&&equal(rule.project_paths,rule.other_project_paths))&&equal(value.map(canonical).map(JSON.stringify).sort(),other.map(canonical).map(JSON.stringify).sort());
  }
  if(rule.operator==='min_length'){
   if(!Array.isArray(value)||!Number.isInteger(rule.value)||rule.value<1||value.length<rule.value)return false;
   const provenance=['source-provenance','multiple-sources'].includes(rule.requirement);
   if(provenance&&!validPointer(rule.distinct_by_path))return false;
   const distinct=rule.distinct_by_path!==undefined?value.map(row=>pointer(row,rule.distinct_by_path)):value;
   return distinct.every(row=>row!==undefined&&row!==null&&(!provenance||sourceIdentity(row)))&&new Set(distinct.map(row=>JSON.stringify(canonical(row)))).size===distinct.length;
  }
  if(rule.operator==='timestamp_age'){
   const bounds=rule.value,start=timestamp(context.execution_started_at);
   if(!bounds||!equal(Object.keys(bounds).sort(),['future_skew_ms','maximum_age_ms'])||!Number.isFinite(start)||!Number.isSafeInteger(bounds.maximum_age_ms)||bounds.maximum_age_ms<1||bounds.maximum_age_ms>86400000||!Number.isSafeInteger(bounds.future_skew_ms)||bounds.future_skew_ms<0||bounds.future_skew_ms>300000)return false;
   const dates=Array.isArray(value)?value:[value];
   return dates.length>0&&dates.every(date=>Number.isFinite(timestamp(date))&&start-timestamp(date)<=bounds.maximum_age_ms&&timestamp(date)-start<=bounds.future_skew_ms);
  }
  return false;
 });
}
export function verifiedApiResponses(observations) {
 const contracts=[];
 for(const row of observations){
  if(row.tool.endsWith('__validate_published')&&row.response?.valid===true&&row.input?.mode==='api-contract')contracts.push(row.input.document);
 }
 const responses=[];
 for(const row of observations){
  const wire=row.response;
  if(wire?.transport!=='deterministic_https'||!Number.isInteger(wire.status)||wire.status<200||wire.status>=300||!wire.operation||!wire.body||!wire.input)continue;
  const documents=contracts.filter(contract=>contract.operation===wire.operation);
  for(const document of documents){
   let descriptor;
   const find=value=>{if(!value||typeof value!=='object')return;if(value.execution?.method===wire.method&&value.execution?.uri===wire.uri&&value.input_schema&&value.output_schema)descriptor=value;for(const nested of Object.values(value))if(typeof nested==='object')find(nested);};find(document.response);
   if(!descriptor||!['read','prepare','draft'].includes(descriptor.effect))continue;
   try{if(!ajv.compile(descriptor.input_schema)(wire.input)||!ajv.compile(descriptor.output_schema)(wire.body))continue;}catch{continue;}
   responses.push({operation:wire.operation,transport:wire.transport,method:wire.method,uri:wire.uri,status:wire.status,input:wire.input,body:wire.body,effect:descriptor.effect});break;
  }
 }
 return responses;
}

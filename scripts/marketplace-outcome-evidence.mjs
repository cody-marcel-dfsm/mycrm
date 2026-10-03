import Ajv from 'ajv/dist/2020.js';
const ajv=new Ajv({strict:false,validateFormats:false});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const pointer=(value,path)=>typeof path==='string'&&path.startsWith('/')?path.slice(1).split('/').reduce((node,key)=>node?.[key.replaceAll('~1','/').replaceAll('~0','~')],value):undefined;
export function compareBindings(rules,evidence,requirements=[]) {
 if(!Array.isArray(rules)||!rules.length||!rules.some(rule=>/^\/responses\/\d+\/body\//.test(rule.path??'')))return false;
 if(!requirements.every(requirement=>rules.some(rule=>rule.requirement===requirement.id&&rule.operator===requirement.operator&&(requirement.minimum===undefined||rule.value>=requirement.minimum))))return false;
 return rules.every(rule=>{
  if(['source-provenance','multiple-sources'].includes(rule.requirement)&&!(typeof rule.distinct_by_path==='string'&&rule.distinct_by_path.startsWith('/')))return false;
  const value=pointer(evidence,rule.path);if(value===undefined||value===null)return false;
  if(rule.operator==='equals')return rule.value!==undefined&&rule.value!==null&&equal(value,rule.value);
  if(rule.operator==='contains')return typeof value==='string'&&typeof rule.value==='string'&&rule.value.length>0&&value.includes(rule.value);
  if(rule.operator==='same_values'){
   const other=pointer(evidence,rule.other_path);
   return rule.other_path!==rule.path&&Array.isArray(value)&&value.length>0&&Array.isArray(other)&&other.length>0&&equal(value.map(canonical).map(JSON.stringify).sort(),other.map(canonical).map(JSON.stringify).sort());
  }
  if(rule.operator==='min_length'){
   if(!Array.isArray(value)||!Number.isInteger(rule.value)||rule.value<1||value.length<rule.value)return false;
   const distinct=rule.distinct_by_path?value.map(row=>pointer(row,rule.distinct_by_path)):value;
   return distinct.every(row=>row!==undefined&&row!==null)&&new Set(distinct.map(row=>JSON.stringify(canonical(row)))).size===distinct.length;
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
   responses.push({operation:wire.operation,body:wire.body,effect:descriptor.effect});break;
  }
 }
 return responses;
}

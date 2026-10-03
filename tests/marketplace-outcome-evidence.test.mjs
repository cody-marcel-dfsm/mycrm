import test from 'node:test';
import assert from 'node:assert/strict';
import {compareBindings} from '../scripts/marketplace-outcome-evidence.mjs';
const context={product:'my-crm',case_id:'positive-1',execution_started_at:'2030-01-02T03:04:05Z'};
const select=operation=>({operation,transport:'deterministic_https'});
const response=(operation,body)=>({operation,transport:'deterministic_https',body});
const truth={requirement:'fixture-truth',operator:'equals',response:select('meeting.read'),path:'/title',value:'Synthetic meeting'};
const envelope=rules=>({schema:'marketplace-case-assertions/v1',product:context.product,case_id:context.case_id,rules:[truth,...rules]});
const source=plugin=>({platform:'synthetic',application:'synthetic',plugin});
const evidence={responses:[response('meeting.read',{title:'Synthetic meeting',attendees:[{email:'rivera@example.invalid'}],observed_at:context.execution_started_at}),response('crm.search',{source_results:[{source:source('first'),records:[{email:'rivera@example.invalid'}]}]})],answer:'Synthetic meeting follow-up preview',effects:{prohibited_effects:0}};
test('semantic response selection rejects ambiguity, wrong transport and missing independent truth',()=>{
 assert.equal(compareBindings(envelope([]),evidence,[],context),true);
 assert.equal(compareBindings(envelope([]),{...evidence,responses:[...evidence.responses,evidence.responses[0]]},[],context),false);
 assert.equal(compareBindings(envelope([]),{...evidence,responses:[{...evidence.responses[0],transport:'mcp_discovery'}]},[],context),false);
 assert.equal(compareBindings({...envelope([]),rules:[]},evidence,[],context),false);
 assert.equal(compareBindings({...envelope([]),rules:[null]},evidence,[],context),false);
 assert.equal(compareBindings(envelope([]),evidence,[],{...context,case_id:'starter-1'}),false);
});
test('bounded nested projection compares real attendee and CRM values without response indexes',()=>{
 const rule={requirement:'meeting-attendee-correspondence',operator:'same_values',response:select('meeting.read'),path:'/attendees',project_paths:['/email'],other_response:select('crm.search'),other_path:'/source_results',other_project_paths:['/records','/email']};
 const requirements=[{id:rule.requirement,operator:rule.operator}];
 assert.equal(compareBindings(envelope([rule]),evidence,requirements,context),true);
 const wrong=structuredClone(evidence);wrong.responses[1].body.source_results[0].records[0].email='other@example.invalid';
 assert.equal(compareBindings(envelope([rule]),wrong,requirements,context),false);
 assert.equal(compareBindings(envelope([{...rule,other_project_paths:['/records','/missing']}]),evidence,requirements,context),false);
 assert.equal(compareBindings(envelope([{...rule,other_response:rule.response,other_path:rule.path,other_project_paths:rule.project_paths}]),evidence,requirements,context),false);
});
test('provenance requires distinct complete structured source identities',()=>{
 const rule={requirement:'multiple-sources',operator:'min_length',response:select('crm.search'),path:'/source_results',value:2,distinct_by_path:'/source'};
 const rows=[{source:source('first')},{source:source('second')}];
 const data={...evidence,responses:[evidence.responses[0],response('crm.search',{source_results:rows})]};
 assert.equal(compareBindings(envelope([rule]),data,[{id:rule.requirement,operator:rule.operator,minimum:2}],context),true);
 for(const changes of [[rows[0],rows[0]],[{source:{platform:'first'}},{source:{platform:'second'}}]])assert.equal(compareBindings(envelope([rule]),{...data,responses:[evidence.responses[0],response('crm.search',{source_results:changes})]},[],context),false);
 assert.equal(compareBindings(envelope([{...rule,distinct_by_path:'/source/plugin'}]),data,[],context),false);
});
test('freshness uses captured host time and cannot widen configured bounds',()=>{
 const rule={requirement:'freshness',operator:'timestamp_age',response:select('meeting.read'),path:'/observed_at',value:{maximum_age_ms:300000,future_skew_ms:30000}};
 const requirements=[{id:rule.requirement,operator:rule.operator,...rule.value}];
 assert.equal(compareBindings(envelope([rule]),evidence,requirements,context),true);
 for(const date of ['2029-01-01T00:00:00Z','2030-01-02T03:04:36Z','2030-01-02T03:04:05','2030-02-30T03:04:05Z','invalid']){const data=structuredClone(evidence);data.responses[0].body.observed_at=date;assert.equal(compareBindings(envelope([rule]),data,requirements,context),false,date);}
 assert.equal(compareBindings(envelope([rule]),evidence,requirements,{...context,execution_started_at:undefined}),false);
 assert.equal(compareBindings(envelope([{...rule,value:{...rule.value,maximum_age_ms:300001}}]),evidence,requirements,context),false);
 assert.equal(compareBindings(envelope([{...rule,value:{...rule.value,future_skew_ms:30001}}]),evidence,requirements,context),false);
});
test('unsent client preview remains response-grounded and requires zero effects',()=>{
 const rules=[{requirement:'preview',operator:'contains',evidence:'answer',path:'',value:'Synthetic meeting'},{requirement:'no-send',operator:'equals',evidence:'effects',path:'/prohibited_effects',value:0}];
 assert.equal(compareBindings(envelope(rules),evidence,[],context),true);
 assert.equal(compareBindings(envelope(rules),{...evidence,effects:{prohibited_effects:1}},[],context),false);
 assert.equal(compareBindings({...envelope(rules),rules},evidence,[],context),false);
});

test('same_values rejects equivalent and overlapping actual locations while retaining independent collections',()=>{
 const selector=select('crm.search');
 const rule={requirement:'correspondence',operator:'same_values',response:selector,path:'/records',project_paths:['/email'],other_response:selector,other_path:'/records',other_project_paths:['','/email']};
 const rows=[{email:'synthetic@example.invalid'}];
 const data={...evidence,responses:[evidence.responses[0],response('crm.search',{records:rows,expected_attendees:structuredClone(rows),'escaped/key':rows})]};
 const check=row=>compareBindings(envelope([row]),data,[{id:'correspondence',operator:'same_values'}],context);
 assert.equal(check(rule),false);
 assert.equal(check({...rule,project_paths:[],other_project_paths:['']}),false);
 assert.equal(check({...rule,path:'/records/0/email',project_paths:undefined}),false);
 assert.equal(check({...rule,path:'/escaped~1key',other_path:'/escaped~1key',project_paths:['/email']}),false);
 assert.equal(check({...rule,other_path:'/expected_attendees'}),true);
 assert.equal(check({...rule,path:'',project_paths:['/records','/email']}),false);
 const doubled=structuredClone(data);doubled.responses[1].body.records.push({email:'synthetic@example.invalid'});
 const overlap={...rule,path:'',project_paths:['/records','/email'],other_path:'/records',other_project_paths:['/email']};
 assert.equal(compareBindings(envelope([overlap]),doubled,[],context),false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCreateRequest,
  buildDeleteRequest,
  buildSearchRequest,
  buildUpdateRequest,
  createConceptualCustomer
} from "../src/crm/operations.mjs";

const sourceA = {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source-a"};
const sourceB = {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source-b"};

test("request builders preserve complete discovered source references", () => {
  assert.deepEqual(buildSearchRequest({text: "cody.marcel@dfsm.ai"}), {text: "cody.marcel@dfsm.ai"});
  assert.deepEqual(buildSearchRequest({text: "person", source: sourceA}).source, sourceA);
  assert.deepEqual(buildCreateRequest({source: sourceA, changes: {custom_field: "value", student_id: "student-public-42"}}), {source: sourceA, changes: {custom_field: "value", student_id: "student-public-42"}});
});

test("update and delete accept one to five explicit unique targets for one conceptual customer", () => {
  const records = [
    {source: sourceA, record: {selector: "sel_a"}},
    {source: sourceB, record: {selector: "sel_b"}}
  ];
  const update = buildUpdateRequest({targets: records.map((item) => ({...item, changes: {custom_field: "new"}}))});
  assert.equal(update.targets.length, 2);
  assert.equal(buildDeleteRequest({targets: records}).targets.length, 2);
  assert.throws(() => buildDeleteRequest({targets: []}), /one to five/);
  assert.throws(() => buildDeleteRequest({targets: [records[0], records[0]]}), /duplicate/);
  assert.throws(() => buildDeleteRequest({targets: Array.from({length: 6}, (_, index) => ({source: sourceA, record: {selector: `sel_${index}`}}))}), /one to five/);
});

test("request builders reject client authority, identity, idempotency, and retry state", () => {
  for (const forbidden of [
    {organization_id: "x"}, {tenant: "x"}, {context_id: "x"}, {idempotency_key: "x"},
    {execution_id: "x"}, {retry_count: 1}, {provider_id: "x"}, {database_id: "x"}
  ]) assert.throws(() => buildCreateRequest({source: sourceA, changes: forbidden}), /forbidden/i);
  assert.throws(() => buildSearchRequest({text: "person", organization_id: "x"}), /unsupported/);
  assert.throws(() => buildUpdateRequest({targets: [{source: sourceA, record: {selector: "sel"}, changes: {custom_field: "x"}, retry_count: 1}]}), /unsupported/);
});

test("conceptual reconciliation preserves records and evidence without creating global identity", () => {
  const records = [{source: sourceA, record: {public_selector: "sel_a"}}, {source: sourceB, record: {public_selector: "sel_b"}}];
  const result = createConceptualCustomer({records, evidence: [{kind: "exact", fields: ["mailbox"]}], confidence: "high", conflicts: [], uncertainty: "Source observations remain distinct."});
  assert.deepEqual(result.records, records);
  assert.equal(result.id, undefined);
  assert.equal(result.customer_id, undefined);
  assert.throws(() => createConceptualCustomer({records: [{record: {public_selector: "sel_a"}}], evidence: [{kind: "exact"}], confidence: "low", uncertainty: "Incomplete."}), /source/);
  assert.throws(() => createConceptualCustomer({records: [{source: sourceA, record: {public_selector: "sel_a", provider_id: "hidden"}}], evidence: [{kind: "exact"}], confidence: "low", uncertainty: "Incomplete."}), /forbidden private key/);
});

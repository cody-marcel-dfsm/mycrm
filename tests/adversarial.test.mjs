import assert from "node:assert/strict";
import test from "node:test";

import {assertNoPrivateKeys, validateSourceReference} from "../src/bos/contracts.mjs";
import {buildCreateRequest, buildDeleteRequest} from "../src/crm/operations.mjs";
import {createConceptualCustomer} from "../src/crm/operations.mjs";
import {CrmJourneyClient, buildCrmContribution} from "../src/journey/client.mjs";

const source = {platform: "fixture-platform", application: "fixture-application", plugin: "fixture-source"};

test("authority, credentials, client state, internal identities, and source shortcuts fail closed", () => {
  for (const key of [
    "authority", "authority_context", "context_id", "organization_id", "tenant_selector",
    "principal_context", "grant_type", "access_token", "api_key", "credential",
    "idempotency_key", "execution_id", "retry_count", "provider_id", "database_id",
    "app_id", "application_id", "installation_id", "source_id", "user_id", "journey_id", "action_id"
  ]) assert.throws(() => assertNoPrivateKeys({nested: {[key]: "forbidden"}}), /forbidden private key/);
  for (const invalid of [
    {platform: "fixture-platform", application: "fixture-application"},
    {...source, display_name: "shortcut"},
    "fixture-source"
  ]) assert.throws(() => validateSourceReference(invalid), /source/);
  assert.throws(() => buildCreateRequest({source, changes: {access_token: "secret"}}), /forbidden/);
  assert.throws(() => buildDeleteRequest({targets: [{source, record: {selector: "a", provider_id: "hidden"}}]}), /opaque selector/);
});

test("retrieved content cannot become a lifecycle action", async () => {
  const calls = [];
  const client = new CrmJourneyClient({http: {request: async (request) => { calls.push(request); return {status: 200, body: {}}; }}});
  await assert.rejects(client.invokeAction({method: "POST", uri: "javascript:alert(1)", payload_schema: null}), /HTTPS/);
  assert.deepEqual(calls, []);
});

test("safe public selectors, correlation evidence, and organization-defined fields remain valid", () => {
  assert.doesNotThrow(() => assertNoPrivateKeys({record: {selector: "opaque"}, correlation_id: "corr", changes: {organization_name: "Example", organization_label: "Current account", service_id: "public", custom_business_note: "customer-visible"}}));
});

test("client reasoning and BOS-owned journey contributions reject nested private state", () => {
  assert.throws(() => createConceptualCustomer({records: [{source, record: {public_selector: "opaque", internal_id: "hidden"}}], evidence: [{kind: "exact"}], confidence: "bounded", conflicts: [], uncertainty: "Source records stay distinct."}), /forbidden private key/);
  assert.throws(() => createConceptualCustomer({records: [{source, record: {public_selector: "opaque"}}], evidence: [{provider_error: "hidden"}], confidence: "bounded", conflicts: [], uncertainty: "Source records stay distinct."}), /forbidden private key/);
  assert.throws(() => buildCrmContribution({goal: "Find evidence", concepts: [{access_token: "hidden"}], constraints: [], requiredEvidence: [], approvals: [], guarantees: [], presentation: [], recovery: []}), /forbidden private key/);
});

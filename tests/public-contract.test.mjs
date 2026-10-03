import assert from "node:assert/strict";
import test from "node:test";

import {BosContractClient} from "../src/bos/client.mjs";
import {assertNoPrivateKeysPreservingCanonicalErrors, validateApplicationDiscovery, validateJsonValueAgainstSchema, validateOperationDescription, validatePublicError} from "../src/bos/contracts.mjs";
import {createSyntheticDocuments, startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

test("discovery URL returns operation-scoped Describe contracts and runtime schemas", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, http: service.http, bos: service.bos});
  const described = await client.describe(["search", "update"]);
  assert.deepEqual(described.operations.map(({operation}) => operation), ["search", "update"]);
  for (const operation of described.operations) {
    validateJsonValueAgainstSchema(operation.operation === "search" ? {text: "Synthetic Person"} : service.documents.examples.update.request, operation.input_schema, `${operation.operation} input`);
  }
});

test("application discovery validates the exact published journey registration contract", () => {
  const discovery = createSyntheticDocuments().discovery;
  assert.deepEqual(validateApplicationDiscovery(discovery).journey_registration, {
    contract: {
      capability: "api.contract.get",
      input: {operation: "lead-director.journeys.register"}
    }
  });
  for (const journey_registration of [
    undefined,
    {contract: {capability: "api.contract.get", input: {operation: "other"}}},
    {contract: {capability: "other", input: {operation: "lead-director.journeys.register"}}},
    {contract: {capability: "api.contract.get", input: {operation: "lead-director.journeys.register", extra: true}}}
  ]) {
    assert.throws(() => validateApplicationDiscovery({...discovery, journey_registration}), /journey_registration|must be an object/);
  }
});

test("application discovery remains compatible when journey registration is not advertised", () => {
  const discovery = structuredClone(createSyntheticDocuments().discovery);
  delete discovery.journey_registration;
  assert.equal(validateApplicationDiscovery(discovery).journey_registration, undefined);
});

test("operations absent from discovery cannot be described or executed", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, http: service.http, bos: service.bos});
  await assert.rejects(client.describe(["unknown_operation"]), /not present in current discovery/);
  await assert.rejects(client.execute("unknown_operation", {}), /not been described/);
});

test("described schemas preserve organization-owned email fields", () => {
  const operation = structuredClone(createSyntheticDocuments().describe.operations[0]);
  operation.output_schema.properties.email = {type: "string"};
  operation.output_schema.properties.email_address = {type: "string"};
  const validated = validateOperationDescription(operation);
  assert.equal(validated.output_schema.properties.email.type, "string");
  assert.equal(validated.output_schema.properties.email_address.type, "string");
});

test("discovered schemas enforce current scalar constraints", async (context) => {
  const service = await startSyntheticBosService({variant: "beta"});
  context.after(service.close);
  const client = new BosContractClient({discovery: service.discovery, http: service.http, bos: service.bos});
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: ""}), /does not satisfy its schema/);
  await assert.rejects(client.execute("search", {text: "x".repeat(513)}), /does not satisfy its schema/);
});

test("public errors enforce structural code, message privacy, and detail safety", () => {
  assert.equal(validatePublicError({code: "SOURCE_TEMPORARILY_UNAVAILABLE", message: "Safe", retryable: true, correlation_id: "corr", details: []}).code, "SOURCE_TEMPORARILY_UNAVAILABLE");
  assert.throws(() => validatePublicError({code: "Validation_Failed", message: "Safe", retryable: false, correlation_id: "corr", details: []}), /code is invalid/);
  assert.throws(() => validatePublicError({code: "failed", message: "token=synthetic-secret; SQLSTATE synthetic failure", retryable: false, correlation_id: "corr", details: []}), /private implementation detail/);
  assert.throws(() => validatePublicError({code: "failed", message: "Safe", retryable: false, correlation_id: "corr", details: [{access_token: "private"}]}), /private key/);
});

test("public errors require the exact envelope and an array of details", () => {
  const valid = {code: "failed", message: "Safe", retryable: false, correlation_id: "corr", details: []};
  assert.deepEqual(validatePublicError(valid), valid);
  assert.throws(() => validatePublicError({code: "failed", message: "Safe", retryable: false, correlation_id: "corr"}), /shape is invalid/);
  assert.throws(() => validatePublicError({...valid, details: null}), /details must be an array/);
  assert.throws(() => validatePublicError({...valid, provider: "private"}), /shape is invalid/);
});

test("public error details recursively reject the complete family-private vocabulary", () => {
  const base = {code: "failed", message: "Safe", retryable: false, correlation_id: "corr", details: []};
  for (const key of [
    "sql", "SQL", "stack_trace", "stackTrace", "provider_payload", "providerPayload",
    "provider_message", "providerMessage", "graph_id", "graphId", "password", "handler",
    "org_id", "orgId", "plugin_id", "pluginId", "email", "email_address", "emailAddress"
  ]) {
    assert.throws(() => validatePublicError({...base, details: [{public: [{nested: {[key]: "private"}}]}]}), /forbidden private key/, key);
  }
  assert.deepEqual(validatePublicError({...base, details: [{field: "email", message: "The email field needs review."}]}).details, [{field: "email", message: "The email field needs review."}]);
  assert.throws(() => validatePublicError({...base, details: [{reason: `Do not expose bos_ctx_v2_${"a".repeat(64)} here.`}]}), /private implementation text/);
});

test("public error details retain service-owned cardinality, key count, and safe depth", () => {
  let deep = {value: "safe"};
  for (let index = 0; index < 40; index += 1) deep = {[`level_${index}`]: deep};
  const wide = Object.fromEntries(Array.from({length: 40}, (_, index) => [`field_${index}`, `value_${index}`]));
  const details = Array.from({length: 40}, (_, index) => ({index, deep: structuredClone(deep), wide: structuredClone(wide)}));
  const error = {code: "failed", message: "Safe", retryable: false, correlation_id: "corr", details};
  assert.deepEqual(validatePublicError(error), error);
});

test("canonical recognition uses complete service-owned paths rather than error-key suffixes", () => {
  const business = {
    object: {record: {error: {message: "Organization-defined status."}}},
    metadata: {error: {message: "Organization-defined metadata."}},
    outcomes: [{metadata: {error: {message: "Organization-defined outcome metadata."}}}]
  };
  assert.doesNotThrow(() => assertNoPrivateKeysPreservingCanonicalErrors(business));
  assert.throws(() => assertNoPrivateKeysPreservingCanonicalErrors({records: [{error: {message: "Malformed sanctioned error."}}]}), /public error shape is invalid/);
});

test("public error messages preserve whitespace and count Unicode code points", () => {
  const base = {code: "failed", retryable: false, correlation_id: "corr", details: []};
  assert.equal(validatePublicError({...base, message: " \n\t "}).message, " \n\t ");
  assert.equal(validatePublicError({...base, message: "😀".repeat(2048)}).message, "😀".repeat(2048));
  assert.throws(() => validatePublicError({...base, message: "😀".repeat(2049)}), /too long/);
  assert.throws(() => validatePublicError({...base, message: ""}), /non-empty string/);
});

test("source availability preserves current and recognized archived values", () => {
  const operation = createSyntheticDocuments().describe.operations[0];
  for (const availability of ["ready", "authorization_required", "configuration_required", "temporarily_unavailable", "provider_authorization_required", "source_not_available", "source_temporarily_unavailable"]) {
    const candidate = structuredClone(operation);
    candidate.sources[0].availability = availability;
    assert.equal(validateOperationDescription(candidate).sources[0].availability, availability);
  }
  for (const availability of ["unknown", "Ready", "AUTHORIZATION_REQUIRED"]) {
    const candidate=structuredClone(operation);candidate.sources[0].availability=availability;
    assert.throws(() => validateOperationDescription(candidate), /availability is invalid/);
  }
});

test("declared error codes preserve case and reject mixed or malformed values", () => {
  for (const codes of [["INVALID_REQUEST","SOURCE_TEMPORARILY_UNAVAILABLE"],["invalid_request","source_temporarily_unavailable"]]) {
    const operation=createSyntheticDocuments().describe.operations[0];
    operation.error_contract.codes=codes;
    assert.deepEqual(validateOperationDescription(operation).error_contract.codes,codes);
  }
  for(const code of ["Invalid_Request","INVALID-REQUEST","invalid request"]) {
    const operation=createSyntheticDocuments().describe.operations[0];operation.error_contract.codes=[code];
    assert.throws(() => validateOperationDescription(operation), /error_contract.codes/);
  }
});

test("unready sources remain describable and cannot reach business transport", async () => {
  for (const availability of ["authorization_required", "configuration_required", "temporarily_unavailable"]) {
    const documents = createSyntheticDocuments();
    const operation = documents.describe.operations[0];
    operation.sources[0].availability = availability;
    const requests = [];
    const client = new BosContractClient({
      discovery: {read: async () => documents.discovery, refresh: async () => documents.discovery},
      http: {request: async (request) => {
        requests.push(request);
        assert.equal(request.uri, documents.discovery.describe.uri);
        return {status: 200, body: {...documents.describe, operations: [operation]}};
      }},
      bos: {recoverAuthentication: async () => {throw new Error("Readiness cannot grant authentication");}}
    });
    const described = await client.describe([operation.operation]);
    assert.equal(described.operations[0].sources[0].availability, availability);
    await assert.rejects(client.execute(operation.operation, {text: "Synthetic Person"}), /no ready selected source/);
    assert.equal(requests.length, 1);
  }
});

test("optional public Describe limits preserve strict types and attachment bounds",()=>{
 const operation=structuredClone(createSyntheticDocuments().describe.operations[0]);
 for(const value of [true,false])assert.equal(validateOperationDescription({...operation,limits:{...operation.limits,multiple_selectors_per_source:value}}).limits.multiple_selectors_per_source,value);
 for(const value of [1,26214400])assert.equal(validateOperationDescription({...operation,limits:{...operation.limits,maximum_attachment_bytes:value}}).limits.maximum_attachment_bytes,value);
 for(const value of [null,0,1,"true",{},[]])assert.throws(()=>validateOperationDescription({...operation,limits:{...operation.limits,multiple_selectors_per_source:value}}),/limits/);
 for(const value of [null,0,-1,26214401,1.5,true,"26214400",{},[]])assert.throws(()=>validateOperationDescription({...operation,limits:{...operation.limits,maximum_attachment_bytes:value}}),/limits/);
 assert.throws(()=>validateOperationDescription({...operation,limits:{...operation.limits,unknown_limit:true}}),/limits shape/);
 assert.equal(validateOperationDescription({...operation,limits:{...operation.limits,max_targets:null}}).limits.max_targets,null);
});

import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {
  validateApplicationDiscovery,
  validateDescribeResponse,
  validateJsonValueAgainstSchema,
  validatePublicError
} from "../src/bos/contracts.mjs";

const published = async (name) => JSON.parse(await readFile(new URL(`../contracts/bos/lead-director/v1/${name}`, import.meta.url), "utf8"));
const owned = async (name) => JSON.parse(await readFile(new URL(`../contracts/my-crm/v1/${name}`, import.meta.url), "utf8"));

test("Oracle-approved app.describe and task-scoped Describe release artifacts conform", async () => {
  const discovery = await published("app.describe.example.json");
  const request = await published("describe.request.example.json");
  const response = await published("describe.response.example.json");
  assert.deepEqual(validateApplicationDiscovery(discovery).application, {platform: "bos", application: "lead-director"});
  const described = validateDescribeResponse(response, request.operations);
  assert.deepEqual(described.operations.map(({operation, status}) => [operation, status]), [["search", "described"], ["create", "described"], ["update", "described"], ["delete", "described"], ["calendar_read_event", "not_available"]]);
  assert.equal(described.operations[0].sources[0].availability, "ready");
});

test("app.describe pins the canonical Describe route and one BOSL authority partition", async () => {
  const discovery = await published("app.describe.example.json");
  assert.throws(() => validateApplicationDiscovery({...discovery, describe: {...discovery.describe, uri: "/other/apps/lead-director/api/v1/organizations/{organization}/describe"}}), /schema|URI/);
  assert.throws(() => validateApplicationDiscovery({...discovery, bosl: {...discovery.bosl, examples_uri: "bos://apps/lead-director/bosl/cccccccccccccccccccccccccccccccc/examples"}}), /partition/);
});

test("Describe validation enforces exact requested operation keys and published wrappers", async () => {
  const request = await published("describe.request.example.json");
  const response = await published("describe.response.example.json");
  assert.throws(() => validateDescribeResponse(response, []), /one to/);
  assert.throws(() => validateDescribeResponse(response, ["search", "search"]), /unique/);
  assert.throws(() => validateDescribeResponse(response, ["a", "b", "c", "d", "e", "f"]), /one to/);
  assert.throws(() => validateDescribeResponse(response, ["search"]), /exactly the requested/);
  const broken = structuredClone(response);
  broken.operations[0].semantic_operation_id = broken.operations[0].operation;
  assert.throws(() => validateDescribeResponse(broken, request.operations), /shape|schema/);
  const bareSource = structuredClone(response);
  bareSource.operations[0].sources[0] = bareSource.operations[0].sources[0].source;
  assert.throws(() => validateDescribeResponse(bareSource, request.operations), /shape|schema/);
  const reversed = structuredClone(response);
  reversed.operations.reverse();
  assert.throws(() => validateDescribeResponse(reversed, request.operations), /request order/);
  assert.throws(() => validateDescribeResponse({...response, observed_at: "2026-09-19"}, request.operations), /observed_at|schema/);
  const extraLimit = structuredClone(response);
  extraLimit.operations[0].limits.provider_limit = 1;
  assert.throws(() => validateDescribeResponse(extraLimit, request.operations), /schema|limits shape/);
  const extraExecution = structuredClone(response);
  extraExecution.operations[0].execution.provider = "raw";
  assert.throws(() => validateDescribeResponse(extraExecution, request.operations), /schema|execution shape/);
});

test("released JSON schemas validate exact examples and strict date-time formats", async () => {
  const appSchema = await published("app.describe.schema.json");
  const describeSchema = await published("describe.response.schema.json");
  const app = await published("app.describe.example.json");
  const response = await published("describe.response.example.json");
  assert.doesNotThrow(() => validateJsonValueAgainstSchema(app, appSchema, "app.describe"));
  assert.doesNotThrow(() => validateJsonValueAgainstSchema(response, describeSchema, "Describe response"));
  assert.throws(() => validateJsonValueAgainstSchema({...response, observed_at: "September someday"}, describeSchema, "Describe response"), /format/);
});

test("released operation examples conform to every advertised invocation schema", async () => {
  const response = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  for (const operationId of ["search", "create", "update", "delete"]) {
    const operation = response.operations.find(({operation}) => operation === operationId);
    validateJsonValueAgainstSchema(examples[operationId].request, operation.input_schema, `published ${operationId} request`);
    validateJsonValueAgainstSchema(examples[operationId].response, operation.output_schema, `published ${operationId} response`);
  }
});

test("discovered JSON Schemas enforce local references, composition, and scalar constraints", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    required: ["target", "count"],
    properties: {target: {$ref: "#/$defs/target"}, count: {type: "integer", minimum: 1}, mode: {oneOf: [{const: "safe"}, {const: "review"}]}},
    $defs: {target: {type: "object", additionalProperties: false, required: ["selector"], properties: {selector: {type: "string", minLength: 1}}}}
  };
  assert.doesNotThrow(() => validateJsonValueAgainstSchema({target: {selector: "sel"}, count: 1, mode: "safe"}, schema));
  assert.throws(() => validateJsonValueAgainstSchema({target: {}, count: 1.5, mode: "unsafe"}, schema), /schema/);
  assert.throws(() => validateJsonValueAgainstSchema({target: {selector: "sel", provider_id: "raw"}, count: 1}, schema), /schema/);
  assert.throws(() => validateJsonValueAgainstSchema({}, {$ref: "https://example.invalid/schema"}), /invalid or unsupported/);
});

test("public errors reject provider and internal leakage", () => {
  assert.equal(validatePublicError({code: "DENIED", message: "The operation is unavailable.", retryable: false, correlation_id: "corr_public", details: [{field: "value"}]}).code, "DENIED");
  assert.equal(validatePublicError({code: "DENIED", message: "The operation is unavailable.", retryable: false, correlation_id: "corr_public"}).code, "DENIED");
  for (const value of [
    {code: "BAD", message: "bad", retryable: false, correlation_id: "corr", details: [], provider_error: "raw"},
    {code: "BAD", message: "bad", retryable: false, correlation_id: "corr", details: [{access_token: "secret"}]},
    {code: "BAD", message: "bad", retryable: false, correlation_id: "corr", details: [{database_id: "42"}]},
    {code: "bad", message: "bad", retryable: false, correlation_id: "corr", details: []},
    {code: "A".repeat(129), message: "bad", retryable: false, correlation_id: "corr", details: []},
    {code: "BAD", message: "x".repeat(2049), retryable: false, correlation_id: "corr", details: []},
    {code: "BAD", message: "bad", retryable: false, correlation_id: "bad space", details: []},
    {code: "BAD", message: "bad", retryable: false, correlation_id: `a${"b".repeat(128)}`, details: []},
    {code: "BAD", message: "bad", retryable: false, correlation_id: "corr", details: {field: "value"}}
  ]) assert.throws(() => validatePublicError(value), /public error/i);
});

test("owned conceptual-customer schema requires source-first record evidence", async () => {
  const schema = await owned("conceptual-customer.schema.json");
  const example = JSON.parse(await readFile(new URL("../examples/crm/conceptual-customer.json", import.meta.url), "utf8"));
  assert.doesNotThrow(() => validateJsonValueAgainstSchema(example, schema, "conceptual customer"));
  const missingSource = structuredClone(example);
  delete missingSource.records[0].source;
  assert.throws(() => validateJsonValueAgainstSchema(missingSource, schema, "conceptual customer"), /required/);
  const missingSelector = structuredClone(example);
  delete missingSelector.records[0].record.public_selector;
  assert.throws(() => validateJsonValueAgainstSchema(missingSelector, schema, "conceptual customer"), /required/);
});

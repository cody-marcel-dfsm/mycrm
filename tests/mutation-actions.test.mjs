import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {OperationStateActionClient, ReturnedActionClient, validateOperationStateAction} from "../src/bos/action-client.mjs";
import {BosContractClient} from "../src/bos/client.mjs";

const published = async (name) => JSON.parse(await readFile(new URL(`../contracts/bos/lead-director/v1/${name}`, import.meta.url), "utf8"));
const selectDescribe = (response, operationIds) => ({...structuredClone(response), operations: response.operations.filter(({operation}) => operationIds.includes(operation))});

test("an approval action invokes only its returned URI and advertised payload schema", async () => {
  const calls = [];
  const action = {method: "POST", uri: "https://fixture.invalid/action/delete-approved", payload_schema: {type: "object", additionalProperties: false, required: ["approved"], properties: {approved: {const: true}}}};
  const actions = new ReturnedActionClient({http: {request: async (request) => { calls.push(request); return {status: 200, body: {complete: true}}; }}});
  await actions.invoke(action, {approved: true});
  assert.deepEqual(calls[0], {method: "POST", uri: action.uri, headers: {"content-type": "application/json"}, body: {approved: true}});
  await assert.rejects(actions.invoke(action, {approved: false}), /schema/);
  assert.equal(calls.length, 1);
});

test("in-progress state action is physically bodyless and cannot replay mutation input", async () => {
  const calls = [];
  const action = {verb: "state", method: "GET", uri: "https://fixture.invalid/action/state", body: null};
  const actions = new OperationStateActionClient({http: {request: async (request) => { calls.push(request); return {status: 200, body: {complete: true}}; }}});
  await actions.invoke(action);
  assert.deepEqual(calls[0], {method: "GET", uri: action.uri, headers: {}});
  await assert.rejects(actions.invoke(action, {}), /bodyless/);
  assert.equal(calls.length, 1);
  assert.deepEqual(validateOperationStateAction({uri: action.uri}), action);
  for (const invalid of [
    {...action, method: "POST"},
    {...action, verb: "retry"},
    {...action, body: {}},
    {...action, payload_schema: null},
    {...action, uri: "http://fixture.invalid/action/state"},
    {...action, uri: "https://user:secret@fixture.invalid/action/state"},
    {...action, uri: "https://fixture.invalid/action/state#fragment"}
  ]) assert.throws(() => validateOperationStateAction(invalid), /state action|HTTPS|credentials|fragment/);
});

test("runtime public failures require correlation evidence, advertised codes, and sanitized details", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({uri, body}) => uri === discovery.describe.uri ? {status: 200, body: selectDescribe(describe, body.operations)} : {status: 400, body: {error: {code: "INVALID_REQUEST", message: "SQLSTATE 999 stack trace", retryable: false, correlation_id: "corr", details: []}}}},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_ERROR");
});

test("public recovery instructions use a bounded allowlist and validated returned actions", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  let instruction = {redirect_uri: "https://evil.invalid/phish"};
  const client = new BosContractClient({
    discovery: {read: async () => discovery, refresh: async () => discovery},
    http: {request: async ({uri, body}) => uri === discovery.describe.uri ? {status: 200, body: selectDescribe(describe, body.operations)} : {status: 400, body: {error: {code: "INVALID_REQUEST", message: "The request needs review.", retryable: false, correlation_id: "corr", details: []}, instruction}}},
    bos: {recoverAuthentication: async () => ({status: "READY"})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_INSTRUCTION" && error.instruction === null);
  instruction = {
    effect: "delete_record",
    message: "Review the exact target.",
    review: {targets: [{source: {platform: "bos", application: "lead-director", plugin: "fixture"}, record: {selector: "opaque"}}]},
    approval_schema: {type: "object", additionalProperties: false, required: ["approved"], properties: {approved: {const: true}}},
    action: {method: "POST", uri: "https://fixture.invalid/action/approve", payload_schema: {type: "object"}}
  };
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_REQUEST" && error.instruction.action.method === "POST");
  instruction.action.uri = "javascript:alert(1)";
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_INSTRUCTION");
  instruction = {effect: "delete_record", approval_schema: {type: "object", properties: {access_token: {type: "string"}}}};
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_INSTRUCTION");
});

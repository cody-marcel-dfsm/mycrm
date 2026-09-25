import assert from "node:assert/strict";
import test from "node:test";

import {OperationStateActionClient, ReturnedActionClient, validateOperationStateAction} from "../src/bos/action-client.mjs";
import {BosContractClient} from "../src/bos/client.mjs";
import {startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

test("a returned action is validated and delegated unchanged to the BOS adapter", async () => {
  const calls = [];
  const action = {verb: "step", method: "POST", href: "/action/delete-approved", payload_schema: {type: "object", additionalProperties: false, required: ["approved"], properties: {approved: {const: true}}}};
  const actions = new ReturnedActionClient({bos: {invokeReturnedAction: async (current, payload) => { calls.push({action: current, payload}); return {status: 200, body: {complete: true}}; }}});
  await actions.invoke(action, {approved: true});
  assert.deepEqual(calls[0], {action, payload: {approved: true}});
  assert.equal(JSON.stringify(calls[0]).includes("header"), false);
  assert.equal(JSON.stringify(calls[0]).includes("bos_ctx_v2_"), false);
  await assert.rejects(actions.invoke(action, {approved: false}), /schema/);
  assert.equal(calls.length, 1);
});

test("in-progress state action is physically bodyless and cannot replay mutation input", async () => {
  const calls = [];
  const action = {verb: "state", method: "GET", href: "/action/state", payload_schema: null};
  const actions = new OperationStateActionClient({bos: {invokeStateAction: async (current) => { calls.push(current); return {status: 200, body: {complete: true}}; }}});
  await actions.invoke(action);
  assert.deepEqual(calls[0], action);
  await assert.rejects(actions.invoke(action, {}), /bodyless/);
  assert.equal(calls.length, 1);
  assert.deepEqual(validateOperationStateAction(action), action);
  for (const invalid of [
    {...action, method: "POST"},
    {...action, verb: "retry"},
    {...action, body: {}},
    {...action, payload_schema: {type: "object"}},
    {...action, href: "http://fixture.invalid/action/state"},
    {...action, href: "//fixture.invalid/action/state"},
    {...action, href: "/action/state#fragment"}
  ]) assert.throws(() => validateOperationStateAction(invalid), /returned|state action|origin-relative|fragment/);
});

test("runtime public failures require correlation evidence, advertised codes, and sanitized details", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = new BosContractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 400, body: {error: {code: "VALIDATION_FAILED", message: "SQLSTATE 999 stack trace", retryable: false, correlation_id: "corr", details: []}}})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_ERROR");
});

test("public recovery instructions use a bounded allowlist and validated returned actions", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  let instruction = {redirect_uri: "https://evil.invalid/phish"};
  const client = new BosContractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 400, body: {error: {code: "VALIDATION_FAILED", message: "The request needs review.", retryable: false, correlation_id: "corr", details: []}, instruction}})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_INSTRUCTION" && error.instruction === null);
  instruction = {
    effect: "delete_record",
    message: "Review the exact target.",
    review: {targets: [{source: {platform: "bos", application: "lead-director", plugin: "fixture"}, record: {selector: "opaque"}}]},
    approval_schema: {type: "object", additionalProperties: false, required: ["approved"], properties: {approved: {const: true}}},
    action: {verb: "step", method: "POST", href: "/action/approve", payload_schema: {type: "object"}}
  };
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "VALIDATION_FAILED" && error.instruction.action.method === "POST");
  instruction.action.href = "javascript:alert(1)";
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_INSTRUCTION");
  instruction = {effect: "delete_record", approval_schema: {type: "object", properties: {access_token: {type: "string"}}}};
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "INVALID_PUBLIC_INSTRUCTION");
});

import assert from "node:assert/strict";
import test from "node:test";

import {OperationStateActionClient, ReturnedActionClient, validateOperationStateAction} from "../src/bos/action-client.mjs";
import {BosContractClient} from "../src/bos/client.mjs";
import {startSyntheticBosService} from "./support/synthetic-bos-service.mjs";

function contractClient(options) {
  const http = options.http ?? {
    request: async ({method, uri, body, context_header}) => {
      if (Array.isArray(body?.operations)) return {status: 200, body: await options.discovery.describe(body)};
      return options.bos.invokeDiscoveredOperation({execution: {method, uri, context_header}}, body);
    }
  };
  return new BosContractClient({...options, bos: {recoverAuthentication: async () => ({status: "READY"}), ...options.bos}, http});
}

test("a returned action is validated and delegated unchanged to the BOS adapter", async () => {
  const calls = [];
  const action = {verb: "step", method: "POST", href: "/bos/action/delete-approved", payload_schema: {type: "object", additionalProperties: false, required: ["approved"], properties: {approved: {const: true}}}};
  const actions = new ReturnedActionClient({bos: {invokeReturnedAction: async (current, payload) => { calls.push({action: current, payload}); return {status: 200, body: {complete: true}}; }}});
  await actions.invoke(action, {approved: true});
  assert.deepEqual(calls[0], {action, payload: {approved: true}});
  assert.equal(JSON.stringify(calls[0]).includes("header"), false);
  assert.equal(JSON.stringify(calls[0]).includes("bos_ctx_v2_"), false);
  await assert.rejects(actions.invoke(action, {approved: false}), /schema/);
  assert.equal(calls.length, 1);
});

test("service-owned literal percent text is delegated unchanged after one decoded safety inspection", async () => {
  const calls = [];
  const action = {verb: "state", method: "GET", href: "/bos/apps/lead-director/api/v1/organizations/example/journeys/follow-up%3A%2520?capability=opaque", payload_schema: null};
  const actions = new OperationStateActionClient({bos: {invokeStateAction: async (current) => { calls.push(current); return {status: 200, body: {status: "in_progress"}}; }}});
  await actions.invoke(action);
  assert.deepEqual(calls, [action]);
});

test("in-progress state action is physically bodyless and cannot replay mutation input", async () => {
  const calls = [];
  const action = {verb: "state", method: "GET", href: "/bos/action/state", payload_schema: null};
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
    {...action, href: "/bos/action/state#fragment"}
  ]) assert.throws(() => validateOperationStateAction(invalid), /returned|state action|origin-relative|fragment/);
});

test("unsafe returned journey and state actions fail before BOS transport", async () => {
  const returnedCalls = [];
  const stateCalls = [];
  const returned = new ReturnedActionClient({bos: {invokeReturnedAction: async (...args) => returnedCalls.push(args)}});
  const state = new OperationStateActionClient({bos: {invokeStateAction: async (...args) => stateCalls.push(args)}});
  const unsafeHrefs = [
    "/action/outside-bos",
    "//fixture.invalid/bos/action",
    "https://fixture.invalid/bos/action",
    "/bos/../private",
    "/bos/..?/private",
    "/bos/%2e%2e/private",
    "/bos/%2e./private",
    "/bos/.%2e/private",
    "/bos/%2e%2e%2fprivate",
    "/bos/action%3f/../private",
    "/bos/action#fragment",
    "/bos/action%23fragment",
    "/bos/action\r\nx-header:value",
    "/bos/action%0d%0ax-header:value",
    "/bos//action",
    "/bos/%2faction",
    "/bos/\\..\\private"
  ];
  for (const href of unsafeHrefs) {
    await assert.rejects(returned.invoke({verb: "step", method: "POST", href, payload_schema: null}), /safe origin-relative \/bos\//);
    await assert.rejects(state.invoke({verb: "state", method: "GET", href, payload_schema: null}), /safe origin-relative \/bos\//);
  }
  assert.deepEqual(returnedCalls, []);
  assert.deepEqual(stateCalls, []);
});

test("runtime public failures reject private implementation message content", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 400, body: {error: {code: "invalid_request", message: "SQLSTATE 999 stack trace", retryable: false, correlation_id: "corr", details: []}}})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => !Object.hasOwn(error, "code") && error.publicError === null && /nonconforming public error/.test(error.message));
});

test("canonical BOS platform failures reach the client unchanged", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  const client = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 403, body: {error: {code: "authorization_denied", message: "Current authority does not permit this operation.", retryable: false, correlation_id: "corr", details: []}}})}
  });
  await client.describe(["search"]);
  await assert.rejects(
    client.execute("search", {text: "person"}),
    (error) => error.code === "authorization_denied" && error.publicError.code === "authorization_denied"
  );
});

test("public recovery instructions use a bounded allowlist and validated returned actions", async (context) => {
  const service = await startSyntheticBosService();
  context.after(service.close);
  let instruction = {redirect_uri: "https://evil.invalid/phish"};
  const client = contractClient({
    discovery: service.discovery,
    bos: {...service.bos, invokeDiscoveredOperation: async () => ({status: 400, body: {error: {code: "invalid_request", message: "The request needs review.", retryable: false, correlation_id: "corr", details: []}, instruction}})}
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "invalid_request" && error.message === "The request needs review." && error.instruction === null);
  instruction = {
    effect: "delete_record",
    message: "Review the exact target.",
    review: {targets: [{source: {platform: "bos", application: "lead-director", plugin: "fixture"}, record: {selector: "opaque"}}]},
    approval_schema: {type: "object", additionalProperties: false, required: ["approved"], properties: {approved: {const: true}}},
    action: {verb: "step", method: "POST", href: "/bos/action/approve", payload_schema: {type: "object"}}
  };
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "invalid_request" && error.instruction.action.method === "POST");
  instruction.action.href = "javascript:alert(1)";
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "invalid_request" && error.message === "The request needs review." && error.instruction === null);
  instruction = {effect: "delete_record", approval_schema: {type: "object", properties: {access_token: {type: "string"}}}};
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error.code === "invalid_request" && error.message === "The request needs review." && error.instruction === null);
});

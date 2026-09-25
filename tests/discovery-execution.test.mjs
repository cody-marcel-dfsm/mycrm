import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

import {authenticationCondition, BosContractClient, BosContractError} from "../src/bos/client.mjs";

const published = async (name) => JSON.parse(await readFile(new URL(`../contracts/bos/lead-director/v1/${name}`, import.meta.url), "utf8"));
const selectDescribe = (response, operationIds) => ({...structuredClone(response), operations: response.operations.filter(({operation}) => operationIds.includes(operation))});
const discoveryAdapter = (discovery, describe, overrides = {}) => ({
  read: async () => structuredClone(discovery),
  refresh: async () => structuredClone(discovery),
  describe: async ({operations}) => selectDescribe(describe, operations),
  ...overrides
});
const bosAdapter = (overrides = {}) => ({
  recoverAuthentication: async () => ({status: "READY"}),
  invokeDiscoveredOperation: async () => { throw new Error("unexpected discovered operation invocation"); },
  ...overrides
});

test("every package-declared authentication condition delegates to BOS", async () => {
  const product = JSON.parse(await readFile(new URL("../plugins/my-crm/.bos-product.json", import.meta.url), "utf8"));
  for (const condition of product.authentication_handoff.recognized_condition_categories) {
    assert.deepEqual(authenticationCondition({code: condition}), {
      category: condition === "MCP_SESSION_CLOSED" ? "mcp_session" : "authentication",
      code: condition,
      source: "protected_resource"
    });
  }
  assert.deepEqual(authenticationCondition({status: 401}), {category: "authentication", code: "AUTHORIZATION_REQUIRED", source: "protected_resource"});
  assert.equal(authenticationCondition({status: 403, code: "PERMISSION_DENIED"}), null);
});

test("client passes the exact published execution contact to the BOS dependency adapter", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const calls = [];
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe),
    bos: bosAdapter({invokeDiscoveredOperation: async (contact, payload) => {
      calls.push({contact: structuredClone(contact), payload: structuredClone(payload)});
      return {status: 200, body: structuredClone(examples.search.response)};
    }})
  });
  const contract = await client.describe(["search"]);
  const input = {text: "fixture.person@example.invalid"};
  assert.equal((await client.execute("search", input)).status, 200);
  const operation = contract.operations[0];
  assert.deepEqual(calls, [{contact: operation, payload: input}]);
  assert.equal(calls[0].contact.execution.context_header, "X-BOS-Context-Handle");
  assert.equal(JSON.stringify(calls).includes("bos_ctx_v2_"), false);
});

test("client rejects adapter responses outside the closed public response contract", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  for (const response of [
    {status: 0, body: {}},
    {status: 200, body: {}, headers: {authorization: "Bearer private"}}
  ]) {
    const client = new BosContractClient({
      discovery: discoveryAdapter(discovery, describe),
      bos: bosAdapter({invokeDiscoveredOperation: async () => structuredClone(response)})
    });
    await client.describe(["search"]);
    await assert.rejects(
      client.execute("search", {text: "person"}),
      (error) => error instanceof BosContractError && error.code === "TRANSPORT_FAILURE" && !error.message.includes("Bearer private")
    );
  }
});

test("GET operations remain physically bodyless at the BOS dependency boundary", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const read = structuredClone(describe.operations[0]);
  read.operation = "search";
  read.execution.method = "GET";
  let argumentCount = null;
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, {...describe, operations: [read]}),
    bos: bosAdapter({invokeDiscoveredOperation: async function () {
      argumentCount = arguments.length;
      return {status: 200, body: structuredClone(examples.search.response)};
    }})
  });
  await client.describe(["search"]);
  await client.execute("search", {text: "person"});
  assert.equal(argumentCount, 1);
});

test("Describe authentication delegates condition/resource, refreshes, and retries exact task scope once", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const resource = "https://fixture.invalid/mcp/lead-director";
  const recoveries = [];
  let describeCalls = 0;
  let refreshes = 0;
  let invalidations = 0;
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe, {
      refresh: async () => { refreshes += 1; return discovery; },
      describe: async ({operations}) => {
        describeCalls += 1;
        if (describeCalls === 1) {
          const error = new Error("private transport detail");
          error.code = "MCP_SESSION_CLOSED";
          error.resource = resource;
          throw error;
        }
        return selectDescribe(describe, operations);
      }
    }),
    bos: bosAdapter({recoverAuthentication: async (request) => { recoveries.push(request); return {status: "READY"}; }}),
    onAuthenticationReady: async () => { invalidations += 1; }
  });
  assert.deepEqual((await client.describe(["search"])).operations.map(({operation}) => operation), ["search"]);
  assert.deepEqual(recoveries, [{resource, condition: {category: "mcp_session", code: "MCP_SESSION_CLOSED", source: "protected_resource"}}]);
  assert.equal(describeCalls, 2);
  assert.equal(refreshes, 1);
  assert.equal(invalidations, 1);
});

test("authentication recovery remains pending through BOS host action and resumes discovery without user repair instructions", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  let reads = 0;
  let waits = 0;
  const expected = {resource: "https://fixture.invalid/protected-resource", condition: {category: "authentication", code: "AUTHENTICATION_REQUIRED", source: "protected_resource"}};
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe, {
      read: async () => {
        reads += 1;
        if (reads === 1) {
          const error = new Error("expired");
          error.code = "AUTHENTICATION_REQUIRED";
          error.resource = expected.resource;
          throw error;
        }
        return discovery;
      }
    }),
    bos: bosAdapter({
      recoverAuthentication: async (request) => { assert.deepEqual(request, expected); return {status: "HOST_ACTION_REQUIRED"}; },
      waitForAuthentication: async (request) => { waits += 1; assert.deepEqual(request, expected); return {status: "READY"}; }
    })
  });
  assert.equal((await client.describe(["search"])).operations[0].operation, "search");
  assert.equal(waits, 1);
});

test("client distinguishes absent, not-available, and non-ready operation sources", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const unavailable = selectDescribe(describe, ["search"]);
  unavailable.operations[0].sources[0].availability = "configuration_required";
  let executions = 0;
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe, {describe: async ({operations}) => operations.includes("search") ? unavailable : selectDescribe(describe, operations)}),
    bos: bosAdapter({invokeDiscoveredOperation: async () => { executions += 1; return {status: 200, body: {records: []}}; }})
  });
  await assert.rejects(client.describe(["read"]), (error) => error instanceof BosContractError && error.code === "OPERATION_UNAVAILABLE");
  await client.describe(["calendar_read_event"]);
  await assert.rejects(client.execute("calendar_read_event", {}), (error) => error instanceof BosContractError && error.code === "OPERATION_UNAVAILABLE");
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error instanceof BosContractError && error.code === "OPERATION_NOT_READY");
  assert.equal(executions, 0);
});

test("ready source matching is semantic and independent of JSON key order", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const examples = await published("operation.examples.json");
  const selected = describe.operations[0].sources[0].source;
  let executions = 0;
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe),
    bos: bosAdapter({invokeDiscoveredOperation: async () => { executions += 1; return {status: 200, body: structuredClone(examples.search.response)}; }})
  });
  await client.describe(["search"]);
  await client.execute("search", {text: "person", source: {plugin: selected.plugin, platform: selected.platform, application: selected.application}});
  assert.equal(executions, 1);
});

test("operation transport and authentication recovery stay inside the BOS dependency adapter", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe),
    bos: bosAdapter({invokeDiscoveredOperation: async () => { const error = new Error("credential detail"); error.code = "AUTHENTICATION_RECOVERY_PENDING"; throw error; }})
  });
  await client.describe(["search"]);
  await assert.rejects(client.execute("search", {text: "person"}), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_PENDING" && !error.message.includes("credential detail"));
});

test("returned lifecycle actions pass unchanged to the BOS dependency adapter", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  const calls = [];
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe),
    bos: bosAdapter({invokeReturnedAction: async (action, payload) => { calls.push({action, payload}); return {status: 200, body: {status: "step_completed"}}; }})
  });
  const action = {verb: "complete", method: "POST", href: "/actions/complete", payload_schema: {type: "object", additionalProperties: false, required: ["acknowledged"], properties: {acknowledged: {const: true}}}};
  assert.equal((await client.invokeReturnedAction(action, {acknowledged: true})).status, 200);
  assert.deepEqual(calls, [{action, payload: {acknowledged: true}}]);
});

test("BOSL descriptor changes invalidate cached descriptions", async () => {
  const first = await published("app.describe.example.json");
  const second = structuredClone(first);
  second.bosl.descriptor_etag = "c".repeat(64);
  const describe = await published("describe.response.example.json");
  let current = first;
  const client = new BosContractClient({
    discovery: discoveryAdapter(first, describe, {read: async () => current, refresh: async () => { current = second; return current; }}),
    bos: bosAdapter()
  });
  await client.describe(["search"]);
  await client.refreshDiscovery();
  assert.throws(() => client.getDescription("search"), /not been described/);
});

test("a second Describe authentication failure is bounded and sanitized", async () => {
  const discovery = await published("app.describe.example.json");
  const describe = await published("describe.response.example.json");
  let recoveries = 0;
  const fail = async () => { const error = new Error("credential detail"); error.code = "INVALID_TOKEN"; throw error; };
  const client = new BosContractClient({
    discovery: discoveryAdapter(discovery, describe, {describe: fail}),
    bos: bosAdapter({recoverAuthentication: async () => { recoveries += 1; return {status: "READY"}; }})
  });
  await assert.rejects(client.describe(["search"]), (error) => error instanceof BosContractError && error.code === "AUTHENTICATION_RECOVERY_FAILED" && !error.message.includes("credential detail"));
  assert.equal(recoveries, 1);
});
